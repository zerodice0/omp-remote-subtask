import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveHost } from "../src/config.ts";

let scratch: string;
let configPath: string;
beforeAll(() => {
  const root = execFileSync(join(homedir(), ".config/herdr/scripts/agent_work.py"), ["path", "--name", "sshcore-tests"], { encoding: "utf8" }).trim();
  scratch = mkdtempSync(join(root, "config-"));
  configPath = join(scratch, "hosts.json");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function config(value: unknown) {
  writeFileSync(configPath, JSON.stringify(value));
  return loadConfig(configPath);
}

test("strict user config, defaults and host resolution", () => {
  const cfg = config({ hosts: { studio: { sshAlias: "mac-studio", defaultModel: "openai-codex/gpt-6-luna:low", allowedCwdRoots: ["/Users/test/workspace/./"] } } });
  expect(cfg.defaultTimeoutSeconds).toBe(600);
  expect(cfg.maxTimeoutSeconds).toBe(3600);
  expect(resolveHost(cfg, "studio")).toEqual({ sshAlias: "mac-studio", defaultModel: "openai-codex/gpt-6-luna:low", allowedCwdRoots: ["/Users/test/workspace/"] });
  expect(() => resolveHost(cfg, "other")).toThrow("unknown_host");
  expect(() => resolveHost(cfg, "other")).toThrow("studio");
  expect(() => resolveHost(cfg, "toString")).toThrow("unknown_host");
});

test("rejects unknown keys, wrong types, invalid aliases and roots", () => {
  for (const value of [null, [], {}, { hosts: [] }, { hosts: {}, extra: true },
    { hosts: { studio: { sshAlias: "mac-studio", extra: true } } },
    { hosts: { studio: { sshAlias: "-oProxyCommand=id" } } },
    { hosts: { studio: { sshAlias: "bad host" } } },
    { hosts: { studio: { sshAlias: 5 } } },
    { hosts: { studio: { sshAlias: "ok", allowedCwdRoots: ["relative"] } } },
    { hosts: { studio: { sshAlias: "ok", allowedCwdRoots: ["/bad\npath"] } } },
    { hosts: { studio: { sshAlias: "ok", allowedCwdRoots: "/root" } } },
    { hosts: { studio: { sshAlias: "ok", defaultModel: "model;id" } } },
    { hosts: {}, defaultTimeoutSeconds: 0 }, { hosts: {}, maxTimeoutSeconds: 1.5 },
    { hosts: {}, defaultTimeoutSeconds: 700, maxTimeoutSeconds: 600 },
  ]) expect(() => config(value)).toThrow();
});

test("config environment override and actionable read errors", () => {
  writeFileSync(configPath, '{"hosts":{"book":{"sshAlias":"macbook-pro"}}}');
  const previous = process.env.OMP_REMOTE_SUBTASK_CONFIG;
  process.env.OMP_REMOTE_SUBTASK_CONFIG = configPath;
  try { expect(resolveHost(loadConfig(), "book").sshAlias).toBe("macbook-pro"); }
  finally {
    if (previous === undefined) delete process.env.OMP_REMOTE_SUBTASK_CONFIG;
    else process.env.OMP_REMOTE_SUBTASK_CONFIG = previous;
  }
  expect(() => loadConfig(join(scratch, "missing.json"))).toThrow("config_read_error");
  writeFileSync(configPath, "not-json");
  expect(() => loadConfig(configPath)).toThrow("config_read_error");
});

test("host lookup safely supports own keys named like object prototypes", () => {
  writeFileSync(configPath, '{"hosts":{"__proto__":{"sshAlias":"safe"}}}');
  const cfg = loadConfig(configPath);
  expect(resolveHost(cfg, "__proto__").sshAlias).toBe("safe");
});

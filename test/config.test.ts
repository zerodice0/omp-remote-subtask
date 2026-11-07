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
  const cfg = config({ hosts: { studio: { sshAlias: "mac-studio", defaultRole: "explore", allowedCwdRoots: ["/Users/test/workspace/./"] } } });
  expect(cfg.roleTimeoutSeconds).toEqual({ tiny: 120, smol: 300, explore: 900, slow: 1800 });
  expect(cfg.maxTimeoutSeconds).toBe(3600);
  expect(resolveHost(cfg, "studio")).toEqual({ sshAlias: "mac-studio", defaultRole: "explore", allowedCwdRoots: ["/Users/test/workspace/"], allowExec: false });
  expect(() => resolveHost(cfg, "other")).toThrow("unknown_host");
  expect(() => resolveHost(cfg, "other")).toThrow("studio");
  expect(() => resolveHost(cfg, "toString")).toThrow("unknown_host");
});

test("exec permission defaults off and accepts only explicit booleans", () => {
  const cfg = config({ hosts: {
    omitted: { sshAlias: "safe" },
    disabled: { sshAlias: "safe", allowExec: false },
    enabled: { sshAlias: "safe", allowExec: true },
  } });
  expect(resolveHost(cfg, "omitted").allowExec).toBe(false);
  expect(resolveHost(cfg, "disabled").allowExec).toBe(false);
  expect(resolveHost(cfg, "enabled").allowExec).toBe(true);
  for (const allowExec of [null, 0, 1, "", "false", "true", [], {}]) {
    expect(() => config({ hosts: { studio: { sshAlias: "safe", allowExec } } })).toThrow("invalid_config: hosts.studio.allowExec must be a boolean");
  }
  expect(() => config({ hosts: { studio: { sshAlias: "safe", allowExec: true, extra: true } } })).toThrow('unknown key "extra"');
  expect(() => config({ hosts: {}, allowExec: true })).toThrow('config: unknown key "allowExec"');
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
    { hosts: {}, roleTimeoutSeconds: null }, { hosts: {}, roleTimeoutSeconds: [] },
    { hosts: {}, maxTimeoutSeconds: 1.5 },
  ]) expect(() => config(value)).toThrow();
});

test("merges per-role timeout overrides over the built-in defaults", () => {
  const cfg = config({ hosts: {}, roleTimeoutSeconds: { tiny: 45.5, slow: 2400 } });
  expect(cfg.roleTimeoutSeconds).toEqual({ tiny: 45.5, smol: 300, explore: 900, slow: 2400 });
});

test("rejects unknown timeout roles and the removed global timeout key", () => {
  expect(() => config({ hosts: {}, roleTimeoutSeconds: { unknown: 10 } })).toThrow('invalid_config: roleTimeoutSeconds: unknown key "unknown"');
  const removedKey = "default" + "TimeoutSeconds";
  expect(() => config({ hosts: {}, [removedKey]: 600 })).toThrow(`invalid_config: config: unknown key "${removedKey}"`);
});

test("rejects invalid or out-of-bounds role timeouts, including merged defaults", () => {
  for (const value of [0, -1, null, "120", true]) {
    expect(() => config({ hosts: {}, roleTimeoutSeconds: { tiny: value } })).toThrow("roleTimeoutSeconds.tiny must be a positive number");
  }
  expect(() => config({ hosts: {}, roleTimeoutSeconds: { slow: 3601 } })).toThrow("roleTimeoutSeconds.slow must not exceed maxTimeoutSeconds");
  expect(() => config({ hosts: {}, maxTimeoutSeconds: 1200 })).toThrow("roleTimeoutSeconds.slow must not exceed maxTimeoutSeconds");
  expect(config({ hosts: {}, maxTimeoutSeconds: 1200, roleTimeoutSeconds: { slow: 1200 } }).roleTimeoutSeconds.slow).toBe(1200);
});

test("rejects invalid default roles", () => {
  for (const defaultRole of ["unknown", "@explore", "", 1, null]) {
    expect(() => config({ hosts: { studio: { sshAlias: "ok", defaultRole } } })).toThrow("invalid_config: hosts.studio.defaultRole is invalid");
  }
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

test("run policy is opt-in and independent of exec permission", () => {
  const requireMode = { path: "/var/lib/ally-mode/mode", value: "server" };
  const systemdSlice = { slice: "ally-jobs.slice", memoryMax: "8G", memorySwapMax: "2G" };
  const cfg = config({ hosts: {
    plain: { sshAlias: "safe" },
    empty: { sshAlias: "safe", runPolicy: {} },
    modeOnly: { sshAlias: "safe", runPolicy: { requireMode } },
    sliceOnly: { sshAlias: "safe", runPolicy: { systemdSlice: { slice: "ally-jobs.slice" } } },
    combined: { sshAlias: "rogallyx", allowExec: true, runPolicy: { requireMode, systemdSlice } },
  } });
  expect(resolveHost(cfg, "plain")).toEqual({ sshAlias: "safe", allowExec: false });
  expect(Object.hasOwn(resolveHost(cfg, "plain"), "runPolicy")).toBe(false);
  expect(resolveHost(cfg, "empty").runPolicy).toEqual({});
  expect(resolveHost(cfg, "modeOnly")).toEqual({ sshAlias: "safe", allowExec: false, runPolicy: { requireMode } });
  expect(resolveHost(cfg, "sliceOnly").runPolicy).toEqual({ systemdSlice: { slice: "ally-jobs.slice" } });
  expect(resolveHost(cfg, "combined")).toEqual({ sshAlias: "rogallyx", allowExec: true, runPolicy: { requireMode, systemdSlice } });
});

test("rejects non-object run policies and nested policy sections", () => {
  for (const value of [null, false, 0, "", "server", []]) {
    expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: value } } })).toThrow("invalid_config: hosts.ally.runPolicy must be an object");
    for (const key of ["requireMode", "systemdSlice"]) {
      expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: { [key]: value } } } })).toThrow(`invalid_config: hosts.ally.runPolicy.${key} must be an object`);
    }
  }
});

test("rejects unknown run policy keys at every nesting level", () => {
  const policies = [
    { extra: true },
    { requireMode: { path: "/mode", value: "server", extra: true } },
    { systemdSlice: { slice: "ally-jobs.slice", extra: true } },
    { systemdSlice: { slice: "ally-jobs.slice", MemoryMax: "8G" } },
  ];
  for (const runPolicy of policies) {
    expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy } } })).toThrow("invalid_config:");
    expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy } } })).toThrow("unknown key");
  }
  expect(() => config({ hosts: {}, runPolicy: {} })).toThrow('invalid_config: config: unknown key "runPolicy"');
});

test("requires an absolute single-line mode path and a nonempty single-line value", () => {
  for (const path of [undefined, null, false, 3, [], {}, "", "relative", "~/mode", "C:\\mode", "/bad\0path", "/bad\rpath", "/bad\npath", "/mode\n"]) {
    expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: { requireMode: { path, value: "server" } } } } })).toThrow("invalid_config: hosts.ally.runPolicy.requireMode.path");
  }
  for (const value of [undefined, null, false, 3, [], {}, "", "ser\0ver", "ser\rver", "ser\nver", "server\n", "server\r\n"]) {
    expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: { requireMode: { path: "/mode", value } } } } })).toThrow("invalid_config: hosts.ally.runPolicy.requireMode.value");
  }
  expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: { requireMode: {} } } } })).toThrow("invalid_config:");
  const requireMode = { path: "/var/lib/ally mode/'current'", value: " server " };
  expect(config({ hosts: { ally: { sshAlias: "safe", runPolicy: { requireMode } } } }).hosts.ally.runPolicy).toEqual({ requireMode });
});

test("accepts systemd slice names from the configured character set", () => {
  for (const slice of ["ally-jobs.slice", "A0:_.-jobs.slice", "a.slice"]) {
    expect(config({ hosts: { ally: { sshAlias: "safe", runPolicy: { systemdSlice: { slice } } } } }).hosts.ally.runPolicy).toEqual({ systemdSlice: { slice } });
  }
});

test("rejects invalid systemd slice names and trailing line terminators", () => {
  for (const slice of [undefined, null, false, 1, [], {}, "", ".slice", "ally-jobs", "ally-jobs.service", "/ally.slice", "ally jobs.slice", "ally@jobs.slice", "ally.slice;id", "ally.slice\0", "ally.slice\r", "ally.slice\n", "ally.slice\r\n", "ally.slice\u2028", "ally.slice\u2029", "ally\njobs.slice"]) {
    expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: { systemdSlice: { slice } } } } })).toThrow("invalid_config: hosts.ally.runPolicy.systemdSlice.slice");
  }
});

test("accepts each supported size format for both optional memory limits", () => {
  for (const value of ["0", "0008", "1024", "1.5", "1K", "2M", "8G", "1T", "0.25G", "infinity"]) {
    for (const key of ["memoryMax", "memorySwapMax"]) {
      const systemdSlice = { slice: "ally-jobs.slice", [key]: value };
      expect(config({ hosts: { ally: { sshAlias: "safe", runPolicy: { systemdSlice } } } }).hosts.ally.runPolicy).toEqual({ systemdSlice });
    }
  }
});

test("rejects invalid sizes and non-string limits with strict end matching", () => {
  for (const value of [null, false, 0, 8, [], {}, "", "-1", "+1", ".5G", "1.G", "1.2.3G", "8g", "8GB", "1P", "1e3", "Infinity", "max", " 8G", "8G ", "8G;id", "8G\0", "8G\r", "8G\n", "8G\r\n", "8G\u2028", "8G\u2029", "infinity\n"]) {
    for (const key of ["memoryMax", "memorySwapMax"]) {
      expect(() => config({ hosts: { ally: { sshAlias: "safe", runPolicy: { systemdSlice: { slice: "ally-jobs.slice", [key]: value } } } } })).toThrow(`invalid_config: hosts.ally.runPolicy.systemdSlice.${key}`);
    }
  }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCleanupCheckScript, buildLaunchScript, buildProbeScript, parseProbe, supportedFlags } from "../src/remote-scripts.ts";
import { remoteShellCommand } from "../src/ssh.ts";

let scratch: string;
let fakeHome: string;
let fakeBin: string;
beforeAll(() => {
  const root = execFileSync(join(homedir(), ".config/herdr/scripts/agent_work.py"), ["path", "--name", "sshcore-tests"], { encoding: "utf8" }).trim();
  scratch = mkdtempSync(join(root, "scripts-"));
  fakeHome = join(scratch, "home");
  fakeBin = join(scratch, "bin");
  mkdirSync(fakeHome);
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "omp"), `#!/bin/sh
case "$1" in
--version) if [ "\${BUN_BE_BUN:-}" = 1 ]; then printf '1.4.3\\n'; else printf '18.12.6\\n'; fi ;;
--help) printf 'Usage: omp\\n--mode rpc --no-ui --cwd DIR --max-time N\\n' ;;
*) printf '%s\\n' "$BUN_BE_BUN" "$1" "$2"; cat ;;
esac
`, { mode: 0o700 });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function run(script: string, input?: string) {
  return spawnSync("/bin/sh", ["-c", remoteShellCommand(script)], { cwd: scratch, env: { ...process.env, HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}`, BUN_BE_BUN: "1" }, input, encoding: "utf8" });
}

test("portable probe parses versions, flags, non-repo and fallback without creating it", () => {
  const output = run(buildProbeScript({ cwd: scratch, runId: "probe-unit" }));
  expect(output.status).toBe(0);
  const probe = parseProbe(output.stdout);
  expect(probe.ompPath).toBe(join(fakeBin, "omp"));
  expect(probe.ompVersion).toBe("18.12.6");
  expect(probe.bunVersion).toBe("1.4.3");
  expect(probe.cwdReal).toBe(scratch);
  expect(probe.revision).toBe("");
  expect(probe.branch).toBe("");
  expect(probe.dirtyCount).toBeNull();
  expect(probe.runDirSource).toBe("fallback");
  expect(probe.runDir).toBe(join(fakeHome, ".cache/agent-work/omp-remote-subtask/runs/probe-unit"));
  expect(existsSync(probe.runDir)).toBe(false);
  expect([...supportedFlags(probe.help)]).toEqual(["--mode", "--no-ui", "--cwd", "--max-time"]);
});

test("probe reports missing cwd and preserves shell-injection/newline paths literally", () => {
  const missing = run(buildProbeScript({ cwd: join(scratch, "does-not-exist"), runId: "missing" }));
  expect(missing.status).toBe(0);
  expect(parseProbe(missing.stdout).cwdError).toBe("missing");
  expect(parseProbe(missing.stdout).cwdReal).toBeNull();
  const weird = join(scratch, "'; $(id) `id` 한글\nsecond=line");
  mkdirSync(weird);
  const result = run(buildProbeScript({ cwd: weird, runId: "weird" }));
  expect(result.status).toBe(0);
  expect(parseProbe(result.stdout).cwdReal).toBe(weird);
});

test("probe uses executable agent_work from resolved cwd", () => {
  const scripts = join(fakeHome, ".config/herdr/scripts");
  mkdirSync(scripts, { recursive: true });
  const program = join(scripts, "agent_work.py");
  writeFileSync(program, '#!/bin/sh\n[ "$1" = path ] && [ "$2" = --checkout ] && [ "$3" = "$PWD" ] && [ "$4" = --name ] || exit 2\nprintf "%s/%s\\n" "$PWD" "$5"\n', { mode: 0o700 });
  try {
    const result = run(buildProbeScript({ cwd: scratch, runId: "agent-work-unit" }));
    expect(result.status).toBe(0);
    const probe = parseProbe(result.stdout);
    expect(probe.runDirSource).toBe("agent_work");
    expect(probe.runDir).toBe(join(scratch, "remote-subtask-agent-work-unit"));
    expect(existsSync(probe.runDir)).toBe(false);
  } finally { rmSync(program); }
});

test("disabled-provider metadata preserves arrays and defaults legacy omission to empty", () => {
  const result = run(buildProbeScript({ cwd: scratch, runId: "disabled-provider-parse" }));
  expect(result.status).toBe(0);
  expect(parseProbe(result.stdout).disabledProviders).toEqual([]);
  const providers = ["anthropic", "existing-provider", { provider: "future-shape" }, null, 7];
  expect(parseProbe(result.stdout + `disabled_providers_json=${JSON.stringify(providers)}\n`).disabledProviders).toEqual(providers);
  expect(parseProbe(result.stdout + "disabled_providers_json=[]\n").disabledProviders).toEqual([]);
});

test.each(["", "[", "undefined", "null", "true", "3", '"anthropic"', '{"provider":"anthropic"}'])("rejects malformed disabled-provider metadata %s", value => {
  const result = run(buildProbeScript({ cwd: scratch, runId: "disabled-provider-invalid" }));
  expect(result.status).toBe(0);
  expect(() => parseProbe(result.stdout + `disabled_providers_json=${value}\n`)).toThrow("invalid_probe");
});

test("parses base64 fields strictly and rejects malformed probe metadata", () => {
  const valid = run(buildProbeScript({ cwd: scratch, runId: "parse" })).stdout;
  expect(parseProbe(valid.replace("dirty_count=", "dirty_count=12")).dirtyCount).toBe(12);
  for (const invalid of [valid + "omp_path=again\n", valid.replace("help_b64=", "help_b64=!"), valid.replace("dirty_count=", "dirty_count=-1"), valid.replace("run_dir_source=fallback", "run_dir_source=other"), "banner without equals\n" + valid, valid.replace(/^omp_path=.*\n/m, "")]) expect(() => parseProbe(invalid)).toThrow("invalid_probe");
  expect(() => parseProbe("omp_error=missing\n")).toThrow("unsupported_remote_omp");
  expect(supportedFlags("--mode --mode=rpc, --no-ui; --max-time N")).toEqual(new Set(["--mode", "--no-ui", "--max-time"]));
  expect(supportedFlags("").size).toBe(0);
});

test("launch writes source and sessions privately, quotes paths, and preserves stdin", () => {
  const runDir = join(scratch, "launch '\" $(id) `id` 한글");
  const source = 'console.log("literal $() `id` 한글");\n';
  const config = { runId: "test-launch", task: "' $(id)\n한글" };
  const output = run(buildLaunchScript({ ompPath: join(fakeBin, "omp"), runDir, supervisorSource: source, supervisorConfig: config }), "unchanged stdin\n");
  expect(output.status).toBe(0);
  const lines = output.stdout.split("\n");
  expect(lines[0]).toBe("1");
  expect(lines[1]).toBe(join(runDir, "supervisor.mjs"));
  expect(JSON.parse(Buffer.from(lines[2], "base64").toString("utf8"))).toEqual(config);
  expect(lines[3]).toBe("unchanged stdin");
  expect(readFileSync(join(runDir, "supervisor.mjs"), "utf8")).toBe(source);
  expect(existsSync(join(runDir, "sessions"))).toBe(true);
});

test("cleanup check finds run process and excludes its own shell", async () => {
  const runId = `rst-cleanup-${process.pid}-${Date.now()}`;
  const child = spawn("/bin/sh", ["-c", "read value", runId], { stdio: ["pipe", "ignore", "ignore"] });
  const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
  child.once("exit", onExit);
  try {
    const output = run(buildCleanupCheckScript({ runId }));
    expect(output.status).toBe(0);
    const lines = output.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(Number(lines[0].trim().split(/\s+/)[0])).toBe(child.pid);
  } finally { child.kill("SIGTERM"); await exited; }
  expect(run(buildCleanupCheckScript({ runId })).stdout).toBe("");
});

test("rejects traversal and shell payload run ids", () => {
  for (const runId of ["../escape", "..", ".", "bad;id", "bad\nline", ""]) {
    expect(() => buildProbeScript({ cwd: scratch, runId })).toThrow("invalid_run_id");
    expect(() => buildCleanupCheckScript({ runId })).toThrow("invalid_run_id");
  }
});

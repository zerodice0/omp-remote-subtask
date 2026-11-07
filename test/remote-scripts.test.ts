import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCleanupCheckScript, buildLaunchScript, buildProbeScript, parseProbe, RemoteModeError, supportedFlags, systemdUnitName } from "../src/remote-scripts.ts";
import type { RunPolicy } from "../src/config.ts";
import { posixQuote, remoteShellCommand } from "../src/ssh.ts";

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

function policyFixture() {
  const directory = mkdtempSync(join(scratch, "policy-"));
  const bin = join(directory, "bin");
  const modePath = join(directory, "mode ' $(id) 한글");
  const runDir = join(directory, "run ' $(id) 한글");
  mkdirSync(bin);
  writeFileSync(modePath, "server\n");
  const policy: RunPolicy = {
    requireMode: { path: modePath, value: "server" },
    systemdSlice: { slice: "ally-jobs.slice", memoryMax: "4G", memorySwapMax: "2G" },
  };
  writeFileSync(join(bin, "systemd-run"), `#!/bin/sh
printf '%s\\0' "$@" > "$POLICY_CAPTURE/systemd-argv"
if [ -n "\${POLICY_SWITCH_MODE:-}" ]; then
  printf %s "$POLICY_SWITCH_MODE" > "$POLICY_MODE_PATH"
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -p|-E) shift; shift ;;
    *) shift ;;
  esac
done
exec env -i HOME="$HOME" PATH="$PATH" BUN_BE_BUN=1 "$@"
`, { mode: 0o700 });
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\0' "$@" >> "$POLICY_CAPTURE/systemctl-argv"
`, { mode: 0o700 });
  writeFileSync(join(bin, "omp"), `#!/bin/sh
printf '%s\\0' "$@" > "$POLICY_CAPTURE/omp-argv"
printf '%s\\0' "$HOME" "$PATH" "$BUN_BE_BUN" "$POLICY_INHERITED" > "$POLICY_CAPTURE/omp-env"
cat > "$POLICY_CAPTURE/stdin"
exit "\${POLICY_EXIT:-0}"
`, { mode: 0o700 });
  return {
    directory, modePath, runDir, policy,
    launch(overrides: { policy?: RunPolicy; mode?: string; exit?: number; input?: string } = {}) {
      return spawnSync("/bin/sh", ["-c", remoteShellCommand(buildLaunchScript({
        ompPath: join(bin, "omp"), runDir, supervisorSource: "literal supervisor source 한글\n",
        supervisorConfig: { runId: "policy-unit", task: "literal $() 한글" }, runPolicy: overrides.policy ?? policy, runId: "policy-unit",
      }))], {
        cwd: directory, encoding: "utf8", input: overrides.input ?? "stdin survives systemd\n",
        env: {
          ...process.env, HOME: fakeHome, PATH: `${bin}:${fakeBin}:${process.env.PATH}`,
          POLICY_CAPTURE: directory, POLICY_MODE_PATH: modePath, POLICY_SWITCH_MODE: overrides.mode ?? "",
          POLICY_EXIT: String(overrides.exit ?? 0), POLICY_INHERITED: "' $() `id` 한글\nsecond=line",
        },
      });
    },
    cleanup(runId: string, stopUnit?: string) {
      return spawnSync("/bin/sh", ["-c", remoteShellCommand(buildCleanupCheckScript({ runId, stopUnit }))], {
        cwd: directory, encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, POLICY_CAPTURE: directory },
      });
    },
    args(name: string): string[] { return readFileSync(join(directory, name), "utf8").split("\0").slice(0, -1); },
  };
}

test("mode policy probe accepts the configured mode without creating a run directory", () => {
  const fixture = policyFixture();
  const result = run(buildProbeScript({ cwd: scratch, runId: "mode-probe", runPolicy: fixture.policy }));
  expect(result.status).toBe(0);
  const probe = parseProbe(result.stdout);
  expect(probe.modeObserved).toBe("server");
  expect(probe.ompPath).toBe(join(fakeBin, "omp"));
  expect(existsSync(probe.runDir)).toBe(false);
});

test.each([
  { observed: "game", readable: true, expected: "server" },
  { observed: "game\nsecond=line", readable: true, expected: "server" },
  { observed: "server\r", readable: true, expected: "server" },
  { observed: "", readable: true, expected: "server" },
  { observed: "unreadable", readable: false, expected: "server" },
  { observed: "unreadable", readable: false, expected: "unreadable" },
])("mode policy probe rejects $observed (readable=$readable, expected=$expected) before omp discovery", ({ observed, readable, expected }) => {
  const fixture = policyFixture();
  if (readable) writeFileSync(fixture.modePath, observed + "\n");
  else rmSync(fixture.modePath);
  const result = run(buildProbeScript({
    cwd: scratch, runId: "rejected-mode-probe",
    runPolicy: { requireMode: { path: fixture.modePath, value: expected } },
  }));
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("mode_error=not_allowed\n");
  expect(result.stdout).not.toContain("omp_path=");
  expect(() => parseProbe(result.stdout)).toThrow(RemoteModeError);
  try { parseProbe(result.stdout); } catch (error) {
    expect((error as RemoteModeError).observed).toBe(observed);
  }
});

test.each([
  { observed: "game", readable: true, expected: "server", sliced: false },
  { observed: "game\nsecond=line", readable: true, expected: "server", sliced: true },
  { observed: "unreadable", readable: false, expected: "server", sliced: true },
  { observed: "unreadable", readable: false, expected: "unreadable", sliced: false },
  { observed: "unreadable", readable: false, expected: "unreadable", sliced: true },
])("launch pre-gate rejects $observed (readable=$readable, expected=$expected, sliced=$sliced)", ({ observed, readable, expected, sliced }) => {
  const fixture = policyFixture();
  if (readable) writeFileSync(fixture.modePath, observed + "\n");
  else rmSync(fixture.modePath);
  const result = fixture.launch({
    policy: { requireMode: { path: fixture.modePath, value: expected }, ...(sliced ? { systemdSlice: fixture.policy.systemdSlice } : {}) },
  });
  expect(result.status).toBe(78);
  const frame = JSON.parse(result.stdout.trim());
  expect(frame).toEqual({
    type: "remote_subtask_supervisor", runId: "policy-unit", event: "exited",
    reason: "remote_mode_not_allowed", groupGone: true, modeObservedB64: Buffer.from(observed).toString("base64"),
  });
  expect(existsSync(join(fixture.directory, "systemd-argv"))).toBe(false);
  expect(existsSync(join(fixture.directory, "omp-argv"))).toBe(false);
  expect(existsSync(join(fixture.runDir, "launch-env.sh"))).toBe(false);
});

test("unit gate rechecks mode after systemd admission and before launching the supervisor", () => {
  const fixture = policyFixture();
  const result = fixture.launch({ mode: "game\nchanged=before-child" });
  expect(result.status).toBe(78);
  const frames = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(frames).toEqual([
    {
      type: "remote_subtask_supervisor", runId: "policy-unit", event: "exited", reason: "remote_mode_not_allowed",
      groupGone: true, modeObservedB64: Buffer.from("game\nchanged=before-child").toString("base64"),
    },
    { type: "remote_subtask_supervisor", runId: "policy-unit", event: "unit_result", code: 78 },
  ]);
  expect(existsSync(join(fixture.directory, "systemd-argv"))).toBe(true);
  expect(existsSync(join(fixture.directory, "omp-argv"))).toBe(false);
  expect(fixture.args("systemctl-argv")).toEqual(["--user", "stop", "remote-subtask-policy-unit.service"]);
  expect(existsSync(join(fixture.runDir, "launch-env.sh"))).toBe(false);
});

test.each([0, 37])("systemd launch forwards unit, caps, environment and stdin and preserves exit %s", code => {
  const fixture = policyFixture();
  const input = "unchanged stdin ' $() 한글\nsecond=line\n";
  const result = fixture.launch({ exit: code, input });
  expect(result.status).toBe(code);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    type: "remote_subtask_supervisor", runId: "policy-unit", event: "unit_result", code,
  });
  const argv = fixture.args("systemd-argv");
  const path = `${join(fixture.directory, "bin")}:${fakeBin}:${process.env.PATH}`;
  expect(argv.slice(0, -1)).toEqual([
    "--user", "--pipe", "--wait", "--collect", "--quiet", "--expand-environment=no",
    "--slice=ally-jobs.slice", "--unit=remote-subtask-policy-unit.service",
    "-p", "MemoryMax=4G", "-p", "MemorySwapMax=2G",
    "-E", `HOME=${fakeHome}`, "-E", `PATH=${path}`, "-E", "BUN_BE_BUN=1",
    "--", "/bin/sh", "-c",
  ]);
  expect(fixture.args("omp-env")).toEqual([fakeHome, path, "1", "' $() `id` 한글\nsecond=line"]);
  const ompArgv = fixture.args("omp-argv");
  expect(ompArgv[0]).toBe(join(fixture.runDir, "supervisor.mjs"));
  expect(JSON.parse(Buffer.from(ompArgv[1], "base64").toString("utf8"))).toEqual({ runId: "policy-unit", task: "literal $() 한글" });
  expect(readFileSync(join(fixture.runDir, "supervisor.mjs"), "utf8")).toBe("literal supervisor source 한글\n");
  expect(readFileSync(join(fixture.directory, "stdin"), "utf8")).toBe(input);
  expect(statSync(join(fixture.runDir, "supervisor.mjs")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(fixture.runDir, "launch-env.sh"))).toBe(false);
  expect(fixture.args("systemctl-argv")).toEqual(["--user", "stop", "remote-subtask-policy-unit.service"]);
});

test("cleanup stops only the matching run unit and rejects foreign units", () => {
  const fixture = policyFixture();
  const runId = "policy-owned-cleanup";
  const unit = "remote-subtask-policy-owned-cleanup.service";
  expect(systemdUnitName(runId)).toBe(unit);
  expect(fixture.cleanup(runId, unit).status).toBe(0);
  expect(fixture.args("systemctl-argv")).toEqual(["--user", "stop", "--no-block", unit]);
  expect(fixture.cleanup(runId).status).toBe(0);
  expect(fixture.args("systemctl-argv")).toEqual(["--user", "stop", "--no-block", unit]);
  for (const stopUnit of ["ally-jobs.slice", "remote-subtask-another-run.service", "--all", `${unit}; id`]) {
    expect(() => buildCleanupCheckScript({ runId, stopUnit })).toThrow("invalid_run_unit");
  }
});

test("policy-less launch is byte-for-byte the original source/base64/config launch literal", () => {
  const ompPath = "/bin/omp ' 한글";
  const runDir = "/work/run ' $(id) 한글";
  const supervisorSource = 'console.log("literal $() 한글");\n';
  const supervisorConfig = { runId: "legacy-unit", task: "' $(id)\n한글" };
  const source = Buffer.from(supervisorSource, "utf8").toString("base64");
  const config = JSON.stringify(supervisorConfig);
  const original = `set -eu
umask 077
mkdir -p ${posixQuote(runDir)} ${posixQuote(`${runDir}/sessions`)}
decoder=/usr/bin/base64
[ -x "$decoder" ] || decoder=$(command -v base64) || exit 127
printf %s ${posixQuote(source)} | "$decoder" -d > ${posixQuote(`${runDir}/supervisor.mjs`)} 2>/dev/null || printf %s ${posixQuote(source)} | "$decoder" -D > ${posixQuote(`${runDir}/supervisor.mjs`)} || exit
exec env BUN_BE_BUN=1 ${posixQuote(ompPath)} ${posixQuote(`${runDir}/supervisor.mjs`)} ${posixQuote(Buffer.from(config, "utf8").toString("base64"))}
`;
  expect(buildLaunchScript({ ompPath, runDir, supervisorSource, supervisorConfig })).toBe(original);
});

test("mode-only policy launches directly after a successful gate and preserves stdin", () => {
  const fixture = policyFixture();
  const result = fixture.launch({ policy: { requireMode: fixture.policy.requireMode }, input: "mode-only stdin\n" });
  expect(result.status).toBe(0);
  expect(fixture.args("omp-argv")[0]).toBe(join(fixture.runDir, "supervisor.mjs"));
  expect(readFileSync(join(fixture.directory, "stdin"), "utf8")).toBe("mode-only stdin\n");
  expect(existsSync(join(fixture.directory, "systemd-argv"))).toBe(false);
  expect(existsSync(join(fixture.directory, "systemctl-argv"))).toBe(false);
});

test("slice-only policy does not invent memory caps or require a mode file", () => {
  const fixture = policyFixture();
  rmSync(fixture.modePath);
  const result = fixture.launch({ policy: { systemdSlice: { slice: "ally-jobs.slice" } } });
  expect(result.status).toBe(0);
  const argv = fixture.args("systemd-argv");
  expect(argv).toContain("--slice=ally-jobs.slice");
  expect(argv).not.toContain("-p");
  expect(argv.some(arg => arg.startsWith("MemoryMax=") || arg.startsWith("MemorySwapMax="))).toBe(false);
  expect(fixture.args("omp-argv")[0]).toBe(join(fixture.runDir, "supervisor.mjs"));
  expect(JSON.parse(result.stdout.trim()).code).toBe(0);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FIXED_DECODER, controlPath, posixQuote, remoteShellCommand, sshArgv } from "../src/ssh.ts";

let scratch: string;
beforeAll(() => {
  const root = execFileSync(join(homedir(), ".config/herdr/scripts/agent_work.py"), ["path", "--name", "sshcore-tests"], { encoding: "utf8" }).trim();
  scratch = mkdtempSync(join(root, "ssh-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const modulePath = resolve(import.meta.dir, "../src/ssh.ts");
function inScratch(expression: string): unknown {
  const code = `import {controlPath} from ${JSON.stringify(modulePath)}; import {statSync} from 'node:fs'; console.log(JSON.stringify(${expression}));`;
  const result = spawnSync(process.execPath, ["--eval", code], { cwd: scratch, env: { ...process.env, BUN_BE_BUN: "1" }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

describe("SSH transport", () => {
  test("exact hardened argv and explicitly disabled multiplexing", () => {
    expect(sshArgv("mac-studio", "command", { controlPath: "/safe/%C", connectTimeoutSeconds: 7 })).toEqual([
      "ssh", "-o", "BatchMode=yes", "-o", "ConnectionAttempts=1", "-o", "ConnectTimeout=7",
      "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
      "-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-S", "/safe/%C", "-T", "mac-studio", "command",
    ]);
    const disabled = sshArgv("macbook-pro", "command", { controlPath: null });
    expect(disabled.slice(-7)).toEqual(["-o", "ControlMaster=no", "-o", "ControlPath=none", "-T", "macbook-pro", "command"]);
    expect(disabled).not.toContain("-F");
    expect(disabled).not.toContain("--");
    expect(disabled).toContain("ConnectTimeout=10");
  });
  test("rejects aliases and invalid option values", () => {
    for (const alias of ["", "-oProxyCommand=id", "host name", "host;id", "user@host", "host\nother", "host\n", "host\u2028", "a".repeat(65)]) {
      expect(() => sshArgv(alias, "true", { controlPath: null })).toThrow("invalid_ssh_alias");
    }
    expect(sshArgv("a".repeat(64), "true", { controlPath: null }).at(-2)).toBe("a".repeat(64));
    for (const timeout of [0, -1, 1.5, NaN, Infinity]) expect(() => sshArgv("host", "true", { controlPath: null, connectTimeoutSeconds: timeout })).toThrow();
  });
  test("quotes with shlex semantics and rejects NUL", () => {
    expect(posixQuote("")).toBe("''");
    expect(posixQuote("a/b-c_d@e%f+x=y:z,.")).toBe("a/b-c_d@e%f+x=y:z,.");
    expect(posixQuote("a'b")).toBe("'a'\"'\"'b'");
    expect(() => posixQuote("a\0b")).toThrow();
    expect(() => remoteShellCommand("\0")).toThrow();
    expect(() => remoteShellCommand("true", "bad name")).toThrow();
  });
  test("fixed decoder is fish-safe and carries only base64 data", () => {
    expect(FIXED_DECODER).not.toContain("\\");
    expect(FIXED_DECODER).not.toContain("'");
    const command = remoteShellCommand("printf hello");
    expect(command).toMatch(/^sh -c '.*' omp-remote-subtask [A-Za-z0-9+/=]+$/);
    expect(spawnSync("/bin/sh", ["-c", remoteShellCommand("")]).status).toBe(0);
  });
  for (const shell of ["/bin/sh", "fish"]) {
    const installed = shell !== "fish" || spawnSync("fish", ["--version"]).status === 0;
    test.skipIf(!installed)(`literal injection round trips through ${shell}`, () => {
      for (const payload of ["'; rm -rf ~ #", "$(id)", "`id`", "line1\nline2", "trailing newline\n", "한글 🐦", "slash\\quote'\"$; &|<>"]) {
        const result = spawnSync(shell, ["-c", remoteShellCommand(`printf %s ${posixQuote(payload)}`)], { encoding: "utf8", cwd: scratch });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(payload);
      }
      const stdin = spawnSync(shell, ["-c", remoteShellCommand('IFS= read -r value; printf %s "$value"')], { input: "RPC stdin preserved\n", encoding: "utf8", cwd: scratch });
      expect(stdin.status).toBe(0);
      expect(stdin.stdout).toBe("RPC stdin preserved");
    });
  }
  test("control socket boundary includes 40-byte hash and 17-byte suffix", () => {
    for (const platform of ["linux", "darwin"]) {
      const limit = platform === "linux" ? 108 : 104;
      const suffixBytes = Buffer.byteLength("/.ssh/omp-rst-cm");
      const boundaryHome = "h".repeat(limit - 58 - suffixBytes);
      expect(controlPath(boundaryHome, platform)).toBeNull();
      const shortHome = boundaryHome.slice(1);
      expect(inScratch(`controlPath(${JSON.stringify(shortHome)},${JSON.stringify(platform)})`)).toBe(`${shortHome}/.ssh/omp-rst-cm/%C`);
    }
    expect(controlPath("한".repeat(20), "linux")).toBeNull();
  });
  test("checks ownership, rejects symlinks, tightens mode and escapes percents", () => {
    expect(inScratch(`(()=>{const p=controlPath('percent%home','linux'); return [p, statSync('percent%home/.ssh/omp-rst-cm').mode & 511]})()`)).toEqual(["percent%%home/.ssh/omp-rst-cm/%C", 0o700]);
    expect(inScratch(`(()=>{try{controlPath('owner','linux',process.getuid()+1);return false}catch(e){return e.message.includes('unsafe_control_directory')}})()`)).toBe(true);
    mkdirSync(join(scratch, "symlink/.ssh"), { recursive: true });
    mkdirSync(join(scratch, "target"));
    symlinkSync(join(scratch, "target"), join(scratch, "symlink/.ssh/omp-rst-cm"));
    expect(inScratch(`(()=>{try{controlPath('symlink','linux');return false}catch(e){return e.message.includes('unsafe_control_directory')}})()`)).toBe(true);
  });
});

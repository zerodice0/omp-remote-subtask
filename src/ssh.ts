import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Keep this decoder identical to HAM's fish-safe transport decoder. Only the
// fixed decoder and base64 reach the user's SSH login shell; stdin stays free.
export const FIXED_DECODER = 'decoder=/usr/bin/base64; [ -x "$decoder" ] || decoder=$(command -v base64) || exit 127; script=$(printf %s "$1" | "$decoder" -d 2>/dev/null) || script=$(printf %s "$1" | "$decoder" -D) || exit; eval "$script"';

export function posixQuote(value: string): string {
  if (value.includes("\0")) throw new Error("invalid_shell_argument: NUL is not allowed");
  if (value.length > 0 && !/[^A-Za-z0-9_@%+=:,./-]/.test(value)) return value;
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function remoteShellCommand(script: string, name = "omp-remote-subtask"): string {
  if (script.includes("\0")) throw new Error("invalid_remote_script: NUL is not allowed");
  // A variable name must not introduce fish quoting grammar into the wrapper.
  if (!name || /[^A-Za-z0-9_@%+=:,./-]/.test(name)) throw new Error("invalid_remote_command_name");
  return `sh -c '${FIXED_DECODER}' ${name} ${Buffer.from(script, "utf8").toString("base64") || "''"}`;
}

export function validateSshAlias(alias: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/.test(alias)) throw new Error(`invalid_ssh_alias: ${JSON.stringify(alias)}`);
}

export function controlPath(home = os.homedir(), platform: string = process.platform, uid = process.getuid?.()): string | null {
  const directory = path.join(home, ".ssh", "omp-rst-cm");
  const limit = platform.startsWith("linux") ? 108 : 104;
  // %C expands to 40 bytes; OpenSSH also adds a 17-byte temporary suffix.
  // Leave one byte for the terminating NUL in sockaddr_un.sun_path.
  if (Buffer.byteLength(directory) + 1 + 40 + 17 >= limit) return null;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || uid === undefined || metadata.uid !== uid) {
    throw new Error("unsafe_control_directory: SSH control directory must be owned by the current user and not a symlink");
  }
  fs.chmodSync(directory, 0o700);
  return directory.replaceAll("%", "%%") + "/%C";
}

export interface SshOptions {
  controlPath?: string | null;
  connectTimeoutSeconds?: number;
}

export function sshArgv(alias: string, remoteCommand: string, opts: SshOptions = {}): string[] {
  validateSshAlias(alias);
  if (remoteCommand.includes("\0")) throw new Error("invalid_remote_command: NUL is not allowed");
  const timeout = opts.connectTimeoutSeconds ?? 10;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("invalid_connect_timeout");
  const socket = opts.controlPath === undefined ? controlPath() : opts.controlPath;
  if (socket?.includes("\0")) throw new Error("invalid_control_path");
  const reuse = socket !== null
    ? ["-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-S", socket]
    : ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectionAttempts=1", "-o", `ConnectTimeout=${timeout}`,
    "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
    ...reuse, "-T", alias, remoteCommand];
}

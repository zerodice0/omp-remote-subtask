import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { validateSshAlias } from "./ssh.ts";

export const REMOTE_ROLES = ["tiny", "smol", "explore", "slow"] as const;
export type RemoteRole = typeof REMOTE_ROLES[number];

export interface HostConfig {
  sshAlias: string;
  defaultRole?: RemoteRole;
  allowedCwdRoots?: string[];
  allowExec?: boolean;
}

export interface HostsConfig {
  roleTimeoutSeconds: Record<RemoteRole, number>;
  maxTimeoutSeconds: number;
  hosts: Record<string, HostConfig>;
}

function invalid(message: string): never {
  throw new Error(`invalid_config: ${message}`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], location: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${location}: unknown key ${JSON.stringify(key)}`);
}

function seconds(value: unknown, fallback: number, location: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${location} must be a positive integer`);
  return value;
}

// omp documents plugin setting persistence, but no ExtensionAPI accessor for
// that plugin-specific settings map. Do not depend on its internal lockfile.
export function loadConfig(configPath = process.env.OMP_REMOTE_SUBTASK_CONFIG ?? join(homedir(), ".omp", "agent", "omp-remote-subtask.json")): HostsConfig {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`config_read_error: ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = object(data, "config");
  keys(root, ["roleTimeoutSeconds", "maxTimeoutSeconds", "hosts"], "config");
  const maxTimeoutSeconds = seconds(root.maxTimeoutSeconds, 3600, "maxTimeoutSeconds");
  const roleTimeoutSeconds: Record<RemoteRole, number> = { tiny: 120, smol: 300, explore: 900, slow: 1800 };
  if (root.roleTimeoutSeconds !== undefined) {
    const overrides = object(root.roleTimeoutSeconds, "roleTimeoutSeconds");
    keys(overrides, [...REMOTE_ROLES], "roleTimeoutSeconds");
    for (const role of REMOTE_ROLES) {
      if (!Object.hasOwn(overrides, role)) continue;
      const value = overrides[role];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`roleTimeoutSeconds.${role} must be a positive number`);
      roleTimeoutSeconds[role] = value;
    }
  }
  for (const role of REMOTE_ROLES) {
    if (roleTimeoutSeconds[role] > maxTimeoutSeconds) invalid(`roleTimeoutSeconds.${role} must not exceed maxTimeoutSeconds`);
  }
  const hosts: Record<string, HostConfig> = Object.create(null);
  for (const [name, rawHost] of Object.entries(object(root.hosts, "hosts"))) {
    if (!name || /[\0\r\n]/.test(name)) invalid("host names must be nonempty single-line strings");
    const host = object(rawHost, `hosts.${name}`);
    keys(host, ["sshAlias", "defaultRole", "allowedCwdRoots", "allowExec"], `hosts.${name}`);
    if (typeof host.sshAlias !== "string") invalid(`hosts.${name}.sshAlias must be a string`);
    validateSshAlias(host.sshAlias);
    const parsed: HostConfig = { sshAlias: host.sshAlias, allowExec: false };
    if (host.allowExec !== undefined) {
      if (typeof host.allowExec !== "boolean") invalid(`hosts.${name}.allowExec must be a boolean`);
      parsed.allowExec = host.allowExec;
    }
    if (host.defaultRole !== undefined) {
      if (typeof host.defaultRole !== "string" || !REMOTE_ROLES.includes(host.defaultRole as RemoteRole)) invalid(`hosts.${name}.defaultRole is invalid`);
      parsed.defaultRole = host.defaultRole as RemoteRole;
    }
    if (host.allowedCwdRoots !== undefined) {
      if (!Array.isArray(host.allowedCwdRoots)) invalid(`hosts.${name}.allowedCwdRoots must be an array`);
      parsed.allowedCwdRoots = host.allowedCwdRoots.map((cwd, index) => {
        if (typeof cwd !== "string" || !posix.isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) invalid(`hosts.${name}.allowedCwdRoots[${index}] must be an absolute single-line path`);
        return posix.normalize(cwd);
      });
    }
    hosts[name] = parsed;
  }
  return { roleTimeoutSeconds, maxTimeoutSeconds, hosts };
}

export function resolveHost(config: HostsConfig, name: string): HostConfig {
  if (!Object.hasOwn(config.hosts, name)) throw new Error(`unknown_host: ${JSON.stringify(name)}; configured hosts: ${Object.keys(config.hosts).sort().join(", ") || "(none)"}`);
  return config.hosts[name];
}

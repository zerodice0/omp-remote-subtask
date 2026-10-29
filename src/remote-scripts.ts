import { posixQuote } from "./ssh.ts";

export interface ProbeResult {
  ompPath: string;
  ompVersion: string;
  bunVersion: string;
  help: string;
  cwdReal: string | null;
  cwdError?: "missing";
  revision: string;
  branch: string;
  dirtyCount: number | null;
  runDir: string;
  runDirSource: "agent_work" | "fallback";
  home: string;
  disabledProviders: unknown[];
}

function checkRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/.test(runId) || runId === "." || runId === "..") throw new Error("invalid_run_id");
}

export function buildProbeScript({ cwd, runId, exec = false }: { cwd: string; runId: string; exec?: boolean }): string {
  checkRunId(runId);
  return `set -eu
emit() {
  case "$2" in
    *'
'*) printf '%s_b64=' "$1"; printf %s "$2" | base64 | tr -d '\\r\\n'; printf '\\n' ;;
    *) printf '%s=%s\\n' "$1" "$2" ;;
  esac
}
omp_path=$(command -v omp) || { printf 'omp_error=missing\\n'; exit 127; }
emit omp_path "$omp_path"
omp_version=$(unset BUN_BE_BUN; "$omp_path" --version)
emit omp_version "$omp_version"
bun_version=$(BUN_BE_BUN=1 "$omp_path" --version)
emit bun_version "$bun_version"
help=$(unset BUN_BE_BUN; "$omp_path" --help)
printf 'help_b64='; printf %s "$help" | base64 | tr -d '\\r\\n'; printf '\\n'
emit home "$HOME"
if ! cd -- ${posixQuote(cwd)} 2>/dev/null; then
  printf 'cwd_error=missing\\n'
  exit 0
fi
${exec ? `disabled_providers=$(unset BUN_BE_BUN; "$omp_path" config get disabledProviders --json)
disabled_providers=$(printf %s "$disabled_providers" | env BUN_BE_BUN=1 "$omp_path" -e 'const value = await Bun.stdin.json(); if (!Array.isArray(value.value)) throw new Error("invalid disabledProviders"); console.log(JSON.stringify(value.value));')
printf 'disabled_providers_json_b64='; printf %s "$disabled_providers" | base64 | tr -d '\\r\\n'; printf '\\n'` : ""}
cwd_real=$(pwd -P)
emit cwd_real "$cwd_real"
revision=
branch=
dirty_count=
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  revision=$(git rev-parse --verify HEAD 2>/dev/null || :)
  branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || :)
  dirty_count=$(git status --porcelain=v1 -uall | wc -l | tr -d '[:space:]')
fi
emit revision "$revision"
emit branch "$branch"
emit dirty_count "$dirty_count"
if [ -x "$HOME/.config/herdr/scripts/agent_work.py" ]; then
  run_dir=$("$HOME/.config/herdr/scripts/agent_work.py" path --checkout "$cwd_real" --name ${posixQuote(`remote-subtask-${runId}`)})
  run_dir_source=agent_work
else
  run_dir="$HOME/.cache/agent-work/omp-remote-subtask/runs/"${posixQuote(runId)}
  run_dir_source=fallback
fi
emit run_dir "$run_dir"
emit run_dir_source "$run_dir_source"
`;
}

function decodeBase64(value: string, key: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`invalid_probe: malformed base64 for ${key}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64"));
  } catch {
    throw new Error(`invalid_probe: invalid UTF-8 for ${key}`);
  }
}

export function parseProbe(stdout: string): ProbeResult {
  const values: Record<string, string> = Object.create(null);
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`invalid_probe: malformed line ${JSON.stringify(line)}`);
    const rawKey = line.slice(0, separator);
    const encoded = rawKey.endsWith("_b64");
    const key = encoded ? rawKey.slice(0, -4) : rawKey;
    if (Object.hasOwn(values, key)) throw new Error(`invalid_probe: duplicate ${key}`);
    values[key] = encoded ? decodeBase64(line.slice(separator + 1), key) : line.slice(separator + 1);
  }
  if (values.omp_error) throw new Error(`unsupported_remote_omp: ${values.omp_error}`);
  for (const key of ["omp_path", "omp_version", "bun_version", "help", "home"]) {
    if (!values[key]) throw new Error(`invalid_probe: missing ${key}`);
  }
  if (values.cwd_error !== undefined && values.cwd_error !== "missing") throw new Error("invalid_probe: invalid cwd_error");
  const missing = values.cwd_error === "missing";
  if (!missing) {
    for (const key of ["cwd_real", "run_dir", "run_dir_source", "revision", "branch", "dirty_count"]) {
      if (!Object.hasOwn(values, key)) throw new Error(`invalid_probe: missing ${key}`);
    }
    if (!values.cwd_real.startsWith("/") || !values.run_dir.startsWith("/")) throw new Error("invalid_probe: paths must be absolute");
    if (values.run_dir_source !== "agent_work" && values.run_dir_source !== "fallback") throw new Error("invalid_probe: invalid run_dir_source");
  }
  const count = values.dirty_count ?? "";
  if (count !== "" && (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)))) throw new Error("invalid_probe: invalid dirty_count");
  let disabledProviders: unknown[] = [];
  if (values.disabled_providers_json !== undefined) {
    try { disabledProviders = JSON.parse(values.disabled_providers_json); } catch { throw new Error("invalid_probe: invalid disabled_providers_json"); }
    if (!Array.isArray(disabledProviders)) throw new Error("invalid_probe: disabled_providers_json must be an array");
  }
  return {
    ompPath: values.omp_path, ompVersion: values.omp_version, bunVersion: values.bun_version,
    help: values.help, home: values.home, cwdReal: missing ? null : values.cwd_real,
    ...(missing ? { cwdError: "missing" as const } : {}), revision: values.revision ?? "", branch: values.branch ?? "",
    dirtyCount: count === "" ? null : Number(count), runDir: values.run_dir ?? "",
    runDirSource: values.run_dir_source === "agent_work" ? "agent_work" : "fallback",
    disabledProviders,
  };
}

export function supportedFlags(help: string): Set<string> {
  return new Set(help.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) ?? []);
}

export function buildLaunchScript({ ompPath, runDir, supervisorSource, supervisorConfig }: {
  ompPath: string; runDir: string; supervisorSource: string; supervisorConfig: unknown;
}): string {
  const source = Buffer.from(supervisorSource, "utf8").toString("base64");
  const config = JSON.stringify(supervisorConfig);
  if (config === undefined) throw new Error("invalid_supervisor_config");
  return `set -eu
umask 077
mkdir -p ${posixQuote(runDir)} ${posixQuote(`${runDir}/sessions`)}
decoder=/usr/bin/base64
[ -x "$decoder" ] || decoder=$(command -v base64) || exit 127
printf %s ${posixQuote(source)} | "$decoder" -d > ${posixQuote(`${runDir}/supervisor.mjs`)} 2>/dev/null || printf %s ${posixQuote(source)} | "$decoder" -D > ${posixQuote(`${runDir}/supervisor.mjs`)} || exit
exec env BUN_BE_BUN=1 ${posixQuote(ompPath)} ${posixQuote(`${runDir}/supervisor.mjs`)} ${posixQuote(Buffer.from(config, "utf8").toString("base64"))}
`;
}

export function buildCleanupCheckScript({ runId }: { runId: string }): string {
  checkRunId(runId);
  return `set -eu
run_id=${posixQuote(runId)}
processes=$(ps -axo pid=,pgid=,command=)
while read -r pid pgid command; do
  [ "$pid" = "$$" ] && continue
  case "$command" in
    *"$run_id"*) printf '%s %s %s\\n' "$pid" "$pgid" "$command" ;;
  esac
done <<EOF
$processes
EOF
`;
}

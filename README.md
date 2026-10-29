# omp-remote-subtask

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) plugin exposing `remote_task`: run a read-only investigation on another machine over SSH and return its final answer. Each call starts one supervised `omp --mode rpc --no-ui` session. This is not a replacement for interactive HAM sessions, a remote shell, a file synchronizer, or a security sandbox.

## Install

Only the caller needs this plugin. Each remote host needs a working `omp` executable with embedded Bun and the remote user's existing model authentication.

```sh
omp plugin link /absolute/path/to/omp-remote-subtask
# Or install from GitHub:
omp plugin install github:zerodice0/omp-remote-subtask
```

SSH aliases must already work non-interactively with the user's normal SSH configuration and known-hosts trust. The plugin never disables host-key checks or forwards agents, X11, or ports. It uses BatchMode, one connection attempt, a connection timeout, no PTY, and a private multiplexing socket when its path fits OS limits. Credentials remain on their respective hosts.

## Host configuration

Configuration is a user-owned JSON file at `~/.omp/agent/omp-remote-subtask.json`, or the path in `OMP_REMOTE_SUBTASK_CONFIG`. No documented structured plugin-settings API is available to this extension; the file is intentionally separate from omp's own configuration. Unknown keys, unsafe aliases, relative roots, and invalid limits are rejected.

```json
{
  "defaultTimeoutSeconds": 600,
  "maxTimeoutSeconds": 3600,
  "hosts": {
    "mac-studio": {
      "sshAlias": "mac-studio",
      "defaultModel": "openai-codex/gpt-6-luna:low",
      "allowedCwdRoots": ["/Users/geom-eungom/workspace"]
    }
  }
}
```

The tool registers even if configuration is missing or invalid, then returns a clear execution error. Its description lists hosts available when the extension loads. Host names are configuration keys; the model cannot supply raw SSH options or credentials. Remote cwd is resolved physically before checking optional allowed roots. These checks constrain requested cwd, not the files a remote process can access.

## Tool contract

```json
{
  "host": "mac-studio",
  "cwd": "/Users/geom-eungom/workspace/project",
  "task": "Read the implementation and explain why request cancellation can race. Do not modify files.",
  "model": "openai-codex/gpt-6-luna:low",
  "timeoutSeconds": 600
}
```

`host`, absolute `cwd`, and a nonempty self-contained `task` are required. Optional `model` overrides the host default; supported suffixes are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A suffix becomes `--thinking`. A positive timeout cannot exceed the configured maximum. The extension declares `approval: "exec"`; the calling omp approval policy governs execution.

Before launch the runner probes the remote omp version/help, embedded Bun, real cwd, Git revision/branch/dirty count, and working-storage location. Every requested CLI flag must exist remotely; incompatible versions fail with `unsupported_remote_omp` instead of silently weakening the profile. It negotiates RPC v2 when offered, reads `get_state` before sending exactly one prompt, and waits for both prompt completion and session settlement. It requests final session statistics best-effort, closes stdin, and bounds supervisor shutdown.

Results contain the remote assistant's final text (capped at 60,000 characters with a transcript pointer) and a status footer. `details` includes run ID, host/cwd, revision, status, actual model/usage, remote session/run paths, local log path, cancellation confirmation, inherited tools/prompt size/context tokens/model, remote omp version, protocol version, duration, and errors when applicable. Statistics and supervisor records are included when received. Progress is throttled to at most twice per second and 600 characters per update.

## Remote inheritance policy

The remote process explicitly uses:

- `--tools read,grep,glob` with **write/edit/bash/eval/ast_edit/task/browser denied** by overlay approval policy;
- `--no-extensions --no-skills --no-rules --no-prewalk --no-lsp --no-pty --no-title`;
- RPC/no-UI mode, the resolved cwd, a separate session directory, and a maximum runtime;
- an overlay disabling autolearn, memory backend, and asynchronous jobs;
- an appended instruction to investigate read-only and finish with a complete final answer.

Remote account/provider authentication, normal model defaults when no override is supplied, and other settings not overridden above remain inherited. **Context files are inherited from remote cwd ancestors and the remote home.** Studio omp 18.12.6 cannot disable them because its help lacks `--no-context-files`. A task is therefore not a blank-context session. Observed baseline context was approximately 24.8k tokens on Studio and 6.1k on MacBook; these are host observations, not guarantees.

`write` remains in `get_state.dumpTools` because omp's default `tools.xdev: true` uses it to invoke mounted `xd://` devices, including MCP tools. The overlay denies write so that device execution is not available to the remote model. Do **not** set `tools.xdev: false`: that re-exposes MCP tools at the top level. This policy is not an OS sandbox, and inherited instructions/settings can still affect behavior. The pre-prompt check fails with `unexpected_remote_tools` if the top-level tool list contains anything outside `read`, `grep`, `glob`, and `write`.

The earlier **141,730-token** investigation found that `--no-tools` removed built-ins but did not remove configured MCP schemas: 238 tool schemas, including 207 `mcp__rea*`, 25 Playwright, five Pencil, and autolearn's `manage_skill`, occupied 837,765 characters. Explicit tool selection, denying device execution, and disabling autolearn address that inherited schema exposure. `dumpTools` is only the top-level inventory; absence there does not mean an MCP server is disconnected.

## Status and cancellation

- **completed**: the prompt completed and the session settled. This says nothing about correctness of the answer.
- **failed**: a definitive remote error, rejected prompt, invalid/incompatible configuration, or failure before any prompt was sent.
- **aborted**: cancellation was requested **and** the supervisor's exit frame confirmed `groupGone: true`.
- **unknown**: the transport disappeared after the prompt was sent, or cancellation/process cleanup could not be confirmed. Inspect recorded run/session paths before deciding whether to start new work.

**A lost prompt is never resent automatically.** SSH reconnection is only used for a bounded post-cancellation process check, not recovery or retry. A clean post-check alone does not upgrade unknown to confirmed cancellation.

The supervisor spawns omp in its own process group and removes `BUN_BE_BUN` from that child's environment. Caller cancellation sends RPC `abort`, waits a grace period, then requests supervisor termination. The supervisor handles control termination, stdin EOF (including SSH drop), and its own deadline. It aborts/closes child input and escalates TERM to KILL for **only its owned process group**, checking for remaining descendants before reporting exit. Disconnects can prevent its confirmation reaching the caller even when cleanup succeeded. Default grace is ten seconds per stage; local timeout includes a small margin over the requested remote limit. An OS crash, uninterruptible process, or broken network can prevent confirmation.

## Logs and limits

Each run has a unique `rst-<UTC timestamp>-<random>` ID. Local logs use `agent_work.py path --name remote-subtask-<runId>` from the caller's cwd, falling back to `~/.cache/agent-work/omp-remote-subtask/runs/<runId>`. They contain `events.jsonl` (sent commands and received frames), `ssh-stderr.log` when stderr occurs, and `result.json`. Remote storage uses the same helper when available, otherwise a home-cache fallback; it contains the supervisor/overlay, session files, `omp.stderr.log`, and `supervisor.log`. Nothing is intentionally written under `/tmp` or `/private/tmp`.

Logs and sessions can contain the full task, source text, inherited system prompt, and model output. Keep them private and apply your normal agent-work retention policy. The plugin does not synchronize repositories or delete run evidence. Remote read-only access is not a filesystem sandbox. Host heavy-work/device rules still apply; this tool's profile intentionally excludes tools that would launch browsers or device work. There are no additional dependencies or runtimes to install.

## Development and manual smoke

```sh
BUN_BE_BUN=1 omp test
BUN_BE_BUN=1 omp run scripts/smoke.ts \
  --host mac-studio --cwd /absolute/remote/project \
  --task 'Read README.md and summarize it without changing files.' \
  --model openai-codex/gpt-6-luna:low
```

The smoke prints `details` JSON to stdout and answer/progress to stderr. Optional `--timeout <seconds>`, `--cancel-after <seconds>` or `--drop-after <seconds>` exercise runtime limits, AbortSignal cancellation, or local SSH-process death respectively. Cancel/drop timers start at transport launch. Run those paid real-host checks deliberately; tests use a local fake omp and never contact SSH hosts or model providers.

## Not verified yet

Real-remote model smoke results are intentionally not claimed here. The main session will record host/model, completion, cancellation and transport-drop evidence after running those checks. In particular, real-provider read-only approval enforcement, actual context costs, cross-version remote operation, and network-loss cleanup confirmation remain to be verified with paid real-remote runs. The local fixture tests are not proof of those behaviors.

## License

MIT

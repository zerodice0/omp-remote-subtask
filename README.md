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

Remote account/provider authentication, normal model defaults when no override is supplied, and other settings not overridden above remain inherited. **Context files are inherited from remote cwd ancestors and the remote home.** Studio omp 18.12.6 cannot disable them because its help lacks `--no-context-files`. A task is therefore not a blank-context session. Observed context before the prompt (`get_state.contextUsage`) was 14,936 tokens on Studio (64,229-char system prompt) and 3,668 tokens on MacBook (11,115 chars); these are host observations, not guarantees.

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

## Verified on real hosts

Caller winmini (omp 18.13.3) → Studio (omp 18.12.6) and MacBook (omp 18.13.0), model `openai-codex/gpt-6-luna:low`, 2026-10-29:

| Host | Scenario | Status | Duration | Input / cache read / output tokens | Cost (USD) |
|---|---|---|---|---|---|
| Studio | read-only answer | completed | 6.9 s | 19,777 / 26,112 / 69 | 0.0023 |
| Studio | cancel after 12 s | aborted, `cancellationConfirmed` | 12.5 s | 27,042 / 81,152 / 193 | 0.0036 |
| Studio | SSH client killed after 10 s | unknown, one prompt sent | 10.4 s | 19,328 / 11,008 / 75 | 0.0021 |
| Studio | write attempt | completed; write blocked by policy, no file | 9.4 s | 15,451 / 15,104 / 83 | 0.0017 |
| MacBook | read-only answer | completed | 8.6 s | 8,635 / 3,584 / 67 | 0.0009 |
| MacBook | cancel after 12 s | aborted, `cancellationConfirmed` | 14.0 s | 6,941 / 7,296 / 579 | 0.0011 |
| MacBook | SSH client killed after 6 s | unknown, one prompt sent | 8.7 s | 950 / 2,816 / 37 | 0.0001 |
| MacBook | write attempt | completed; write blocked by policy, no file | 6.0 s | 4,069 / 3,584 / 85 | 0.0005 |

After every cancel and drop, `ps` on the remote host showed no process carrying the run ID, and `supervisor.log` recorded `groupGone: true` (reason `terminate` for cancel, `stdin_eof` within about one second for drop). The first Studio cancel attempt exposed a macOS behaviour: `kill(-pgid, 0)` returns `EPERM` for a group that holds only zombies; the supervisor now settles that case with `ps`.

After `omp plugin link .` on winmini with `~/.omp/agent/omp-remote-subtask.json`, a fresh `omp -p` session called `remote_task` against MacBook and printed the remote answer (completed in about 12 s end to end).

## Not verified yet

- Runs that reach the `--max-time`/supervisor deadline, and SIGKILL escalation against a child that ignores TERM, on real hosts (covered only by the local fake-omp tests).
- Network loss where the remote sshd does not notice the drop (e.g. a sleeping laptop or a cut link rather than a killed client): the supervisor relies on stdin EOF, so cleanup then waits for TCP keepalive or the run deadline.
- Remote hosts other than the two above, Linux remote hosts, and omp versions other than 18.12.6 / 18.13.0.
- Interactive TUI use (approval prompt, progress rendering, Esc cancellation); only `omp -p` and the smoke script were exercised.
- Retention: run directories under the home-cache fallback (`~/.cache/agent-work/omp-remote-subtask/runs`, used on MacBook and locally when the caller cwd is not a checkout) are not managed by `agent_work.py gc`.

## License

MIT

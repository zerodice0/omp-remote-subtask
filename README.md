# omp-remote-subtask

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) plugin exposing `remote_task`: investigate another machine over SSH, or explicitly opt in to remote edits and commands, and return the final answer. Read-only mode remains the default. Each call starts one supervised `omp --mode rpc --no-ui` session. This is not a replacement for interactive HAM sessions, a general remote shell, a file synchronizer, or a security sandbox.

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
  "roleTimeoutSeconds": {
    "tiny": 120,
    "smol": 300,
    "explore": 900,
    "slow": 1800
  },
  "maxTimeoutSeconds": 3600,
  "hosts": {
    "mac-studio": {
      "sshAlias": "mac-studio",
      "defaultRole": "explore",
      "allowedCwdRoots": ["/Users/geom-eungom/workspace"],
      "allowExec": false
    }
  }
}
```

The tool registers even if configuration is missing or invalid, then returns a clear execution error. Its description lists hosts available when the extension loads. Host names are configuration keys; the model cannot supply raw SSH options or credentials. Remote cwd is resolved physically before checking optional allowed roots. These checks constrain requested cwd, not the files a remote process can access.

`defaultRole` is optional and must be one of `tiny`, `smol`, `explore`, or `slow`. A tool call's explicit role takes precedence over the host default; without either, the role is `explore`.

`allowExec` is a per-host boolean, defaulting to `false`. Set it to `true` only on a trusted host where remote commands and edits are intended. This does not change the default call mode: each execution call must also explicitly request `"mode": "exec"`. A request for exec on a host without `allowExec: true` is rejected before remote work starts. Omitted mode or `"mode": "read"` keeps the existing read-only profile, even on an exec-enabled host.

`roleTimeoutSeconds` is optional; its only allowed keys are the four roles, and omitted entries retain the built-in defaults shown above. Each timeout must be a positive number no greater than `maxTimeoutSeconds` (default 3600 seconds), including entries inherited from the built-in defaults. Resolve the role first (explicit tool-call role, host `defaultRole`, then `explore`); an explicit tool-call `timeoutSeconds` overrides that role's configured timeout. Omit `timeoutSeconds` unless the task needs a different bound.

## Tool contract

```json
{
  "host": "mac-studio",
  "cwd": "/Users/geom-eungom/workspace/project",
  "task": "Read the implementation and explain why request cancellation can race. Do not modify files.",
  "mode": "read",
  "role": "explore",
  "timeoutSeconds": 600
}
```

`host`, absolute `cwd`, and a nonempty self-contained `task` are required. Optional `role` selects the workload, not a provider or model. Each remote host maps roles to its own configured model and thinking effort through its `modelRoles` settings; mappings may differ per host. The runner passes `--model @role`, letting that host resolve both model and effort. Optional `timeoutSeconds` defaults to the resolved role's timeout; any explicit positive value must not exceed the configured maximum. The extension declares `approval: "exec"`; the calling omp approval policy governs execution.

`mode` accepts only `read` (the default) or `exec`; role and mode are independent. To permit exec, the user-owned host configuration must contain `"allowExec": true`, and the individual call must opt in:

```json
{
  "host": "mac-studio",
  "cwd": "/Users/geom-eungom/workspace/project",
  "task": "In src/parser.ts, fix the named trailing-comma bug using edit. Run the existing focused parser test through bash. Do not change other files or start background services. Return the patch summary, exact commands and results, and remote output paths.",
  "mode": "exec",
  "role": "explore",
  "timeoutSeconds": 900
}
```

Use a self-contained task with explicit file scope, required checks, and output expectations. Neither the caller's conversation nor its local files or tool results are sent automatically. Execution happens against the remote checkout as it exists; local and remote revisions can differ.

| Role | Choose for |
|---|---|
| `tiny` | A single-fact lookup: a version string, or whether a file or setting exists. |
| `smol` | A small, well-scoped read of one or two named files with a short summary. |
| `explore` (default) | A multi-file investigation, tracing a code path, or comparing configurations. |
| `slow` | Hard root-cause analysis or design judgment where a wrong answer is costly; slowest and most expensive. |

The selected role must resolve on the remote host. omp's own role fallbacks apply: Studio has no `slow` entry in `modelRoles`, yet `@slow` resolved to `anthropic/claude-opus-5-5` with `xhigh`. A role that does not resolve at all fails before the prompt is sent, with no model cost; the result includes the remote startup error, such as `Model "@<role>" not found`.

Before launch the runner probes the remote omp version/help, embedded Bun, real cwd, Git revision/branch/dirty count, and working-storage location. Every requested CLI flag must exist remotely; incompatible versions fail with `unsupported_remote_omp` instead of silently weakening the profile. It negotiates RPC v2 when offered, reads `get_state` before sending exactly one prompt, and waits for both prompt completion and session settlement. It requests final session statistics best-effort, closes stdin, and bounds supervisor shutdown.

Results contain the remote assistant's final text (capped at 60,000 characters with a transcript pointer) and a status footer. `details` includes run ID, host/cwd, `mode`, revision, status, resolved `role`, `actualModel`, `thinkingLevel` (reported by remote `get_state`, or null), cumulative usage, remote session/run paths, local log path, cancellation confirmation, inherited tools/prompt size/context tokens/model, remote omp version, protocol version, duration, and errors when applicable. Statistics and supervisor records are included when received. `toolCalls` retains the last 50 calls in start order, with short arguments, running/done/error status and duration; `totalToolCalls` counts every call.

### Live progress and result views

The interactive TUI shows the host, role and a short task preview on the call. Live updates show the resolved remote model and thinking effort as soon as startup reports them, phase, elapsed time, tool count, cumulative input/output/cache-read tokens and reported cost. The last six tool calls have status glyphs and durations, followed by up to three lines of the assistant's text tail. Updates are throttled to at most twice per second, including quiet periods; structured `details.progress` carries the same bounded tool list and usage. Only assistant `message_end` frames contribute usage, not repeated `turn_end` records or in-flight estimates.

The collapsed final result shows status, model/effort, duration, total tool count, cost and the first answer lines. Expanding reveals the full returned answer, all retained tool summaries, the remote session path and local log directory. Lines are measured in terminal cells, including CJK/emoji; long answer/path lines wrap in the expanded view. Theme colors are optional. Plain-text progress (a header, last four tool calls and text tail) remains available to non-TUI frontends and the smoke script; `omp -p` receives the ordinary final answer and footer.

This is an extension tool card, not a registered built-in subagent: it creates **no entry in `agent://`, `history://` or `proc://`**, because no documented extension API registers an external agent in those registries. The authoritative remote session transcript stays on the remote host. Local `events.jsonl` mirrors sent commands and received RPC frames, including text deltas and tool events, for replay and diagnosis.

## Remote inheritance policy

The read-mode process keeps the existing profile:

- `--tools read,grep,glob` with **write/edit/bash/eval/ast_edit/task/browser denied** by overlay approval policy;
- `--no-extensions --no-skills --no-rules --no-prewalk --no-lsp --no-pty --no-title`;
- RPC/no-UI mode, the resolved cwd, a separate session directory, and a maximum runtime;
- an overlay disabling autolearn, memory backend, and asynchronous jobs;
- an appended instruction to investigate read-only and finish with a complete final answer.

Exec mode selects the restricted `--tools read,grep,glob,bash,edit` list. Its overlay disables autolearn, memory backend, and asynchronous jobs, sets **`tools.approvalMode: yolo`** and **`tools.xdev: false`**, explicitly allows `read`, `grep`, `glob`, `bash`, and `edit`, and denies the other tools listed below. Disabling xdev suppresses implicit `write` and device mounting; a pre-prompt inventory check rejects any tools outside the exact exec allowlist. The remote session therefore does not stop for individual tool approvals; the outer `remote_task` call still follows the caller's execution-approval policy. The other isolation/startup flags above remain in effect.

| Exec tool policy | Reason |
|---|---|
| Allow `read`, `grep`, `glob`, `bash`, `edit` only | File investigation, scoped edits, and explicitly requested commands/checks. |
| Deny `write` | It can dispatch mounted `xd://` devices; safe separation of file writes from device execution has not been proven. Use `edit` for file changes. |
| Deny `task` | No nested delegation: avoid uncontrolled provider cost and host load. |
| Deny `browser` | Heavy GPU/browser work is not needed for this execution profile. |
| Deny `eval` | It would bypass the intended bash command patterns and guidance. |
| Deny `ast_edit`, `computer`, `generate_image`, `web_search`, and all MCP tools | Outside the narrow execution contract; restricted tool selection and disabled xdev prevent exposing them as approved exec tools. |

**These are an instruction and tool-policy contract, not an OS security boundary.** In particular, `bash` runs as the remote user with that user's filesystem and network access. It can reach outside cwd or run programs with effects equivalent to denied tools. Allowed cwd roots validate the requested working directory, not every file or command. Instructions about scope, command patterns, no delegation/browser/device work, no persistent services, and working-storage locations guide the remote model; they do not sandbox shell execution or make an untrusted task safe. Use exec only with trusted tasks, repositories, hosts, and inherited context.

The appended exec instructions confine work to cwd and `<remoteRunDir>/work`; forbid Git commit/push/checkout/branch/reset/stash, package installation, global configuration changes, persistent servers/daemons, and killing processes the task did not start; and require absolute output paths in the final answer. When the remote heavy-slot helper is present, the instructions require heavy commands to use `~/.config/herdr/scripts/heavy_slot.py run --label "remote_task <runId>" -- <command>`. These restrictions are instructions to the model, not shell-command enforcement or a replacement for host rules.

Remote account/provider authentication and model/effort settings remain inherited except for the overrides described here. Roles resolve against the remote host, not the caller. **Neither mode is a blank-context session.** Read mode retains its existing context inheritance from cwd ancestors and the remote home. Historical read observations before the prompt (`get_state.contextUsage`) were 14,936 tokens on Studio (64,229-char system prompt) and 3,668 tokens on MacBook (11,115 chars); these are host observations, not guarantees.

Exec must also suppress MCP-bearing resource providers: it preserves the host's effective `disabledProviders` and adds `native`, `omp-plugins`, `claude`, `agent-plugins`, `claude-plugins`, `codex`, `gemini`, `opencode`, `cursor`, `windsurf`, `vscode`, and `mcp-json`. Older supported omp versions have no universal MCP-only disable switch. This deliberately has broader context consequences:

- Disabled native resources include `~/.omp/agent/AGENTS.md`, project `.omp/AGENTS.md`, and `SYSTEM.md`/`SYSTEM_TEMPLATE.md`.
- Disabled Claude resources include `~/.claude/CLAUDE.md` and `.claude/CLAUDE.md`; Codex resources include `~/.codex/AGENTS.md`; Gemini resources include `~/.gemini/GEMINI.md` and `.gemini/GEMINI.md`; OpenCode resources include `~/.config/opencode/AGENTS.md`.
- Custom system prompts supplied through disabled providers are suppressed too. Root/ancestor repository `AGENTS.md` remains available through the separate `agents-md` provider. The overlay does not disable `agents-md`, `claude-md`, `agents`, `github`, or `custom-context-files`; those and any other enabled providers can still contribute context.
- `cursor` and `opencode` are also actual model-provider IDs, so disabling them can affect availability of those providers, not just MCP/context resources. The observed `openai-codex` role resolution is unaffected. Do not assume every host/model combination works without checking its startup result.

In read mode, `write` can remain in `get_state.dumpTools` because omp's default `tools.xdev: true` uses it to invoke mounted `xd://` devices, including MCP tools. The existing read overlay denies write and leaves xdev unchanged. Exec instead combines its restricted `--tools` selection with `tools.xdev: false`, suppressing implicit `write`/device mounting while still denying `write` in its approval policy. The pre-prompt inventory check permits only `read`, `grep`, `glob`, and the denied `write` entry in read mode; exec permits only `read`, `grep`, `glob`, `bash`, and `edit`. Unexpected top-level tools fail startup with `unexpected_remote_tools`.

The earlier **141,730-token** investigation found that `--no-tools` removed built-ins but did not remove configured MCP schemas: 238 tool schemas, including 207 `mcp__rea*`, 25 Playwright, five Pencil, and autolearn's `manage_skill`, occupied 837,765 characters. Restricted `--tools` selection alone did not prevent mounted MCP device documentation on Studio 18.12.6 in read mode. The read profile denies device execution and disables autolearn; exec additionally disables the MCP-bearing providers above, disables xdev, and requires the exact five-tool inventory. The overlay does not rely on a separate MCP-only enable/disable flag. `dumpTools` is a top-level inventory, not proof that every possible MCP connection is disconnected, and bash is not constrained by that inventory.

## Status and cancellation

- **completed**: the prompt completed and the session settled. This says nothing about correctness of the answer.
- **failed**: a definitive remote error, rejected prompt, invalid/incompatible configuration, or failure before any prompt was sent.
- **aborted**: cancellation was requested **and** the supervisor's exit frame confirmed `groupGone: true`.
- **unknown**: the transport disappeared after the prompt was sent, or cancellation/process cleanup could not be confirmed. Inspect recorded run/session paths before deciding whether to start new work.

**A lost prompt is never resent automatically.** SSH reconnection is only used for a bounded post-cancellation process check, not recovery or retry. A clean post-check alone does not upgrade unknown to confirmed cancellation.

The supervisor spawns omp in its own process group and removes `BUN_BE_BUN` from that child's environment. Caller cancellation sends RPC `abort`, waits a grace period, then requests supervisor termination. The supervisor handles control termination, stdin EOF (including SSH drop), and its own deadline. It aborts/closes child input and escalates TERM to KILL for **only its owned processes**, including tracked descendants that escape the original process group, before reporting exit. Normal settlement also cleans up owned background descendants; a final answer is not permission to leave a service running. Cleanup does not target unrelated sessions or processes. Disconnects can prevent its confirmation reaching the caller even when cleanup succeeded. Default grace is ten seconds per stage; local timeout includes a small margin over the requested remote limit. This process tracking is not a sandbox or a guarantee against hostile daemonization. An OS crash, uninterruptible process, or broken network can prevent confirmation.

## Logs and limits

Each run has a unique `rst-<UTC timestamp>-<random>` ID. Local logs use `agent_work.py path --name remote-subtask-<runId>` from the caller's cwd, falling back to `~/.cache/agent-work/omp-remote-subtask/runs/<runId>`. They contain `events.jsonl` (sent commands and received frames), `ssh-stderr.log` when stderr occurs, and `result.json`. Remote storage uses the same named helper when available, otherwise a home-cache fallback; it contains the supervisor/overlay, session files, `omp.stderr.log`, and `supervisor.log`.

The requested `cwd`, returned `remoteRunDir`, remote session, edited checkout, and command/build outputs are **on the remote host**. They are not synchronized back to the caller. The local transcript records text and events, not an automatic copy of remote files. Ask the task to report exact output paths and collect any wanted patch or artifacts separately.

The supervisor creates `<remoteRunDir>/tmp` and exports it as `TMPDIR` for **both read and exec modes**; read tools and overlay remain unchanged. Only exec creates `<remoteRunDir>/work`. Exec instructions place scratch files, captures, logs, and build outputs there, allowing outputs in cwd only when the task asks, and use `mktemp -d -p <remoteRunDir>/work`; do not use `/tmp` or `/private/tmp`. These locations and instructions are not a rewrite of every shell command or third-party program's temporary-file behavior.

Named helper directories are `remote-subtask-<runId>` and normally become eligible for `agent_work.py gc` after **14 days since their last `path --name` use**, when not in use; each helper `path` call refreshes that lifetime. Retain needed evidence before expiry or pin the named directory with the helper. The plugin does not delete run evidence. Home-cache fallback directories are not managed by that named-directory GC and need explicit retention management.

Logs and sessions can contain the full task, source text, inherited system prompt, and model output. Keep them private and apply your normal agent-work retention policy. Both profiles are instruction/tool policies, not filesystem sandboxes. Host heavy-work/device rules still apply; exec guidance does not replace a host's slot or device-claim requirements. There are no additional dependencies or runtimes to install.

## Development and manual smoke

```sh
BUN_BE_BUN=1 omp test
BUN_BE_BUN=1 omp run scripts/smoke.ts \
  --host mac-studio --cwd /absolute/remote/project \
  --task 'Read README.md and summarize it without changing files.' \
  --role tiny
```

The smoke prints `details` JSON to stdout and answer/progress to stderr. Optional `--mode read|exec` selects the profile; exec still requires the host's `allowExec` opt-in. Optional `--timeout <seconds>`, `--cancel-after <seconds>` or `--drop-after <seconds>` exercise runtime limits, AbortSignal cancellation, or local SSH-process death respectively. Cancel/drop timers start at transport launch; `--cancel-on-bash <seconds>` instead starts cancellation timing when a bash tool begins, for cleanup checks. Choose at most one cancel/drop option. Run those paid real-host checks deliberately; tests use a local fake omp and never contact SSH hosts or model providers.

Final local check on 2026-10-29: `BUN_BE_BUN=1 omp test` ran once after integration: **144 passed, 0 failed**, 3,318 assertions across eight files (16.23 s).

## Verified on real hosts

### Exec opt-in, commands, and cleanup

2026-10-29 real-host smokes used role `tiny`, resolving to `openai-codex/gpt-6-luna` with low effort on both Studio (omp 18.12.6) and desktop (Linux, omp 18.13.3):

| Host | Scenario | Observed result | Duration |
|---|---|---|---|
| Studio | Exec create/read/delete a file under remote run `work/`; run `node -v` | `completed`; file round trip succeeded; Node v26.12.1 | 6.887 s |
| Desktop | Same exec file/Node task | `completed`; file round trip succeeded; Node v26.12.1 | 8.936 s |
| Studio | Read-mode request to execute `node -v`, rerun after shared TMPDIR fix | Refused to execute; no bash available | 11.067 s |
| Desktop | Same read-mode rerun | Refused to execute; no bash available | 3.635 s |
| Studio | Exec requested without host opt-in | `failed`, `exec_not_allowed`, before SSH/model work; no event log | 0.068 s |
| Desktop | Same opt-out rejection | `failed`, `exec_not_allowed`, before SSH/model work; no event log | 0.070 s |
| Studio | Cancel while external `/bin/sleep 600` is live | Cancellation confirmed; observed PID/PGID 7827 disappeared | 12.432 s |
| Desktop | Same live external-process cancellation | Cancellation confirmed; observed PID/PGID 11663 disappeared | 12.265 s |

Both exec sessions reported exactly `read`, `grep`, `glob`, `bash`, and `edit`. Normal completion and cancellation reported `groupGone`, `descendantsGone`, and `escapedGone` all true on both hosts. The cancellation children were observed live in their own process groups before cancellation; TERM was sufficient, so these runs do not prove SIGKILL escalation. An external `/bin/sleep` was used because a shell's bare `sleep` can be a built-in without an OS child process.

An initial Studio exec startup failed closed with `unexpected_remote_tools`: restricted `--tools` plus disabled xdev alone exposed inherited tools. That finding required the additional `disabledProviders` isolation documented above before the successful exec runs.

The normal exec evidence runs were `rst-20261029124738-294ba0` on Studio and `rst-20261029124752-e6f1c7` on desktop. The complete file paths created, read, and deleted were:

- Studio: `/Users/geom-eungom/.cache/agent-work/couple-calendar-e7b346a37d/remote-subtask-rst-20261029124738-294ba0/work/smoke-node-20261029-97638-1793278063541421000.txt`
- Desktop: `/home/zerodice0/.cache/agent-work/noctalia-liquid-glass-b40377e617/remote-subtask-rst-20261029124752-e6f1c7/work/smoke-node.bEBbRm.txt`

These files stayed remote, not copied to the caller. The final read reruns were `rst-20261029125018-3e0e63` on Studio and `rst-20261029125029-4d7eb9` on desktop. The final temporary-file audit found no run-attributable files remaining under `/tmp`; three blob-tunnel logs from the initial desktop read were moved into that read run's `tmp/` to preserve evidence. Unrelated Waydroid files and another session's omp log were left untouched. These observations cover bash/file handling, cancellation, and run-attributable temporary files, not every denied-tool route, edit behavior, or hostile daemon escape.

### Historical read-mode and delegation checks

The following observations used the read-only profile before exec mode was added; they are not evidence that exec tools or escaped-descendant cleanup worked on those hosts.

Caller winmini (omp 18.13.3) → Studio (omp 18.12.6) and MacBook (omp 18.13.0), model `openai-codex/gpt-6-luna` with low effort, 2026-10-29:

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

Role resolution, observed through RPC `get_state` with `--model @<role>` (no prompt sent):

| Role | Studio (18.12.6) | MacBook (18.13.0) |
|---|---|---|
| `tiny` | `openai-codex/gpt-6-luna`, low | `anthropic/claude-haiku-4-5`, minimal |
| `smol` | `openai-codex/gpt-6.1-terra`, low | `anthropic/claude-sonnet-5-5`, medium |
| `explore` | `openai-codex/gpt-6.1-sol`, medium | `anthropic/claude-sonnet-5-5`, medium |
| `slow` | `anthropic/claude-opus-5-5`, xhigh | `anthropic/claude-opus-5-5`, high |

Real role runs: MacBook `tiny` completed with haiku-4-5/minimal in 4.4 s (cost $0.0133), Studio `tiny` completed with gpt-6-luna/low in 5.0 s ($0.0021), and Studio without a role used `explore` and completed with gpt-6.1-sol/medium in 6.5 s ($0.0410).

Four-role delegation review (2026-10-29): fresh `omp -p` caller sessions on winmini (`openai-codex/gpt-6.1-sol`, medium) each called the linked `remote_task` once against Studio `couple-calendar`, with an answer-format requirement and an unrelated internal note in the caller prompt.

| Role | Remote model | Remote duration | Remote tool calls | Input / cache read / output tokens | Cost (USD) |
|---|---|---|---|---|---|
| `tiny` | gpt-6-luna, low | 3.9 s | 1 | 20,310 / 11,008 / 61 | 0.0022 |
| `smol` | gpt-6.1-terra, low | 6.8 s | 2 | 19,953 / 11,008 / 267 | 0 (as reported by omp) |
| `explore` | gpt-6.1-sol, medium | 106.5 s | 14 | 36,089 / 144,000 / 4,075 | 0.1273 |
| `slow` | claude-opus-5-5, xhigh | 325.2 s | 63 | 78 / 2,696,783 / 28,757 | 2.0367 |

All four completed and returned the remote answer to the caller. Every caller restated the format requirement inside `task` and none forwarded the unrelated note; each remote session held exactly one user message, equal to `task`. The remote system prompt included the repository's own `AGENTS.md`. Caller conversation, files and earlier tool results are not transferred: `task` is the only caller context. The `slow` run took 325.2 seconds, exceeding the example configuration's former 300-second global timeout, and finished because the caller set 600 seconds; role defaults now give `slow` 1800 seconds. The `tiny` answer gave the right version but cited `pubspec.yaml:15` instead of line 19.

Interactive TUI progress/result smoke (2026-10-29): a fresh PTY caller on winmini (`openai-codex/gpt-6-luna`, low) invoked `remote_task` once on Studio `couple-calendar`, role `smol`, asking for three rules from `AGENTS.md` and `CLAUDE.md`. The live card displayed `running`, `openai-codex/gpt-6.1-terra · low`, elapsed time, tokens/cost, and `✓ read CLAUDE.md`. The final card displayed `completed`, 15.8 seconds, one tool call, 19.4k input / 115 output / 11.0k cache-read tokens, cost $0 as reported remotely, and three answer lines. Ctrl+O expansion displayed the retained tool list and remote session/local log paths. No approval prompt appeared under the caller's existing policy. The caller was closed after capture; ANSI-stripped partial/final/expanded excerpts and the raw PTY stream were retained in agent-work.

## Not verified yet

- Runs that reach the `--max-time`/supervisor deadline, and SIGKILL escalation against a child that ignores TERM, on real hosts (covered only by the local fake-omp tests).
- Network loss where the remote sshd does not notice the drop (e.g. a sleeping laptop or a cut link rather than a killed client): the supervisor relies on stdin EOF, so cleanup then waits for TCP keepalive or the run deadline.
- Remote hosts other than Studio, MacBook, and the Linux desktop above, and omp versions other than 18.12.6 / 18.13.0 / 18.13.3.
- Interactive Esc cancellation and a caller policy that displays an execution-approval dialog; the successful PTY smoke used the existing approval policy without a dialog.
- Retention: run directories under the home-cache fallback (`~/.cache/agent-work/omp-remote-subtask/runs`, used on MacBook and locally when the caller cwd is not a checkout) are not managed by `agent_work.py gc`.

## License

MIT

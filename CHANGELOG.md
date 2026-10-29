# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Remote workload roles `tiny`, `smol`, `explore`, and `slow`, resolved through each remote host's own model/effort settings, with optional per-host `defaultRole`.
- Per-role `roleTimeoutSeconds` defaults and explicit per-call timeout overrides, bounded by `maxTimeoutSeconds`.
- Interactive TUI progress and expandable results showing remote model/effort, phase, elapsed time, bounded tool history, tokens/cost, answer text, and remote session/local log paths.
- Opt-in execution mode: hosts must enable `allowExec` (default `false`), and each execution call must request `mode: "exec"`; omitted mode remains `read`.
- A narrow exec profile allowing only `read`, `grep`, `glob`, `bash`, and `edit`, with explicit approval allows under `tools.approvalMode: yolo`. Restricted tool selection and `tools.xdev: false` suppress implicit write/device mounting, and a pre-prompt inventory guard rejects unexpected tools; `write`, delegation, browser, eval, MCP, and other out-of-contract tools remain denied.

### Changed

- Supervisor cleanup covers owned processes and tracked descendants that escape the original process group, including background descendants after normal settlement, without targeting unrelated sessions.
- Removed heavy-slot probing and helper instructions; exec now runs heavy commands directly and requires immediate cleanup of task-started processes after each step, including failures, plus a final leftover-process check. Supervisor descendant cleanup remains the enforcement backstop.
- Both modes now create and export a run-local `tmp/` as `TMPDIR`; exec also creates `work/` for task outputs. Read-mode tools and overlay remain unchanged.
- Exec preserves existing disabled resource providers and disables additional MCP-bearing providers. This also suppresses those providers' context files and custom system prompts, while leaving root/ancestor repository `AGENTS.md` available through `agents-md`; read-mode inheritance is unchanged. Disabling `cursor`/`opencode` can also affect models using those provider IDs.
- Documented remote-only checkout/output paths, named agent-work retention and lifetime refresh, and the instruction-contract limits of exec mode: shell commands retain the remote user's filesystem and network access and are not sandboxed.

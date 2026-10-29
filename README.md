# omp-remote-subtask

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) plugin that runs a subtask on another machine over SSH and returns its final answer as a tool result.

The plugin registers a `remote_task` tool. The tool starts a headless `omp --mode rpc --no-ui` session on a configured SSH host, waits for it to settle, streams progress, supports cancellation, and returns the remote session's final answer together with run metadata.

Status: under development. The first scope is read-only tasks on configured hosts.

## License

MIT

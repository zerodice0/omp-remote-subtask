import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveHost, type HostsConfig } from './config.ts';
import { controlPath, remoteShellCommand, sshArgv } from './ssh.ts';
import { buildProbeScript, parseProbe, supportedFlags, buildLaunchScript, buildCleanupCheckScript } from './remote-scripts.ts';
import { LineSplitter, RpcFrameDecoder, negotiate } from './rpc-frames.ts';
import { createRunState, reduceRunState, decide, type RunEvent, type RunState, type RunStatus } from './run-state.ts';

export interface RemoteTaskParams { host: string; cwd: string; task: string; model?: string; timeoutSeconds?: number }
export interface TransportRequest {
  kind: 'probe' | 'launch' | 'cleanup'; argv: string[]; script: string;
  supervisorConfig?: SupervisorConfig;
}
export interface SupervisorConfig {
  runId: string; ompPath: string; ompArgs: string[]; cwd: string; runDir: string;
  deadlineSeconds: number; graceSeconds: number; overlayYaml: string;
}
export interface RunnerOptions {
  signal?: AbortSignal; onUpdate?: (text: string) => void; cwd?: string; config?: HostsConfig;
  transport?: (request: TransportRequest) => ChildProcess;
  onTransportSpawn?: (child: ChildProcess) => void;
  graceSeconds?: number;
}
export interface RemoteTaskDetails {
  runId: string; host: string; cwd: string; status: RunStatus;
  revision: { commit: string; branch: string; dirtyCount: number | null } | null;
  actualModel: string | null; usage: RunState['usage'] | null;
  remoteSessionPath: string | null; remoteRunDir: string | null; localLogDir: string;
  cancellationConfirmed: boolean; remoteOmpVersion: string | null; protocolVersion: number | null; durationMs: number;
  inheritance: { tools: string[]; systemPromptChars: number | null; contextTokensBeforePrompt: number | null; model: unknown; contextFilesNote: string } | null;
  supervisor?: RunState['supervisor']; stats?: unknown; postCheck?: { output?: string; error?: string };
  error?: { code: string; message: string };
  notStarted?: true;
}
export const READ_ONLY_NOTE = 'You are running as a remote read-only subtask launched by another omp session through remote_task. Do not modify files. Investigate with read/grep/glob and finish with a final answer that fully states the result.';
export const OVERLAY_YAML = 'autolearn:\n  enabled: false\nmemory:\n  backend: off\nasync:\n  enabled: false\ntools:\n  approval:\n    write: deny\n    edit: deny\n    bash: deny\n    eval: deny\n    ast_edit: deny\n    task: deny\n    browser: deny\n';
const CONTEXT_NOTE = 'Context files are inherited from the remote cwd ancestry and home; this profile cannot disable them on omp 18.12.6.';
const SUPERVISOR_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs'), 'utf8');
const ALLOWED_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, write: true };
const defaultTransport = ({ argv }: TransportRequest) => spawn(argv[0], argv.slice(1), { stdio: 'pipe' });

async function capture(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let stdout = ''; let stderr = ''; let finished = false;
  const finish = (error?: Error) => {
    if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (error) { child.kill('SIGKILL'); reject(error); } else resolve(stdout);
  };
  const abort = () => finish(new Error('aborted_before_launch'));
  const timer = setTimeout(() => finish(new Error('transport_timeout')), timeoutMs);
  child.stdout?.on('data', chunk => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) finish(new Error('probe_too_large')); });
  child.stderr?.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString(); });
  child.on('error', error => finish(error));
  child.on('close', code => finish(code === 0 ? undefined : new Error(`transport_failed (${code}): ${stderr}`)));
  child.stdin?.end();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return promise;
}
async function localLogDirectory(cwd: string, runId: string) {
  const helper = join(homedir(), '.config/herdr/scripts/agent_work.py');
  let path: string;
  try { path = (await capture(spawn(helper, ['path', '--name', `remote-subtask-${runId}`], { cwd, stdio: 'pipe' }), 10000)).trim(); if (!isAbsolute(path)) throw new Error('invalid_agent_work_path'); }
  catch { path = join(homedir(), '.cache/agent-work/omp-remote-subtask/runs', runId); }
  mkdirSync(path, { recursive: true, mode: 0o700 }); return path;
}
function inside(path: string, root: string) { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)); }
function modelArgs(model?: string) {
  if (!model) return [];
  if (!/^[A-Za-z0-9._/@-]+(:[a-z]+)?$/.test(model)) throw new Error('invalid_model');
  const [name, thinking] = model.split(':');
  if (thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('invalid_thinking_level');
  return ['--model', name, ...(thinking ? ['--thinking', thinking] : [])];
}
function parseRemoteState(value: unknown) {
  if (!value || typeof value !== 'object' || !('dumpTools' in value) || !Array.isArray(value.dumpTools)) throw new Error('invalid_remote_state');
  const tools: string[] = [];
  for (const tool of value.dumpTools) {
    if (!tool || typeof tool !== 'object' || !('name' in tool) || typeof tool.name !== 'string') throw new Error('invalid_remote_state');
    tools.push(tool.name);
  }
  const systemPrompt = 'systemPrompt' in value ? value.systemPrompt : null;
  if (Array.isArray(systemPrompt) && !systemPrompt.every(part => typeof part === 'string')) throw new Error('invalid_remote_state');
  const context = 'contextUsage' in value ? value.contextUsage : null;
  const contextTokens = context && typeof context === 'object' && 'tokens' in context && typeof context.tokens === 'number' ? context.tokens : null;
  return {
    inheritance: { tools, systemPromptChars: Array.isArray(systemPrompt) ? systemPrompt.join('\n').length : typeof systemPrompt === 'string' ? systemPrompt.length : null, contextTokensBeforePrompt: contextTokens, model: 'model' in value ? value.model : null, contextFilesNote: CONTEXT_NOTE },
    remoteSessionPath: 'sessionFile' in value && typeof value.sessionFile === 'string' ? value.sessionFile : null,
  };
}

export async function runRemoteTask(params: RemoteTaskParams, options: RunnerOptions = {}) {
  const startedAt = Date.now();
  const runId = `rst-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const localLogDir = await localLogDirectory(options.cwd ?? process.cwd(), runId);
  const details: RemoteTaskDetails = { runId, host: params.host, cwd: params.cwd, revision: null, status: 'failed', actualModel: null, usage: null, remoteSessionPath: null, remoteRunDir: null, localLogDir, cancellationConfirmed: false, inheritance: null, remoteOmpVersion: null, protocolVersion: null, durationMs: 0 };
  const record = (direction: string, value: unknown) => appendFileSync(join(localLogDir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), direction, value }) + '\n', { mode: 0o600 });
  const transport = options.transport ?? defaultTransport;
  const graceMs = Math.max(10, (options.graceSeconds ?? 10) * 1000);
  let state = createRunState();
  let child: ChildProcess | undefined;
  let cleanupCheck: (() => ChildProcess) | undefined;
  let transportClosed = false;
  let promptSent = false;
  let completionDecided = false;
  let phase = 'probe';
  let lastUpdate = 0;
  let streamTail = '';
  const toolNames = new Set<string>();
  const update = () => {
    if (Date.now() - lastUpdate < 500) return;
    lastUpdate = Date.now();
    try { options.onUpdate?.(`${phase}${toolNames.size ? ` tools=${[...toolNames].slice(-8).join(',')}` : ''}\n${streamTail.slice(-450)}`.slice(0, 600)); } catch { /* UI updates cannot affect the remote run. */ }
  };
  const queue: RunEvent[] = [];
  let wake: (() => void) | undefined;
  const enqueue = (event: RunEvent) => { queue.push(event); wake?.(); wake = undefined; };
  const next = async (timeout: number) => {
    if (!queue.length) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.max(0, timeout));
      wake = () => { clearTimeout(timer); resolve(); };
      await promise;
    }
    return queue.shift();
  };
  const reduce = (event: RunEvent) => {
    if (completionDecided && event.kind === 'abort_requested') return;
    if (event.kind === 'frame' && event.frame.type === 'remote_subtask_supervisor'
      && event.frame.event === 'exited' && event.frame.reason === 'deadline' && !completionDecided) {
      state = reduceRunState(state, { kind: 'abort_requested', reason: 'timeout' });
    }
    state = reduceRunState(state, event);
  };
  const send = (frame: object) => {
    if (!child?.stdin?.writable || transportClosed) throw new Error('transport_not_writable');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > inboundLimit) throw new Error('command_too_large');
    record('sent', frame); child.stdin.write(line);
  };
  let inboundLimit = 1024 * 1024;
  let localTimer: NodeJS.Timeout | undefined;
  const abort = () => enqueue({ kind: 'abort_requested', reason: 'signal' });
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const config = options.config ?? loadConfig();
    const host = resolveHost(config, params.host);
    if (!isAbsolute(params.cwd) || /[\0\r\n]/.test(params.cwd)) throw new Error('invalid_cwd: expected an absolute path without NUL/newlines');
    if (typeof params.task !== 'string' || !params.task.trim()) throw new Error('invalid_task');
    const timeoutSeconds = params.timeoutSeconds ?? config.defaultTimeoutSeconds;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > config.maxTimeoutSeconds) throw new Error(`invalid_timeout: maximum ${config.maxTimeoutSeconds}s`);
    const selectedModelArgs = modelArgs(params.model ?? host.defaultModel);
    const reuse = options.transport ? null : controlPath();
    const request = (kind: TransportRequest['kind'], script: string, supervisorConfig?: SupervisorConfig) => transport({ kind, script, argv: sshArgv(host.sshAlias, remoteShellCommand(script), { controlPath: reuse }), supervisorConfig });
    cleanupCheck = () => request('cleanup', buildCleanupCheckScript({ runId }));
    const probe = parseProbe(await capture(request('probe', buildProbeScript({ cwd: params.cwd, runId })), 30000, options.signal));
    if (!probe.cwdReal) throw new Error('remote_cwd_missing');
    if (host.allowedCwdRoots?.length && !host.allowedCwdRoots.some(root => inside(probe.cwdReal!, root))) throw new Error('remote_cwd_not_allowed');
    if (!probe.ompPath || !probe.runDir || !probe.bunVersion) throw new Error('unsupported_remote_omp: missing omp, embedded Bun, or run directory');
    details.cwd = probe.cwdReal; details.remoteRunDir = probe.runDir; details.remoteOmpVersion = probe.ompVersion;
    details.revision = probe.revision ? { commit: probe.revision, branch: probe.branch, dirtyCount: probe.dirtyCount } : null;
    const ompArgs = ['--mode', 'rpc', '--no-ui', '--cwd', probe.cwdReal, '--session-dir', join(probe.runDir, 'sessions'), '--no-title', '--tools', 'read,grep,glob', '--no-extensions', '--no-skills', '--no-rules', '--no-prewalk', '--no-lsp', '--no-pty', '--config', join(probe.runDir, 'overlay.yml'), '--append-system-prompt', READ_ONLY_NOTE, ...selectedModelArgs, '--max-time', String(timeoutSeconds)];
    const flags = supportedFlags(probe.help);
    for (const arg of ompArgs) if (arg.startsWith('--') && !flags.has(arg)) throw new Error(`unsupported_remote_omp: missing ${arg}`);
    if (options.signal?.aborted) throw new Error('aborted_before_launch');
    const supervisorConfig: SupervisorConfig = { runId, ompPath: probe.ompPath, ompArgs, cwd: probe.cwdReal, runDir: probe.runDir, deadlineSeconds: timeoutSeconds, graceSeconds: graceMs / 1000, overlayYaml: OVERLAY_YAML };
    const splitter = new LineSplitter(); const decoder = new RpcFrameDecoder();
    phase = 'starting'; update();
    child = request('launch', buildLaunchScript({ ompPath: probe.ompPath, runDir: probe.runDir, supervisorSource: SUPERVISOR_SOURCE, supervisorConfig }), supervisorConfig);
    child.stdin?.on('error', error => enqueue({ kind: 'local_error', code: 'stdin_error', message: String(error) }));
    child.stdout?.on('data', chunk => {
      try { for (const line of splitter.push(chunk)) { const frame = decoder.push(line); if (frame) { record('received', frame); enqueue({ kind: 'frame', frame }); } } }
      catch (error) { enqueue({ kind: 'local_error', code: 'invalid_rpc_frame', message: String(error) }); }
    });
    child.stdout?.on('end', () => { try { splitter.end(); decoder.end(); } catch (error) { enqueue({ kind: 'local_error', code: 'invalid_rpc_frame', message: String(error) }); } });
    child.stderr?.on('data', chunk => appendFileSync(join(localLogDir, 'ssh-stderr.log'), chunk, { mode: 0o600 }));
    child.on('error', error => enqueue({ kind: 'local_error', code: 'transport_error', message: String(error) }));
    child.on('close', (exitCode, signal) => { transportClosed = true; enqueue({ kind: 'transport_closed', exitCode, signal }); });
    options.onTransportSpawn?.(child);
    localTimer = setTimeout(() => enqueue({ kind: 'abort_requested', reason: 'timeout' }), timeoutSeconds * 1000 + 2000);
    let phaseDeadline = Date.now() + Math.min(30000, timeoutSeconds * 1000 + 2000);
    let sentState = false; let sentPrompt = false; let cancelling = false; let finishing = false;
    const getState = () => { if (!sentState) { sentState = true; send({ id: 'state-1', type: 'get_state' }); } };
    while (true) {
      const event = await next(Math.max(0, phaseDeadline - Date.now()));
      if (!event) {
        if (phase === 'stats') break;
        if (phase === 'cancel_abort') { send({ type: 'remote_subtask_control', op: 'terminate' }); reduce({ kind: 'terminate_requested' }); phase = 'cancel_terminate'; phaseDeadline = Date.now() + graceMs; continue; }
        if (phase === 'cancel_terminate') break;
        enqueue(promptSent ? { kind: 'abort_requested', reason: 'timeout' } : { kind: 'local_error', code: 'rpc_startup_timeout', message: 'Remote RPC startup timed out' });
        continue;
      }
      if (event.kind === 'abort_requested' && finishing) continue;
      reduce(event);
      if (event.kind === 'transport_closed') break;
      if (event.kind === 'local_error') { details.error = { code: event.code, message: event.message }; break; }
      if (event.kind === 'abort_requested') {
        if (!cancelling && !finishing) { cancelling = true; phase = 'cancel_abort'; phaseDeadline = Date.now() + graceMs; send({ id: 'abort-1', type: 'abort' }); }
        continue;
      }
      if (event.kind !== 'frame') continue;
      const frame = event.frame;
      if (frame?.type === 'ready') {
        const maxFrameBytes = typeof frame.maxFrameBytes === 'number' ? frame.maxFrameBytes : inboundLimit;
        const maxReassembledFrameBytes = typeof frame.maxReassembledFrameBytes === 'number' ? frame.maxReassembledFrameBytes : 64 * 1024 * 1024;
        decoder.setLimits({ maxFrameBytes, maxReassembledFrameBytes }); inboundLimit = maxFrameBytes;
        const negotiation = negotiate(frame); details.protocolVersion = negotiation.version;
        if (negotiation.send) send(negotiation.send); else getState();
      } else if (frame?.type === 'response' && frame.id === 'protocol-1') {
        if (!frame.success) throw new Error('protocol_negotiation_failed');
        getState();
      } else if (frame?.type === 'response' && frame.id === 'state-1') {
        if (!frame.success) throw new Error('remote_get_state_failed');
        const remoteState = parseRemoteState(frame.data);
        details.inheritance = remoteState.inheritance;
        details.remoteSessionPath = remoteState.remoteSessionPath;
        const tools = remoteState.inheritance.tools;
        if (tools.some(name => !Object.hasOwn(ALLOWED_TOOLS, name))) throw new Error('unexpected_remote_tools');
        if (!sentPrompt && !cancelling) { sentPrompt = true; send({ id: 'prompt-1', type: 'prompt', message: params.task }); promptSent = true; reduce({ kind: 'prompt_sent' }); phase = 'running'; phaseDeadline = startedAt + timeoutSeconds * 1000 + 32000; }
      }
      if (frame?.type === 'tool_execution_start' && typeof frame.toolName === 'string') toolNames.add(frame.toolName);
      const delta = frame?.assistantMessageEvent;
      if (delta && typeof delta === 'object' && 'type' in delta && delta.type === 'text_delta' && 'delta' in delta && typeof delta.delta === 'string') streamTail = (streamTail + delta.delta).slice(-600);
      if (frame?.type === 'message_end') streamTail = state.lastAssistantText.slice(-600);
      update();
      if (cancelling && frame?.type === 'prompt_result' && phase === 'cancel_abort') {
        send({ type: 'remote_subtask_control', op: 'terminate' }); reduce({ kind: 'terminate_requested' }); phase = 'cancel_terminate'; phaseDeadline = Date.now() + graceMs;
      }
      if (frame?.type === 'remote_subtask_supervisor' && frame.event === 'exited') break;
      if (frame?.type === 'response' && frame.id === 'stats-1') { details.stats = frame.success ? frame.data : { error: frame.error }; break; }
      const outcome = decide(state);
      if (outcome.done && !cancelling && !finishing) {
        if (outcome.status === 'completed') { completionDecided = true; finishing = true; phase = 'stats'; phaseDeadline = Date.now() + 2000; send({ id: 'stats-1', type: 'get_session_stats' }); }
        else break;
      }
    }
    child.stdin?.end();
    const closeDeadline = cancelling && !state.supervisor.exited ? Date.now() : Date.now() + graceMs * 3 + 500;
    while ((queue.length || !transportClosed) && Date.now() < closeDeadline) {
      const event = await next(closeDeadline - Date.now()); if (!event) break; reduce(event);
    }
    if (!transportClosed) { child.kill('SIGKILL'); reduce({ kind: 'transport_closed', exitCode: null, signal: 'SIGKILL' }); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    details.error = { code: message.split(':')[0], message };
    reduce({ kind: 'local_error', ...details.error });
    if (child && !transportClosed) {
      try { send({ type: 'remote_subtask_control', op: 'terminate' }); } catch {}
      child.stdin?.end();
      const until = Date.now() + graceMs * 3 + 500;
      while ((queue.length || !transportClosed) && Date.now() < until) { const event = await next(until - Date.now()); if (!event) break; reduce(event); }
      if (!transportClosed) { child.kill('SIGKILL'); reduce({ kind: 'transport_closed', exitCode: null, signal: 'SIGKILL' }); }
    }
  } finally {
    clearTimeout(localTimer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (child && state.abortRequested && !state.supervisor.exited && cleanupCheck) {
    try { details.postCheck = { output: await capture(cleanupCheck(), 10000) }; }
    catch (error) { details.postCheck = { error: String(error) }; }
  }
  const outcome = decide(state);
  details.status = outcome.status ?? (promptSent ? 'unknown' : 'failed');
  details.cancellationConfirmed = outcome.cancellationConfirmed;
  if (outcome.notStarted) details.notStarted = true;
  details.actualModel = state.actualModel; details.usage = state.usage;
  details.supervisor = state.supervisor;
  details.durationMs = Date.now() - startedAt;
  if (!details.error && details.status !== 'completed') {
    const remoteError = typeof state.promptResult?.error === 'string' ? state.promptResult.error : state.promptResponseError;
    const message = details.status === 'unknown'
      ? `The prompt was sent, but completion or owned-group cleanup could not be confirmed. Do not automatically resend; inspect ${details.remoteSessionPath ?? details.remoteRunDir ?? localLogDir}`
      : details.status === 'aborted'
        ? 'Cancellation confirmed: the supervisor reported its owned process group is gone'
        : remoteError ?? (details.notStarted ? 'No prompt was sent to the remote agent' : 'The remote process exited without settled completion');
    details.error = { code: outcome.reason, message };
  }
  let text = state.lastAssistantText || (details.status === 'completed' ? 'Remote task completed without assistant text.' : `Remote task ${details.status}: ${details.error?.message ?? outcome.reason}.`);
  if (text.length > 60000) text = text.slice(0, 60000) + `\n[Truncated at 60,000 characters; full transcript: ${localLogDir}/events.jsonl]`;
  if (details.status !== 'completed' && state.lastAssistantText) text += `\nRemote task ${details.status}: ${details.error?.message ?? outcome.reason}.`;
  text += `\n[remote_task ${details.status} host=${params.host} run=${runId}]`;
  const result = { text, details };
  writeFileSync(join(localLogDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return result;
}

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export function parseProcessSnapshot(output) {
  const processes = new Map();
  for (const row of output.split('\n')) {
    if (!row.trim()) continue;
    const fields = row.trim().split(/\s+/);
    if (fields.length !== 3 || fields.some(field => !/^\d+$/.test(field))) throw new Error('invalid ps process snapshot');
    const [pid, ppid, pgid] = fields.map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) throw new Error('invalid ps process snapshot');
    processes.set(pid, { pid, ppid, pgid });
  }
  return processes;
}

// Seed each snapshot with surviving previously observed descendants. They remain
// owned when setsid/setpgid or reparenting severs their path back to omp.
export function snapshotDescendants(processes, rootPid, previous, groups) {
  const owned = new Map();
  const children = new Map();
  for (const row of processes.values()) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
    if (row.pid === rootPid || previous.has(row.pid) || groups.has(row.pgid)) owned.set(row.pid, row);
  }
  const queue = [...owned.values()];
  for (let index = 0; index < queue.length; index++) {
    for (const row of children.get(queue[index].pid) ?? []) {
      if (owned.has(row.pid)) continue;
      owned.set(row.pid, row);
      queue.push(row);
    }
  }
  return owned;
}

// Never signal a foreign group merely because an owned PID joined it. Fall back
// to individual PIDs when the group includes anyone we have not attributed.
export function cleanupTargets(processes, owned, groups, supervisorPid, supervisorPgid) {
  const safeGroups = new Set(groups);
  safeGroups.delete(supervisorPgid);
  safeGroups.delete(0);
  for (const row of processes.values()) if (!owned.has(row.pid)) safeGroups.delete(row.pgid);
  const pids = [];
  const activeGroups = new Set();
  for (const row of owned.values()) {
    if (row.pid === supervisorPid) continue;
    if (safeGroups.has(row.pgid)) activeGroups.add(row.pgid);
    else pids.push(row.pid);
  }
  return { groups: [...activeGroups], pids };
}

function supervise(config) {
  const { runId, ompPath, ompArgs, cwd, runDir, deadlineSeconds, graceSeconds = 10, overlayYaml } = config;
  mkdirSync(join(runDir, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runDir, 'overlay.yml'), overlayYaml, { mode: 0o600 });
  const stderr = openSync(join(runDir, 'omp.stderr.log'), 'a', 0o600);
  const env = { ...process.env };
  delete env.BUN_BE_BUN;
  mkdirSync(join(runDir, 'tmp'), { recursive: true, mode: 0o700 });
  env.TMPDIR = join(runDir, 'tmp');
  if (config.mode === 'exec') mkdirSync(join(runDir, 'work'), { recursive: true, mode: 0o700 });
  const child = spawn(ompPath, ompArgs, { cwd, detached: true, env, stdio: ['pipe', 'pipe', stderr] });
  closeSync(stderr);
  let stdoutOpen = true;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let reason = 'child_exit';
  let termSent = false;
  let killSent = false;
  let shuttingDown;
  let finishing;
  const pgid = child.pid;
  let owned = new Map();
  const groups = new Set(pgid ? [pgid] : []);
  const escapedPids = new Set();
  const escapedGroups = new Set();
  let supervisorPgid;
  let trackingError;
  const graceMs = Math.max(10, graceSeconds * 1000);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const log = record => appendFileSync(join(runDir, 'supervisor.log'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  function frame(record) {
    const value = { type: 'remote_subtask_supervisor', runId, ...record };
    log(value);
    if (stdoutOpen) process.stdout.write(JSON.stringify(value) + '\n');
  }
  function ps(fields) {
    const listing = spawnSync('ps', ['-A', '-o', fields], { encoding: 'utf8' });
    if (listing.error || listing.status !== 0) throw new Error(`ps failed: ${listing.error || listing.stderr || listing.status}`);
    return listing.stdout;
  }
  function snapshot() {
    const processes = parseProcessSnapshot(ps('pid=,ppid=,pgid='));
    supervisorPgid = processes.get(process.pid)?.pgid ?? supervisorPgid;
    if (supervisorPgid === undefined) throw new Error('supervisor missing from ps snapshot');
    owned = snapshotDescendants(processes, exited ? undefined : pgid, owned, groups);
    owned.delete(process.pid);
    // Drop vanished groups/PIDs instead of retaining stale IDs indefinitely.
    const presentGroups = new Set([...processes.values()].map(row => row.pgid));
    for (const group of groups) if (!presentGroups.has(group)) groups.delete(group);
    for (const row of owned.values()) {
      if (row.pid === row.pgid && row.pgid !== supervisorPgid) groups.add(row.pgid);
      if (row.pgid !== pgid) {
        if (!escapedPids.has(row.pid)) log({ event: 'escaped_descendant', pid: row.pid, pgid: row.pgid });
        escapedPids.add(row.pid);
        if (row.pgid !== supervisorPgid && groups.has(row.pgid)) escapedGroups.add(row.pgid);
      }
    }
    return processes;
  }
  function track() {
    try { snapshot(); }
    catch (error) {
      if (!trackingError) log({ error: String(error), source: 'descendant_tracking' });
      trackingError ??= String(error);
    }
  }
  // Start before accepting RPC input and keep observing through graceful shutdown.
  track();
  const tracker = setInterval(track, 50);
  function liveSnapshot() {
    const processes = snapshot();
    // macOS may return EPERM for groups containing only zombies. Zombies cannot
    // execute or retain pipes and must not make cleanup look unconfirmed.
    const live = new Set();
    for (const row of ps('pid=,stat=').split('\n')) {
      const [pid, stat] = row.trim().split(/\s+/);
      if (stat && !stat.startsWith('Z')) live.add(Number(pid));
    }
    return new Map([...processes].filter(([pid]) => live.has(pid)));
  }
  function cleanupState() {
    const processes = liveSnapshot();
    const remaining = new Map([...owned].filter(([pid]) => processes.has(pid)));
    return { processes, remaining, gone: remaining.size === 0 };
  }
  function signalOwned(signal) {
    try {
      const { processes, remaining } = cleanupState();
      const targets = cleanupTargets(processes, remaining, groups, process.pid, supervisorPgid);
      for (const target of [...targets.groups.map(group => -group), ...targets.pids]) {
        try {
          process.kill(target, signal);
          if (signal === 'SIGTERM') termSent = true;
          else killSent = true;
        } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') log({ error: String(error), signal }); }
      }
    } catch (error) { trackingError ??= String(error); }
  }
  async function waitUntil(predicate, milliseconds) {
    const until = Date.now() + milliseconds;
    while (!predicate() && Date.now() < until) await delay(Math.min(25, until - Date.now()));
    return predicate();
  }
  async function finish() {
    if (finishing) return finishing;
    finishing = (async () => {
      clearTimeout(deadline);
      input.close();
      process.stdin.pause();
      let groupGone = false;
      let escapedGone = false;
      let descendantsGone = false;
      let error;
      try {
        if (!cleanupState().gone) {
          signalOwned('SIGTERM');
          if (!await waitUntil(() => cleanupState().gone, graceMs)) {
            signalOwned('SIGKILL');
            await waitUntil(() => cleanupState().gone, graceMs);
          }
        }
        // Escaped descendants can retain stdout too; drain only after cleanup.
        await waitUntil(() => child.stdout.readableEnded || child.stdout.destroyed, graceMs);
        const state = cleanupState();
        escapedGone = !trackingError && ![...state.remaining.values()].some(row => row.pgid !== pgid);
        descendantsGone = state.gone && !trackingError;
        // Existing consumers use groupGone to confirm cancellation, so it must
        // also require escaped descendants gone, not merely the original group.
        groupGone = descendantsGone && !trackingError;
      } catch (caught) { error = String(caught); }
      clearInterval(tracker);
      error ??= trackingError;
      let stderrTail;
      try {
        const fd = openSync(join(runDir, 'omp.stderr.log'), 'r');
        try {
          const size = fstatSync(fd).size;
          const buffer = Buffer.alloc(Math.min(2048, size));
          stderrTail = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)));
        } finally { closeSync(fd); }
      } catch (caught) { log({ error: String(caught), source: 'stderr_tail' }); }
      frame({ event: 'exited', code: exitCode, signal: exitSignal, reason, termSent, killSent, groupGone, descendantsGone, escapedGone, escapedPids: [...escapedPids], escapedGroups: [...escapedGroups], ...(error ? { error } : {}), ...(stderrTail ? { stderrTail } : {}) });
      if (stdoutOpen) await new Promise(resolve => process.stdout.write('', resolve));
      process.exit(exitCode === null ? 0 : exitCode);
    })();
    return finishing;
  }
  async function shutdown(why, immediate = false) {
    if (shuttingDown) return shuttingDown;
    reason = why;
    shuttingDown = (async () => {
      if (!exited && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ type: 'abort', id: 'supervisor-eof' }) + '\n');
        child.stdin.end();
      }
      if (immediate && !exited) signalOwned('SIGTERM');
      if (!await waitUntil(() => exited, graceMs)) {
        signalOwned('SIGTERM');
        if (!await waitUntil(() => exited, graceMs)) {
          signalOwned('SIGKILL');
          await waitUntil(() => exited, graceMs);
        }
      }
      await finish();
    })();
    return shuttingDown;
  }
  process.stdout.on('error', error => {
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') log({ error: String(error) });
    stdoutOpen = false;
    child.stdout.unpipe(process.stdout);
    child.stdout.resume();
    void shutdown('stdout_closed');
  });
  child.stdin.on('error', () => {});
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let parsed;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed?.type === 'remote_subtask_control') {
      if (parsed.op === 'terminate') void shutdown('terminate');
      return;
    }
    if (!shuttingDown && child.stdin.writable && !child.stdin.write(line + '\n')) {
      process.stdin.pause();
      child.stdin.once('drain', () => { if (!shuttingDown) process.stdin.resume(); });
    }
  });
  input.on('close', () => { if (!exited) void shutdown('stdin_eof'); });
  const deadline = setTimeout(() => void shutdown('deadline'), deadlineSeconds * 1000);
  child.on('error', error => { log({ error: String(error) }); exited = true; exitCode = 1; void finish(); });
  child.on('exit', (code, signal) => { exited = true; owned.delete(pgid); exitCode = code; exitSignal = signal; void finish(); });
  child.on('close', () => { void finish(); });
  if (pgid) frame({ event: 'started', pid: child.pid, pgid, runDir, sessionDir: join(runDir, 'sessions') });
  child.stdout.pipe(process.stdout, { end: false });
  process.on('SIGTERM', () => void shutdown('supervisor_signal', true));
  process.on('SIGINT', () => void shutdown('supervisor_signal', true));
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  supervise(JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')));
}

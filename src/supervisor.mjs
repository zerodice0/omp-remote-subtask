import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const config = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const { runId, ompPath, ompArgs, cwd, runDir, deadlineSeconds, graceSeconds = 10, overlayYaml } = config;
mkdirSync(join(runDir, 'sessions'), { recursive: true, mode: 0o700 });
writeFileSync(join(runDir, 'overlay.yml'), overlayYaml, { mode: 0o600 });
const stderr = openSync(join(runDir, 'omp.stderr.log'), 'a', 0o600);
const env = { ...process.env };
delete env.BUN_BE_BUN;
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
const graceMs = Math.max(10, graceSeconds * 1000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = record => appendFileSync(join(runDir, 'supervisor.log'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
function frame(record) {
  const value = { type: 'remote_subtask_supervisor', runId, ...record };
  log(value);
  if (stdoutOpen) process.stdout.write(JSON.stringify(value) + '\n');
}
process.stdout.on('error', error => {
  if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') log({ error: String(error) });
  stdoutOpen = false;
  child.stdout.unpipe(process.stdout);
  child.stdout.resume();
  void shutdown('stdout_closed');
});
child.stdin.on('error', () => {});
// macOS reports EPERM from kill(-pgid, 0) while the group holds only zombies, so a
// non-ESRCH answer is settled by listing live (non-zombie) members of the group.
function groupExists() {
  if (!pgid) return false;
  try { process.kill(-pgid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code !== 'EPERM') throw error; }
  const listing = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`ps failed: ${listing.stderr || listing.status}`);
  return listing.stdout.split('\n').some(row => {
    const [group, stat] = row.trim().split(/\s+/);
    return Number(group) === pgid && stat !== undefined && !stat.startsWith('Z');
  });
}
function signalGroup(signal) {
  if (!pgid) return;
  try { process.kill(-pgid, signal); if (signal === 'SIGTERM') termSent = true; else killSent = true; }
  catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') log({ error: String(error), signal }); }
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
    let error;
    try {
      if (groupExists()) {
        signalGroup('SIGTERM');
        if (!await waitUntil(() => !groupExists(), graceMs)) {
          signalGroup('SIGKILL');
          await waitUntil(() => !groupExists(), graceMs);
        }
      }
      // Descendants may retain stdout after their parent exits. Kill the group first,
      // then drain the child's final output before placing the exit frame after it.
      await waitUntil(() => child.stdout.readableEnded || child.stdout.destroyed, graceMs);
      groupGone = !groupExists();
    } catch (caught) {
      error = String(caught);
    }
    frame({ event: 'exited', code: exitCode, signal: exitSignal, reason, termSent, killSent, groupGone, ...(error ? { error } : {}) });
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
    if (immediate && !exited) signalGroup('SIGTERM');
    if (!await waitUntil(() => exited, graceMs)) {
      signalGroup('SIGTERM');
      if (!await waitUntil(() => exited, graceMs)) {
        signalGroup('SIGKILL');
        await waitUntil(() => exited, graceMs);
      }
    }
    await finish();
  })();
  return shuttingDown;
}
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
child.on('error', error => {
  log({ error: String(error) });
  exited = true;
  exitCode = 1;
  void finish();
});
child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; void finish(); });
child.on('close', () => { void finish(); });
if (pgid) frame({ event: 'started', pid: child.pid, pgid, runDir, sessionDir: join(runDir, 'sessions') });
child.stdout.pipe(process.stdout, { end: false });
process.on('SIGTERM', () => void shutdown('supervisor_signal', true));
process.on('SIGINT', () => void shutdown('supervisor_signal', true));

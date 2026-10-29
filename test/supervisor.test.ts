import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupTargets, parseProcessSnapshot, snapshotDescendants } from '../src/supervisor.mjs';
import { posixQuote } from '../src/ssh.ts';

let scratch: string;
let executable: string;
const supervisor = resolve('src/supervisor.mjs');
beforeAll(() => {
  const root = execFileSync(join(homedir(), '.config/herdr/scripts/agent_work.py'), ['path', '--name', 'sshcore-tests'], { encoding: 'utf8' }).trim();
  scratch = mkdtempSync(join(root, 'supervisor-'));
  const fixture = join(scratch, 'fixture.mjs');
  writeFileSync(fixture, `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const role = process.argv[2];
if (role === 'env') {
  console.log(JSON.stringify({ fixture: 'env', tmpdir: process.env.TMPDIR, cwd: process.cwd(), bun: process.env.BUN_BE_BUN }));
} else if (role === 'leaf') {
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({ fixture: 'leaf', pid: process.pid }));
  setInterval(() => {}, 1000);
} else {
  const input = createInterface({ input: process.stdin });
  if (role === 'intermediate') {
    const leaf = spawn(process.execPath, [import.meta.filename, 'leaf'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BUN_BE_BUN: '1' } });
    leaf.stdout.pipe(process.stdout);
    input.on('line', () => process.exit(0));
  } else {
    const intermediate = spawn(process.execPath, [import.meta.filename, 'intermediate'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, BUN_BE_BUN: '1' } });
    intermediate.stdout.pipe(process.stdout);
    intermediate.on('exit', () => console.log(JSON.stringify({ fixture: 'reparented' })));
    input.on('line', line => {
      if (line === 'release') intermediate.stdin.end('release\\n');
      if (line === 'complete') process.exit(0);
    });
    process.on('SIGTERM', () => process.exit(0));
  }
  setInterval(() => {}, 1000);
}
`);
  executable = join(scratch, 'omp-fixture');
  // The supervisor must remove BUN_BE_BUN before entering the omp executable.
  writeFileSync(executable, `#!/bin/sh\n[ -z "$BUN_BE_BUN" ] || exit 98\nexec env BUN_BE_BUN=1 ${posixQuote(process.execPath)} ${posixQuote(fixture)} "$@"\n`, { mode: 0o700 });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const snapshot = (value: string) => parseProcessSnapshot(value);

test('portable snapshots track arbitrary-depth descendants after detachment and reparenting', () => {
  const first = snapshot(' 10 1 10\n11 10 10\n12 11 12\n13 12 12\n20 1 20\n');
  const owned = snapshotDescendants(first, 10, new Map(), new Set([10]));
  expect([...owned.keys()].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  const after = snapshot('12 1 12\n13 12 12\n14 13 14\n20 1 20\n');
  const retained = snapshotDescendants(after, 10, owned, new Set([10, 12]));
  expect([...retained.keys()].sort((a, b) => a - b)).toEqual([12, 13, 14]);
  expect(retained.has(20)).toBe(false);
  // A PID absent from a snapshot loses its ownership; later reuse is unrelated.
  const gone = snapshotDescendants(snapshot('20 1 20\n'), 10, retained, new Set());
  expect(snapshotDescendants(snapshot('12 1 20\n20 1 20\n'), 10, gone, new Set()).size).toBe(0);
});

test('cleanup targets exclude supervisor and unrelated groups and use owned PID fallback', () => {
  const processes = snapshot('5 1 5\n10 1 10\n11 10 10\n12 1 12\n13 12 12\n14 1 20\n20 1 20\n15 1 5\n');
  const owned = new Map([...processes].filter(([pid]) => ![5, 20].includes(pid)));
  const targets = cleanupTargets(processes, owned, new Set([5, 10, 12, 20]), 5, 5);
  expect(targets.groups.sort((a, b) => a - b)).toEqual([10, 12]);
  expect(targets.pids.sort((a, b) => a - b)).toEqual([14, 15]);
  const withSupervisor = cleanupTargets(processes, processes, new Set([5]), 5, 5);
  expect(withSupervisor.groups).not.toContain(5);
  expect(withSupervisor.pids).not.toContain(5);
});

test('malformed ps output cannot silently discard process ownership', () => {
  for (const output of ['10 1\n', '10 nope 10\n', '0 1 0\n', '10 1 10 unexpected\n']) expect(() => snapshot(output)).toThrow('invalid ps process snapshot');
  expect(snapshot('\n 10 1 10 \n').get(10)).toEqual({ pid: 10, ppid: 1, pgid: 10 });
});

function launch(name: string, role: string, mode?: 'read' | 'exec', deadlineSeconds = 15) {
  const runDir = join(scratch, name);
  mkdirSync(runDir);
  const config = { runId: name, ompPath: executable, ompArgs: [role], cwd: scratch, runDir, deadlineSeconds, graceSeconds: 0.2, overlayYaml: '', ...(mode ? { mode } : {}) };
  const child = spawn(process.execPath, [supervisor, Buffer.from(JSON.stringify(config)).toString('base64')], { env: { ...process.env, BUN_BE_BUN: '1', TMPDIR: scratch }, stdio: 'pipe' });
  let output = '';
  let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const { promise: closed, resolve: onClose, reject: onError } = Promise.withResolvers<number | null>();
  child.once('error', onError);
  child.once('close', onClose);
  const frames = () => output.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
  return { child, closed, runDir, frames, stderr: () => stderr };
}
// These integration tests observe detached OS processes and a separate supervisor
// clock. Advancing this test process's fake timers cannot drive either of them.
async function until(predicate: () => boolean, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for supervisor fixture');
    await Bun.sleep(20);
  }
}
function live(pid: number) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return result.status === 0 && !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}
function killChild(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }

test('exec creates private work/tmp and passes per-run TMPDIR without changing cwd', async () => {
  const run = launch('exec-env', 'env', 'exec');
  try {
    expect(await run.closed).toBe(0);
    const env = run.frames().find(frame => frame.fixture === 'env');
    expect(env.tmpdir).toBe(join(run.runDir, 'tmp'));
    expect(env.cwd).toBe(scratch);
    for (const directory of ['work', 'tmp']) expect(statSync(join(run.runDir, directory)).mode & 0o777).toBe(0o700);
    expect(run.frames().at(-1)).toMatchObject({ event: 'exited', groupGone: true, escapedGone: true, descendantsGone: true });
    expect(run.stderr()).toBe('');
  } finally { killChild(run.child); }
});

test('omitted mode uses run TMPDIR without creating an exec work directory', async () => {
  const run = launch('read-env', 'env');
  try {
    expect(await run.closed).toBe(0);
    expect(run.frames().find(frame => frame.fixture === 'env').tmpdir).toBe(join(run.runDir, 'tmp'));
    expect(existsSync(join(run.runDir, 'work'))).toBe(false);
    expect(existsSync(join(run.runDir, 'tmp'))).toBe(true);
  } finally { killChild(run.child); }
});

test('shutdown kills a tracked detached child after reparenting and leaves unrelated processes alive', async () => {
  const unrelated = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  const run = launch('escaped-cleanup', 'root', 'exec');
  let escapedPid: number | undefined;
  try {
    await until(() => run.frames().some(frame => frame.fixture === 'leaf'));
    escapedPid = run.frames().find(frame => frame.fixture === 'leaf').pid;
    const log = join(run.runDir, 'supervisor.log');
    // Wait for actual ownership capture, not a scheduling-dependent fixed delay.
    await until(() => existsSync(log) && readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).some(frame => frame.event === 'escaped_descendant' && frame.pid === escapedPid));
    run.child.stdin.write('release\n');
    await until(() => run.frames().some(frame => frame.fixture === 'reparented'));
    expect(live(escapedPid!)).toBe(true);
    run.child.stdin.write(JSON.stringify({ type: 'remote_subtask_control', op: 'terminate' }) + '\n');
    await run.closed;
    const exited = run.frames().at(-1);
    expect(exited).toMatchObject({ event: 'exited', reason: 'terminate', groupGone: true, descendantsGone: true, escapedGone: true, termSent: true, killSent: true });
    expect(exited.escapedPids).toContain(escapedPid);
    expect(exited.escapedGroups).toContain(escapedPid);
    expect(live(escapedPid!)).toBe(false);
    expect(live(unrelated.pid!)).toBe(true);
    expect(run.stderr()).toBe('');
  } finally {
    killChild(run.child);
    unrelated.kill('SIGKILL');
    if (escapedPid && live(escapedPid)) process.kill(escapedPid, 'SIGKILL');
    // If an assertion failed before cleanup, the root still owns its original group.
    const started = run.frames().find(frame => frame.event === 'started');
    if (started?.pgid) { try { process.kill(-started.pgid, 'SIGKILL'); } catch {} }
  }
}, 12000);

test.each(['normal', 'deadline'] as const)('%s exit also kills tracked escaped descendants', async outcome => {
  const run = launch(`escaped-${outcome}`, 'root', 'exec', outcome === 'deadline' ? 2 : 15);
  let escapedPid: number | undefined;
  try {
    await until(() => run.frames().some(frame => frame.fixture === 'leaf'));
    escapedPid = run.frames().find(frame => frame.fixture === 'leaf').pid;
    const log = join(run.runDir, 'supervisor.log');
    await until(() => readFileSync(log, 'utf8').includes(`"pid":${escapedPid},`));
    run.child.stdin.write('release\n');
    await until(() => run.frames().some(frame => frame.fixture === 'reparented'));
    if (outcome === 'normal') run.child.stdin.write('complete\n');
    await run.closed;
    expect(run.frames().at(-1)).toMatchObject({
      event: 'exited', reason: outcome === 'normal' ? 'child_exit' : 'deadline',
      groupGone: true, descendantsGone: true, escapedGone: true, killSent: true,
    });
    expect(live(escapedPid!)).toBe(false);
  } finally {
    killChild(run.child);
    if (escapedPid && live(escapedPid)) process.kill(escapedPid, 'SIGKILL');
    const started = run.frames().find(frame => frame.event === 'started');
    if (started?.pgid) { try { process.kill(-started.pgid, 'SIGKILL'); } catch {} }
  }
}, 12000);

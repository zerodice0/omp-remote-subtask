import { afterAll, expect, test } from 'bun:test';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runRemoteTask, type RunnerOptions, type TransportRequest } from '../src/runner.ts';
import { posixQuote } from '../src/ssh.ts';
import type { RemoteRole } from '../src/config.ts';

const scratchRoot = execFileSync(join(homedir(), '.config/herdr/scripts/agent_work.py'), ['path', '--name', 'runner-tests'], { encoding: 'utf8' }).trim();
const scratch = execFileSync('mktemp', ['-d', '-p', scratchRoot], { encoding: 'utf8' }).trim();
const fake = resolve('test/fixtures/fake-omp.mjs');
const supervisor = resolve('src/supervisor.mjs');
const executable = join(scratch, 'fake-omp');
writeFileSync(executable, `#!/bin/sh\nif [ -n "$BUN_BE_BUN" ]; then exit 98; fi\nexec env BUN_BE_BUN=1 ${posixQuote(process.execPath)} ${posixQuote(fake)} "$@"\n`);
chmodSync(executable, 0o700);
const config = { defaultTimeoutSeconds: 20, maxTimeoutSeconds: 60, hosts: { local: { sshAlias: 'local' } } };
const children: number[] = [];
const flags = '--mode --no-ui --cwd --session-dir --no-title --tools --no-extensions --no-skills --no-rules --no-prewalk --no-lsp --no-pty --config --append-system-prompt --model --max-time';
function localTransport(mode: string) {
  return (request: TransportRequest) => {
    if (request.kind === 'launch') {
      const launch = request.supervisorConfig!;
      mkdirSync(launch.runDir, { recursive: true });
      const child = spawn(process.execPath, [fake, '--transport', supervisor, Buffer.from(JSON.stringify(launch)).toString('base64')], { env: { ...process.env, BUN_BE_BUN: '1', FAKE_OMP_MODE: mode }, stdio: 'pipe' });
      if (child.pid) children.push(child.pid);
      return child;
    }
    let output = '';
    if (request.kind === 'probe') {
      const runId = request.script.match(/rst-\d{14}-[a-f0-9]{6}/)?.[0];
      if (!runId) throw new Error('run ID missing from probe');
      output = `omp_path=${executable}\nomp_version=fake-1\nbun_version=1.4\nhelp_b64=${Buffer.from(flags).toString('base64')}\ncwd_real=${scratch}\nrevision=\nbranch=\ndirty_count=\nrun_dir=${join(scratch, runId)}\nrun_dir_source=fallback\nhome=${scratch}\n`;
    }
    return spawn('/bin/sh', ['-c', `printf %s ${posixQuote(output)}`], { stdio: 'pipe' });
  };
}
function options(mode = 'complete'): RunnerOptions { return { config, cwd: process.cwd(), transport: localTransport(mode), graceSeconds: 0.15 }; }
function events(localLogDir: string) { return readFileSync(join(localLogDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
function assertGone(pid: number) { expect(() => process.kill(pid, 0)).toThrow(); }
function onFixtureReady(child: ChildProcess, action: () => void) {
  let buffered = ''; let fired = false;
  child.stdout?.on('data', chunk => {
    buffered += chunk.toString();
    if (!fired && buffered.includes('"type":"fixture_pids"')) { fired = true; action(); }
  });
}
afterAll(() => { for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} } });

test('completed: negotiates, checks inheritance, prompts once and waits for settled', async () => {
  const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Answer locally.', role: 'tiny' }, options());
  expect(result.details.status).toBe('completed');
  expect(result.text).toContain('Local fake answer.');
  expect(result.details.protocolVersion).toBe(2);
  expect(result.details.actualModel).toBe('fake/model');
  expect(result.details.role).toBe('tiny');
  expect(result.details.thinkingLevel).toBe('medium');
  expect(result.details.inheritance.model).toBe('fake/model');
  expect(result.details.inheritance.tools).toEqual(['read', 'grep', 'glob', 'write']);
  expect(result.details.inheritance.contextTokensBeforePrompt).toBe(12);
  expect(result.details.supervisor.exited.groupGone).toBe(true);
  expect(result.details.supervisor.exited).not.toHaveProperty('stderrTail');
  expect(result.details.stats.cost).toBe(0.001);
  const sent = events(result.details.localLogDir).filter(event => event.direction === 'sent').map(event => event.value);
  expect(sent.filter(frame => frame.type === 'prompt')).toHaveLength(1);
  expect(sent.map(frame => frame.type)).toEqual(['negotiate_protocol', 'get_state', 'prompt', 'get_session_stats']);
});

test.each([
  { role: 'slow', defaultRole: 'smol', expected: 'slow' },
  { role: undefined, defaultRole: 'smol', expected: 'smol' },
  { role: undefined, defaultRole: undefined, expected: 'explore' },
] as { role?: RemoteRole; defaultRole?: RemoteRole; expected: RemoteRole }[])('role precedence: $role / $defaultRole resolves to $expected', async ({ role, defaultRole, expected }) => {
  const opts = options();
  opts.config = { ...config, hosts: { local: { sshAlias: 'local', defaultRole } } };
  const transport = opts.transport!;
  let argv: string[] | undefined;
  opts.transport = request => {
    if (request.kind === 'launch') argv = request.supervisorConfig!.ompArgs;
    return transport(request);
  };
  const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Answer locally.', role }, opts);
  expect(result.details.status).toBe('completed');
  expect(result.details.role).toBe(expected);
  expect(argv).toBeDefined();
  expect(argv!.slice(argv!.indexOf('--model'), argv!.indexOf('--model') + 2)).toEqual(['--model', `@${expected}`]);
});

test('rejects invalid runtime roles without starting transport', async () => {
  const opts = options();
  opts.transport = () => { throw new Error('unexpected_transport'); };
  for (const role of ['invalid', '', null, 1]) {
    const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Do not send.', role: role as RemoteRole }, opts);
    expect(result.details.status).toBe('failed');
    expect(result.details.notStarted).toBe(true);
    expect(result.details.error.code).toBe('invalid_role');
  }
});

test('remote startup stderr fails before sending a prompt', async () => {
  const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Do not send.', role: 'slow' }, options('startup-error'));
  expect(result.details.status).toBe('failed');
  expect(result.details.notStarted).toBe(true);
  expect(result.details.error.code).toBe('remote_omp_exited_before_ready');
  expect(result.details.error.message).toContain('Model "@slow" not found');
  expect(result.details.thinkingLevel).toBeNull();
  expect(Buffer.byteLength(result.details.supervisor.exited.stderrTail)).toBeLessThanOrEqual(2048);
  expect(events(result.details.localLogDir).filter(event => event.direction === 'sent')).toHaveLength(0);
});

test('signal abort confirms supervisor group cleanup including a grandchild', async () => {
  const controller = new AbortController();
  const opts = options('ignore-abort');
  opts.signal = controller.signal;
  opts.onTransportSpawn = child => onFixtureReady(child, () => controller.abort());
  const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Wait.' }, opts);
  expect(result.details.status).toBe('aborted');
  expect(result.details.cancellationConfirmed).toBe(true);
  expect(result.details.supervisor.exited.groupGone).toBe(true);
  const pids = events(result.details.localLogDir).find(event => event.value.type === 'fixture_pids').value;
  assertGone(pids.pid); assertGone(pids.grandchild);
}, 10000);

test('killed transport returns unknown without resend; EOF cleans remote group', async () => {
  const opts = options('ignore-abort');
  opts.onTransportSpawn = child => onFixtureReady(child, () => child.kill('SIGTERM'));
  const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Wait.' }, opts);
  expect(result.details.status).toBe('unknown');
  expect(result.details.cancellationConfirmed).toBe(false);
  const recorded = events(result.details.localLogDir);
  expect(recorded.filter(event => event.direction === 'sent' && event.value.type === 'prompt')).toHaveLength(1);
  const pids = recorded.find(event => event.value.type === 'fixture_pids').value;
  const log = join(result.details.remoteRunDir, 'supervisor.log');
  const deadline = Date.now() + 4000;
  // This deliberately checks external OS process cleanup after transport loss;
  // fake JS timers cannot drive the detached supervisor's clock.
  while ((!existsSync(log) || !readFileSync(log, 'utf8').includes('"event":"exited"')) && Date.now() < deadline) await Bun.sleep(20);
  expect(readFileSync(log, 'utf8')).toContain('"groupGone":true');
  assertGone(pids.pid); assertGone(pids.grandchild);
}, 10000);

test('unexpected remote tools fail before any prompt', async () => {
  const result = await runRemoteTask({ host: 'local', cwd: scratch, task: 'Do not send.' }, options('bad-tools'));
  expect(result.details.status).toBe('failed');
  expect(result.details.error.code).toBe('unexpected_remote_tools');
  expect(events(result.details.localLogDir).filter(event => event.direction === 'sent' && event.value.type === 'prompt')).toHaveLength(0);
});

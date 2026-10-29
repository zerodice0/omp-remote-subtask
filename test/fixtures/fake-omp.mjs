import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv[2] === '--transport') {
  const config = JSON.parse(Buffer.from(process.argv[4], 'base64').toString('utf8'));
  const child = spawn(process.execPath, [process.argv[3], process.argv[4]], { env: { ...process.env, BUN_BE_BUN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('close', code => process.exit(code ?? 0));
  process.on('SIGTERM', () => { appendFileSync(config.runDir + '/transport-dropped', 'yes'); process.exit(0); });
} else {
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  const mode = process.env.FAKE_OMP_MODE ?? 'complete';
  if (mode === 'startup-error') {
    const role = process.argv[process.argv.indexOf('--model') + 1];
    process.stderr.write('.'.repeat(4096) + `\nModel "${role}" not found\n`);
    process.exit(1);
  }
  // The executable wrapper checks the supervisor removed BUN_BE_BUN before selecting Bun.
  delete process.env.BUN_BE_BUN;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sleeping;
  let active = false;
  let terminating = false;
  const heartbeat = setInterval(() => {}, 1000);
  function terminate() {
    if (terminating) return;
    terminating = true;
    clearInterval(heartbeat);
    if (sleeping) {
      sleeping.once('close', () => process.exit(0));
      sleeping.kill('SIGTERM');
    } else process.exit(0);
  }
  process.on('SIGTERM', terminate);
  input.on('close', () => { if (mode !== 'ignore-abort') terminate(); });
  send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
  input.on('line', line => {
    const command = JSON.parse(line);
    const response = data => send({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type === 'negotiate_protocol') response({ protocolVersion: 2 });
    else if (command.type === 'get_state') response({ dumpTools: (mode === 'bad-tools' ? ['read', 'bash'] : ['read', 'grep', 'glob', 'write']).map(name => ({ name })), systemPrompt: ['Inherited context'], contextUsage: { tokens: 12 }, model: { provider: 'fake', id: 'model' }, thinkingLevel: 'medium', sessionFile: process.cwd() + '/fake-session.jsonl' });
    else if (command.type === 'prompt') {
      active = true;
      response({});
      if (mode === 'ignore-abort') {
        sleeping = spawn('sleep', ['300'], { stdio: 'ignore' });
        send({ type: 'fixture_pids', pid: process.pid, grandchild: sleeping.pid });
      } else {
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Local fake answer.' } });
        send({ type: 'message_end', message: { role: 'assistant', provider: 'fake', model: 'model', content: [{ type: 'text', text: 'Local fake answer.' }], usage: { input: 10, output: 4, totalTokens: 14, cost: { total: 0.001 } } } });
        active = false;
        send({ type: 'prompt_result', id: command.id, status: 'completed', sessionSettled: false });
        setTimeout(() => send({ type: 'session_settled' }), 20);
      }
    } else if (command.type === 'get_session_stats') response({ tokens: { input: 10, output: 4 }, cost: 0.001 });
    else if (command.type === 'abort') {
      response({});
      if (mode !== 'ignore-abort' && active) send({ type: 'prompt_result', id: 'prompt-1', status: 'aborted', sessionSettled: true });
    }
  });
}

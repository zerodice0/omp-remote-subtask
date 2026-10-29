import { runRemoteTask, type RemoteMode } from '../src/runner.ts';
import { REMOTE_ROLES, type RemoteRole } from '../src/config.ts';

const args = process.argv.slice(2);
const values: Record<string, string> = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]; const value = args[index + 1];
  if (!['--host', '--cwd', '--task', '--mode', '--role', '--timeout', '--cancel-after', '--cancel-on-bash', '--drop-after'].includes(key) || value === undefined) throw new Error(`Invalid arguments near ${key}`);
  values[key] = value;
}
if (!values['--host'] || !values['--cwd'] || !values['--task']) throw new Error('Usage: BUN_BE_BUN=1 omp run scripts/smoke.ts --host NAME --cwd /remote/path --task TEXT [--mode read|exec] [--role tiny|smol|explore|slow] [--timeout SECONDS] [--cancel-after SECONDS | --cancel-on-bash SECONDS | --drop-after SECONDS]');
if (values['--role'] !== undefined && !REMOTE_ROLES.includes(values['--role'] as RemoteRole)) throw new Error(`--role must be one of ${REMOTE_ROLES.join(', ')}`);
if (values['--mode'] !== undefined && !['read', 'exec'].includes(values['--mode'])) throw new Error('--mode must be read or exec');
if (['--cancel-after', '--cancel-on-bash', '--drop-after'].filter(key => values[key]).length > 1) throw new Error('Choose cancellation or transport drop, not both');
for (const key of ['--timeout', '--cancel-after', '--cancel-on-bash', '--drop-after']) if (values[key] && (!Number.isFinite(Number(values[key])) || Number(values[key]) <= 0)) throw new Error(`${key} must be positive seconds`);
const controller = new AbortController();
let timer: NodeJS.Timeout | undefined;
try {
  const result = await runRemoteTask({ host: values['--host'], cwd: values['--cwd'], task: values['--task'], mode: values['--mode'] as RemoteMode | undefined, role: values['--role'] as RemoteRole | undefined, timeoutSeconds: values['--timeout'] ? Number(values['--timeout']) : undefined }, {
    signal: controller.signal,
    onUpdate: (text, { progress }) => {
      process.stderr.write(text + '\n');
      if (values['--cancel-on-bash'] && !timer && progress.toolCalls.some(tool => tool.name === 'bash' && tool.status === 'running')) timer = setTimeout(() => controller.abort(), Number(values['--cancel-on-bash']) * 1000);
    },
    onTransportSpawn: child => {
      if (values['--cancel-after']) timer = setTimeout(() => controller.abort(), Number(values['--cancel-after']) * 1000);
      if (values['--drop-after']) timer = setTimeout(() => child.kill('SIGKILL'), Number(values['--drop-after']) * 1000);
    },
  });
  console.log(JSON.stringify(result.details, null, 2));
  process.stderr.write(result.text + '\n');
  process.exitCode = result.details.status === 'completed' ? 0 : 1;
} finally { clearTimeout(timer); }

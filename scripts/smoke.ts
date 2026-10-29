import { runRemoteTask } from '../src/runner.ts';
import { REMOTE_ROLES, type RemoteRole } from '../src/config.ts';

const args = process.argv.slice(2);
const values: Record<string, string> = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]; const value = args[index + 1];
  if (!['--host', '--cwd', '--task', '--role', '--timeout', '--cancel-after', '--drop-after'].includes(key) || value === undefined) throw new Error(`Invalid arguments near ${key}`);
  values[key] = value;
}
if (!values['--host'] || !values['--cwd'] || !values['--task']) throw new Error('Usage: BUN_BE_BUN=1 omp run scripts/smoke.ts --host NAME --cwd /remote/path --task TEXT [--role tiny|smol|explore|slow] [--timeout SECONDS] [--cancel-after SECONDS | --drop-after SECONDS]');
if (values['--role'] !== undefined && !REMOTE_ROLES.includes(values['--role'] as RemoteRole)) throw new Error(`--role must be one of ${REMOTE_ROLES.join(', ')}`);
if (values['--cancel-after'] && values['--drop-after']) throw new Error('Choose cancellation or transport drop, not both');
for (const key of ['--timeout', '--cancel-after', '--drop-after']) if (values[key] && (!Number.isFinite(Number(values[key])) || Number(values[key]) <= 0)) throw new Error(`${key} must be positive seconds`);
const controller = new AbortController();
let timer: NodeJS.Timeout | undefined;
try {
  const result = await runRemoteTask({ host: values['--host'], cwd: values['--cwd'], task: values['--task'], role: values['--role'] as RemoteRole | undefined, timeoutSeconds: values['--timeout'] ? Number(values['--timeout']) : undefined }, {
    signal: controller.signal,
    onUpdate: text => process.stderr.write(text + '\n'),
    onTransportSpawn: child => {
      if (values['--cancel-after']) timer = setTimeout(() => controller.abort(), Number(values['--cancel-after']) * 1000);
      if (values['--drop-after']) timer = setTimeout(() => child.kill('SIGKILL'), Number(values['--drop-after']) * 1000);
    },
  });
  console.log(JSON.stringify(result.details, null, 2));
  process.stderr.write(result.text + '\n');
  process.exitCode = result.details.status === 'completed' ? 0 : 1;
} finally { clearTimeout(timer); }

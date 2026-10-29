import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { loadConfig } from './config.ts';
import { runRemoteTask } from './runner.ts';

export default function (pi: ExtensionAPI) {
  let hosts = 'none configured';
  try { hosts = Object.keys(loadConfig().hosts).join(', ') || hosts; } catch { /* Registration must survive missing configuration. */ }
  pi.registerTool({
    name: 'remote_task',
    label: 'Remote Task',
    approval: 'exec',
    loadMode: 'essential',
    description: `Run one read-only investigation on a configured SSH host (${hosts}). Requires an absolute remote cwd and a self-contained task. Remote files are not synchronized. Uses the remote user's authentication, context files and model settings. Never retries a lost prompt; unknown means completion or cancellation could not be confirmed.`,
    parameters: pi.zod.object({
      host: pi.zod.string().describe('Configured host name, not an arbitrary SSH target'),
      cwd: pi.zod.string().describe('Absolute remote working directory'),
      task: pi.zod.string().describe('Self-contained read-only investigation and required answer'),
      model: pi.zod.string().optional().describe('Optional provider/model[:thinking] override'),
      timeoutSeconds: pi.zod.number().optional().describe('Positive timeout within the configured maximum'),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await runRemoteTask(params, {
          signal, cwd: ctx.cwd,
          onUpdate: text => onUpdate?.({ content: [{ type: 'text', text }], details: { phase: 'remote_task' } }),
        });
        return { content: [{ type: 'text', text: result.text }], details: result.details, isError: result.details.status !== 'completed' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `remote_task could not start: ${message}` }], details: { status: 'failed', error: message }, isError: true };
      }
    },
  });
}

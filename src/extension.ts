import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { loadConfig, REMOTE_ROLES } from './config.ts';
import { runRemoteTask } from './runner.ts';
import { renderCall, renderResult } from './render.ts';

export default function (pi: ExtensionAPI) {
  let hosts = 'none configured';
  try { hosts = Object.keys(loadConfig().hosts).join(', ') || hosts; } catch { /* Registration must survive missing configuration. */ }
  pi.registerTool({
    name: 'remote_task',
    label: 'Remote Task',
    approval: 'exec',
    loadMode: 'essential',
    description: `Run one read-only investigation on a configured SSH host (${hosts}). Requires an absolute remote cwd and a self-contained task. Remote files are not synchronized. Uses the remote user's authentication and context files. Each host maps workload roles to its own configured model and thinking effort; these differ per host. Actual model and effort are reported in result details. Never retries a lost prompt; unknown means completion or cancellation could not be confirmed.`,
    parameters: pi.zod.object({
      host: pi.zod.string().describe('Configured host name, not an arbitrary SSH target'),
      cwd: pi.zod.string().describe('Absolute remote working directory'),
      task: pi.zod.string().describe('Self-contained read-only investigation and required answer'),
      role: pi.zod.enum(REMOTE_ROLES).optional().describe('Workload role (host default, otherwise explore): tiny = single-fact lookup, such as a version string or whether a file/setting exists; smol = small well-scoped read of one or two named files with a short summary; explore = multi-file investigation, code-path tracing, or config comparison; slow = hard root-cause analysis or design judgment where a wrong answer is costly, slowest and most expensive. The remote host chooses the model and effort for each role.'),
      timeoutSeconds: pi.zod.number().optional().describe('Optional positive timeout in seconds, defaulting per resolved role from config.roleTimeoutSeconds (built-in tiny 120 s, smol 300 s, explore 900 s, slow 1800 s). Must not exceed the configured maximum. Omit unless the task needs a different bound.'),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await runRemoteTask(params, {
          signal, cwd: ctx.cwd,
          onUpdate: (text, details) => onUpdate?.({ content: [{ type: 'text', text }], details }),
        });
        return { content: [{ type: 'text', text: result.text }], details: result.details, isError: result.details.status !== 'completed' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `remote_task could not start: ${message}` }], details: { status: 'failed', error: message }, isError: true };
      }
    },
    renderCall,
    renderResult,
  });
}

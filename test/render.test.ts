import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { createProgress, fitLine, MAX_TOOL_CALLS, progressSnapshot, progressText, reduceProgress, renderCall, renderResult, summarizeArgs, type RemoteProgress } from '../src/render.ts';
import type { RpcFrame } from '../src/rpc-frames.ts';

// Captured explore/slow RPC frames from 2026-10-29. Large tool results, thinking,
// repeated turn_end messages and assistant text after 160 characters are omitted.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/progress-frames.json', import.meta.url), 'utf8')) as { sourceRun: string; frames: { at: string; frame: RpcFrame }[] }[];

function replay(index: number) {
  const fixture = fixtures[index];
  const startedAt = Date.parse(fixture.frames[0].at);
  return fixture.frames.reduce((progress, row) => reduceProgress(progress, row.frame, Date.parse(row.at)), createProgress(fixture.sourceRun, 'mac-studio', index === 0 ? 'explore' : 'slow', startedAt));
}

test('summarizes read ranges, grep, glob and other arguments within 80 cells', () => {
  expect(summarizeArgs('read', { path: 'README.md:12-40' })).toBe('README.md:12-40');
  expect(summarizeArgs('grep', { pattern: 'message_end', path: 'src/**' })).toContain('message_end · src/**');
  expect(summarizeArgs('glob', { path: '**/*.ts' })).toBe('**/*.ts');
  expect(summarizeArgs('glob', { pattern: '*.md' })).toBe('*.md');
  expect(summarizeArgs('other', { limit: 4 })).toBe('{"limit":4}');
  for (const summary of [summarizeArgs('read', { path: '경로🙂'.repeat(90) }), summarizeArgs('other', { text: 'x'.repeat(200) })]) expect(Bun.stringWidth(summary)).toBeLessThanOrEqual(80);
  expect(summarizeArgs('read', { path: '\x1b[31msecret\n\tfile' })).toBe('secret file');
  expect(summarizeArgs('read', null)).toBe('null');
});

test.each([0, 1])('replays real RPC tools and cumulative assistant usage without counting turn_end twice (%s)', index => {
  const progress = replay(index);
  const expectedCalls = index === 0 ? 14 : 63;
  expect(progress.totalToolCalls).toBe(expectedCalls);
  expect(progress.toolCalls).toHaveLength(Math.min(expectedCalls, MAX_TOOL_CALLS));
  expect(progress.toolCalls.every(call => call.status === 'done' || call.status === 'error')).toBe(true);
  expect(progress.toolCalls.every(call => call.durationMs >= 0)).toBe(true);
  expect(progress.actualModel).toBe(index === 0 ? 'openai-codex/gpt-6.1-sol' : 'anthropic/claude-opus-5-5');
  const messages = fixtures[index].frames.filter(row => row.frame.type === 'message_end').map(row => row.frame.message as { usage: { input: number; output: number; cacheRead: number; cost: { total: number } } });
  expect(progress.usage.input).toBe(messages.reduce((sum, message) => sum + message.usage.input, 0));
  expect(progress.usage.output).toBe(messages.reduce((sum, message) => sum + message.usage.output, 0));
  expect(progress.usage.cacheRead).toBe(messages.reduce((sum, message) => sum + message.usage.cacheRead, 0));
  expect(progress.usage.cost.total).toBeCloseTo(messages.reduce((sum, message) => sum + message.usage.cost.total, 0), 8);
});

test('startup model, text deltas, errors, stable order and snapshots are structured and immutable', () => {
  const initial = createProgress('run-1', 'mac-studio', 'smol', 1000);
  let progress = reduceProgress(initial, { type: 'response', id: 'state-1', success: true, data: { model: { provider: 'openai-codex', id: 'gpt-6.1-terra' }, thinkingLevel: 'low' } }, 1100);
  expect(progress.actualModel).toBe('openai-codex/gpt-6.1-terra');
  expect(progress.thinkingLevel).toBe('low');
  const start = { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'AGENTS.md:1-80' } };
  progress = reduceProgress(progress, start, 1200);
  progress = reduceProgress(progress, start, 1300);
  expect(progress.totalToolCalls).toBe(1);
  const snapshot = progressSnapshot(progress, 'running', 'smol', 1500);
  expect(snapshot.toolCalls[0].durationMs).toBe(300);
  expect(progress.toolCalls[0].durationMs).toBe(0);
  progress = reduceProgress(progress, { type: 'tool_execution_start', toolCallId: 'b', toolName: 'glob', args: { path: '*.md' } }, 1300);
  progress = reduceProgress(progress, { type: 'tool_execution_end', toolCallId: 'a', isError: true }, 1800);
  expect(progress.toolCalls.map(call => call.id)).toEqual(['a', 'b']);
  expect(progress.toolCalls[0]).toMatchObject({ status: 'error', durationMs: 600 });
  progress = reduceProgress(progress, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private thinking' } }, 1800);
  expect(progress.assistantTextTail).toBe('');
  for (const delta of ['First ', 'answer']) progress = reduceProgress(progress, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }, 1900);
  expect(progress.assistantTextTail).toBe('First answer');
  progress = reduceProgress(progress, { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'not assistant' }] } }, 2000);
  expect(progress.assistantTextTail).toBe('First answer');
  progress = reduceProgress(progress, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(4000) } }, 2100);
  expect(progress.assistantTextTail.length).toBeLessThanOrEqual(1200);
  expect(initial.toolCalls).toHaveLength(0);
  const fallback = progressText(snapshot);
  for (const field of ['mac-studio', 'smol', 'running', 'AGENTS.md:1-80', 'low']) expect(fallback).toContain(field);
});

const theme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m` };
function assertWidths(lines: readonly string[], width: number) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(Bun.stringWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(width);
}

test('call, partial and final renderers fit terminal cells and expose key fields', () => {
  let progress: RemoteProgress = { ...replay(0), role: 'smol', phase: 'running', thinkingLevel: 'low', assistantTextTail: 'Working on the answer.\n검토 중🙂' };
  const partial = renderResult({ content: [], details: { progress } }, { isPartial: true, expanded: false }, theme);
  const partialText = partial.render(160).map(stripVTControlCharacters).join('\n');
  for (const field of ['mac-studio', 'smol', 'gpt-6.1-sol', 'low', '14 tools', 'in ', 'cache ', '$', 'read', 'Working on the answer.']) expect(partialText).toContain(field);
  const result = { content: [{ type: 'text', text: 'Three rules:\n1. Keep changes read-only.\n2. Follow AGENTS.md.\n3. Follow CLAUDE.md.\n' + '한글🙂'.repeat(100) }], details: {
    status: 'completed' as const, host: 'mac-studio', role: 'smol' as const, actualModel: progress.actualModel, thinkingLevel: 'low', durationMs: 2400,
    totalToolCalls: progress.totalToolCalls, toolCalls: progress.toolCalls, usage: progress.usage, remoteSessionPath: '/remote/sessions/run.jsonl', localLogDir: '/local/logs/run',
  } };
  const collapsed = renderResult(result, { isPartial: false, expanded: false }, theme);
  const collapsedText = collapsed.render(160).map(stripVTControlCharacters).join('\n');
  for (const field of ['completed', 'gpt-6.1-sol', '2.4s', '14 tools', '$', 'Three rules:']) expect(collapsedText).toContain(field);
  expect(collapsedText).not.toContain('/remote/sessions');
  const expanded = renderResult(result, { isPartial: false, expanded: true });
  const expandedText = expanded.render(160).join('\n');
  for (const field of ['3. Follow CLAUDE.md.', '/remote/sessions/run.jsonl', '/local/logs/run', progress.toolCalls[0].args]) expect(expandedText).toContain(field);
  for (const width of [0, 1, 8, 20, 40, 80, 160]) {
    for (const view of [partial, collapsed, expanded, renderCall({ host: 'mac-studio', role: 'smol', task: '키돌이🙂'.repeat(30) }, { expanded: false, isPartial: true }, theme)]) assertWidths(view.render(width), width);
  }
  expect(partial.render(80)).toBe(partial.render(80));
  partial.invalidate();
  assertWidths(partial.render(80), 80);
  const missingTheme = renderResult(result, { isPartial: false, expanded: false }, { fg: () => { throw new Error('missing token'); } });
  expect(missingTheme.render(80).join('\n')).toContain('completed');
  expect(fitLine('e\u0301🙂한글', 4)).not.toContain('\ufffd');
});

test('read mode preserves the existing call, header and plain-text presentation', () => {
  const options = { isPartial: false, expanded: false };
  const args = { host: 'mac-studio', role: 'smol', task: 'Inspect the config' };
  const expectedCall = ['mac-studio · smol · Inspect the config'];
  expect(renderCall(args, options).render(160)).toEqual(expectedCall);
  expect(renderCall({ ...args, mode: 'read' }, options).render(160)).toEqual(expectedCall);
  const progress = createProgress('read-1', 'mac-studio', 'smol', 1000);
  expect(progress.mode).toBe('read');
  expect(progressText(progress)).toStartWith('mac-studio · smol · probe · resolving model · 0ms · 0 tools');
  const partial = renderResult({ content: [], details: { progress } }, { ...options, isPartial: true });
  expect(partial.render(160)[0]).toBe('mac-studio · smol · probe · resolving model');
  const result = { content: [{ type: 'text', text: 'Answer' }], details: { host: 'mac-studio', role: 'smol' as const, status: 'completed' as const } };
  expect(renderResult(result, options).render(160)[0]).toBe('completed · mac-studio · smol · resolving model');
  expect(renderResult({ ...result, details: { ...result.details, mode: 'read' } }, options).render(160)).toEqual(renderResult(result, options).render(160));
});

test('exec mode is explicit in calls, partial and final headers and plain-text fallback', () => {
  const progress = createProgress('exec-1', 'mac-studio', 'smol', 1000, 'exec');
  const snapshot = progressSnapshot(progress, 'running', 'smol', 1200);
  expect(snapshot.mode).toBe('exec');
  expect(progressText(snapshot)).toStartWith('[exec] mac-studio · smol · running');
  const options = { isPartial: false, expanded: false };
  const call = renderCall({ host: 'mac-studio', role: 'smol', task: 'Edit config', mode: 'exec' }, options, theme);
  expect(call.render(160).map(stripVTControlCharacters).join('\n')).toBe('[exec] mac-studio · smol · Edit config');
  expect(stripVTControlCharacters(call.render(12)[0])).toStartWith('[exec]');
  const partial = renderResult({ content: [], details: { progress: snapshot } }, { ...options, isPartial: true }, theme);
  expect(stripVTControlCharacters(partial.render(160)[0])).toStartWith('[exec] mac-studio · smol · running');
  const result = { content: [{ type: 'text', text: 'Changed /remote/project/config.json' }], details: {
    mode: 'exec' as const, status: 'completed' as const, host: 'mac-studio', role: 'smol' as const,
  } };
  const collapsed = renderResult(result, options, theme);
  const expanded = renderResult(result, { ...options, expanded: true });
  for (const view of [collapsed, expanded]) {
    expect(stripVTControlCharacters(view.render(160)[0])).toStartWith('[exec] completed · mac-studio · smol');
  }
  const failed = renderResult({ content: [{ type: 'text', text: 'remote_task could not start: denied' }], details: { mode: 'exec', status: 'failed' }, isError: true }, options);
  expect(failed.render(160)[0]).toStartWith('[exec] failed');
  for (const width of [0, 1, 8, 20, 40, 80, 160]) {
    for (const view of [call, partial, collapsed, expanded, failed]) assertWidths(view.render(width), width);
  }
});

test('early failures without run details still render the error', () => {
  const view = renderResult({ content: [{ type: 'text', text: 'remote_task could not start: no hosts' }], isError: true }, { isPartial: false, expanded: false });
  expect(view.render(100).join('\n')).toContain('no hosts');
  expect(view.render(100).join('\n')).toContain('failed');
});

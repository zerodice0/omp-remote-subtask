import { stripVTControlCharacters } from 'node:util';
import { createRunState, reduceRunState, type RunUsage } from './run-state.ts';
import type { RpcFrame } from './rpc-frames.ts';
import type { RemoteRole } from './config.ts';
import type { RemoteTaskDetails } from './runner.ts';

export type RemotePhase = 'probe' | 'starting' | 'running' | 'cancel_abort' | 'cancel_terminate' | 'stats';
export interface RemoteToolCall {
  id: string; name: string; args: string; status: 'running' | 'done' | 'error';
  startedAt: number; durationMs: number;
}
export interface RemoteProgress {
  runId: string; host: string; role: RemoteRole; actualModel: string | null; thinkingLevel: string | null;
  phase: RemotePhase; startedAt: number; elapsedMs: number;
  toolCalls: RemoteToolCall[]; totalToolCalls: number; usage: RunUsage; assistantTextTail: string;
}
export const MAX_TOOL_CALLS = 50;
const TEXT_TAIL_LIMIT = 1200;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const clean = (text: string) => stripVTControlCharacters(text).replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const singleLine = (value: string) => clean(value).replace(/\s+/g, ' ').trim();

/** Bun ships with omp; use its terminal-cell measurement, including CJK and emoji. */
export function fitLine(text: string, width: number): string {
  text = singleLine(text);
  width = Math.max(0, Math.floor(width));
  if (Bun.stringWidth(text) <= width) return text;
  if (width < 1) return '';
  let result = ''; let cells = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = Bun.stringWidth(segment);
    if (cells + size > width - 1) break;
    result += segment; cells += size;
  }
  return result + '…';
}

export function summarizeArgs(name: string, raw: unknown): string {
  const args = record(raw);
  if (name === 'read' && typeof args.path === 'string') return fitLine(args.path, 80);
  if (name === 'grep') return fitLine(`${String(args.pattern ?? '')}${args.path ? ` · ${args.path}` : ''}`, 80);
  if (name === 'glob') return fitLine(String(args.pattern ?? args.path ?? ''), 80);
  try { return fitLine(JSON.stringify(raw) ?? '', 80); } catch { return ''; }
}

export function createProgress(runId: string, host: string, role: RemoteRole, startedAt: number): RemoteProgress {
  return { runId, host, role, actualModel: null, thinkingLevel: null, phase: 'probe', startedAt, elapsedMs: 0,
    toolCalls: [], totalToolCalls: 0, usage: createRunState().usage, assistantTextTail: '' };
}

/** Frame timestamps are supplied by the caller so replay tests stay deterministic. */
export function reduceProgress(progress: RemoteProgress, frame: RpcFrame, now: number): RemoteProgress {
  let next = { ...progress, elapsedMs: Math.max(0, now - progress.startedAt) };
  if (frame.type === 'response' && frame.id === 'state-1' && frame.success === true) {
    const data = record(frame.data); const model = record(data.model);
    next.actualModel = typeof model.id === 'string' ? `${typeof model.provider === 'string' ? `${model.provider}/` : ''}${model.id}` : next.actualModel;
    next.thinkingLevel = typeof data.thinkingLevel === 'string' ? data.thinkingLevel : next.thinkingLevel;
  } else if (frame.type === 'tool_execution_start' && typeof frame.toolCallId === 'string' && typeof frame.toolName === 'string') {
    if (progress.toolCalls.some(call => call.id === frame.toolCallId)) return next;
    const call: RemoteToolCall = { id: frame.toolCallId, name: singleLine(frame.toolName), args: summarizeArgs(frame.toolName, frame.args), status: 'running', startedAt: now, durationMs: 0 };
    next.toolCalls = [...progress.toolCalls, call].slice(-MAX_TOOL_CALLS);
    next.totalToolCalls++;
  } else if (frame.type === 'tool_execution_end' && typeof frame.toolCallId === 'string') {
    next.toolCalls = progress.toolCalls.map(call => call.id === frame.toolCallId
      ? { ...call, status: frame.isError === true ? 'error' : 'done', durationMs: Math.max(0, now - call.startedAt) } : call);
  } else if (frame.type === 'message_start' && record(frame.message).role === 'assistant') {
    next.assistantTextTail = '';
  } else if (frame.type === 'message_update') {
    const delta = record(frame.assistantMessageEvent);
    if (delta.type === 'text_delta' && typeof delta.delta === 'string') next.assistantTextTail = (progress.assistantTextTail + delta.delta).slice(-TEXT_TAIL_LIMIT);
  } else if (frame.type === 'message_end' && record(frame.message).role === 'assistant') {
    // Share the runner's usage accounting: turn_end repeats the assistant message and must not count it again.
    const state = reduceRunState({ ...createRunState(), usage: progress.usage, actualModel: progress.actualModel }, { kind: 'frame', frame });
    next.usage = state.usage;
    next.actualModel = state.actualModel ?? progress.actualModel;
    next.assistantTextTail = state.lastAssistantText.slice(-TEXT_TAIL_LIMIT);
  }
  return next;
}

export function progressSnapshot(progress: RemoteProgress, phase: RemotePhase, role: RemoteRole, now: number): RemoteProgress {
  return { ...progress, phase, role, elapsedMs: Math.max(0, now - progress.startedAt),
    toolCalls: progress.toolCalls.map(call => call.status === 'running' ? { ...call, durationMs: Math.max(0, now - call.startedAt) } : call) };
}

const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const tokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const modelLabel = (model: string | null, effort: string | null) => `${model ?? 'resolving model'}${effort ? ` · ${effort}` : ''}`;
const usageLabel = (usage: RunUsage | null) => usage ? `in ${tokens(usage.input)} out ${tokens(usage.output)} cache ${tokens(usage.cacheRead)} · $${usage.cost.total.toFixed(4)}` : '';
const toolLine = (call: RemoteToolCall) => `${call.status === 'running' ? '◷' : call.status === 'error' ? '✗' : '✓'} ${call.name} ${call.args} · ${duration(call.durationMs)}`;

export function progressText(progress: RemoteProgress): string {
  return [ `${progress.host} · ${progress.role} · ${progress.phase} · ${modelLabel(progress.actualModel, progress.thinkingLevel)} · ${duration(progress.elapsedMs)} · ${progress.totalToolCalls} tools · ${usageLabel(progress.usage)}`,
    ...progress.toolCalls.slice(-4).map(toolLine), ...clean(progress.assistantTextTail).split('\n').slice(-3),
  ].join('\n');
}

type RenderTone = 'toolTitle' | 'toolOutput' | 'accent' | 'muted' | 'dim' | 'error' | 'success';
export interface RenderTheme { fg?: (color: RenderTone, text: string) => string; bold?: (text: string) => string }
export interface RenderOptions { expanded: boolean; isPartial: boolean }
export interface RenderComponent { render(width: number): readonly string[]; invalidate(): void }
export interface RemoteRenderResult {
  content: { type: string; text?: string }[];
  details?: Omit<Partial<RemoteTaskDetails>, 'error'> & { progress?: RemoteProgress; error?: RemoteTaskDetails['error'] | string };
  isError?: boolean;
}
const color = (theme: RenderTheme | undefined, name: RenderTone, text: string) => {
  try { return theme?.fg?.(name, text) ?? text; } catch { return text; }
};

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [''];
  const rows: string[] = []; let row = ''; let cells = 0;
  for (const { segment } of graphemes.segment(clean(line))) {
    const size = Bun.stringWidth(segment);
    if (cells + size > width && row) { rows.push(row); row = ''; cells = 0; }
    if (size <= width) { row += segment; cells += size; }
  }
  rows.push(row);
  return rows;
}

function component(build: (width: number) => string[]): RenderComponent {
  let lastWidth = -1; let rows: string[] = [];
  return { render(width) { width = Math.max(0, Math.floor(width)); if (width !== lastWidth) { rows = build(width); lastWidth = width; } return rows; }, invalidate() { lastWidth = -1; } };
}

export function renderCall(args: { host?: string; role?: string; task?: string }, _options: RenderOptions, theme?: RenderTheme): RenderComponent {
  return component(width => [color(theme, 'toolTitle', fitLine(`${args.host ?? 'remote'} · ${args.role ?? 'host default'} · ${args.task ?? ''}`, width))]);
}

export function renderResult(result: RemoteRenderResult, options: RenderOptions, theme?: RenderTheme): RenderComponent {
  return component(width => {
    const details = result.details;
    const progress = details?.progress;
    const rows: string[] = [];
    const add = (text: string, tone: RenderTone = 'toolOutput', wrap = false) => {
      for (const line of clean(text).split('\n')) for (const row of wrap ? wrapLine(line, width) : [fitLine(line, width)]) rows.push(color(theme, tone, row));
    };
    if (options.isPartial && progress) {
      add(`${progress.host} · ${progress.role} · ${progress.phase} · ${modelLabel(progress.actualModel, progress.thinkingLevel)}`, 'accent', true);
      add(`${duration(progress.elapsedMs)} · ${progress.totalToolCalls} tools · ${usageLabel(progress.usage)}`, 'muted', true);
      for (const call of progress.toolCalls.slice(-6)) add(toolLine(call), call.status === 'error' ? 'error' : call.status === 'running' ? 'accent' : 'dim');
      for (const line of clean(progress.assistantTextTail).split('\n').filter(Boolean).slice(-3)) add(line);
      return rows;
    }
    const status = details?.status ?? (result.isError ? 'failed' : 'completed');
    add(`${status} · ${details?.host ?? 'remote'} · ${details?.role ?? ''} · ${modelLabel(details?.actualModel ?? null, details?.thinkingLevel ?? null)}`, status === 'completed' ? 'success' : 'error', true);
    add(`${duration(details?.durationMs ?? 0)} · ${details?.totalToolCalls ?? details?.toolCalls?.length ?? 0} tools · ${usageLabel(details?.usage ?? null)}`, 'muted', true);
    const answer = result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
    const answerLines = clean(answer).split('\n');
    for (const line of options.expanded ? answerLines : answerLines.filter(Boolean).slice(0, 3)) add(line, 'toolOutput', options.expanded);
    if (options.expanded) {
      add(`Tools (${details?.totalToolCalls ?? 0} total; last ${details?.toolCalls?.length ?? 0} retained)`, 'muted');
      for (const call of details?.toolCalls ?? []) add(toolLine(call), call.status === 'error' ? 'error' : 'dim', true);
      add(`Remote session: ${details?.remoteSessionPath ?? '(not available)'}`, 'muted', true);
      add(`Local logs: ${details?.localLogDir ?? '(not available)'}`, 'muted', true);
    }
    return rows;
  });
}

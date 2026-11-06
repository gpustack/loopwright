import { readFileSync } from 'node:fs';
import type { Digest } from '@loopwright/core';
import { canonical, digest, freeze } from './boundary.js';
import { refuse } from './errors.js';
import type { PiOpenInput } from './types.js';
export interface CatalogIdentity { readonly contextWindow: number; readonly digest: Digest }
/** Read the selected pinned artifact once per construction, then retain its validated window and identity. */
export function selectedCatalog(input: PiOpenInput): CatalogIdentity {
  const data = JSON.parse(readFileSync(new URL('./providers/data/github-copilot.json', import.meta.resolve('@earendil-works/pi-ai')), 'utf8')) as Record<string, Record<string, { api: string; provider: string; id: string; contextWindow: number; maxTokens: number; thinkingLevelMap: Record<string, string | null> }>>;
  const selection = input.policy.selection, model = data['anthropic-messages']?.['chat:' + selection.model];
  if (!model || model.id !== selection.model || model.api !== selection.api || model.provider !== selection.provider) refuse('MODEL_UNAVAILABLE', '/policy/selection/model');
  if (model.thinkingLevelMap[selection.thinking] !== selection.thinking) refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || model.maxTokens < input.policy.context.maxOutputTokens || Math.min(model.contextWindow, input.policy.context.workingWindowCeiling) < input.policy.context.serviceMargin + input.policy.context.toolReserve + input.policy.context.maxOutputTokens) refuse('CONTEXT_UNSAFE', '/policy/context');
  return freeze({ contextWindow: model.contextWindow, digest: digest(Buffer.from(canonical(model))) });
}

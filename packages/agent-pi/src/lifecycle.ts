import { refuse } from './errors.js';
import { object, integer } from './boundary.js';
export interface NativeCompletion {
  readonly agentEnds: number; readonly agentSettles: number; readonly aborted: boolean;
  readonly compactionEnds: number; readonly compacted: boolean; readonly idle: boolean;
  readonly invocations: number; readonly parserAcks: number; readonly pending: number;
}
/** The native turn barrier is separate from raw provider termination and manual compaction. */
export function verifyNativeCompletion(value: unknown, kind: 'execute' | 'compact'): void {
  const native = object(value, ['agentEnds', 'agentSettles', 'aborted', 'compactionEnds', 'compacted', 'idle', 'invocations', 'parserAcks', 'pending']);
  for (const key of ['agentEnds', 'agentSettles', 'compactionEnds', 'invocations', 'parserAcks', 'pending']) integer(native[key], 0, 2048, '/native/' + key);
  if (native.aborted !== false || native.idle !== true || native.pending !== 0 || native.invocations === 0 || native.parserAcks !== native.invocations
    || typeof native.compacted !== 'boolean' || (kind === 'execute' ? (native.agentSettles as number) < 1 : native.compactionEnds !== 1 || native.compacted !== true)) refuse('RECOVERY_REQUIRED', '', { phase: 'session', effect: 'possible' });
}

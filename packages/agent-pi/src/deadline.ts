export interface DeadlineClock {
  readonly set: (callback: () => void, milliseconds: number) => unknown;
  readonly clear: (handle: unknown) => void;
}
const clock: DeadlineClock = { set: (callback, milliseconds) => setTimeout(callback, milliseconds), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
/** Rearm long task deadlines without Node's oversized-timer clamp. Ports are internal test seams only. */
export function scheduleDeadline(remaining: () => number | null, expired: () => void, ports = clock): () => void {
  let stopped = false, handle: unknown;
  const arm = () => {
    if (stopped) return;
    const left = remaining();
    if (left === null || !Number.isFinite(left) || left <= 0) { stopped = true; expired(); return; }
    handle = ports.set(arm, Math.min(left, 2147483647));
  };
  arm(); return () => { stopped = true; ports.clear(handle); };
}

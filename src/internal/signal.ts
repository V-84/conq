/**
 * `AbortSignal.any` fallback for the Node 20 floor.
 * Prefers native. Trap: AbortSignal.any keeps references — for hot retry loops
 * prefer a single internal controller you can retire, not per-attempt any-signals.
 */
type AnyStatic = { any?: (signals: readonly AbortSignal[]) => AbortSignal };

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as AnyStatic).any;
  if (typeof native === 'function') return native(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  const onAbort = function (this: AbortSignal) {
    controller.abort(this.reason);
    for (const s of signals) s.removeEventListener('abort', onAbort);
  };
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

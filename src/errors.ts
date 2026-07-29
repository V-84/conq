/**
 * Thrown when a task attempt exceeds its `timeoutMs`.
 *
 * @example
 * ```ts
 * import { mapConcurrent, TimeoutError } from 'c-queue';
 * try {
 *   await mapConcurrent([1], async () => new Promise(() => {}), { timeoutMs: 50 });
 * } catch (err) {
 *   if (err instanceof TimeoutError) console.log(err.timeoutMs); // 50
 * }
 * ```
 */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError' as const;
  readonly timeoutMs: number;
  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Task attempt exceeded ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a task is aborted (pre-aborted signal, mid-run abort, `clear()`,
 * or timeout — where `TimeoutError` is the underlying cause).
 *
 * `cause` is the abort reason from the user's `AbortSignal`, when available.
 *
 * @example
 * ```ts
 * import { mapConcurrent, AbortError } from 'c-queue';
 * const ac = new AbortController(); ac.abort('user cancelled');
 * try { await mapConcurrent([1], async () => 1, { signal: ac.signal }); }
 * catch (err) { if (err instanceof AbortError) console.log(err.cause); }
 * ```
 */
export class AbortError extends Error {
  override readonly name = 'AbortError' as const;
  override readonly cause?: unknown;
  constructor(message = 'Aborted', cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAbortError(err: unknown): err is AbortError {
  return err instanceof AbortError || (err instanceof Error && err.name === 'AbortError');
}

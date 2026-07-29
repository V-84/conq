/**
 * A lazy task function. The queue controls when it starts.
 *
 * @example
 * ```ts
 * import type { Task } from 'queue-warden';
 * const t: Task<string> = async (ctx) => { ctx.signal.throwIfAborted(); return 'x'; };
 * ```
 */
export type Task<T> = (context: TaskContext) => T | PromiseLike<T>;

/**
 * Context passed to a task invocation. `signal` fires on run-abort, per-attempt
 * timeout, or `Queue.clear()`. `attempt` is 0 for the first try, 1 for the
 * first retry, and so on.
 *
 * @example
 * ```ts
 * import { mapConcurrent } from 'queue-warden';
 * await mapConcurrent([1], async (item, index, ctx) => {
 *   if (ctx.signal.aborted) throw ctx.signal.reason;
 *   return ctx.attempt;
 * });
 * ```
 */
export interface TaskContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
}

/**
 * Retry configuration. Delays follow `min(minDelayMs * factor ** (n-1), maxDelayMs)`
 * where `n` is 1-based. Jitter modes: `none`, `full` (random × base), `equal`
 * (base/2 + random × base/2). Default `isRetryable` retries everything except
 * `AbortError`. `TimeoutError` is retryable by default.
 *
 * The core admission-control rule: a retry holds its concurrency slot across
 * the backoff delay but **re-acquires a rate-limit token** before firing —
 * this is what makes the naive `p-queue + p-retry` composition wrong.
 *
 * @example
 * ```ts
 * import { mapConcurrent } from 'queue-warden';
 * await mapConcurrent(urls, fetchOne, {
 *   retry: { attempts: 3, minDelayMs: 100, factor: 2, jitter: 'full' },
 * });
 * ```
 */
export interface RetryOptions {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: 'none' | 'full' | 'equal';
  isRetryable?: (error: unknown, attempt: number) => boolean;
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
}

/**
 * Progress snapshot passed to `onProgress` after each task settles (and once
 * initially with zero counters when input is not empty).
 *
 * @example
 * ```ts
 * import { mapConcurrent } from 'queue-warden';
 * await mapConcurrent([1, 2], async (n) => n, {
 *   onProgress: (info) => console.log(`${info.completed}/${info.total ?? '?'}`),
 * });
 * ```
 */
export interface ProgressInfo {
  completed: number;
  succeeded: number;
  failed: number;
  running: number;
  total: number | undefined;
}

/**
 * Options common to `mapConcurrent`, `mapSettled`, `forEachConcurrent`, and
 * `Queue`.
 *
 * @example
 * ```ts
 * import { mapConcurrent } from 'queue-warden';
 * await mapConcurrent([1, 2, 3], async (n) => n * 2, { concurrency: 2 });
 * ```
 */
export interface RunOptions {
  concurrency?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: RetryOptions;
  onProgress?: (info: ProgressInfo) => void;
  intervalMs?: number;
  intervalCap?: number;
}

/**
 * `stopOnError: true` (default) rejects on the first failure after awaiting
 * in-flight settlement. `false` runs everything and rejects with an
 * `AggregateError` whose `errors` are in input-index order.
 *
 * @example
 * ```ts
 * import { mapConcurrent } from 'queue-warden';
 * await mapConcurrent([1, 2], async (n) => n, { stopOnError: false });
 * ```
 */
export interface MapOptions extends RunOptions {
  stopOnError?: boolean;
}

/**
 * Result shape returned by `mapSettled`, carrying input-index.
 *
 * @example
 * ```ts
 * import { mapSettled } from 'queue-warden';
 * const rs = await mapSettled([1], async (n) => n);
 * if (rs[0]!.status === 'fulfilled') console.log(rs[0]!.value);
 * ```
 */
export type SettledResult<R> =
  | { status: 'fulfilled'; value: R; index: number }
  | { status: 'rejected'; reason: unknown; index: number };

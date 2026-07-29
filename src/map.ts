import { normalizeCommonOptions, runPool } from './pool.js';
import type { MapOptions, RunOptions, SettledResult, TaskContext } from './types.js';
import { assertInputNotThenable, assertTaskFunction } from './validate.js';

/**
 * Map a worker over an iterable input with bounded concurrency, preserving
 * input order in the returned array. Rejects on the first failure by default
 * (`stopOnError: true`), after awaiting settlement of all in-flight tasks so
 * shared state is not mutated by orphaned promises.
 *
 * @example
 * ```ts
 * import { mapConcurrent } from 'con-q';
 * const doubled = await mapConcurrent([1, 2, 3], async (n) => n * 2, { concurrency: 2 });
 * // -> [2, 4, 6]
 * ```
 */
export async function mapConcurrent<T, R>(
  input: Iterable<T> | AsyncIterable<T>,
  worker: (item: T, index: number, context: TaskContext) => R | PromiseLike<R>,
  options: MapOptions = {},
): Promise<R[]> {
  assertTaskFunction(worker, 0, 'worker');
  assertInputNotThenable(input);
  const stopOnError = options.stopOnError !== false;
  const normalized = normalizeCommonOptions(options);
  const total = sizeOf(input);

  const results = await runPool<T, R>({
    input,
    worker: (item, index, ctx) => worker(item, index, ctx),
    concurrency: normalized.concurrency,
    signal: options.signal,
    stopOnError,
    onProgress: options.onProgress,
    total,
    retry: normalized.retry,
    timeoutMs: normalized.timeoutMs,
    rateLimiter: normalized.rateLimiter,
  });

  const out: R[] = new Array(results.length);
  const errors: unknown[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === 'fulfilled') {
      out[i] = r.value as R;
    } else if (!stopOnError) {
      errors.push(r.reason);
    }
  }
  if (!stopOnError && errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} task(s) failed`);
  }
  return out;
}

/**
 * Like `mapConcurrent`, but never rejects for individual task failures.
 * Returns per-item settled results in input-index order.
 *
 * @example
 * ```ts
 * import { mapSettled } from 'con-q';
 * const res = await mapSettled([1, 2], async (n) => (n === 1 ? n : Promise.reject('nope')));
 * // res[1] -> { status: 'rejected', reason: 'nope', index: 1 }
 * ```
 */
export async function mapSettled<T, R>(
  input: Iterable<T> | AsyncIterable<T>,
  worker: (item: T, index: number, context: TaskContext) => R | PromiseLike<R>,
  options: RunOptions = {},
): Promise<SettledResult<R>[]> {
  assertTaskFunction(worker, 0, 'worker');
  assertInputNotThenable(input);
  const normalized = normalizeCommonOptions(options);
  const total = sizeOf(input);

  const results = await runPool<T, R>({
    input,
    worker: (item, index, ctx) => worker(item, index, ctx),
    concurrency: normalized.concurrency,
    signal: options.signal,
    stopOnError: false,
    onProgress: options.onProgress,
    total,
    retry: normalized.retry,
    timeoutMs: normalized.timeoutMs,
    rateLimiter: normalized.rateLimiter,
  });

  return results.map<SettledResult<R>>((r) =>
    r.status === 'fulfilled'
      ? { status: 'fulfilled', value: r.value as R, index: r.index }
      : { status: 'rejected', reason: r.reason, index: r.index },
  );
}

/**
 * Fire-and-forget variant: discards results (O(concurrency) memory) for large
 * streams. Same error semantics as `mapConcurrent`.
 *
 * @example
 * ```ts
 * import { forEachConcurrent } from 'con-q';
 * await forEachConcurrent(bigStream, async (item) => save(item), { concurrency: 8 });
 * ```
 */
export async function forEachConcurrent<T>(
  input: Iterable<T> | AsyncIterable<T>,
  worker: (item: T, index: number, context: TaskContext) => unknown | PromiseLike<unknown>,
  options: MapOptions = {},
): Promise<void> {
  assertTaskFunction(worker, 0, 'worker');
  assertInputNotThenable(input);
  const stopOnError = options.stopOnError !== false;
  const normalized = normalizeCommonOptions(options);
  const total = sizeOf(input);

  const errors: { index: number; reason: unknown }[] = [];
  await runPool<T, unknown>({
    input,
    worker: async (item, index, ctx) => {
      try {
        await worker(item, index, ctx);
      } catch (reason) {
        if (!stopOnError) errors.push({ index, reason });
        throw reason;
      }
    },
    concurrency: normalized.concurrency,
    signal: options.signal,
    stopOnError,
    onProgress: options.onProgress,
    total,
    retry: normalized.retry,
    timeoutMs: normalized.timeoutMs,
    rateLimiter: normalized.rateLimiter,
    discardResults: true,
  });

  if (!stopOnError && errors.length > 0) {
    errors.sort((a, b) => a.index - b.index);
    throw new AggregateError(
      errors.map((e) => e.reason),
      `${errors.length} task(s) failed`,
    );
  }
}

function sizeOf<T>(input: Iterable<T> | AsyncIterable<T>): number | undefined {
  if (Array.isArray(input)) return input.length;
  const maybe = input as { size?: unknown; length?: unknown };
  if (typeof maybe.length === 'number') return maybe.length;
  if (typeof maybe.size === 'number') return maybe.size;
  return undefined;
}

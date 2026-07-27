/**
 * Shared scheduler used by both `mapConcurrent`/`mapSettled` and `Queue`.
 * Retry, timeout, rate-limit, priority all layer on top; this file stays
 * focused on: laziness, ordering, immediate slot refill, error handling,
 * abort, progress.
 */
import { AbortError, isAbortError } from './errors.js';
import type { ProgressInfo, RunOptions } from './types.js';
import { validatePositiveIntOrInfinity, validateNonNegativeFinite } from './validate.js';

export interface PoolItem<T> {
  index: number;
  value: T;
}

export interface PoolRunnerContext {
  signal: AbortSignal;
  attempt: number;
}

export interface PoolOptions<T, R> {
  input: Iterable<T> | AsyncIterable<T>;
  worker: (item: T, index: number, ctx: PoolRunnerContext) => R | PromiseLike<R>;
  concurrency: number;
  signal?: AbortSignal | undefined;
  stopOnError: boolean;
  onProgress?: ((info: ProgressInfo) => void) | undefined;
  total: number | undefined;
}

export interface PoolResult<R> {
  status: 'fulfilled' | 'rejected';
  value?: R;
  reason?: unknown;
  index: number;
}

export interface NormalizedCommon {
  concurrency: number;
  timeoutMs?: number;
}
export function normalizeCommonOptions(o: RunOptions): NormalizedCommon {
  const concurrency = o.concurrency === undefined ? 4 : validatePositiveIntOrInfinity('concurrency', o.concurrency);
  const out: NormalizedCommon = { concurrency };
  if (o.timeoutMs !== undefined) out.timeoutMs = validateNonNegativeFinite('timeoutMs', o.timeoutMs);
  const hasInt = o.intervalMs !== undefined;
  const hasCap = o.intervalCap !== undefined;
  if (hasInt !== hasCap) {
    throw new TypeError(
      `conq: 'intervalMs' and 'intervalCap' must be provided together or not at all`,
    );
  }
  if (hasInt) validateNonNegativeFinite('intervalMs', o.intervalMs);
  if (hasCap) validatePositiveIntOrInfinity('intervalCap', o.intervalCap);
  return out;
}

/**
 * Run a pool of `concurrency` workers over an iterable input, preserving
 * input-index in results. Handles laziness, immediate refill, stopOnError,
 * external-signal abort, and progress reporting.
 *
 * Retry, timeout, and rate limiting are the caller's responsibility (they
 * wrap `worker` before calling in).
 */
export async function runPool<T, R>(opts: PoolOptions<T, R>): Promise<PoolResult<R>[]> {
  const { input, worker, concurrency, signal, stopOnError, onProgress } = opts;

  const internalController = new AbortController();
  const onExternalAbort = () => internalController.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) throw new AbortError('Aborted', signal.reason);
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const results: PoolResult<R>[] = [];
  let firstRejection: { reason: unknown; index: number } | undefined;
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let started = 0;

  const emitProgress = (): void => {
    if (!onProgress) return;
    onProgress({
      completed: succeeded + failed,
      succeeded,
      failed,
      running,
      total: opts.total,
    });
  };

  if (onProgress && opts.total !== 0) emitProgress();

  const isSync = isSyncIterable(input);
  const iterator: AsyncIterator<T> | Iterator<T> = isSync
    ? (input as Iterable<T>)[Symbol.iterator]()
    : (input as AsyncIterable<T>)[Symbol.asyncIterator]();

  // Serialize source pulls: even async iterators must be advanced one at a time.
  let pullChain: Promise<IteratorResult<T>> | undefined;
  const pullNext = async (): Promise<IteratorResult<T>> => {
    if (isSync) return (iterator as Iterator<T>).next();
    const p = pullChain
      ? pullChain.then(() => (iterator as AsyncIterator<T>).next())
      : (iterator as AsyncIterator<T>).next();
    pullChain = p;
    return p;
  };

  const runner = async (): Promise<void> => {
    for (;;) {
      if (internalController.signal.aborted) return;
      let step: IteratorResult<T>;
      try {
        step = await pullNext();
      } catch (err) {
        // Source iterator threw. Treat as fatal in stopOnError; otherwise
        // record and stop pulling (no index to attach to — surface as run error).
        internalController.abort(err);
        if (!firstRejection) firstRejection = { reason: err, index: -1 };
        return;
      }
      if (step.done) return;
      const index = started++;
      running++;

      let outcome: PoolResult<R>;
      try {
        const value = await worker(step.value, index, {
          signal: internalController.signal,
          attempt: 0,
        });
        outcome = { status: 'fulfilled', value, index };
      } catch (reason) {
        outcome = { status: 'rejected', reason, index };
      } finally {
        running--;
      }

      results[index] = outcome;
      if (outcome.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        if (stopOnError && !firstRejection) {
          firstRejection = { reason: outcome.reason, index };
          internalController.abort(new AbortError('stopOnError'));
        }
      }
      emitProgress();
    }
  };

  const limit = concurrency === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : concurrency;
  // Spawn only as many runners as we could plausibly use.
  const effective =
    limit === Number.POSITIVE_INFINITY || opts.total === undefined
      ? Number.isFinite(limit)
        ? limit
        : 1024 // async input, unbounded concurrency: cap at a sane number (won't matter — laziness bounds it)
      : Math.min(limit, opts.total);
  const runnerCount = Math.max(1, effective);
  const runners = Array.from({ length: runnerCount }, () => runner());
  try {
    await Promise.all(runners);
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    // Try to release the source iterator's resources.
    if (!isSync) {
      try {
        await (iterator as AsyncIterator<T>).return?.();
      } catch {
        /* ignore */
      }
    } else {
      try {
        (iterator as Iterator<T>).return?.();
      } catch {
        /* ignore */
      }
    }
  }

  if (signal && signal.aborted) {
    // External abort takes precedence over stopOnError's synthetic abort.
    throw new AbortError('Aborted', signal.reason);
  }

  if (firstRejection && stopOnError) {
    if (isAbortError(firstRejection.reason)) throw firstRejection.reason;
    throw firstRejection.reason;
  }
  return results;
}

function isSyncIterable<T>(x: Iterable<T> | AsyncIterable<T>): x is Iterable<T> {
  return typeof (x as Iterable<T>)[Symbol.iterator] === 'function';
}

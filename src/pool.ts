/**
 * Shared scheduler used by both `mapConcurrent`/`mapSettled` and `Queue`.
 * Handles: laziness, ordering, immediate slot refill, error handling, abort,
 * progress, per-attempt retry, per-attempt timeout, rate-limit token
 * acquisition (§4.8 admission-control rule).
 */
import { AbortError, TimeoutError, isAbortError } from './errors.js';
import { type RateLimiter, createRateLimiter } from './rate-limit.js';
import { NO_RETRY, type NormalizedRetry, computeBackoffMs, normalizeRetry } from './retry.js';
import type { ProgressInfo, RunOptions } from './types.js';
import { validateNonNegativeFinite, validatePositiveIntOrInfinity } from './validate.js';

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
  retry?: NormalizedRetry | undefined;
  timeoutMs?: number | undefined;
  rateLimiter?: RateLimiter | undefined;
  /** If true, per-item results are not retained (O(concurrency) memory) — used by forEachConcurrent. */
  discardResults?: boolean;
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
  retry: NormalizedRetry;
  rateLimiter?: RateLimiter;
}

export function normalizeCommonOptions(o: RunOptions): NormalizedCommon {
  const concurrency =
    o.concurrency === undefined ? 4 : validatePositiveIntOrInfinity('concurrency', o.concurrency);
  const out: NormalizedCommon = { concurrency, retry: normalizeRetry(o.retry) };
  if (o.timeoutMs !== undefined)
    out.timeoutMs = validateNonNegativeFinite('timeoutMs', o.timeoutMs);
  const hasInt = o.intervalMs !== undefined;
  const hasCap = o.intervalCap !== undefined;
  if (hasInt !== hasCap) {
    throw new TypeError(
      `conq: 'intervalMs' and 'intervalCap' must be provided together or not at all`,
    );
  }
  if (hasInt && hasCap) {
    const ms = validateNonNegativeFinite('intervalMs', o.intervalMs);
    const cap = validatePositiveIntOrInfinity('intervalCap', o.intervalCap);
    out.rateLimiter = createRateLimiter(
      ms,
      cap === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : cap,
    );
  }
  return out;
}

/**
 * Attempt loop: rate token → invoke with per-attempt timeout → retry with
 * backoff. `poolSignal` fires on run-abort or stopOnError-abort; a
 * per-attempt controller adds the timeout signal on top.
 */
export async function runAttempts<T, R>(
  item: T,
  index: number,
  worker: PoolOptions<T, R>['worker'],
  poolSignal: AbortSignal,
  retry: NormalizedRetry,
  timeoutMs: number | undefined,
  rateLimiter: RateLimiter | undefined,
): Promise<R> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (poolSignal.aborted) throw new AbortError('Aborted', poolSignal.reason);

    if (rateLimiter) {
      // Re-acquire a rate-limit token every attempt (the whole point of A1).
      await rateLimiter.acquire(poolSignal);
    }

    // Per-attempt signal = poolSignal ∪ optional timeoutSignal
    const attemptAc = new AbortController();
    const onPoolAbort = () => attemptAc.abort(poolSignal.reason);
    if (poolSignal.aborted) attemptAc.abort(poolSignal.reason);
    else poolSignal.addEventListener('abort', onPoolAbort, { once: true });

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let timeoutRejectFn: ((err: unknown) => void) | undefined;
    const timeoutPromise =
      timeoutMs !== undefined
        ? new Promise<never>((_r, rej) => {
            timeoutRejectFn = rej;
            timeoutTimer = setTimeout(() => {
              timedOut = true;
              const te = new TimeoutError(timeoutMs);
              attemptAc.abort(te);
              rej(te);
            }, timeoutMs);
            (timeoutTimer as unknown as { unref?: () => void }).unref?.();
          })
        : undefined;

    try {
      const workerPromise = Promise.resolve(
        worker(item, index, { signal: attemptAc.signal, attempt }),
      );
      // Attach a no-op catch on workerPromise so if it rejects later (after
      // timeout has already resolved the race) it does not surface as unhandled.
      workerPromise.catch(() => {});
      const result = timeoutPromise
        ? await Promise.race([workerPromise, timeoutPromise])
        : await workerPromise;
      return result as R;
    } catch (err) {
      lastErr = timedOut ? new TimeoutError(timeoutMs!) : err;
      if (poolSignal.aborted) throw new AbortError('Aborted', poolSignal.reason);
      if (isAbortError(lastErr)) throw lastErr;
      const nextRetryN = attempt + 1;
      if (nextRetryN >= retry.attempts) throw lastErr;
      if (!retry.isRetryable(lastErr, nextRetryN)) throw lastErr;
      const delay = computeBackoffMs(nextRetryN, retry);
      retry.onRetry?.({ error: lastErr, attempt: nextRetryN, delayMs: delay });
      await sleepAbortable(delay, poolSignal);
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      // Prevent the unraced timeoutPromise from rejecting into oblivion.
      if (timeoutRejectFn && !timedOut) {
        // Provide a benign rejection then swallow it (no-op catch inline).
        // Not needed — we already `catch(() => {})` below? Actually timeoutPromise
        // will simply never settle if we cleared the timer, which is fine.
      }
      poolSignal.removeEventListener('abort', onPoolAbort);
    }
  }
  throw lastErr;
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AbortError('Aborted', signal.reason);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError('Aborted', signal.reason));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Note: DO NOT unref this timer — the retry backoff must keep the process
    // alive so the awaiting caller sees the eventual result.
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runPool<T, R>(opts: PoolOptions<T, R>): Promise<PoolResult<R>[]> {
  const { input, worker, concurrency, signal, stopOnError, onProgress } = opts;
  const retry = opts.retry ?? NO_RETRY;
  const timeoutMs = opts.timeoutMs;
  const rateLimiter = opts.rateLimiter;

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
        internalController.abort(err);
        if (!firstRejection) firstRejection = { reason: err, index: -1 };
        return;
      }
      if (step.done) return;
      if (internalController.signal.aborted) return;
      const index = started++;
      running++;
      let outcome: PoolResult<R>;
      try {
        const value = await runAttempts(
          step.value,
          index,
          worker,
          internalController.signal,
          retry,
          timeoutMs,
          rateLimiter,
        );
        outcome = { status: 'fulfilled', value, index };
      } catch (reason) {
        outcome = { status: 'rejected', reason, index };
      } finally {
        running--;
      }
      if (!opts.discardResults) results[index] = outcome;
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
  const effective =
    limit === Number.POSITIVE_INFINITY || opts.total === undefined
      ? Number.isFinite(limit)
        ? limit
        : 1024
      : Math.min(limit, opts.total);
  const runnerCount = Math.max(1, effective);
  const runners = Array.from({ length: runnerCount }, () => runner());
  try {
    await Promise.all(runners);
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
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

  if (signal?.aborted) throw new AbortError('Aborted', signal.reason);
  if (firstRejection && stopOnError) throw firstRejection.reason;
  return results;
}

function isSyncIterable<T>(x: Iterable<T> | AsyncIterable<T>): x is Iterable<T> {
  return typeof (x as Iterable<T>)[Symbol.iterator] === 'function';
}

import { isAbortError } from './errors.js';
/**
 * Retry helpers. The retry loop itself lives in `pool.ts` because retries
 * must interact with the shared admission-control gate — a retry re-acquires
 * a rate-limit token but does NOT release its concurrency slot across the
 * backoff delay (§4.8). This file computes the delays and re-exports the
 * defaults; it does not run tasks.
 */
import { random } from './internal/random.js';
import type { RetryOptions, Task, TaskContext } from './types.js';
import {
  assertTaskFunction,
  validateFactor,
  validateNonNegativeFinite,
  validatePositiveInt,
} from './validate.js';

export interface NormalizedRetry {
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: 'none' | 'full' | 'equal';
  isRetryable: (error: unknown, attempt: number) => boolean;
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
}

export const NO_RETRY: NormalizedRetry = {
  attempts: 1,
  minDelayMs: 100,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 'full',
  isRetryable: defaultIsRetryable,
};

export function normalizeRetry(r?: RetryOptions): NormalizedRetry {
  if (!r) return NO_RETRY;
  const attempts = r.attempts === undefined ? 1 : validatePositiveInt('attempts', r.attempts);
  const minDelayMs =
    r.minDelayMs === undefined ? 100 : validateNonNegativeFinite('minDelayMs', r.minDelayMs);
  const maxDelayMs =
    r.maxDelayMs === undefined ? 30_000 : validateNonNegativeFinite('maxDelayMs', r.maxDelayMs);
  const factor = r.factor === undefined ? 2 : validateFactor('factor', r.factor);
  const jitter = r.jitter ?? 'full';
  if (jitter !== 'none' && jitter !== 'full' && jitter !== 'equal') {
    throw new TypeError(
      `conq: 'jitter' must be 'none' | 'full' | 'equal', received ${String(jitter)}`,
    );
  }
  const isRetryable = r.isRetryable ?? defaultIsRetryable;
  const out: NormalizedRetry = { attempts, minDelayMs, maxDelayMs, factor, jitter, isRetryable };
  if (r.onRetry) out.onRetry = r.onRetry;
  return out;
}

/** Compute backoff delay for retry index `n` (1-based). §4.8. */
export function computeBackoffMs(n: number, cfg: NormalizedRetry): number {
  const base = Math.min(cfg.minDelayMs * cfg.factor ** (n - 1), cfg.maxDelayMs);
  if (cfg.jitter === 'none') return base;
  if (cfg.jitter === 'full') return random() * base;
  // 'equal'
  return base / 2 + random() * (base / 2);
}

function defaultIsRetryable(err: unknown): boolean {
  // Retry everything except AbortError. TimeoutError IS retryable by default.
  return !isAbortError(err);
}

/**
 * Compose a retry policy onto a task function, for users who want to add
 * retry to a single task without going through `mapConcurrent`/`Queue`.
 * Note: this variant does NOT integrate with admission control — for that,
 * use `mapConcurrent` / `Queue` with the `retry` option.
 *
 * @example
 * ```ts
 * import { withRetry } from 'con-q';
 * const t = withRetry(async () => fetch('/x').then(r => r.json()), { attempts: 3 });
 * await t({ signal: new AbortController().signal, attempt: 0 });
 * ```
 */
export function withRetry<T>(task: Task<T>, options?: RetryOptions): Task<T> {
  assertTaskFunction(task, 0, 'task');
  const cfg = normalizeRetry(options);
  return async (ctx: TaskContext): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < cfg.attempts; attempt++) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
      try {
        return await task({ signal: ctx.signal, attempt });
      } catch (err) {
        lastErr = err;
        if (isAbortError(err)) throw err;
        const nextRetryN = attempt + 1;
        if (nextRetryN >= cfg.attempts) throw err;
        if (!cfg.isRetryable(err, nextRetryN)) throw err;
        const delay = computeBackoffMs(nextRetryN, cfg);
        cfg.onRetry?.({ error: err, attempt: nextRetryN, delayMs: delay });
        await sleepAbortable(delay, ctx.signal);
      }
    }
    throw lastErr;
  };
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

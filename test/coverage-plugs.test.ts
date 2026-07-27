import { afterEach, describe, expect, it } from 'vitest';
import { AbortError, Queue } from '../src/index.js';
import { deferred } from '../src/internal/deferred.js';
import { anySignal } from '../src/internal/signal.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { withRetry } from '../src/retry.js';
import {
  assertTaskFunction,
  validateFactor,
  validateNonNegativeFinite,
  validateNonNegativeInt,
  validatePositiveIntOrInfinity,
} from '../src/validate.js';

// --- deferred fallback (native path is used on Node 22; exercise fallback manually)
describe('deferred fallback', () => {
  const orig = (Promise as unknown as { withResolvers?: unknown }).withResolvers;
  afterEach(() => {
    (Promise as unknown as { withResolvers?: unknown }).withResolvers = orig;
  });
  it('polyfill returns a working deferred when Promise.withResolvers is missing', async () => {
    (Promise as unknown as { withResolvers?: unknown }).withResolvers = undefined;
    const d = deferred<number>();
    d.resolve(1);
    expect(await d.promise).toBe(1);
    const d2 = deferred<number>();
    d2.reject(new Error('x'));
    await expect(d2.promise).rejects.toThrow('x');
  });
});

// --- anySignal fallback (native available on Node 22; exercise fallback manually)
describe('anySignal fallback', () => {
  const orig = (AbortSignal as unknown as { any?: unknown }).any;
  afterEach(() => {
    (AbortSignal as unknown as { any?: unknown }).any = orig;
  });
  it('fires when any of the child signals fires', () => {
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const combined = anySignal([ac1.signal, ac2.signal]);
    expect(combined.aborted).toBe(false);
    ac2.abort('foo');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('foo');
  });
  it('already-aborted child aborts the combined immediately', () => {
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    const ac = new AbortController();
    ac.abort('boom');
    const combined = anySignal([new AbortController().signal, ac.signal]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('boom');
  });
});

// --- validate: unused paths (validateNonNegativeInt, describe branches)
describe('validate misc', () => {
  it('validateNonNegativeInt rejects negative / non-int / non-number', () => {
    expect(() => validateNonNegativeInt('x', -1)).toThrow(TypeError);
    expect(() => validateNonNegativeInt('x', 1.5)).toThrow(TypeError);
    expect(() => validateNonNegativeInt('x', 'y' as unknown as number)).toThrow(TypeError);
    expect(validateNonNegativeInt('x', 0)).toBe(0);
  });
  it('validateNonNegativeFinite rejects NaN and Infinity', () => {
    expect(() => validateNonNegativeFinite('x', Number.NaN)).toThrow(TypeError);
    expect(() => validateNonNegativeFinite('x', Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
  it('validateFactor rejects <1 and NaN', () => {
    expect(() => validateFactor('x', 0.5)).toThrow(TypeError);
    expect(() => validateFactor('x', Number.NaN)).toThrow(TypeError);
  });
  it('validatePositiveIntOrInfinity accepts Infinity', () => {
    expect(validatePositiveIntOrInfinity('x', Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
  it('assertTaskFunction messages: null, string, bigint, object', () => {
    expect(() => assertTaskFunction(null, 0)).toThrow(/null/);
    expect(() => assertTaskFunction('x', 0)).toThrow(/"x"/);
    expect(() => assertTaskFunction(5n, 0)).toThrow(/5n/);
    expect(() => assertTaskFunction({}, 0)).toThrow(/Object/);
  });
});

// --- withRetry: aborted signal, isRetryable=false, retryable exhausted, non-retryable throw
describe('withRetry paths', () => {
  it('rejects immediately if signal is pre-aborted', async () => {
    const t = withRetry(async () => 1);
    const ac = new AbortController();
    ac.abort('nope');
    await expect(t({ signal: ac.signal, attempt: 0 })).rejects.toBeDefined();
  });

  it('isRetryable=false short-circuits', async () => {
    let n = 0;
    const t = withRetry(
      async () => {
        n++;
        throw new Error('x');
      },
      { attempts: 5, minDelayMs: 1, jitter: 'none', isRetryable: () => false },
    );
    await expect(t({ signal: new AbortController().signal, attempt: 0 })).rejects.toThrow('x');
    expect(n).toBe(1);
  });

  it('AbortError inside worker not retried', async () => {
    let n = 0;
    const t = withRetry(
      async () => {
        n++;
        throw new AbortError('inner');
      },
      { attempts: 3, minDelayMs: 1, jitter: 'none' },
    );
    await expect(t({ signal: new AbortController().signal, attempt: 0 })).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(n).toBe(1);
  });
});

// --- rate-limit: acquire with an already-aborted signal, and abort while waiting
describe('rate-limit paths', () => {
  it('rejects immediately when signal already aborted', async () => {
    const rl = createRateLimiter(100, 1);
    const ac = new AbortController();
    ac.abort('gone');
    await expect(rl.acquire(ac.signal)).rejects.toBeDefined();
  });

  it('cancels a pending acquire when signal aborts', async () => {
    const rl = createRateLimiter(500, 1);
    await rl.acquire(); // consume the token
    const ac = new AbortController();
    const p = rl.acquire(ac.signal);
    setTimeout(() => ac.abort('cancel'), 10);
    await expect(p).rejects.toBeDefined();
    expect(rl.waiters).toBe(0);
  });
});

// --- Queue: paused clear, pre-aborted external signal, per-task pre-aborted signal, timeoutMs validation
describe('Queue coverage', () => {
  it('paused clear', async () => {
    const q = new Queue({ concurrency: 1, autoStart: false });
    const p = q.add(async () => 1);
    p.catch(() => {});
    expect(q.clear()).toBe(1);
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });

  it('external signal already aborted → add rejects', async () => {
    const ac = new AbortController();
    ac.abort('ext');
    const q = new Queue({ signal: ac.signal });
    const p = q.add(async () => 1);
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });

  it('per-task signal already aborted → add rejects', async () => {
    const q = new Queue();
    const ac = new AbortController();
    ac.abort('t');
    const p = q.add(async () => 1, { signal: ac.signal });
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });

  it('per-task timeoutMs invalid → throws synchronously', () => {
    const q = new Queue();
    expect(() => q.add(async () => 1, { timeoutMs: -1 })).toThrow(TypeError);
  });

  it('addAll delegates to add', async () => {
    const q = new Queue({ concurrency: 2 });
    const r = await q.addAll([async () => 1, async () => 2]);
    expect(r).toEqual([1, 2]);
  });

  it('onEmpty resolves when queue empties', async () => {
    const q = new Queue({ concurrency: 1 });
    q.pause();
    q.add(async () => {});
    const p = q.onEmpty();
    q.resume();
    await p;
  });

  it('resume() is a no-op when not paused', () => {
    const q = new Queue();
    q.resume(); // should not throw
    expect(q.isPaused).toBe(false);
  });
});

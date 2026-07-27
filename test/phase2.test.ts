import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  type RetryOptions,
  TimeoutError,
  mapConcurrent,
  mapSettled,
  withRetry,
} from '../src/index.js';
import { resetRandom, setRandom } from '../src/internal/random.js';

// Reuse the suite-wide unhandled-rejection assertion.
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, `unhandled rejections: ${unhandled.map(String).join(', ')}`).toEqual([]);
});

// ------------------ SC-8 retry + backoff ------------------
describe('SC-8 retry + backoff', () => {
  beforeEach(() => setRandom(() => 0.5));
  afterEach(() => resetRandom());

  it('fails twice then succeeds; onRetry called twice with correct delays', async () => {
    const calls: { attempt: number; delayMs: number }[] = [];
    let n = 0;
    const t0 = Date.now();
    const res = await mapConcurrent(
      [1],
      async () => {
        n++;
        if (n < 3) throw new Error(`boom-${n}`);
        return n;
      },
      {
        retry: {
          attempts: 3,
          minDelayMs: 30,
          factor: 2,
          jitter: 'none',
          onRetry: (info) => calls.push({ attempt: info.attempt, delayMs: info.delayMs }),
        },
      },
    );
    expect(res).toEqual([3]);
    expect(n).toBe(3);
    expect(calls).toEqual([
      { attempt: 1, delayMs: 30 },
      { attempt: 2, delayMs: 60 },
    ]);
    // Wall clock at least 30+60ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(85);
  });

  it('maxDelayMs caps the backoff', async () => {
    const delays: number[] = [];
    let n = 0;
    await mapConcurrent(
      [1],
      async () => {
        n++;
        if (n < 4) throw new Error('x');
        return 1;
      },
      {
        retry: {
          attempts: 4,
          minDelayMs: 100,
          factor: 10,
          maxDelayMs: 150,
          jitter: 'none',
          onRetry: (i) => delays.push(i.delayMs),
        },
      },
    );
    expect(delays).toEqual([100, 150, 150]);
  });

  it('isRetryable:false short-circuits', async () => {
    let n = 0;
    await expect(
      mapConcurrent(
        [1],
        async () => {
          n++;
          throw new Error('nope');
        },
        {
          retry: { attempts: 5, minDelayMs: 5, jitter: 'none', isRetryable: () => false },
        },
      ),
    ).rejects.toThrow('nope');
    expect(n).toBe(1);
  });

  it('jitter bounds', () => {
    setRandom(() => 0);
    // We test computeBackoffMs indirectly by observing delayMs in onRetry.
    // Full jitter with random=0 -> delay=0. Equal jitter -> base/2.
    return (async () => {
      let full = -1;
      let equal = -1;
      let n = 0;
      await mapConcurrent(
        [1],
        async () => {
          n++;
          if (n === 1) throw new Error('x');
          return 1;
        },
        {
          retry: {
            attempts: 2,
            minDelayMs: 100,
            factor: 2,
            jitter: 'full',
            onRetry: (i) => {
              full = i.delayMs;
            },
          },
        },
      );
      n = 0;
      await mapConcurrent(
        [1],
        async () => {
          n++;
          if (n === 1) throw new Error('x');
          return 1;
        },
        {
          retry: {
            attempts: 2,
            minDelayMs: 100,
            factor: 2,
            jitter: 'equal',
            onRetry: (i) => {
              equal = i.delayMs;
            },
          },
        },
      );
      expect(full).toBe(0);
      expect(equal).toBe(50);
    })();
  });

  it('withRetry composable helper works stand-alone', async () => {
    let n = 0;
    const t = withRetry(
      async () => {
        n++;
        if (n < 2) throw new Error('boom');
        return 'ok';
      },
      { attempts: 3, minDelayMs: 5, jitter: 'none' },
    );
    const ac = new AbortController();
    const out = await t({ signal: ac.signal, attempt: 0 });
    expect(out).toBe('ok');
    expect(n).toBe(2);
  });
});

// ------------------ SC-8a retry re-acquires rate-limit token ------------------
describe('SC-8a admission-control rule', () => {
  it('a retrying task re-acquires a token; total starts stay within cap', async () => {
    // 2 tasks, cap 1 per 100ms. Task 0 will fail once then succeed → 2 starts.
    // With 1-cap, second start of task 0 must wait ~100ms.
    const starts: number[] = [];
    let attempt = 0;
    const t0 = Date.now();
    await mapConcurrent(
      [0, 1],
      async (i) => {
        starts.push(Date.now() - t0);
        if (i === 0) {
          attempt++;
          if (attempt === 1) throw new Error('transient');
        }
        return i;
      },
      {
        concurrency: 5,
        intervalMs: 100,
        intervalCap: 1,
        retry: { attempts: 3, minDelayMs: 1, jitter: 'none' },
      },
    );
    // 3 starts total (task0 first attempt, task1, task0 retry)
    expect(starts.length).toBe(3);
    starts.sort((a, b) => a - b);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(90);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(90);
  });
});

// ------------------ SC-9 abort ------------------
describe('SC-9 abort', () => {
  it('(a) pre-aborted → AbortError, worker never invoked', async () => {
    const w = vi.fn(async (n: number) => n);
    const ac = new AbortController();
    ac.abort('early');
    await expect(mapConcurrent([1, 2], w, { signal: ac.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(w).not.toHaveBeenCalled();
  });

  it('(b) mid-run → no new starts, in-flight signal aborted, cause propagated', async () => {
    const started: number[] = [];
    const seenAbort: number[] = [];
    const ac = new AbortController();
    const p = mapConcurrent(
      Array.from({ length: 10 }, (_, i) => i),
      async (i, _idx, ctx) => {
        started.push(i);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 100);
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              seenAbort.push(i);
              reject(new AbortError('inner'));
            },
            { once: true },
          );
        });
      },
      { concurrency: 3, signal: ac.signal },
    );
    setTimeout(() => ac.abort('user reason'), 10);
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect((err as AbortError).cause).toBe('user reason');
    expect(seenAbort.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(10); // no new starts after abort
  });

  it('(c) during backoff → rejects promptly, no wait-out, no more retries', async () => {
    const attempts: number[] = [];
    const ac = new AbortController();
    const p = mapConcurrent(
      [1],
      async () => {
        attempts.push(1);
        throw new Error('bad');
      },
      {
        signal: ac.signal,
        retry: { attempts: 5, minDelayMs: 1000, jitter: 'none' },
      },
    );
    setTimeout(() => ac.abort('cancel'), 20);
    const t0 = Date.now();
    const err = await p.catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(err).toBeInstanceOf(AbortError);
    expect(attempts.length).toBeLessThanOrEqual(2);
  });

  it('AbortError is not retried', async () => {
    let n = 0;
    const ac = new AbortController();
    ac.abort();
    await expect(
      mapConcurrent(
        [1],
        async () => {
          n++;
          throw new AbortError('inner');
        },
        { signal: ac.signal, retry: { attempts: 5, minDelayMs: 1, jitter: 'none' } },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(n).toBe(0);
  });
});

// ------------------ SC-12 timeout ------------------
describe('SC-12 timeout', () => {
  it('per-attempt timeout frees slot promptly with TimeoutError', async () => {
    const t0 = Date.now();
    const err = await mapConcurrent(
      [1],
      async () => new Promise(() => {}), // never settles
      { timeoutMs: 50 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(50);
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('worker sees signal aborted on timeout', async () => {
    let aborted = false;
    await mapConcurrent(
      [1],
      async (_i, _idx, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
      { timeoutMs: 30 },
    ).catch(() => {});
    expect(aborted).toBe(true);
  });

  it('per-attempt when combined with retry: TimeoutError is retryable by default', async () => {
    let n = 0;
    const res = await mapConcurrent(
      [1],
      async () => {
        n++;
        if (n < 3) await new Promise(() => {}); // hang first two attempts
        return n;
      },
      {
        timeoutMs: 30,
        retry: { attempts: 3, minDelayMs: 5, jitter: 'none' },
      },
    );
    expect(res).toEqual([3]);
    expect(n).toBe(3);
  });
});

// ------------------ negative-tests for retry option validation ------------------
describe('retry option validation', () => {
  it.each<[keyof RetryOptions, unknown]>([
    ['attempts', 0],
    ['attempts', -1],
    ['attempts', 'x'],
    ['minDelayMs', -1],
    ['factor', 0.5],
  ])('retry.%s = %p → TypeError', async (k, v) => {
    await expect(
      mapConcurrent([1], async (n) => n, { retry: { [k]: v } as RetryOptions }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

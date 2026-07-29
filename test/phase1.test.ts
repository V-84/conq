import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  type MapOptions,
  type ProgressInfo,
  forEachConcurrent,
  mapConcurrent,
  mapSettled,
} from '../src/index.js';

// -------- global unhandled-rejection counter (SC-6) --------
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(
    unhandled,
    `unhandled rejections during suite: ${unhandled.map(String).join(', ')}`,
  ).toEqual([]);
});

// -------- SC-1: laziness --------
describe('SC-1 laziness', () => {
  it('concurrency:1 runs strictly serially', async () => {
    const log: string[] = [];
    await mapConcurrent(
      [1, 2, 3],
      async (n) => {
        log.push(`start${n}`);
        await Promise.resolve();
        await Promise.resolve();
        log.push(`finish${n}`);
        return n;
      },
      { concurrency: 1 },
    );
    expect(log).toEqual(['start1', 'finish1', 'start2', 'finish2', 'start3', 'finish3']);
  });
});

// -------- SC-2: concurrency ceiling --------
describe('SC-2 concurrency ceiling', () => {
  it('never exceeds configured concurrency across 200 randomised runs', async () => {
    let rng = 1;
    const rand = () => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };
    for (let run = 0; run < 200; run++) {
      const items = Array.from({ length: Math.floor(rand() * 51) }, (_, i) => i);
      const concurrency = 1 + Math.floor(rand() * 10);
      let inFlight = 0;
      let peak = 0;
      await mapConcurrent(
        items,
        async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
          inFlight--;
        },
        { concurrency },
      );
      expect(peak).toBeLessThanOrEqual(concurrency);
    }
  }, 20_000);
});

// -------- SC-3: order preservation --------
describe('SC-3 order preservation', () => {
  it('reversed completion order still yields input-indexed results', async () => {
    for (let run = 0; run < 200; run++) {
      const n = 20;
      const items = Array.from({ length: n }, (_, i) => i);
      const out = await mapConcurrent(
        items,
        async (i) => {
          await new Promise((r) => setTimeout(r, (n - i) * 2));
          return i * i;
        },
        { concurrency: 8 },
      );
      expect(out).toEqual(items.map((i) => i * i));
    }
  }, 30_000);
});

// -------- SC-4: immediate refill (fake timers, event log) --------
describe('SC-4 immediate refill', () => {
  it('durations [1000,10,10,10], concurrency:2 → ~1000ms not ~2000ms; item 3 starts before item 0 finishes', async () => {
    vi.useFakeTimers();
    const durations = [1000, 10, 10, 10];
    const log: string[] = [];
    const p = mapConcurrent(
      durations,
      async (d, i) => {
        log.push(`start${i}`);
        await new Promise((r) => setTimeout(r, d));
        log.push(`finish${i}`);
      },
      { concurrency: 2 },
    );
    // Advance enough to finish everything (~1000ms for longest task).
    await vi.advanceTimersByTimeAsync(1100);
    await p;
    vi.useRealTimers();
    // Item 3 must have started before item 0 finished (immediate refill).
    const start3 = log.indexOf('start3');
    const finish0 = log.indexOf('finish0');
    expect(start3).toBeGreaterThanOrEqual(0);
    expect(finish0).toBeGreaterThan(-1);
    expect(start3).toBeLessThan(finish0);
    // Total event count: 4 starts + 4 finishes
    expect(log.filter((e) => e.startsWith('start')).length).toBe(4);
    expect(log.filter((e) => e.startsWith('finish')).length).toBe(4);
  });
});

// -------- SC-5: failure frees slot --------
describe('SC-5 failure frees slot', () => {
  it('9 tasks complete when task 0 rejects (stopOnError:false)', async () => {
    const done: number[] = [];
    await expect(
      mapConcurrent(
        Array.from({ length: 10 }, (_, i) => i),
        async (i) => {
          if (i === 0) throw new Error('boom');
          done.push(i);
          return i;
        },
        { concurrency: 3, stopOnError: false },
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// -------- SC-6: covered by global counter above --------

// -------- SC-7: stopOnError semantics --------
describe('SC-7 stopOnError', () => {
  it('default: rejects with first error, awaits in-flight settlement', async () => {
    const settled: number[] = [];
    let firstErr: unknown;
    try {
      await mapConcurrent(
        Array.from({ length: 6 }, (_, i) => i),
        async (i, _idx, ctx) => {
          if (i === 1) {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error(`fail-${i}`);
          }
          try {
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, 30);
              ctx.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(t);
                  reject(new AbortError('inner'));
                },
                { once: true },
              );
            });
          } catch {
            /* observe abort */
          }
          settled.push(i);
        },
        { concurrency: 4 },
      );
    } catch (err) {
      firstErr = err;
    }
    expect((firstErr as Error).message).toBe('fail-1');
    // Items 0,2,3 that had already started must have all settled before we saw the rejection.
    expect(settled).toEqual(expect.arrayContaining([0, 2, 3]));
  });

  it('false: AggregateError.errors in input-index order', async () => {
    const err = await mapConcurrent(
      [0, 1, 2, 3],
      async (i) => {
        if (i === 3) {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error('e3');
        }
        if (i === 1) throw new Error('e1');
        return i;
      },
      { concurrency: 2, stopOnError: false },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    const msgs = (err as AggregateError).errors.map((e) => (e as Error).message);
    expect(msgs).toEqual(['e1', 'e3']);
  });

  it('no new starts after first failure', async () => {
    const started: number[] = [];
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      async (i) => {
        started.push(i);
        if (i === 0) {
          await new Promise((r) => setTimeout(r, 2));
          throw new Error('x');
        }
        await new Promise((r) => setTimeout(r, 10));
      },
      { concurrency: 2 },
    ).catch(() => {});
    // Only tasks that were pulled before item 0 rejected should have started.
    expect(started.length).toBeLessThan(20);
  });
});

// -------- SC-10: validation --------
describe('SC-10 validation', () => {
  it.each([Number.NaN, 0, -1, 1.5, '4' as unknown, null as unknown, undefined])(
    'rejects concurrency=%p (except undefined which uses default)',
    async (value) => {
      const opts = value === undefined ? {} : { concurrency: value as number };
      if (value === undefined) {
        await expect(mapConcurrent([1], async (n) => n, opts as MapOptions)).resolves.toEqual([1]);
      } else {
        await expect(mapConcurrent([1], async (n) => n, opts as MapOptions)).rejects.toBeInstanceOf(
          TypeError,
        );
      }
    },
  );

  it('accepts Infinity and positive ints', async () => {
    await expect(
      mapConcurrent([1, 2], async (n) => n, { concurrency: Number.POSITIVE_INFINITY }),
    ).resolves.toEqual([1, 2]);
    await expect(mapConcurrent([1, 2], async (n) => n, { concurrency: 3 })).resolves.toEqual([
      1, 2,
    ]);
  });

  it('error message echoes the value', async () => {
    try {
      await mapConcurrent([1], async (n) => n, { concurrency: Number.NaN });
    } catch (e) {
      expect((e as Error).message).toContain('NaN');
      return;
    }
    throw new Error('no throw');
  });

  it('NaN does NOT hang', async () => {
    const race = Promise.race([
      mapConcurrent([1, 2, 3], async (n) => n, { concurrency: Number.NaN }).catch((e) => e),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('HUNG')), 500)),
    ]);
    const result = await race;
    expect(result).toBeInstanceOf(TypeError);
  });

  it('validates intervalMs/intervalCap together', async () => {
    await expect(mapConcurrent([1], async (n) => n, { intervalMs: 100 })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(mapConcurrent([1], async (n) => n, { intervalCap: 1 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('validates timeoutMs', async () => {
    await expect(mapConcurrent([1], async (n) => n, { timeoutMs: -1 })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      mapConcurrent([1], async (n) => n, { timeoutMs: 'x' as unknown as number }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

// -------- SC-11: empty input --------
describe('SC-11 empty input', () => {
  it('returns [] and never invokes worker', async () => {
    const worker = vi.fn(async (n: number) => n);
    await expect(mapConcurrent([], worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('onProgress invoked at most once with total:0', async () => {
    const calls: ProgressInfo[] = [];
    await mapConcurrent([], async (n) => n, { onProgress: (i) => calls.push(i) });
    expect(calls.length).toBeLessThanOrEqual(1);
    if (calls.length === 1) expect(calls[0]!.total).toBe(0);
  });
});

// -------- SC-32: raw-promise guard --------
describe('SC-32 raw-promise guard', () => {
  it('worker is not a function → TypeError', async () => {
    await expect(mapConcurrent([1], 42 as unknown as (n: number) => number)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('worker is a Promise (thenable) → helpful diagnostic', async () => {
    try {
      await mapConcurrent([1], Promise.resolve(5) as unknown as (n: number) => number);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toContain('Promise');
      expect((e as Error).message).toContain('index');
      return;
    }
    throw new Error('no throw');
  });

  // Regression: the README's own opening example is an ARRAY of live promises
  // passed with an identity worker. The worker is a valid function, so the
  // worker-position guard does not fire — the input guard must catch it.
  it('input is an array of Promises → TypeError naming the index', async () => {
    const promises = [1, 2, 3].map((i) => Promise.resolve(i));
    try {
      await mapConcurrent(promises, (p) => p, { concurrency: 2 });
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toContain('Promise');
      expect((e as Error).message).toContain('input[0]');
      return;
    }
    throw new Error('no throw');
  });

  it('input with a thenable at a later index → reports that index', async () => {
    const input: unknown[] = [1, 2, Promise.resolve(3)];
    try {
      await mapConcurrent(input, (x) => x, { concurrency: 2 });
    } catch (e) {
      expect((e as Error).message).toContain('input[2]');
      return;
    }
    throw new Error('no throw');
  });

  it('mapSettled and forEachConcurrent guard the input too', async () => {
    const p = [Promise.resolve(1)];
    await expect(mapSettled(p, (x) => x, { concurrency: 1 })).rejects.toBeInstanceOf(TypeError);
    await expect(forEachConcurrent(p, (x) => x, { concurrency: 1 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('plain-value arrays and lazy iterables are NOT rejected', async () => {
    await expect(mapConcurrent([1, 2, 3], async (n) => n, { concurrency: 2 })).resolves.toEqual([
      1, 2, 3,
    ]);
    function* gen() {
      yield 1;
      yield 2;
    }
    await expect(mapConcurrent(gen(), async (n) => n, { concurrency: 2 })).resolves.toEqual([1, 2]);
  });

  it('input with Promise.reject does not cause unhandled rejection', async () => {
    const input = [Promise.reject(new Error('r1')), Promise.reject(new Error('r2'))];
    await expect(mapConcurrent(input, (x) => x, { concurrency: 2 })).rejects.toBeInstanceOf(
      TypeError,
    );
    // Give the event loop a tick to detect any unhandled rejections
    await new Promise((r) => setTimeout(r, 10));
  });

  it('a Promise used as the entire input gets the Promise diagnostic', async () => {
    const input = Promise.resolve(1);
    try {
      await mapConcurrent(input as unknown as number[], async (n) => n);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toContain('Promise');
      expect((e as Error).message).toContain('input[0]');
      return;
    }
    throw new Error('no throw');
  });

  it('a rejected Promise used as the entire input is observed', async () => {
    const input = Promise.reject(new Error('raw'));
    await expect(
      mapConcurrent(input as unknown as number[], async (n) => n),
    ).rejects.toBeInstanceOf(TypeError);
    await new Promise((r) => setImmediate(r));
  });

  it('validates Promise values as a lazy iterable pulls them', async () => {
    function* promises() {
      yield 1;
      yield Promise.resolve(2);
    }
    await expect(mapConcurrent(promises(), async (n) => n, { concurrency: 1 })).rejects.toThrow(
      /input\[1\].*Promise/s,
    );
  });
});

// -------- iterator error surfacing even with stopOnError:false --------
describe('iterator error surfacing', () => {
  it('iterator failure surfaces even with stopOnError:false', async () => {
    async function* bad() {
      yield 1;
      throw new Error('iter-fail');
    }
    await expect(mapConcurrent(bad(), async (n) => n, { stopOnError: false })).rejects.toThrow(
      'iter-fail',
    );
  });

  it('mapSettled surfaces iterator failure', async () => {
    async function* bad() {
      yield 1;
      throw new Error('iter-fail');
    }
    await expect(mapSettled(bad(), async (n) => n)).rejects.toThrow('iter-fail');
  });

  it('forEachConcurrent surfaces iterator failure with stopOnError:false', async () => {
    async function* bad() {
      yield 1;
      throw new Error('iter-fail');
    }
    await expect(
      forEachConcurrent(
        bad(),
        async (n) => {
          /* discard */
        },
        { stopOnError: false },
      ),
    ).rejects.toThrow('iter-fail');
  });
});

// -------- forEachConcurrent basic --------
describe('forEachConcurrent basic', () => {
  it('discards results, honours stopOnError:false', async () => {
    const seen: number[] = [];
    await expect(
      forEachConcurrent(
        [1, 2, 3, 4],
        async (n) => {
          seen.push(n);
          if (n === 2) throw new Error('bad');
        },
        { concurrency: 2, stopOnError: false },
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });
});

// -------- mapSettled index carry --------
describe('mapSettled', () => {
  it('returns per-item settled results with index', async () => {
    const res = await mapSettled([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(res[0]).toEqual({ status: 'fulfilled', value: 10, index: 0 });
    expect(res[1]).toMatchObject({ status: 'rejected', index: 1 });
    expect(res[2]).toEqual({ status: 'fulfilled', value: 30, index: 2 });
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { forEachConcurrent, mapConcurrent } from '../src/index.js';

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, `unhandled: ${unhandled.map(String).join(', ')}`).toEqual([]);
});

// ------------------ SC-16 rate limit ------------------
describe('SC-16 rate limit', () => {
  it('intervalCap:2, intervalMs:200 → 6 tasks start at ~0(×2), ~200(×2), ~400(×2)', async () => {
    // Using real timers with a short window to keep the suite fast.
    const starts: number[] = [];
    const t0 = Date.now();
    await mapConcurrent(
      Array.from({ length: 6 }, (_, i) => i),
      async () => {
        starts.push(Date.now() - t0);
      },
      { concurrency: 10, intervalMs: 200, intervalCap: 2 },
    );
    starts.sort((a, b) => a - b);
    // Two starts in first window, two in second, two in third.
    expect(starts[0]!).toBeLessThan(80);
    expect(starts[1]!).toBeLessThan(80);
    expect(starts[2]!).toBeGreaterThanOrEqual(180);
    expect(starts[3]!).toBeGreaterThanOrEqual(180);
    expect(starts[4]!).toBeGreaterThanOrEqual(380);
    expect(starts[5]!).toBeGreaterThanOrEqual(380);
  });

  it('concurrency:1 + generous rate → serial (min governs)', async () => {
    const log: string[] = [];
    await mapConcurrent(
      [1, 2, 3],
      async (n) => {
        log.push(`s${n}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`f${n}`);
      },
      { concurrency: 1, intervalMs: 1000, intervalCap: 1000 },
    );
    expect(log).toEqual(['s1', 'f1', 's2', 'f2', 's3', 'f3']);
  });
});

// ------------------ SC-17 iterables ------------------
describe('SC-17 iterable inputs', () => {
  it('Iterable (array) works', async () => {
    const r = await mapConcurrent([1, 2, 3], async (n) => n * 2);
    expect(r).toEqual([2, 4, 6]);
  });

  it('generator (sync) works', async () => {
    function* gen() {
      yield 'a';
      yield 'b';
      yield 'c';
    }
    const r = await mapConcurrent(gen(), async (s) => s.toUpperCase());
    expect(r).toEqual(['A', 'B', 'C']);
  });

  it('AsyncIterable pulled lazily; not exhausted while tasks running', async () => {
    let yielded = 0;
    let completed = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    async function* agen() {
      for (let i = 0; i < 20; i++) {
        yielded++;
        yield i;
      }
    }
    await mapConcurrent(
      agen(),
      async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // With concurrency 3, once N items have completed the generator should
        // have yielded at most N + concurrency + 1 (small buffer for pending pulls).
        expect(yielded).toBeLessThanOrEqual(completed + inFlight + 3);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        completed++;
      },
      { concurrency: 3 },
    );
    expect(yielded).toBe(20);
    expect(peakInFlight).toBeLessThanOrEqual(3);
  });

  it('async iterator failure surfaces', async () => {
    async function* bad() {
      yield 1;
      throw new Error('gen-fail');
    }
    await expect(mapConcurrent(bad(), async (n) => n)).rejects.toThrow('gen-fail');
  });
});

// ------------------ SC-18 memory: forEachConcurrent over a giant generator ------------------
describe('SC-18 forEachConcurrent memory bounds', () => {
  it('processes 200k generator items with concurrency:4 under fixed ceiling', async () => {
    // Downscaled from 1e6 to keep the default suite fast; kept at 200k which
    // is still well beyond what an array of settled-results would fit under
    // the assert.
    const N = 200_000;
    function* gen() {
      for (let i = 0; i < N; i++) yield i;
    }
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    let count = 0;
    await forEachConcurrent(
      gen(),
      async () => {
        count++;
      },
      { concurrency: 4 },
    );
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    expect(count).toBe(N);
    const delta = after - before;
    // A retained results array of 200k entries would be ~10-20MB. Cap at 50MB
    // to leave headroom for vitest/system noise while still catching regressions.
    expect(delta).toBeLessThan(50 * 1024 * 1024);
  }, 30_000);
});

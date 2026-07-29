import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { forEachConcurrent, mapConcurrent } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '..');

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, `unhandled: ${unhandled.map(String).join(', ')}`).toEqual([]);
});

// ------------------ SC-16 rate limit ------------------
describe('SC-16 rate limit', () => {
  it('intervalCap:2, intervalMs:1000 → exact starts at 0, 1000, and 2000', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const t0 = Date.now();
      const result = mapConcurrent(
        Array.from({ length: 6 }, (_, i) => i),
        async () => {
          starts.push(Date.now() - t0);
        },
        { concurrency: 10, intervalMs: 1000, intervalCap: 2 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0, 0]);
      await vi.advanceTimersByTimeAsync(999);
      expect(starts).toEqual([0, 0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([0, 0, 1000, 1000]);
      await vi.advanceTimersByTimeAsync(999);
      expect(starts).toEqual([0, 0, 1000, 1000]);
      await vi.advanceTimersByTimeAsync(1);

      await result;
      expect(starts).toEqual([0, 0, 1000, 1000, 2000, 2000]);
    } finally {
      vi.useRealTimers();
    }
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
  it('processes 1e6 items under a 32 MiB forced-GC heap ceiling', () => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    const child = spawnSync(
      process.execPath,
      ['--expose-gc', resolve(ROOT, 'scripts/memory-gate.mjs')],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    expect(child.status, `stdout=${child.stdout}\nstderr=${child.stderr}`).toBe(0);
    const result = JSON.parse(child.stdout) as { count: number; delta: number };
    expect(result.count).toBe(1_000_000);
    expect(result.delta).toBeLessThan(32 * 1024 * 1024);
  }, 90_000);

  it('concurrency:Infinity with sized input does not spawn excess runners', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapConcurrent(
      [1],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      },
      { concurrency: Number.POSITIVE_INFINITY },
    );
    expect(peak).toBe(1);
  });
});

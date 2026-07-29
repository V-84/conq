import { afterAll, describe, expect, it, vi } from 'vitest';
import { AbortError, Queue, TimeoutError } from '../src/index.js';

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, `unhandled: ${unhandled.map(String).join(', ')}`).toEqual([]);
});

// ------------------ SC-13 dynamic concurrency ------------------
describe('SC-13 dynamic concurrency', () => {
  it('raising concurrency starts queued tasks the same tick', async () => {
    const q = new Queue({ concurrency: 1 });
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, i) => async () => {
      started.push(i);
      await new Promise<void>((res) => gates.push(res));
      return i;
    });
    for (const t of tasks) q.add(t);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0]);
    q.concurrency = 3;
    await Promise.resolve();
    await Promise.resolve();
    expect(started.slice().sort()).toEqual([0, 1, 2]);
    // Release everything until idle; gates is grown by newly-started tasks.
    while (q.running > 0 || q.size > 0) {
      while (gates.length) gates.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await q.onIdle();
  });

  it('lowering does not kill in-flight; blocks new starts', async () => {
    const q = new Queue({ concurrency: 3 });
    const started: number[] = [];
    const finished: number[] = [];
    const gates: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      q.add(async () => {
        started.push(i);
        await new Promise<void>((res) => gates.push(res));
        finished.push(i);
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(started.sort()).toEqual([0, 1, 2]);
    q.concurrency = 1;
    // In-flight not killed.
    expect(q.running).toBe(3);
    // Complete one of them; next should NOT start until running < 1.
    gates[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(started.length).toBe(3); // still no new start
    gates[1]!();
    gates[2]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(started.length).toBe(4);
    gates[3]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(started.length).toBe(5);
    gates[4]!();
    await q.onIdle();
  });
});

// ------------------ SC-14 queue lifecycle ------------------
describe('SC-14 queue lifecycle', () => {
  it('onIdle resolves immediately if already idle', async () => {
    const q = new Queue();
    const t0 = Date.now();
    await q.onIdle();
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it('onIdle resolves once on drain', async () => {
    const q = new Queue({ concurrency: 2 });
    for (let i = 0; i < 5; i++) q.add(async () => i);
    await q.onIdle();
    expect(q.running).toBe(0);
    expect(q.size).toBe(0);
  });

  it('pause/resume gates without dropping', async () => {
    const q = new Queue({ concurrency: 2 });
    q.pause();
    const results: number[] = [];
    const promises = [1, 2, 3].map((i) =>
      q.add(async () => {
        results.push(i);
        return i;
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(results).toEqual([]);
    expect(q.size).toBe(3);
    q.resume();
    await Promise.all(promises);
    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it('clear() returns count and rejects queued with AbortError', async () => {
    const q = new Queue({ concurrency: 1 });
    q.pause();
    const p1 = q.add(async () => 1);
    const p2 = q.add(async () => 2);
    // Attach catch handlers so rejected promises don't count as unhandled.
    p1.catch(() => {});
    p2.catch(() => {});
    const removed = q.clear();
    expect(removed).toBe(2);
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    await expect(p2).rejects.toBeInstanceOf(AbortError);
  });

  it('aborting a paused queue rejects queued tasks', async () => {
    const ac = new AbortController();
    const q = new Queue({ concurrency: 1, signal: ac.signal });
    q.pause();
    const p1 = q.add(async () => 1);
    const p2 = q.add(async () => 2);
    p1.catch(() => {});
    p2.catch(() => {});
    ac.abort('done');
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    await expect(p2).rejects.toBeInstanceOf(AbortError);
  });

  it('aborting a queued task removes it and rejects while paused', async () => {
    const ac = new AbortController();
    const q = new Queue({ concurrency: 1, autoStart: false });
    const task = q.add(async () => 1, { signal: ac.signal });
    task.catch(() => {});
    const empty = q.onEmpty();
    const idle = q.onIdle();
    ac.abort('task cancelled');
    await expect(task).rejects.toMatchObject({ cause: 'task cancelled' });
    await empty;
    await idle;
    expect(q.size).toBe(0);
    expect(q.running).toBe(0);
  });

  it('add() rejection safety: ignored rejection does not crash', async () => {
    const q = new Queue({ concurrency: 1 });
    q.add(async () => {
      throw new Error('ignored');
    }); // NOT awaited, no catch
    await q.onIdle();
    // Give unhandled-rejection detection a tick to fire.
    await new Promise((r) => setImmediate(r));
    // The unhandled tally is checked at afterAll; if this test triggers one,
    // the whole suite will fail there.
    expect(true).toBe(true);
  });

  it('asyncDispose drains on exit', async () => {
    const seen: number[] = [];
    {
      await using q = new Queue({ concurrency: 1 });
      for (let i = 0; i < 3; i++)
        q.add(async () => {
          seen.push(i);
        });
    }
    expect(seen).toEqual([0, 1, 2]);
  });
});

// ------------------ SC-15 priority ------------------
describe('SC-15 priority scheduling', () => {
  it('higher priority first; ties FIFO', async () => {
    const q = new Queue({ concurrency: 1 });
    q.pause();
    const order: string[] = [];
    q.add(
      async () => {
        order.push('a');
      },
      { priority: 0 },
    );
    q.add(
      async () => {
        order.push('b');
      },
      { priority: 5 },
    );
    q.add(
      async () => {
        order.push('c');
      },
      { priority: 0 },
    );
    q.add(
      async () => {
        order.push('d');
      },
      { priority: 10 },
    );
    q.resume();
    await q.onIdle();
    expect(order).toEqual(['d', 'b', 'a', 'c']);
  });
});

// ------------------ Queue: retry + timeout + rate-limit inherited ------------------
describe('Queue: resilience passthrough', () => {
  it('per-task timeoutMs overrides queue default', async () => {
    const q = new Queue({ concurrency: 1, timeoutMs: 5000 });
    const err = await q.add(async () => new Promise(() => {}), { timeoutMs: 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('rate limit applies across queue tasks', async () => {
    const q = new Queue({ concurrency: 10, intervalMs: 100, intervalCap: 1 });
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all([
      q.add(async () => {
        starts.push(Date.now() - t0);
      }),
      q.add(async () => {
        starts.push(Date.now() - t0);
      }),
      q.add(async () => {
        starts.push(Date.now() - t0);
      }),
    ]);
    starts.sort((a, b) => a - b);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(90);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(90);
  });
});

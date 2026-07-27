// ESM smoke: exercises mapConcurrent, Queue, retry, abort, timeout against the
// packed tarball installed into a scratch dir (see test/smoke.test.ts).
import { strict as assert } from 'node:assert';
import { AbortError, Queue, TimeoutError, mapConcurrent, withRetry } from 'conq';

const r = await mapConcurrent([1, 2, 3, 4], async (n) => n * 2, { concurrency: 2 });
assert.deepEqual(r, [2, 4, 6, 8]);

const q = new Queue({ concurrency: 2 });
const values = await Promise.all([q.add(async () => 'a'), q.add(async () => 'b')]);
assert.deepEqual(values.sort(), ['a', 'b']);
await q.onIdle();

let n = 0;
const retried = await mapConcurrent(
  [1],
  async () => {
    n++;
    if (n < 3) throw new Error('fail');
    return n;
  },
  { retry: { attempts: 3, minDelayMs: 1, jitter: 'none' } },
);
assert.deepEqual(retried, [3]);

const ac = new AbortController();
setTimeout(() => ac.abort('go'), 10);
try {
  await mapConcurrent(
    [1, 2, 3],
    async (_n, _i, ctx) => {
      // Cooperative worker: honour the signal so the pool can settle in-flight.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new AbortError('inner'));
          },
          { once: true },
        );
      });
    },
    { signal: ac.signal },
  );
  throw new Error('should reject');
} catch (err) {
  assert.ok(err instanceof AbortError, `expected AbortError, got ${err?.constructor?.name}`);
}

try {
  await mapConcurrent(
    [1],
    async (_n, _i, ctx) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(ctx.signal.reason);
          },
          { once: true },
        );
      });
    },
    { timeoutMs: 30 },
  );
  throw new Error('should timeout');
} catch (err) {
  assert.ok(err instanceof TimeoutError);
}

const t = withRetry(async () => 42);
assert.equal(await t({ signal: new AbortController().signal, attempt: 0 }), 42);

console.log('SMOKE OK (ESM)');

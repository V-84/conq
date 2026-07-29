import PQueue from 'p-queue';
import pRetry from 'p-retry';

const CONCURRENCY = 10;
const RETRIES = 4; // 4 additional attempts after the first (5 total)

// Arm A: p-queue (strict) + p-retry wrapping the task body.
// The bug: retries fire on p-retry's internal timer inside a single queue slot,
// so the queue's rate-limit governor never sees them.
export async function armA(handle, { N, windowMs, windowCap, backoffMs }) {
  const queue = new PQueue({
    concurrency: CONCURRENCY,
    interval: windowMs,
    intervalCap: windowCap,
    carryoverConcurrencyCount: true,
    strict: true,
  });
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      queue.add(() =>
        pRetry(() => handle(), { retries: RETRIES, minTimeout: backoffMs, factor: 2 }).then(
          (r) => ({ i, ...r }),
        ),
      ),
    ),
  );
  return summarize(results);
}

// Arm B: c-queue-style — retries re-enter admission control through the same gate.
export async function armBSettled(handle, { N, windowMs, windowCap, backoffMs }) {
  const starts = []; // rolling window of task-start timestamps
  const acquireToken = async () => {
    for (;;) {
      const t = Date.now();
      while (starts.length && starts[0] <= t - windowMs) starts.shift();
      if (starts.length < windowCap) {
        starts.push(t);
        return;
      }
      const wait = Math.max(1, starts[0] + windowMs - t);
      await new Promise((r) => setTimeout(r, wait));
    }
  };

  const runOne = async () => {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      await acquireToken();
      try {
        return await handle();
      } catch (err) {
        if (attempt === RETRIES) throw err;
        const delay = backoffMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };

  const items = Array.from({ length: N }, (_, i) => i);
  const results = new Array(N);
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = items.shift();
      if (i === undefined) return;
      try {
        const r = await runOne();
        results[i] = { status: 'fulfilled', value: r };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  });
  await Promise.all(runners);
  return summarize(results);
}

// Arm C: stock p-queue, no p-retry; manual re-add on failure (~12 lines).
export async function armC(handle, { N, windowMs, windowCap, backoffMs }) {
  const queue = new PQueue({
    concurrency: CONCURRENCY,
    interval: windowMs,
    intervalCap: windowCap,
    carryoverConcurrencyCount: true,
    strict: true,
  });
  const results = new Array(N);
  const attemptCount = new Array(N).fill(0);
  let scheduled = N;

  const submit = (i) => {
    scheduled++;
    queue
      .add(async () => {
        attemptCount[i]++;
        try {
          const r = await handle();
          results[i] = { status: 'fulfilled', value: r };
        } catch (err) {
          if (attemptCount[i] >= RETRIES + 1) {
            results[i] = { status: 'rejected', reason: err };
            return;
          }
          const delay = backoffMs * 2 ** (attemptCount[i] - 1);
          setTimeout(() => submit(i), delay);
        }
      })
      .finally(() => {
        scheduled--;
      });
  };

  scheduled = 0;
  for (let i = 0; i < N; i++) submit(i);
  // Wait until every slot filled AND no retry timers pending.
  while (results.some((r) => r === undefined) || scheduled > 0) {
    await new Promise((r) => setTimeout(r, 20));
    await queue.onIdle();
  }
  return summarize(results);
}

function summarize(settled) {
  let ok = 0;
  let fail = 0;
  for (const r of settled) {
    if (r?.status === 'fulfilled') ok++;
    else fail++;
  }
  return { total: settled.length, ok, lost: fail };
}

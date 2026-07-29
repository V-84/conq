# con-q

[![CI](https://github.com/V-84/conq/actions/workflows/ci.yml/badge.svg)](https://github.com/V-84/conq/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/V-84/conq/graph/badge.svg?token=a6764b50-c5c4-4a96-b798-2029ba9b6a3d)](https://codecov.io/gh/V-84/conq)
[![npm](https://img.shields.io/npm/v/con-q)](https://www.npmjs.com/package/con-q)

Bounded async concurrency with retry integrated into admission control.
Zero runtime dependencies. ESM **and** CommonJS. Full TypeScript types.

## Are you here because your queue is silently ignoring your rate limit?

The most common mistake is starting work eagerly and then handing already-live
Promises to a queue:

```js
// readme-expect-error: TypeError
// broken: every fetch has already started before con-q sees it
const promises = urls.map(
  (url) => new Promise((resolve, reject) => fetch(url).then(resolve, reject)),
);
await mapConcurrent(promises, (promise) => promise, { concurrency: 2 });
// -> TypeError: con-q: input[0] is a Promise, not a value.
// All requests have already started, so the concurrency limit cannot govern them.
```

Pass plain values and create each Promise inside the worker instead:

```js
import { mapConcurrent } from 'con-q';

await mapConcurrent(urls, (url) => fetch(url), { concurrency: 2 });
// Only two fetches are started at once.
```

```bash
npm install con-q
```

## Quick start

```js
import { mapConcurrent } from 'con-q';

// Process 100 URLs, 5 at a time, with retry
const results = await mapConcurrent(urls, async (url) => {
  const res = await fetch(url);
  return res.json();
}, {
  concurrency: 5,
  retry: { attempts: 3, minDelayMs: 200 },
});
```

## Why con-q?

Compose `p-queue` + `p-retry` the obvious way and retries silently escape the
rate limiter. In our [motivating experiment](bench/motivation/) (200 tasks,
5-per-second cap, 30% transient failures), the naive composition lost
30% of tasks in the zero-latency channel and 35% with injected latency. The
compliant arms lost 0–2%; the robust headline remains the specified
**roughly 29%-vs-2% gap**.

`con-q` makes retries re-enter admission control by default, so this cannot happen.

**`strict: true` barely helps arm A.** It reduces the burst, but task loss
remains because retries still fire outside the queue.

**Arms B and C are near-identical.** The fix is “retries must re-enter
admission control,” not “use con-q.” Their perfect zero-429 zero-latency result
is partly an in-process clock artifact; the jittered probe is the defensible
comparison and leaves a roughly 29%-vs-2% task-loss gap.

**You can close most of this gap in ~12 lines on stock `p-queue`** by
re-enqueueing retries via `queue.add` instead of wrapping with `p-retry`. What
`con-q` gives you on top of that: correct-by-default retry, first-error abort
that awaits in-flight settlement, a runtime guard for the eager-promise
mistake, and CommonJS support.

## Functional API

### `mapConcurrent(input, worker, options?)`

Map a worker over items with bounded concurrency. Results preserve input order.

```ts
import { mapConcurrent } from 'con-q';

const doubled = await mapConcurrent([1, 2, 3, 4, 5], async (n) => n * 2, {
  concurrency: 2,
});
// [2, 4, 6, 8, 10]
```

**With retry and rate limiting:**

```ts
await mapConcurrent(apiItems, async (item) => callApi(item), {
  concurrency: 10,
  intervalMs: 1000,
  intervalCap: 5,        // at most 5 starts per rolling second
  retry: {
    attempts: 3,          // total including first try
    minDelayMs: 100,
    factor: 2,
    jitter: 'full',       // 'none' | 'full' | 'equal'
  },
  timeoutMs: 30_000,      // per attempt
  signal: controller.signal,
  onProgress: ({ completed, total }) => console.log(`${completed}/${total}`),
});
```

**Error handling:**

```ts
// Default (stopOnError: true) — rejects on first failure, awaits in-flight settlement
await mapConcurrent(items, worker, { concurrency: 4 });

// stopOnError: false — runs everything, rejects with AggregateError (errors in input order)
await mapConcurrent(items, worker, { concurrency: 4, stopOnError: false });
```

### `mapSettled(input, worker, options?)`

Like `mapConcurrent` but never rejects for task failures. Returns per-item settled results.

```ts
import { mapSettled } from 'con-q';

const results = await mapSettled([1, 2, 3], async (n) => {
  if (n === 2) throw new Error('bad');
  return n * 10;
});

// results[0] -> { status: 'fulfilled', value: 10, index: 0 }
// results[1] -> { status: 'rejected', reason: Error('bad'), index: 1 }
// results[2] -> { status: 'fulfilled', value: 30, index: 2 }
```

### `forEachConcurrent(input, worker, options?)`

Fire-and-forget variant. Discards results for O(concurrency) memory on large streams.

```ts
import { forEachConcurrent } from 'con-q';

await forEachConcurrent(hugeStream, async (record) => {
  await db.insert(record);
}, { concurrency: 8 });
```

### Iterable and async iterable input

All three functions accept arrays, iterables, generators, and async generators.
Async generators are pulled lazily — the pool never buffers more than
`concurrency` items ahead.

```ts
async function* fetchPages() {
  let cursor;
  do {
    const page = await getPage(cursor);
    yield* page.items;
    cursor = page.next;
  } while (cursor);
}

await forEachConcurrent(fetchPages(), async (item) => processItem(item), {
  concurrency: 4,
});
```

## Queue API

For long-lived in-process queues with priority, pause/resume, and dynamic concurrency.

```ts
import { Queue } from 'con-q';

const q = new Queue({ concurrency: 4 });

// Enqueue tasks — returns a promise for each result
const result = await q.add(async (ctx) => {
  const res = await fetch('/api', { signal: ctx.signal });
  return res.json();
}, { priority: 5, timeoutMs: 10_000 });

// Batch enqueue
const results = await q.addAll([
  async () => fetchUser(1),
  async () => fetchUser(2),
]);

// Lifecycle
q.pause();
q.resume();
const removed = q.clear();  // rejects queued tasks with AbortError, returns count

await q.onIdle();   // resolves when queue is drained and nothing in-flight
await q.onEmpty();  // resolves when queued list is empty (in-flight may remain)

// Dynamic concurrency
q.concurrency = 8;  // raising starts queued tasks immediately

```

**Queue with rate limiting and retry:**

```ts
const q = new Queue({
  concurrency: 10,
  intervalMs: 1000,
  intervalCap: 5,
  retry: { attempts: 3, minDelayMs: 100 },
  signal: controller.signal,
});

// Per-task overrides
await q.add(task, {
  priority: 10,       // higher runs first; ties are FIFO
  timeoutMs: 5000,
  signal: taskAbortController.signal,
  retry: { attempts: 5 },  // overrides queue default
});
```

## Composable helper

### `withRetry(task, retryOptions?)`

Wrap a task with retry logic for standalone use. Note: this does **not** integrate
with admission control — for that, use `mapConcurrent` or `Queue` with the
`retry` option.

```ts
import { withRetry } from 'con-q';

const resilientTask = withRetry(async (ctx) => {
  const res = await fetch('/api', { signal: ctx.signal });
  return res.json();
}, { attempts: 3, minDelayMs: 200 });

const result = await resilientTask({ signal: controller.signal, attempt: 0 });
```

## Error types

```ts
import { TimeoutError, AbortError } from 'con-q';

try {
  await mapConcurrent(items, worker, { timeoutMs: 5000 });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.timeoutMs}ms`);
  }
  if (err instanceof AbortError) {
    console.log('Aborted:', err.cause);
  }
}
```

## Options reference

### `RunOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `4` | Max concurrent tasks. Positive integer or `Infinity`. |
| `signal` | `AbortSignal` | — | Abort the entire run. |
| `timeoutMs` | `number` | — | Per-attempt timeout in ms. |
| `retry` | `RetryOptions` | — | Retry configuration. |
| `onProgress` | `(info) => void` | — | Called after each task settles. |
| `intervalMs` | `number` | — | Rate limit window (ms). Must pair with `intervalCap`. |
| `intervalCap` | `number` | — | Max starts per window. Must pair with `intervalMs`. |

### `MapOptions` extends `RunOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `stopOnError` | `boolean` | `true` | `true`: reject on first failure. `false`: run all, `AggregateError`. |

### `RetryOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `attempts` | `number` | `1` | Total attempts including first try. |
| `minDelayMs` | `number` | `100` | Delay before first retry. |
| `maxDelayMs` | `number` | `30000` | Backoff cap. |
| `factor` | `number` | `2` | Exponential multiplier. |
| `jitter` | `'none' \| 'full' \| 'equal'` | `'full'` | Jitter strategy. |
| `isRetryable` | `(error, attempt) => boolean` | all except `AbortError` | Control which errors retry. |
| `onRetry` | `(info) => void` | — | Called before each retry with `{ error, attempt, delayMs }`. |

### `TaskOptions` (Queue)

| Option | Type | Default | Description |
|---|---|---|---|
| `priority` | `number` | `0` | Higher runs first. Ties are FIFO. |
| `signal` | `AbortSignal` | — | Per-task abort. |
| `timeoutMs` | `number` | queue default | Per-task timeout override. |
| `retry` | `RetryOptions` | queue default | Per-task retry override. |

### `TaskContext`

Every worker receives a context object:

```ts
const context = {
  signal: new AbortController().signal, // aborted on run-abort, timeout, or clear()
  attempt: 0,                         // 0 for first try, 1 for first retry, ...
};
void context;
```

## Behavioural notes

- **JavaScript cannot forcibly cancel a running Promise.** `timeoutMs` aborts
  the attempt's `AbortSignal` and frees the slot. The underlying work
  continues unless your worker honours `context.signal`. This is a language
  constraint, not a library one.
- **Retry holds its concurrency slot** across the backoff delay, but
  **re-acquires a rate-limit token** before the next attempt. This is the core
  of what `con-q` does differently.
- **`stopOnError: true` (default) awaits every in-flight task's settlement
  before rejecting.** No orphan promises mutating shared state after your
  `.catch` runs.
- **`stopOnError: false`** runs everything and rejects with a native
  `AggregateError` whose `errors` are in input-index order.
- **A task that never settles hangs the pool.** There is no global watchdog;
  use `timeoutMs`.

## Comparison

| Feature | `Promise.all` | `p-limit` | `p-map` | `p-queue` | **con-q** |
|---|---|---|---|---|---|
| Bounded concurrency | - | yes | yes | yes | yes (parity) |
| Order-preserving results | yes | via wrapping | yes | via `addAll` | yes (parity) |
| Async-iterable input | - | - | yes | - | yes (parity with `p-map`) |
| Priority scheduling | - | - | - | yes | yes (parity) |
| Sliding-window rate limiting | - | - | - | yes (`strict: true`) | yes (parity) |
| Pause / resume / clear / `onIdle` | - | - | - | yes | yes (parity) |
| Dynamic concurrency | - | - | - | yes | yes (parity) |
| Per-task timeout | - | - | - | yes | yes (parity) |
| `AbortSignal` | - | via wrapping | yes | yes | yes (parity) |
| **Retry inside admission control** | - | - | - | - (composable, ~12-line workaround) | **yes** |
| **CommonJS support** | n/a | - | - | - | **yes** |
| **First-error abort awaits in-flight** | - (`Promise.all` abandons) | n/a | - | - | **yes** |
| **Runtime eager-promise guard** | - | - | - | - | **yes** |

Everything above the bold rows is table stakes `con-q` matches. The bold rows
are the four things that differentiate it.

## When you should not use con-q

- You already use `p-queue` and are comfortable writing ~12 lines to
  re-enqueue retries. There is nothing else here you can't get.
- You need persistence, dead-letter queues, or distributed queuing. That is
  BullMQ / SQS / RabbitMQ territory. `con-q` is in-process only.
- You need worker threads or real parallelism. `con-q` is cooperative I/O
  concurrency.

## Reproducing the benchmark

```bash
node bench/motivation/run.mjs            # scaled, ~15s
node bench/motivation/run.mjs --full     # spec config (N=200, windowMs=1000, 3 seeds, ~16 min)
```

All figures cited above trace to this script's output.

## Requirements

- Node.js >= 20
- Zero runtime dependencies

## License

MIT

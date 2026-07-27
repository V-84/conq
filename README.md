# conq

Bounded async concurrency with retry integrated into admission control.
Zero runtime dependencies. ESM **and** CommonJS. Full types.

```bash
npm install conq
```

## Are you here because your queue is silently ignoring your rate limit?

The common mistake is starting the work eagerly, then handing the promises to
the queue:

```js
// broken: every fetch has already started running before conq sees it.
const items = [1, 2, 3, 4];
const promises = items.map((i) => new Promise((resolve) => fetch(url(i)).then(resolve)));
await mapConcurrent(promises, (p) => p, { concurrency: 2 }); // concurrency is meaningless here
```

`conq` detects this at runtime and throws a diagnostic instead of silently
running everything unbounded. The fix is a **thunk** — a function the queue
calls when it decides to run:

```js
import { mapConcurrent } from 'conq';
await mapConcurrent(items, async (i) => fetch(url(i)), { concurrency: 2 });
```

That's a JavaScript problem, not a `conq` problem — every concurrency library
in this space has to teach it, and most don't. It is the shape of ~half the
support questions p-queue, p-limit, and friends field.

## The one thing conq does that stock p-queue doesn't

Compose the standard tools the obvious way — `p-queue` for concurrency,
`p-retry` for retries — and the naive integration **silently breaks the rate
limit**:

```js
// broken: retries fire on p-retry's internal timer inside a single queue slot.
// The queue's rate governor never sees them.
const queue = new PQueue({ concurrency: 10, interval: 1000, intervalCap: 5, strict: true });
for (const item of items) {
  queue.add(() => pRetry(() => callApi(item), { retries: 4 }));
}
```

In the motivating experiment (`bench/motivation/`, arms A/B/C, 200 tasks, 5-per-1000ms
limit, 30% transient-503 injection, seeded), this composition **lost 29% of
tasks** to exhausted retry budgets while a compliant queue lost none.

`conq` re-enters admission control on every attempt:

```js
import { mapConcurrent } from 'conq';
await mapConcurrent(items, async (item) => callApi(item), {
  concurrency: 10,
  intervalMs: 1000,
  intervalCap: 5,
  retry: { attempts: 5, minDelayMs: 100, factor: 2, jitter: 'full' },
});
```

Every retry re-acquires a rate-limit token before firing. The concurrency
slot is held across the backoff (a retry does not release its slot). Both
choices are documented, tested, and unambiguous.

### The honest bit

**You can close most of this gap in about twelve lines on stock `p-queue`.**
Don't wrap `p-retry` around the task body — re-enqueue each retry with
`queue.add`:

```js
const queue = new PQueue({ concurrency: 10, interval: 1000, intervalCap: 5, strict: true });
const submit = (item, attempt = 0) =>
  queue.add(async () => {
    try { return await callApi(item); }
    catch (err) {
      if (attempt >= 4) throw err;
      setTimeout(() => submit(item, attempt + 1), 100 * 2 ** attempt);
    }
  });
items.forEach((item) => submit(item));
await queue.onIdle();
```

That's arm **C** in the benchmark. It matches `conq`'s task-loss numbers.
The fix is *"retries must re-enter admission control,"* not *"use `conq`."*

What `conq` gives you is: this behaviour by default, plus a first-error
policy that awaits in-flight settlement, plus a runtime guard for the
eager-promise mistake, plus CommonJS support. Not a capability nobody else
can offer.

## Behavioural notes you should know before you ship

- **JavaScript cannot forcibly cancel a running Promise.** `timeoutMs` aborts
  the attempt's `AbortSignal` and frees the slot. The underlying work
  continues unless *your* worker honours `context.signal`. Same for
  `signal`-based abort. This is a language constraint, not a library one.
- **Retry holds its concurrency slot across the backoff, but re-acquires a
  rate-limit token for the next attempt.** The whole point of `conq`; ignore
  it at your rate limiter's peril.
- **`stopOnError: true` (default) awaits every in-flight task's settlement
  before rejecting.** No orphan promises mutating shared state after your
  `.catch` runs. If you want `Promise.all`'s abandon-on-first-failure
  behaviour, you don't want `conq`.
- **`stopOnError: false` runs every task and rejects with a native
  `AggregateError`** whose `errors` are in input-index order.
- **A task that never settles hangs the pool.** There is no global watchdog;
  set `timeoutMs`.

## API sketch

```ts
import { mapConcurrent, mapSettled, forEachConcurrent, Queue, withRetry,
         TimeoutError, AbortError } from 'conq';

await mapConcurrent(items, async (item, index, ctx) => { /* ... */ }, {
  concurrency: 4,
  timeoutMs: 30_000,
  retry: { attempts: 3, minDelayMs: 100, factor: 2, jitter: 'full' },
  intervalMs: 1000, intervalCap: 5,      // both or neither
  signal: abortController.signal,
  onProgress: (info) => log(info),
  stopOnError: true,                     // default
});

const q = new Queue({ concurrency: 4 });
await q.add(async () => work(), { priority: 5, timeoutMs: 200 });
await q.onIdle();
```

## How this compares to `p-map`, `p-queue`, `p-limit`, `Promise.all`

| Feature | `Promise.all` | `p-limit` | `p-map` | `p-queue` | **conq** |
|---|---|---|---|---|---|
| Bounded concurrency | ✗ | ✓ | ✓ | ✓ | ✓ (parity) |
| Order-preserving results | ✓ | via wrapping | ✓ | via `addAll` | ✓ (parity) |
| Async-iterable input | ✗ | ✗ | ✓ | ✗ | ✓ (parity with `p-map`) |
| Priority scheduling | ✗ | ✗ | ✗ | ✓ | ✓ (parity) |
| Sliding-window rate limiting | ✗ | ✗ | ✗ | ✓ (`strict: true`) | ✓ (parity) |
| Pause / resume / clear / `onIdle` | ✗ | ✗ | ✗ | ✓ | ✓ (parity) |
| Dynamic concurrency | ✗ | ✗ | ✗ | ✓ | ✓ (parity) |
| Per-task timeout | ✗ | ✗ | ✗ | ✓ | ✓ (parity) |
| `AbortSignal` | ✓ | via wrapping | ✓ | ✓ | ✓ (parity) |
| **Retry inside admission control** | ✗ | ✗ | ✗ | ✗ (composable, ~12-line workaround) | **✓ (A1)** |
| **CommonJS support** | n/a | ✗ | ✗ | ✗ | **✓ (A2)** |
| **First-error abort *awaits in-flight settlement*** | ✗ (`Promise.all` abandons) | n/a | ✗ | ✗ | **✓ (A3)** |
| **Runtime guard for the eager-promise mistake** | ✗ | ✗ | ✗ | ✗ | **✓ (A4)** |

Everything above the rule is table stakes `conq` matches. Everything below is
the entire list of what makes it different.

## When you should *not* reach for conq

- You already use `p-queue` and are comfortable writing ~12 lines to
  re-enqueue retries. There is nothing else here you can't have.
- You need cross-process durability, persistence, dead-letter queues, or a
  distributed backend. That is BullMQ / SQS / RabbitMQ territory. `conq` is
  in-process.
- You need worker threads or real parallelism. `conq` is cooperative I/O
  concurrency; add a thread pool separately.

## Reproducing the numbers

```bash
node bench/motivation/run.mjs            # scaled, ~15s
node bench/motivation/run.mjs --full     # spec config (N=200, windowMs=1000, 3 seeds)
```

All figures cited above trace to this script's output.

## License

MIT.

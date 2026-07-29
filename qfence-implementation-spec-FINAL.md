# `qfence` — Final Implementation Specification

**Package:** `qfence` (npm) · **Repo:** `github.com/v-84/qfence` · **Import identifier:** `qfence`
**Audience:** an autonomous coding agent implementing this from scratch.
**Status:** self-contained and authoritative. This supersedes all earlier drafts (`taskq-*`). Where this document and any prior note disagree, this document wins.
**Deliverable:** a small, honest, zero-dependency Node.js + TypeScript library that bounds async concurrency *and* integrates retry correctly with rate limiting.

---

## 0. Read this before writing any code: what this library is, and is not

This project was validated by experiment before being specified. That experiment (reproduced in `bench/motivation/`, results in §1) established two things that must govern every decision below:

1. **The one thing worth building.** Composing the ecosystem's standard tools — `p-queue` for concurrency, `p-retry` for retries — the obvious way silently breaks the rate limit, because the queue only ever governs each task's *first* attempt. Retries fire from an external timer the queue cannot see. Under load this manufactured a self-inflicted 429 storm and **lost ~29% of all tasks** to exhausted retry budgets. `qfence` makes retries re-enter admission control by default, so this cannot happen.

2. **Honesty is a hard requirement, not a tone.** The same experiment proved that a competent engineer closes most of that gap in **about twelve lines** on stock `p-queue` (re-enqueue each retry through `queue.add`). So `qfence`'s value is *correct-by-default* plus a few genuine gaps — **not** a capability nobody else can offer. Any README copy, comparison table, or marketing that implies "impossible without qfence" is a spec violation (SC-28…SC-31). We win trust by conceding the general case and defending a narrow one precisely.

**If, during implementation, you find yourself expanding scope to "beat" `p-queue` on features it already has, stop.** p-queue is excellent, mature, and already ships per-task timeout, priority, pause/resume/clear, `onIdle`, dynamic concurrency, sliding-window rate limiting (`strict: true`), and task introspection. Those are **table stakes to match**, not features to claim.

### What `qfence` genuinely offers over `p-queue` (the entire list — there are four)

| # | Advantage | Weight |
|---|---|---|
| **A1** | **Retry integrated with admission control by default** — a failed attempt is re-admitted through the same concurrency + rate-limit gate, so retries never escape the limiter. | **Substantial** (but has a ~12-line userland workaround; sell as *correct default*, not *unique capability*) |
| **A2** | **CommonJS support.** p-queue is ESM-only; `p-queue-cjs`/`p-queue-compat` exist solely to fill this. | Real, unglamorous, probably drives the most installs |
| **A3** | **First-error handling that aborts and awaits in-flight work** before rejecting, instead of `Promise.all`-style abandonment. | Real, smaller impact |
| **A4** | **Runtime guard for the eager-promise mistake** — throws a diagnostic instead of silently running a live promise and disabling concurrency. | Small, high support value for JS users |

Everything else `qfence` does (bounded concurrency, order preservation, streaming input, `AggregateError` semantics, priority, rate limiting) **matches** `p-map`/`p-queue` and must be described as parity, never as advantage.

---

## 1. The motivating experiment (required reading; ships in the repo)

`p-queue@9.3.3` + `p-retry@8.0.0`. 200 tasks, rolling limit of 5 per 1000ms, 30% transient-503 injection, seeded, run to completion, 3 repetitions. Three arms:

- **A** — `p-queue` (`strict: true`) with `p-retry` wrapped inside each task (the naive composition).
- **B** — a `qfence`-style queue with retries re-admitted through the same gate.
- **C** — stock `p-queue` (`strict: true`), **no** `p-retry`, retries re-enqueued manually via `queue.add` (~12 lines).

| metric (median of 3 seeds) | A: p-queue + p-retry | B: qfence | C: p-queue + manual re-add |
|---|---|---|---|
| tasks lost / 200 | **57 (29%)** | 0 | 0 |
| 429s received | 230 | 0 | 0 |
| peak requests in a rolling window (cap 5) | 21 | 5 | 5 |

**Two findings that must be preserved verbatim in the README, because omitting them is dishonest:**

- **`strict: true` barely helps arm A.** It halves peak burst but leaves task loss essentially unchanged — the failure is retries escaping the queue, not the window algorithm. Pre-empt the "just turn on strict mode" comment with this.
- **Arms B and C are near-identical.** The fix is *"retries must re-enter admission control,"* not *"use qfence."* The zero-429 result for B and C is partly an artifact of a zero-latency test channel; under jittered latency both compliant arms emit ~80 429s and lose ~4/200 (qfence stays marginally ahead because it never leaves admission control at all). The **29%-vs-2% task-loss gap is the robust, defensible headline** and *widens* under realistic latency; the "perfect zero" framing must not be used.

`bench/motivation/` must contain a runnable version of this (arms A/B/C, seeded, plus the jittered-latency probe) so any reader can reproduce the numbers the README cites.

---

## 2. Scope

### In scope (v1.0.0)

| # | Feature | Status vs p-queue |
|---|---|---|
| F1 | Lazy task functions (`() => Promise<T>`); queue controls start time | parity |
| F2 | Bounded concurrency, immediate slot refill | parity |
| F3 | Input-order-preserved results | parity |
| F4 | `mapSettled` variant (never rejects for task failures) | parity |
| F5 | **Per-task retry: attempts, exponential backoff, jitter, `isRetryable`, `onRetry`** | **A1 — differentiator** |
| F6 | Per-task timeout | parity |
| F7 | `AbortSignal` support | parity |
| F8 | Progress reporting callback | parity |
| F9 | Long-lived `Queue` class: `add`, `pause`, `resume`, `clear`, `onIdle`, `onEmpty`, mutable concurrency | parity |
| F10 | Priority scheduling | parity |
| F11 | Rate limiting (token bucket, sliding window) | parity |
| F12 | Iterable / AsyncIterable input | parity (with `p-map`) |
| F13 | Zero runtime dependencies; ESM **and CJS**; full types | **A2 — differentiator (CJS)** |
| F14 | **First-error abort + in-flight settlement before rejecting** | **A3 — differentiator** |
| F15 | **Runtime guard against raw-promise misuse** | **A4 — differentiator** |

### Out of scope (do not implement; do not add dependencies for)

Persistence, durability, cross-process/cross-machine queuing (BullMQ/SQS/RabbitMQ territory); worker threads / true parallelism; dead-letter queues; cron/scheduling; distributed locks; a CLI; a browser-specific build target (the code is runtime-agnostic and dependency-free, so bundlers handle browsers, but no DOM types and no separate build).

---

## 3. Public API (normative)

Names and option keys are normative — tests and docs reference them exactly.

```ts
// ---------- Core types ----------
export type Task<T> = (context: TaskContext) => T | PromiseLike<T>;

export interface TaskContext {
  readonly signal: AbortSignal;   // aborted on run-abort, timeout, or clear()
  readonly attempt: number;       // 0-based: 0 first try, 1 first retry, …
}

export interface RetryOptions {
  attempts?: number;              // total incl. first; integer ≥ 1; default 1 (no retry)
  minDelayMs?: number;            // delay before first retry; ≥ 0; default 100
  maxDelayMs?: number;            // cap after backoff; default 30_000
  factor?: number;                // exponential multiplier; ≥ 1; default 2
  jitter?: 'none' | 'full' | 'equal';   // default 'full'
  isRetryable?: (error: unknown, attempt: number) => boolean; // default: retry all except AbortError
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
}

export interface ProgressInfo {
  completed: number; succeeded: number; failed: number; running: number;
  total: number | undefined;      // undefined for unsized async iterables
}

export interface RunOptions {
  concurrency?: number;           // positive integer or Infinity; default 4
  signal?: AbortSignal;
  timeoutMs?: number;             // per attempt; default none
  retry?: RetryOptions;
  onProgress?: (info: ProgressInfo) => void;
  intervalMs?: number;            // rate limit: both or neither
  intervalCap?: number;
}

export interface MapOptions extends RunOptions {
  stopOnError?: boolean;          // true (default): reject on first failure; false: run all, AggregateError
}

// ---------- Functional API (headline) ----------
export function mapConcurrent<T, R>(
  input: Iterable<T> | AsyncIterable<T>,
  worker: (item: T, index: number, context: TaskContext) => R | PromiseLike<R>,
  options?: MapOptions,
): Promise<R[]>;

export type SettledResult<R> =
  | { status: 'fulfilled'; value: R; index: number }
  | { status: 'rejected'; reason: unknown; index: number };

export function mapSettled<T, R>(
  input: Iterable<T> | AsyncIterable<T>,
  worker: (item: T, index: number, context: TaskContext) => R | PromiseLike<R>,
  options?: RunOptions,
): Promise<SettledResult<R>[]>;

export function forEachConcurrent<T>(   // discards results; O(concurrency) memory
  input: Iterable<T> | AsyncIterable<T>,
  worker: (item: T, index: number, context: TaskContext) => unknown | PromiseLike<unknown>,
  options?: MapOptions,
): Promise<void>;

// ---------- Class API ----------
export interface QueueOptions extends RunOptions { autoStart?: boolean; } // default true
export interface TaskOptions {
  priority?: number;              // higher first; ties FIFO; default 0
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: RetryOptions;
}

export declare class Queue {
  constructor(options?: QueueOptions);
  add<T>(task: Task<T>, options?: TaskOptions): Promise<T>;   // rejection always observable
  addAll<T>(tasks: readonly Task<T>[], options?: TaskOptions): Promise<T[]>;
  pause(): void;
  resume(): void;
  clear(): number;                // rejects removed tasks with AbortError; returns count
  onIdle(): Promise<void>;        // empty AND nothing in flight; resolves immediately if already idle
  onEmpty(): Promise<void>;       // pending empty; in-flight may remain
  readonly size: number;          // queued, not started
  readonly running: number;       // in flight
  readonly isPaused: boolean;
  concurrency: number;            // settable at runtime; raising starts more immediately
  [Symbol.asyncDispose](): Promise<void>;   // `await using q = new Queue()` drains on exit
}

// ---------- Composable helper ----------
export function withRetry<T>(task: Task<T>, options?: RetryOptions): Task<T>;

// ---------- Errors ----------
export declare class TimeoutError extends Error { readonly name: 'TimeoutError'; readonly timeoutMs: number; }
export declare class AbortError extends Error { readonly name: 'AbortError'; readonly cause?: unknown; }
```

> **Naming note.** The class is `Queue`, not `TaskQueue`/`QfenceQueue` — users write `import { Queue } from 'qfence'`. Do not prefix exports with the package name.

---

## 4. Normative semantics

Each corner below has a matching success criterion. Decide exactly as written.

**4.1 Laziness.** Never invoke a task until a concurrency slot and (if configured) a rate-limit token are both available.

**4.2 Slot accounting.** Track in-flight work by integer count or by identity `Set`, never by array position. Release on **settle** (`finally`), never on fulfil only.

**4.3 Ordering.** `mapConcurrent`/`mapSettled` return arrays indexed by input position regardless of completion order. `mapSettled` results also carry `index`.

**4.4 `stopOnError: true` (default).** On first rejection: (a) stop pulling new items; (b) abort the internal signal so cooperating in-flight tasks bail; (c) **await settlement of all in-flight tasks**; (d) then reject with the first error. Later errors are swallowed (no unhandled rejections). Rationale for (c): returning while work still mutates shared state is a footgun, and abandoning in-flight promises is the classic unhandled-rejection source. **This is differentiator A3.**

**4.5 `stopOnError: false`.** Run everything; if any failed, reject with a native `AggregateError` whose `errors` are in **input-index order**.

**4.6 Abort.** Pre-aborted signal → reject `AbortError` immediately, worker never invoked. Mid-run → stop pulling, abort `context.signal`, await in-flight settlement, reject `AbortError` with `cause = signal.reason`. Abort is not a task failure and is never retried.

**4.7 Timeout.** `timeoutMs` is **per attempt**. On expiry: abort that attempt's signal, free the slot, treat as rejection with `TimeoutError`. Clear the timer on settle and `timer.unref?.()`. README must state plainly: JS cannot forcibly cancel a running promise — the work continues unless the worker honours `context.signal`.

**4.8 Retry — the core differentiator (A1).** Retry index `n` (1-based) waits:
```
base = min(minDelayMs * factor ** (n - 1), maxDelayMs)
none  -> base
full  -> random() * base
equal -> base/2 + random() * base/2
```
`random` is injectable via a module-internal seam (not public) for deterministic tests. Default `isRetryable`: `false` for `AbortError`, `true` otherwise; `TimeoutError` is retryable by default.

**Admission-control rule (the whole point of the library):**
- A retry **holds its concurrency slot** across the backoff delay (it does not release and re-queue for concurrency).
- A retry **re-acquires a rate-limit token** before firing. It must never bypass the rate limiter. This is precisely what the naive `p-queue + p-retry` composition gets wrong.
- Document both choices explicitly.

**4.9 Concurrency validation.** Throw `TypeError` unless `concurrency === Infinity` or (`Number.isInteger` and `≥ 1`). Rejects `NaN`, `0`, `-1`, `2.5`, `'4'`, `null`. `undefined` → default. **The `NaN` case must not hang** (`running < NaN` is always false → silent stall). Message names the parameter and echoes the value. Same validation shape for `attempts`, `factor`, `intervalMs`, `intervalCap`, `timeoutMs`.

**4.10 Empty input.** Resolve `[]` immediately; worker never invoked; `onProgress` called 0 or 1 time (`total: 0`) — pick one, test it.

**4.11 Effective concurrency.** Never spawn more runners than items for sized iterables. For async iterables, spawn up to `concurrency` lazily.

**4.12 Rate limiting.** Sliding-window token bucket: at most `intervalCap` task *starts* per rolling `intervalMs`. Orthogonal to and composable with `concurrency` (effective rate = min of the two). Timers unref'd.

**4.13 Priority (class only).** Higher first; ties FIFO via a monotonic sequence number (explicit tiebreak, not reliance on sort stability). Evaluated at slot-acquisition time.

**4.14 `add()` rejection safety.** `add` returns a promise callers may ignore. An ignored rejection must not crash the process — attach an internal no-op catch while still returning a rejecting promise to the caller.

**4.15 Zero unhandled rejections.** Absolute invariant across every path: simultaneous failures, failure during backoff, abort during backoff, `clear()` while paused, ignored `add()`.

**4.16 Raw-promise runtime guard (A4).** Every entry point accepting a task/worker guards at runtime. Non-function → `TypeError`. Thenable (`typeof v?.then === 'function'`) → a `TypeError` that diagnoses the specific mistake:
```
TypeError: qfence: expected a task function, received a Promise at index 2.
A Promise starts running the moment it is created, so passing one here means the
work has already begun and concurrency cannot be limited. Wrap it in a function:
  qfence.mapConcurrent(items, (item) => doWork(item))
```
Validate each element as it is pulled (O(1) per task), never by eagerly walking large inputs.

---

## 5. Reference core

Build outward from this. Do not over-engineer it.

```ts
async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const limit = Math.min(concurrency, items.length);
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;                    // atomic: no await between read and write
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: limit }, runner));
  return results;
}
```

A fixed pool of `limit` runners pulling a shared cursor gives immediate refill, makes positional bookkeeping impossible, writes results by input index, and needs no `running` array. Layer retry/timeout as wrappers around `worker`; rate limiting as an `await tokens.acquire()` before the call; abort and `stopOnError` as a shared flag checked after `cursor++`. **One scheduler** — `mapConcurrent` and `Queue` share it; do not write two.

---

## 6. Toolchain (TypeScript 7)

TS 7.0 went GA 2026-07-08 (Go port; ~8–12× faster full builds). **7.0 ships without a stable programmatic API — that lands in 7.1.** Any tool that imports `typescript` and walks the AST is broken against 7.0. This is a greenfield zero-dependency package, so it can be pure TS 7 provided the following holds.

**Banned** (consume the programmatic API; will fail): `typescript-eslint`/`@typescript-eslint/*` (npm ERESOLVE against `typescript@7`), `ts-jest`, `ts-node`, `ts-loader`, `ts-morph`, custom AST transformers, `ttypescript`, `rollup-plugin-dts`, and `tsup`/`unbuild` **if** their dts step routes through the compiler API. `tsc` emits declarations natively and is now fast — use it.

**Required stack:**

| Concern | Tool | Note |
|---|---|---|
| Compile + declarations | `tsc` from `typescript@^7.0.0` | the only TS-consuming tool in the project |
| Test runner | `vitest` | esbuild transform; doesn't touch the TS API |
| Fake timers | `@sinonjs/fake-timers` **(devDependency only)** | for deterministic timing tests |
| Lint + format | `@biomejs/biome` (or `oxlint`) | Rust-based, no TS dependency |
| Package validation | `publint` | `attw` optional (embeds `typescript`) |
| Runtime | Node `>=20` | see §6b |

Do **not** install `@typescript/native-preview` (`tsgo` nightly). The stable `typescript` package is correct.

**tsconfig.base.json** (TS 7 hard-removes `target: es5`, `moduleResolution: node`, `baseUrl`; `types` now defaults to `[]`):

```jsonc
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2023", "esnext.disposable"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "declaration": true,
    "sourceMap": true,
    "rootDir": "./src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`target: es2022` is chosen for the Node 20 floor (§6b). `erasableSyntaxOnly` bans `enum`/`namespace`/parameter-properties — use `const` object + union instead of `enum`. Enable `declarationMap`, verify the emit, drop it if it misbehaves rather than blocking.

**Dual ESM/CJS:** two `tsc` runs (`tsconfig.esm.json` → `module: nodenext`, `outDir: dist/esm`; `tsconfig.cjs.json` → `module: commonjs`, `moduleResolution: node16`, `outDir: dist/cjs`), then write `dist/esm/package.json` `{"type":"module"}` and `dist/cjs/package.json` `{"type":"commonjs"}`.

```jsonc
// package.json
{
  "name": "qfence",
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "repository": { "type": "git", "url": "git+https://github.com/v-84/qfence.git" },
  "exports": {
    ".": {
      "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
      "require": { "types": "./dist/cjs/index.d.ts", "default": "./dist/cjs/index.js" }
    }
  }
}
```

**Repo layout:**
```
src/
  index.ts          # exports only, no logic
  errors.ts         # TimeoutError, AbortError
  validate.ts       # §4.9, §4.16
  pool.ts           # §5 scheduler
  map.ts            # mapConcurrent, mapSettled, forEachConcurrent
  queue.ts          # Queue class
  retry.ts          # withRetry + backoff (injectable random)
  rate-limit.ts     # sliding-window token bucket
  internal/{deferred,iterate}.ts
test/*.test.ts
bench/
  motivation/       # arms A/B/C + jittered-latency probe (SC-28a)
README.md
```

## 6b. JavaScript consumers are first-class

- **Runtime validation carries the safety load** every static guarantee gives TS users (§4.9, §4.16). Messages name the parameter, echo the value, and explain known mistakes.
- **Editor support for free:** ship `.d.ts`; VS Code gives JS users autocomplete + hover docs with zero config. Never strip declarations.
- **JSDoc users:** `@type {import('qfence').MapOptions}` must resolve (SC-34).
- **Node floor `>=20`:** the only blockers are `Promise.withResolvers` and `AbortSignal.any`; implement both as tiny internal fallbacks in `src/internal/` that prefer native when present. No polyfill dependency. Test on 20, 22, 24.

---

## 7. Success criteria

Complete when **every** item has a passing automated test in CI on Node 20, 22, 24. Each names the falsifiable assertion.

### Correctness

| ID | Criterion | Assertion |
|---|---|---|
| **SC-1** | Laziness | `concurrency:1`, 3 tasks logging start/finish → exact event log `start,finish,×3`, never `start,start,start` |
| **SC-2** | Concurrency ceiling | in-flight counter; ≥200 randomised runs (items 0–50, random durations, concurrency 1–10) → `max ≤ concurrency` every run |
| **SC-3** | Order preservation | reversed/random completion order → `result[i] === f(input[i])` for ≥200 runs |
| **SC-4** | Immediate refill | durations `[1000,10,10,10]`, `concurrency:2`, fake timers → ≈1000ms not ≈2000ms; item 3 starts before item 0 finishes |
| **SC-5** | Failure frees slot | 10 tasks, item 0 rejects, `stopOnError:false` → all 9 others run, settles, no hang |
| **SC-6** | Zero unhandled rejections | global counter asserted 0 after whole suite; suite includes simultaneous failures, failure-in-backoff, abort mid-flight, `clear()` with queued, ignored `add()` |
| **SC-7** | `stopOnError` | default: rejects first error, no new starts after failure, all in-flight settled before rejection (assert settled-count in `.catch`); `false`: `AggregateError` in input order |
| **SC-8** | Retry + backoff | fail twice then succeed, `attempts:3, minDelayMs:100, factor:2, jitter:'none'`, fake timers → exactly 3 invocations; delays 100 then 200ms; `onRetry` twice; plus `maxDelayMs` cap, `isRetryable:false` short-circuit, jitter bounds with stubbed random |
| **SC-8a** | **Retry re-acquires rate-limit token (A1)** | with `intervalCap` set, a retrying task's re-attempt is subject to the limiter — assert the retry does not fire while the window is saturated, and that total starts (incl. retries) never exceed `intervalCap` per window |
| **SC-9** | Abort | (a) pre-aborted → `AbortError`, 0 invocations; (b) mid-run → no new starts, in-flight `signal.aborted`, rejects with `cause=reason`; (c) during backoff → rejects promptly, no wait-out, no retry |
| **SC-10** | Validation | `concurrency` ∈ {NaN,0,-1,1.5,'4',null} each throw `TypeError` synchronously (or immediate rejection — pick/document/test); `Infinity` + positive ints accepted; message echoes value; **assert NaN does not hang**; same for `attempts,factor,intervalMs,intervalCap,timeoutMs` |
| **SC-11** | Empty input | `mapConcurrent([], w)` → `[]`, `w` 0 invocations |
| **SC-12** | Timeout | `timeoutMs:50` on 500ms task → `TimeoutError`, slot freed (~50ms not ~500ms), `signal` aborted; per-attempt when combined with retry |
| **SC-13** | Dynamic concurrency | raising `queue.concurrency` starts queued tasks same tick; lowering doesn't kill in-flight but blocks new starts until drop below new limit |
| **SC-14** | Queue lifecycle | `onIdle()` resolves once on drain and immediately if idle; `pause`/`resume` gate without dropping; `clear()` returns count, rejects removed with `AbortError` |
| **SC-15** | Priority | `concurrency:1`, priorities `[0,5,0,10]` → exact execution order incl. FIFO tiebreak between the two 0s |
| **SC-16** | Rate limit | `intervalCap:2, intervalMs:1000, concurrency:10`, 6 instant tasks, fake timers → starts at ~0(×2), ~1000(×2), ~2000(×2); plus composition: `concurrency:1` + generous limit → serial |
| **SC-17** | Iterables | Iterable, generator, AsyncIterable inputs; async generator pulled lazily (assert not exhausted while tasks running) |
| **SC-18** | Memory | `forEachConcurrent` over generator of 1e6 items, `concurrency:4`, no result retention; heapUsed delta under fixed ceiling with forced GC (slow test, separate job OK) |
| **SC-19** | No process retention | child process runs a small `mapConcurrent` (with `timeoutMs` + rate limit) → exits on its own, code 0, within 5s |
| **SC-20** | Types | `mapConcurrent<number,string>` infers `Promise<string[]>`; `SettledResult` narrows on `status`; **passing a raw `Promise` where `Task` expected is a compile error** (`@ts-expect-error`) |

### Quality gates

| ID | Criterion |
|---|---|
| **SC-21** | `tsc --noEmit` zero errors under §6 tsconfig |
| **SC-22** | Biome lint: zero errors, zero warnings |
| **SC-23** | Coverage ≥95% lines, ≥90% branches, enforced as hard CI threshold |
| **SC-24** | `npm ls --all --omit=dev --prod` → zero runtime deps; `dependencies` absent or `{}` |
| **SC-25** | `publint` passes; ESM (`smoke.mjs`) and CJS (`smoke.cjs`) smoke scripts run clean **against the packed tarball**, not `src/` |
| **SC-26** | CI green on Node 20, 22, 24, ubuntu-latest |
| **SC-27** | Every exported symbol has a TSDoc block with ≥1 `@example` |

### JavaScript-consumer gates

| ID | Criterion |
|---|---|
| **SC-32** | Raw-promise guard: passing `[Promise.resolve(1),…]`/a `Promise`/a non-function worker throws `TypeError` whose message contains the offending index and the word `Promise` (assert message content) |
| **SC-33** | Plain-JS smoke: a no-build `.js` file installs the packed tarball and exercises `mapConcurrent`, `Queue`, retry, abort; green on Node 20/22/24; ESM + CJS variants |
| **SC-34** | JSDoc: a `.js` file using `@type {import('qfence').MapOptions}` type-checks under `tsc --checkJs --noEmit` against the built package |

### Documentation / honesty gates (non-negotiable)

| ID | Criterion |
|---|---|
| **SC-28** | README opens with the eager-promise problem: broken `new Promise(...)` example, its wrong output, the thunk fix. Highest-traffic search intent. |
| **SC-28a** | `bench/motivation/` contains the runnable arms A/B/C experiment + jittered-latency probe reproducing §1's numbers. README's cited figures must match its output. |
| **SC-29** | README states explicitly: (a) JS can't forcibly cancel a running promise — `timeoutMs` frees the slot, work continues unless the worker honours `signal`; (b) retry holds its concurrency slot but re-acquires a rate-limit token; (c) `stopOnError:true` awaits in-flight settlement before rejecting |
| **SC-30** | Comparison section vs `p-map`, `p-queue`, `p-limit`, `Promise.all` that **concedes the general case in plain language** and claims only A1–A4. Every advantage cell traceable to a competitor's published docs. **No cell overstated** — a reviewer must find none. Features p-queue already has (timeout, priority, pause/resume, `onIdle`, dynamic concurrency, `strict` rate limiting, introspection) shown as **parity**, never advantage. |
| **SC-31** | README must **not** imply "impossible without qfence." It must state that re-enqueueing retries fixes most of the rate-limit gap in ~12 lines on stock p-queue, and position qfence as *correct-by-default + CJS + safer error/abort defaults*. Every README code sample is extracted and executed in a test. |

---

## 8. Build order

Each phase green before the next.

0. **Phase 0 — justification (already done; keep in repo).** `bench/motivation/` arms A/B/C + latency probe. Targets: SC-28a. *This gated the whole project and its output is the README's evidence.*
1. **Phase 1 — engine.** `pool.ts`, `validate.ts`, `errors.ts`, `mapConcurrent`, `mapSettled`. Targets: SC-1…7, SC-10, SC-11, SC-20, SC-21, SC-32.
2. **Phase 2 — resilience (the differentiator).** `retry.ts`, timeout, abort, and the admission-control rule. Targets: SC-8, SC-8a, SC-9, SC-12.
3. **Phase 3 — class API.** `queue.ts` (priority, pause/resume/clear, `onIdle`, dynamic concurrency) on the **shared** scheduler. Targets: SC-13, SC-14, SC-15.
4. **Phase 4 — rate limiting + streaming.** `rate-limit.ts`, iterables, `forEachConcurrent`. Targets: SC-16, SC-17, SC-18.
5. **Phase 5 — packaging + docs.** Dual build, exports, smoke tests, README (honesty gates), CI. Targets: SC-19, SC-22…31, SC-33, SC-34.

---

## 9. Implementation traps

- `Promise.withResolvers()` and `AbortSignal.any([userSignal, internalController.signal])` — but note `AbortSignal.any` holds references; don't create one per retry attempt in a hot loop without letting it be collected.
- `AbortSignal.timeout(ms)` yields a `DOMException` `TimeoutError`, not this library's — normalise before surfacing.
- Slot release: always `finally`. Never `.then(release, release)`.
- Priority queue: a min-heap keyed by `(-priority, sequence)`. Do not `sort()` on every insert; do not `shift()` an array in a hot path (O(n)).
- Wrap worker invocation so a **synchronous** throw becomes a rejection and still releases the slot; accept `T | PromiseLike<T>` and normalise non-promise returns.
- A worker that never settles hangs the pool by design — no global watchdog; that's what `timeoutMs` is for. State it in the README.
- Fake-timer tests: advance with `await vi.advanceTimersByTimeAsync(n)` / `@sinonjs` `tickAsync`, and assert on recorded event logs, not `Date.now()` deltas. Beware: a zero-latency in-process test channel makes client and server share one `Date.now()` — good for scheduler tests, but it makes a compliant limiter *incapable* of self-violation, so rate-limit-compliance assertions need injected latency to be meaningful (this is the artifact the motivation experiment had to correct for).

---

## 10. Definition of done

- SC-28a demonstrated (it gated the build) and its numbers match the README.
- All SC-1…SC-34 green in CI on Node 20, 22, 24.
- `npm pack` tarball contains only `dist/`, `README.md`, `LICENSE`, `package.json`.
- Both smoke scripts (ESM + CJS) run clean against the packed tarball installed into a scratch dir — not `src/`.
- No `TODO`, no `any` outside a commented escape hatch, no `@ts-ignore` (`@ts-expect-error` only in type tests).
- The README passes the honesty gates: a knowledgeable reviewer reading it alongside `p-queue`'s docs finds no overstated claim.

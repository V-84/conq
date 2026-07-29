# Motivation benchmark

Reproduces §1 of `conq-implementation-spec-FINAL.md`. Three arms hit a fake
upstream with a rolling 5-per-1000ms limit and 30% transient-503 injection.

```
node bench/motivation/run.mjs           # scaled: ~15s, N=100, windowMs=50
node bench/motivation/run.mjs --full    # spec config: N=200, windowMs=1000, 3 seeds (~16 min)
```

**Arms**

- **A** — `p-queue@9` (strict) with `p-retry` wrapped inside each task. Retries
  fire on `p-retry`'s internal timer inside a single queue slot, so the queue's
  rate-limit governor never sees them. Result: retry storm, budget exhaustion,
  large task loss.
- **B** — a `c-queue`-style queue: every attempt (first or retry) re-acquires a
  rate-limit token before firing. Same technique the shipped library uses.
- **C** — stock `p-queue`, no `p-retry`; retries are manually re-enqueued via
  `queue.add`. ~12 lines. Matches arm B in behaviour — the fix is
  "retries must re-enter admission control," not "use c-queue."

The zero-latency channel keeps arms B and C at or near zero 429s because client
and server share a single `Date.now()`. With latency applied before upstream
admission, both compliant arms emit about 70–80 429s and lose about 2% of
tasks; arm A loses about 35%. The roughly 29%-vs-2% gap remains the robust,
defensible headline.

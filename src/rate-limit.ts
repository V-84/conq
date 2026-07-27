/**
 * Sliding-window token bucket. At most `cap` acquisitions per rolling `windowMs`.
 * `acquire()` is FIFO with respect to waiters. Timers are `unref`'d.
 *
 * §4.12: composable with `concurrency` — effective rate = min of the two.
 */
export interface RateLimiter {
  acquire(signal?: AbortSignal): Promise<void>;
  /** For test observation. */
  readonly waiters: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

export function createRateLimiter(windowMs: number, cap: number): RateLimiter {
  const starts: number[] = []; // timestamps (Date.now) of acquisitions still in window
  const waiters: Waiter[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const evict = (now: number): void => {
    while (starts.length && starts[0]! <= now - windowMs) starts.shift();
  };

  const scheduleDrain = (): void => {
    if (drainTimer !== undefined || starts.length === 0) return;
    const wait = Math.max(1, starts[0]! + windowMs - Date.now());
    drainTimer = setTimeout(drain, wait);
    (drainTimer as unknown as { unref?: () => void }).unref?.();
  };

  const drain = (): void => {
    drainTimer = undefined;
    const now = Date.now();
    evict(now);
    while (waiters.length && starts.length < cap) {
      const w = waiters.shift()!;
      w.cleanup();
      starts.push(Date.now());
      w.resolve();
    }
    if (waiters.length) scheduleDrain();
  };

  return {
    get waiters() {
      return waiters.length;
    },
    async acquire(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const now = Date.now();
      evict(now);
      if (starts.length < cap && waiters.length === 0) {
        starts.push(now);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const w: Waiter = {
          resolve,
          reject,
          cleanup: () => {
            if (signal) signal.removeEventListener('abort', onAbort);
          },
        };
        const onAbort = () => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(signal!.reason ?? new Error('aborted'));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        waiters.push(w);
        scheduleDrain();
      });
    },
  };
}

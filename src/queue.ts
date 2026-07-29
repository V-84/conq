import { AbortError } from './errors.js';
import { type Deferred, deferred } from './internal/deferred.js';
import { type HeapItem, MinHeap } from './internal/heap.js';
import { anySignal } from './internal/signal.js';
import { type NormalizedCommon, normalizeCommonOptions, runAttempts } from './pool.js';
import { type NormalizedRetry, normalizeRetry } from './retry.js';
import type { RetryOptions, RunOptions, Task, TaskContext } from './types.js';
import {
  assertTaskFunction,
  validateNonNegativeFinite,
  validatePositiveIntOrInfinity,
} from './validate.js';

/**
 * Long-lived task queue with priority, pause/resume/clear, `onIdle`/`onEmpty`,
 * dynamic concurrency, and the same admission-control semantics as
 * `mapConcurrent` (retry + rate-limit re-acquisition per attempt).
 *
 * @example
 * ```ts
 * import { Queue } from 'qfence';
 * const q = new Queue({ concurrency: 2 });
 * const r = await q.add(async () => 42);
 * await q.onIdle();
 * ```
 */
export interface QueueOptions extends RunOptions {
  autoStart?: boolean;
}

/**
 * Per-task overrides for options declared on the queue.
 *
 * @example
 * ```ts
 * const q = new Queue({ concurrency: 2 });
 * await q.add(async (ctx) => fetch('/api'), { priority: 10, timeoutMs: 5000 });
 * ```
 */
export interface TaskOptions {
  priority?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: RetryOptions;
}

interface QueuedTask extends HeapItem {
  task: Task<unknown>;
  deferred: Deferred<unknown>;
  taskSignal?: AbortSignal;
  timeoutMs: number | undefined;
  retry: NormalizedRetry;
  abortListener: (() => void) | undefined;
}

/**
 * Long-lived in-process task queue with priorities, lifecycle controls,
 * dynamic concurrency, retries, timeouts, abort signals, and rate limiting.
 *
 * @example
 * ```ts
 * import { Queue } from 'qfence';
 * const queue = new Queue({ concurrency: 2 });
 * const value = await queue.add(async () => 42);
 * await queue.onIdle();
 * ```
 */
export class Queue {
  #concurrency: number;
  #paused: boolean;
  #running = 0;
  #heap = new MinHeap<QueuedTask>();
  #seq = 0;
  #onIdleDeferred: Deferred<void> | undefined;
  #onEmptyDeferred: Deferred<void> | undefined;
  #baseRetry: NormalizedRetry;
  #baseTimeoutMs: number | undefined;
  #normalized: NormalizedCommon;
  #externalSignal: AbortSignal | undefined;
  #controller = new AbortController(); // queue-wide abort (never externally aborted; used to signal clear())

  constructor(options: QueueOptions = {}) {
    this.#normalized = normalizeCommonOptions(options);
    this.#concurrency = this.#normalized.concurrency;
    this.#baseRetry = this.#normalized.retry;
    this.#baseTimeoutMs = this.#normalized.timeoutMs;
    this.#paused = options.autoStart === false;
    this.#externalSignal = options.signal;
    if (this.#externalSignal?.aborted) {
      // The queue itself doesn't reject up-front but any add() will fail.
      this.#controller.abort(this.#externalSignal.reason);
    } else if (this.#externalSignal) {
      this.#externalSignal.addEventListener(
        'abort',
        () => {
          this.#controller.abort(this.#externalSignal!.reason);
          // Reject all queued tasks so their promises don't hang forever
          // (e.g. when paused or autoStart:false and nothing is draining them).
          const drained = this.#heap.drain();
          for (const item of drained) {
            this.#detachTaskAbort(item);
            item.deferred.reject(new AbortError('Queue aborted', this.#externalSignal!.reason));
          }
          this.#maybeResolveEmpty();
          this.#maybeResolveIdle();
        },
        { once: true },
      );
    }
  }

  get size(): number {
    return this.#heap.size;
  }
  get running(): number {
    return this.#running;
  }
  get isPaused(): boolean {
    return this.#paused;
  }
  get concurrency(): number {
    return this.#concurrency;
  }
  set concurrency(value: number) {
    this.#concurrency = validatePositiveIntOrInfinity('concurrency', value);
    this.#tick();
  }

  /**
   * Enqueue a task. The returned promise resolves with the task's result or
   * rejects with its failure. Ignored rejections do not crash the process
   * (§4.14): an internal no-op catch is attached, but the returned promise
   * still rejects for observers.
   *
   * @example
   * ```ts
   * const q = new Queue({ concurrency: 1 });
   * const value = await q.add(async () => 'ok', { priority: 5, timeoutMs: 100 });
   * ```
   */
  add<T>(task: Task<T>, options: TaskOptions = {}): Promise<T> {
    assertTaskFunction(task, 0, 'task');
    const taskRetry = options.retry ? normalizeRetry(options.retry) : this.#baseRetry;
    let timeoutMs = this.#baseTimeoutMs;
    if (options.timeoutMs !== undefined) {
      timeoutMs = validateNonNegativeFinite('timeoutMs', options.timeoutMs);
    }
    const priority = options.priority ?? 0;
    const d = deferred<T>();
    // §4.14: ignored rejections must not crash the process.
    d.promise.catch(() => {});
    const entry: QueuedTask = {
      seq: this.#seq++,
      priority,
      task: task as Task<unknown>,
      deferred: d as Deferred<unknown>,
      timeoutMs,
      retry: taskRetry,
      abortListener: undefined,
    };
    if (options.signal) entry.taskSignal = options.signal;

    if (options.signal?.aborted) {
      d.reject(new AbortError('Aborted', options.signal.reason));
      return d.promise;
    }
    if (this.#controller.signal.aborted) {
      d.reject(new AbortError('Queue aborted', this.#controller.signal.reason));
      return d.promise;
    }
    this.#heap.push(entry);
    if (options.signal) {
      const onTaskAbort = () => {
        if (!this.#heap.remove(entry)) return;
        this.#detachTaskAbort(entry);
        d.reject(new AbortError('Aborted', options.signal!.reason));
        this.#maybeResolveEmpty();
        this.#maybeResolveIdle();
      };
      entry.abortListener = onTaskAbort;
      options.signal.addEventListener('abort', onTaskAbort, { once: true });
      if (options.signal.aborted) onTaskAbort();
    }
    this.#tick();
    return d.promise;
  }

  /**
   * Enqueue a batch. Returns results in input order. If any task rejects the
   * combined promise rejects with the first error (individual promises still
   * settle).
   */
  addAll<T>(tasks: readonly Task<T>[], options: TaskOptions = {}): Promise<T[]> {
    return Promise.all(tasks.map((t) => this.add<T>(t, options)));
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#tick();
  }

  /**
   * Remove all queued (not-yet-started) tasks; reject each with `AbortError`.
   * Returns the number of tasks removed. In-flight tasks are not affected —
   * that matches p-queue's `clear()` semantics.
   */
  clear(): number {
    const drained = this.#heap.drain();
    for (const item of drained) {
      this.#detachTaskAbort(item);
      item.deferred.reject(new AbortError('Task cleared'));
    }
    // If nothing in flight, we're now idle/empty.
    this.#maybeResolveIdle();
    this.#onEmptyDeferred?.resolve();
    this.#onEmptyDeferred = undefined;
    return drained.length;
  }

  /**
   * Resolves once the queue has drained: no queued tasks and no in-flight.
   * Resolves immediately if already idle.
   */
  onIdle(): Promise<void> {
    if (this.#heap.size === 0 && this.#running === 0) return Promise.resolve();
    this.#onIdleDeferred ??= deferred<void>();
    return this.#onIdleDeferred.promise;
  }

  /**
   * Resolves once the queued list is empty (in-flight may remain).
   */
  onEmpty(): Promise<void> {
    if (this.#heap.size === 0) return Promise.resolve();
    this.#onEmptyDeferred ??= deferred<void>();
    return this.#onEmptyDeferred.promise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.onIdle();
  }

  #tick(): void {
    if (this.#paused) return;
    while (this.#running < this.#concurrency && this.#heap.size > 0) {
      const item = this.#heap.pop();
      if (!item) break;
      this.#detachTaskAbort(item);
      if (this.#heap.size === 0) {
        this.#maybeResolveEmpty();
      }
      this.#running++;
      this.#runOne(item).finally(() => {
        this.#running--;
        this.#tick();
        this.#maybeResolveIdle();
      });
    }
  }

  async #runOne(item: QueuedTask): Promise<void> {
    // Combine queue-wide abort + per-task abort into one poolSignal.
    const signals: AbortSignal[] = [this.#controller.signal];
    if (item.taskSignal) signals.push(item.taskSignal);
    const poolSignal = signals.length === 1 ? signals[0]! : anySignal(signals);

    try {
      const value = await runAttempts(
        undefined,
        0,
        // The Queue "worker" ignores item/index and calls the task directly:
        (_i, _idx, ctx: TaskContext) => item.task(ctx),
        poolSignal,
        item.retry,
        item.timeoutMs,
        this.#normalized.rateLimiter,
      );
      item.deferred.resolve(value);
    } catch (err) {
      item.deferred.reject(err);
    }
  }

  #maybeResolveIdle(): void {
    if (this.#running === 0 && this.#heap.size === 0) {
      this.#onIdleDeferred?.resolve();
      this.#onIdleDeferred = undefined;
    }
  }

  #maybeResolveEmpty(): void {
    if (this.#heap.size === 0) {
      this.#onEmptyDeferred?.resolve();
      this.#onEmptyDeferred = undefined;
    }
  }

  #detachTaskAbort(item: QueuedTask): void {
    if (item.taskSignal && item.abortListener) {
      item.taskSignal.removeEventListener('abort', item.abortListener);
      item.abortListener = undefined;
    }
  }
}

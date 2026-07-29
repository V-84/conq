/**
 * Runtime validation for numeric options and task-shape checks.
 *
 * Every message names the parameter and echoes the offending value so JS users
 * get the same immediate signal TS users get from the compiler (§6b).
 */

export function validatePositiveIntOrInfinity(name: string, value: unknown): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `c-queue: '${name}' must be a positive integer or Infinity, received ${describe(value)}`,
    );
  }
  return value;
}

export function validatePositiveInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `c-queue: '${name}' must be a positive integer, received ${describe(value)}`,
    );
  }
  return value;
}

export function validateNonNegativeInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `c-queue: '${name}' must be a non-negative integer, received ${describe(value)}`,
    );
  }
  return value;
}

export function validateNonNegativeFinite(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `c-queue: '${name}' must be a non-negative finite number, received ${describe(value)}`,
    );
  }
  return value;
}

export function validateFactor(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TypeError(
      `c-queue: '${name}' must be a finite number >= 1, received ${describe(value)}`,
    );
  }
  return value;
}

/**
 * Guard against the eager-promise mistake: throwing a diagnostic instead of
 * silently running a live Promise and disabling concurrency (§4.16, A4).
 */
export function assertTaskFunction(value: unknown, index: number, label = 'task'): void {
  if (typeof value === 'function') return;
  if (isThenable(value)) {
    throw new TypeError(
      `c-queue: expected a ${label} function, received a Promise at index ${index}.\nA Promise starts running the moment it is created, so passing one here means the\nwork has already begun and concurrency cannot be limited. Wrap it in a function:\n  c-queue.mapConcurrent(items, (item) => doWork(item))`,
    );
  }
  throw new TypeError(
    `c-queue: expected a ${label} function at index ${index}, received ${describe(value)}`,
  );
}

/**
 * Guard against the *array-of-promises* form of the eager-promise mistake:
 * `mapConcurrent([fetch(a), fetch(b)], (p) => p)`. Here the worker is a valid
 * function, so `assertTaskFunction` passes — but the input elements are live
 * Promises whose work has already started, so concurrency is meaningless. This
 * is the exact case the README leads with (§4.16, A4).
 *
 * Materialized arrays are scanned once so every already-rejected Promise is
 * observed before Node can report it as unhandled. Lazy Iterable and
 * AsyncIterable values are instead validated one at a time by `runPool` as
 * they are pulled, preserving streaming behavior.
 */
export function assertInputNotThenable(input: unknown): void {
  if (isThenable(input)) {
    observeThenable(input);
    throwInputPromise(0);
  }
  if (!Array.isArray(input) || input.length === 0) return;
  let foundIndex = -1;
  for (let i = 0; i < input.length; i++) {
    if (isThenable(input[i])) {
      if (foundIndex === -1) foundIndex = i;
      // Observe every thenable's rejection to prevent unhandled-rejection crashes (SC-6).
      observeThenable(input[i]);
    }
  }
  if (foundIndex === -1) return;
  throwInputPromise(foundIndex);
}

/** Validate lazy iterable values at the point the scheduler pulls them. */
export function assertPulledValueNotThenable(value: unknown, index: number): void {
  if (!isThenable(value)) return;
  observeThenable(value);
  throwInputPromise(index);
}

function throwInputPromise(index: number): never {
  throw new TypeError(
    `c-queue: input[${index}] is a Promise, not a value.\nPassing already-created Promises means the work has already started, so c-queue\ncannot bound concurrency or rate. Pass plain items and do the work in the worker:\n  c-queue.mapConcurrent(items, (item) => doWork(item))`,
  );
}

function observeThenable(value: unknown): void {
  (value as PromiseLike<unknown>).then(undefined, () => {});
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${String(value)}n`;
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return String(value);
}

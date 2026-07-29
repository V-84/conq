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
      `conq: '${name}' must be a positive integer or Infinity, received ${describe(value)}`,
    );
  }
  return value;
}

export function validateNonNegativeInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `conq: '${name}' must be a non-negative integer, received ${describe(value)}`,
    );
  }
  return value;
}

export function validateNonNegativeFinite(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `conq: '${name}' must be a non-negative finite number, received ${describe(value)}`,
    );
  }
  return value;
}

export function validateFactor(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TypeError(
      `conq: '${name}' must be a finite number >= 1, received ${describe(value)}`,
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
      `conq: expected a ${label} function, received a Promise at index ${index}.\nA Promise starts running the moment it is created, so passing one here means the\nwork has already begun and concurrency cannot be limited. Wrap it in a function:\n  conq.mapConcurrent(items, (item) => doWork(item))`,
    );
  }
  throw new TypeError(
    `conq: expected a ${label} function at index ${index}, received ${describe(value)}`,
  );
}

/**
 * Guard against the *array-of-promises* form of the eager-promise mistake:
 * `mapConcurrent([fetch(a), fetch(b)], (p) => p)`. Here the worker is a valid
 * function, so `assertTaskFunction` passes — but the input elements are live
 * Promises whose work has already started, so concurrency is meaningless. This
 * is the exact case the README leads with (§4.16, A4).
 *
 * Only materialized arrays are checked (O(1): first element only), so lazy
 * Iterables and AsyncIterables are never eagerly pulled. A single thenable
 * element is enough to diagnose the mistake; we do not walk the whole array.
 */
export function assertInputNotThenable(input: unknown): void {
  if (!Array.isArray(input) || input.length === 0) return;
  const index = input.findIndex(isThenable);
  if (index === -1) return;
  throw new TypeError(
    `conq: input[${index}] is a Promise, not a value.\nPassing already-created Promises means the work has already started, so conq\ncannot bound concurrency or rate. Pass plain items and do the work in the worker:\n  conq.mapConcurrent(items, (item) => doWork(item))`,
  );
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

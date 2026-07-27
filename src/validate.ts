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
  if (value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
    throw new TypeError(
      `conq: expected a ${label} function, received a Promise at index ${index}.\n` +
        `A Promise starts running the moment it is created, so passing one here means the\n` +
        `work has already begun and concurrency cannot be limited. Wrap it in a function:\n` +
        `  conq.mapConcurrent(items, (item) => doWork(item))`,
    );
  }
  throw new TypeError(
    `conq: expected a ${label} function at index ${index}, received ${describe(value)}`,
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

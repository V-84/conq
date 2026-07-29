// SC-34: JSDoc `@type {import('qfence').X}` must resolve for JS users.
// This file is typechecked by `tsc --checkJs --noEmit` in test/jsdoc.test.ts.
// It is NOT executed.

/** @type {import('qfence').MapOptions} */
const opts = { concurrency: 4, retry: { attempts: 3 } };

/** @type {import('qfence').RetryOptions} */
const retry = { attempts: 3, jitter: 'full' };

/** @type {import('qfence').ProgressInfo} */
const p = { completed: 0, succeeded: 0, failed: 0, running: 0, total: undefined };
void p;

module.exports = { opts, retry };

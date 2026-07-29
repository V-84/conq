// SC-34: JSDoc `@type {import('c-queue').X}` must resolve for JS users.
// This file is typechecked by `tsc --checkJs --noEmit` in test/jsdoc.test.ts.
// It is NOT executed.

/** @type {import('c-queue').MapOptions} */
const opts = { concurrency: 4, retry: { attempts: 3 } };

/** @type {import('c-queue').RetryOptions} */
const retry = { attempts: 3, jitter: 'full' };

/** @type {import('c-queue').ProgressInfo} */
const p = { completed: 0, succeeded: 0, failed: 0, running: 0, total: undefined };
void p;

module.exports = { opts, retry };

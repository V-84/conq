// SC-34: JSDoc `@type {import('conq').X}` must resolve for JS users.
// This file is typechecked by `tsc --checkJs --noEmit` in test/jsdoc.test.ts.
// It is NOT executed.

/** @type {import('conq').MapOptions} */
const opts = { concurrency: 4, retry: { attempts: 3 } };

/** @type {import('conq').RetryOptions} */
const retry = { attempts: 3, jitter: 'full' };

/** @type {import('conq').ProgressInfo} */
const p = { completed: 0, succeeded: 0, failed: 0, running: 0, total: undefined };
void p;

module.exports = { opts, retry };

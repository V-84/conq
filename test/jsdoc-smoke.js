// SC-34: JSDoc `@type {import('queue-warden').X}` must resolve for JS users.
// This file is typechecked by `tsc --checkJs --noEmit` in test/jsdoc.test.ts.
// It is NOT executed.

/** @type {import('queue-warden').MapOptions} */
const opts = { concurrency: 4, retry: { attempts: 3 } };

/** @type {import('queue-warden').RetryOptions} */
const retry = { attempts: 3, jitter: 'full' };

/** @type {import('queue-warden').ProgressInfo} */
const p = { completed: 0, succeeded: 0, failed: 0, running: 0, total: undefined };
void p;

module.exports = { opts, retry };

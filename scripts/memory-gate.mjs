import { forEachConcurrent } from '../dist/esm/index.js';

if (typeof global.gc !== 'function') {
  throw new Error('SC-18 requires Node to run with --expose-gc');
}

const N = 1_000_000;
function* items() {
  for (let i = 0; i < N; i++) yield i;
}

global.gc();
const before = process.memoryUsage().heapUsed;
let count = 0;
await forEachConcurrent(
  items(),
  async () => {
    count++;
  },
  { concurrency: 4 },
);
global.gc();
const delta = process.memoryUsage().heapUsed - before;

console.log(JSON.stringify({ count, delta }));
if (count !== N || delta >= 32 * 1024 * 1024) process.exitCode = 1;

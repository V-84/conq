// Reproduce §1 of conq-implementation-spec-FINAL.md:
// arms A/B/C, seeded, plus a jittered-latency probe.
//
// Defaults: SCALED-TIME mode (windowMs=50, N=100, seeds=[1]) so the whole run
// finishes in ~15s and the ratios/behaviour are preserved.
// Pass --full to run the spec's exact config (N=200, windowMs=1000, 3 seeds) —
// takes several minutes because the token bucket caps throughput at 5/sec.

import { armA, armBSettled, armC } from './arms.mjs';
import { createServer } from './server.mjs';

const FULL = process.argv.includes('--full');
const CFG = FULL
  ? { N: 200, windowMs: 1000, windowCap: 5, seeds: [1, 2, 3], backoffMs: 50 }
  : { N: 100, windowMs: 50, windowCap: 5, seeds: [1], backoffMs: 5 };

async function runArm(name, fn, latency) {
  const per = [];
  for (const seed of CFG.seeds) {
    const server = createServer({
      seed,
      windowMs: CFG.windowMs,
      windowCap: CFG.windowCap,
      latency,
    });
    const res = await fn(server.handle, {
      N: CFG.N,
      windowMs: CFG.windowMs,
      windowCap: CFG.windowCap,
      backoffMs: CFG.backoffMs,
    });
    per.push({
      seed,
      lost: res.lost,
      ok: res.ok,
      err429: server.stats.err429,
      peak: server.stats.peakWindow,
    });
  }
  const median = (k) => per.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(per.length / 2)];
  return {
    name,
    per,
    median: { lost: median('lost'), err429: median('err429'), peak: median('peak') },
  };
}

function fmt(row) {
  return `${row.name.padEnd(28)}  lost=${String(row.median.lost).padStart(3)}/${CFG.N}  429s=${String(row.median.err429).padStart(4)}  peak=${String(row.median.peak).padStart(3)}`;
}

console.log(
  `Config: N=${CFG.N}, windowMs=${CFG.windowMs}, cap=${CFG.windowCap}, seeds=${CFG.seeds.join(',')}${FULL ? '' : ' (scaled; pass --full for spec config)'}`,
);

console.log('\n== Zero-latency channel ==');
const zeroLat = () => 0;
const zeroRows = [
  await runArm('A: p-queue + p-retry', armA, zeroLat),
  await runArm('B: c-queue-style (inline)', armBSettled, zeroLat),
  await runArm('C: p-queue + manual re-add', armC, zeroLat),
];
for (const row of zeroRows) console.log(fmt(row));

console.log('\n== Jittered latency probe ==');
const jitter = (rand) => 5 + Math.floor(rand() * 15);
const jitterRows = [
  await runArm('A: p-queue + p-retry', armA, jitter),
  await runArm('B: c-queue-style (inline)', armBSettled, jitter),
  await runArm('C: p-queue + manual re-add', armC, jitter),
];
for (const row of jitterRows) console.log(fmt(row));

const percentLost = (row) => Math.round((row.median.lost / CFG.N) * 100);
console.log(
  `\nJitter headline: A loses ${percentLost(jitterRows[0])}% of tasks; B loses ${percentLost(jitterRows[1])}%; C loses ${percentLost(jitterRows[2])}%.`,
);
console.log('The zero-latency channel keeps B/C near zero because client and server share');
console.log('Date.now(); injected pre-admission latency exposes real rolling-window drift.');

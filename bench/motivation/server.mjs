// Fake upstream with a rolling 5-per-1000ms limit and 30% transient-503 injection.
// Zero-latency by default; injectable latency for the "jitter" probe.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createServer({
  seed = 1,
  errorRate = 0.3,
  windowMs = 1000,
  windowCap = 5,
  latency = () => 0,
  now = () => Date.now(),
} = {}) {
  const rand = mulberry32(seed);
  const windowStarts = []; // timestamps of accepted requests
  const stats = { requests: 0, ok: 0, err503: 0, err429: 0, peakWindow: 0 };

  const handle = async () => {
    stats.requests++;
    const t = now();
    while (windowStarts.length && windowStarts[0] <= t - windowMs) windowStarts.shift();
    if (windowStarts.length >= windowCap) {
      stats.err429++;
      const err = new Error('rate-limited');
      err.status = 429;
      throw err;
    }
    windowStarts.push(t);
    if (windowStarts.length > stats.peakWindow) stats.peakWindow = windowStarts.length;
    const ms = latency(rand);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (rand() < errorRate) {
      stats.err503++;
      const err = new Error('transient');
      err.status = 503;
      err.transient = true;
      throw err;
    }
    stats.ok++;
    return { ok: true };
  };

  return { handle, stats };
}

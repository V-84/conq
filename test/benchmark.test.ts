import { describe, expect, it } from 'vitest';

// @ts-expect-error The runnable benchmark is intentionally plain JavaScript.
import { createServer } from '../bench/motivation/server.mjs';

describe('SC-28a benchmark accounting', () => {
  it('measures attempted-request peaks independently of the accepted cap', async () => {
    const server = createServer({
      errorRate: 0,
      windowMs: 1000,
      windowCap: 2,
      now: () => 0,
    });

    const attempts = Array.from({ length: 5 }, () => server.handle().catch(() => undefined));
    await Promise.all(attempts);

    expect(server.stats.ok).toBe(2);
    expect(server.stats.err429).toBe(3);
    expect(server.stats.peakWindow).toBe(5);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AbortError,
  Queue,
  TimeoutError,
  forEachConcurrent,
  mapConcurrent,
  mapSettled,
  withRetry,
} from '../src/index.js';

const README = readFileSync(resolve(import.meta.dirname, '..', 'README.md'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

const samples = Array.from(README.matchAll(/```(js|ts)\n([\s\S]*?)```/g), (match, index) => ({
  index,
  language: match[1]!,
  source: match[2]!,
}));

const fakeFetch = async (value: unknown) => ({
  ok: true,
  value,
  json: async () => ({ value }),
});

const bindings = {
  mapConcurrent,
  mapSettled,
  forEachConcurrent,
  Queue,
  withRetry,
  TimeoutError,
  AbortError,
  urls: [1, 2],
  apiItems: [] as number[],
  callApi: async (item: unknown) => item,
  controller: new AbortController(),
  log: () => {},
  items: [1, 2],
  worker: async (item: unknown) => item,
  hugeStream: [1],
  db: { insert: async (_record: unknown) => {} },
  getPage: async (_cursor: unknown) => ({ items: [1], next: undefined }),
  processItem: async (_item: unknown) => {},
  fetchUser: async (id: number) => ({ id }),
  task: async () => 'ok',
  taskAbortController: new AbortController(),
  fetch: fakeFetch,
};

describe('SC-31 README samples', () => {
  it('contains runnable JavaScript or TypeScript samples', () => {
    expect(samples.length).toBeGreaterThan(0);
  });

  for (const sample of samples) {
    it(`executes sample ${sample.index + 1} (${sample.language})`, async () => {
      const withoutImports = sample.source.replace(/^import[\s\S]*?;\s*$/gm, '');
      const names = Object.keys(bindings);
      const run = new AsyncFunction(...names, withoutImports);
      const execution = run(...Object.values(bindings));
      if (sample.source.includes('readme-expect-error: TypeError')) {
        await expect(execution).rejects.toBeInstanceOf(TypeError);
      } else {
        await expect(execution).resolves.not.toThrow();
      }
    });
  }
});

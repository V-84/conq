import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const INDEX = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');

const exports = Array.from(
  INDEX.matchAll(/export(?:\s+type)?\s*\{([^}]+)\}\s*from\s*['"](.+)\.js['"]/g),
).flatMap((match) => {
  const source = resolve(ROOT, 'src', `${match[2]}.ts`);
  return match[1]!
    .split(',')
    .map(
      (entry) =>
        entry
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!,
    )
    .filter(Boolean)
    .map((name) => ({ name, source }));
});

describe('SC-27 exported-symbol TSDoc', () => {
  it('discovers every public export from the package entry point', () => {
    expect(exports.map(({ name }) => name).sort()).toEqual([
      'AbortError',
      'MapOptions',
      'ProgressInfo',
      'Queue',
      'QueueOptions',
      'RetryOptions',
      'RunOptions',
      'SettledResult',
      'Task',
      'TaskContext',
      'TaskOptions',
      'TimeoutError',
      'forEachConcurrent',
      'mapConcurrent',
      'mapSettled',
      'withRetry',
    ]);
  });

  for (const exported of exports) {
    it(`${exported.name} has an adjacent TSDoc block with @example`, () => {
      const source = readFileSync(exported.source, 'utf8');
      const declaration = new RegExp(
        String.raw`\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export\s+(?:declare\s+)?(?:async\s+)?(?:class|function|interface|type)\s+${exported.name}\b`,
      );
      const match = source.match(declaration);
      expect(match, `${exported.name} is missing adjacent TSDoc`).not.toBeNull();
      expect(match![1], `${exported.name} TSDoc is missing @example`).toContain('@example');
    });
  }
});

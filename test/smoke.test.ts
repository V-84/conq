import { execSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRATCH = resolve(ROOT, 'smoke-work');

describe('SC-25/33: packed tarball smoke tests (ESM + CJS)', () => {
  let tarball = '';

  beforeAll(() => {
    // 1) fresh build
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    // 2) scratch dir + npm pack into it (avoids race with jsdoc.test.ts)
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    const packOut = execSync(`npm pack --json --pack-destination "${SCRATCH}"`, {
      cwd: ROOT,
    }).toString();
    const info = JSON.parse(packOut) as Array<{ filename: string }>;
    tarball = resolve(SCRATCH, info[0]!.filename);
    writeFileSync(
      join(SCRATCH, 'package.json'),
      JSON.stringify({ name: 'smoke', version: '0.0.0', private: true }, null, 2),
    );
    execSync(`npm install --no-save --silent "${tarball}"`, { cwd: SCRATCH, stdio: 'ignore' });
    // 4) copy the two smoke scripts in
    cpSync(join(HERE, 'smoke.mjs'), join(SCRATCH, 'smoke.mjs'));
    cpSync(join(HERE, 'smoke.cjs'), join(SCRATCH, 'smoke.cjs'));
  }, 120_000);

  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('ESM smoke runs clean', () => {
    const r = spawnSync(process.execPath, ['smoke.mjs'], { cwd: SCRATCH, encoding: 'utf8' });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('SMOKE OK (ESM)');
  });

  it('CJS smoke runs clean', () => {
    const r = spawnSync(process.execPath, ['smoke.cjs'], { cwd: SCRATCH, encoding: 'utf8' });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('SMOKE OK (CJS)');
  });

  it('tarball contains only dist/, README.md, LICENSE, package.json', () => {
    const list = execSync(`tar -tzf "${tarball}"`, { encoding: 'utf8' });
    const files = list
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, ''));
    for (const f of files) {
      if (f.endsWith('/')) continue; // directory entries
      const ok =
        f === 'package.json' || f === 'README.md' || f === 'LICENSE' || f.startsWith('dist/');
      expect(ok, `unexpected packed file: ${f}`).toBe(true);
    }
  });

  it('SC-19: no process retention — child mapConcurrent with timeout+rate exits within 5s', () => {
    const script = `
      const { mapConcurrent } = require('c-queue');
      const watchdog = setTimeout(() => {
        console.error('WORK DID NOT COMPLETE');
        process.exit(3);
      }, 4000);
      (async () => {
        const r = await mapConcurrent([1,2,3], async (n) => n, { timeoutMs: 100, intervalMs: 50, intervalCap: 1 });
        if (r[2] !== 3) process.exit(2);
        console.log('COMPLETED');
        clearTimeout(watchdog);
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    writeFileSync(join(SCRATCH, 'exit-test.cjs'), script);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['exit-test.cjs'], {
      cwd: SCRATCH,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('COMPLETED');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRATCH = resolve(ROOT, 'jsdoc-work');

describe('SC-34: JSDoc @type resolves against built package', () => {
  it('tsc --checkJs --noEmit passes', () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    const packOut = execSync(`npm pack --json --pack-destination "${SCRATCH}"`, {
      cwd: ROOT,
    }).toString();
    const tarball = resolve(
      SCRATCH,
      (JSON.parse(packOut) as Array<{ filename: string }>)[0]!.filename,
    );
    writeFileSync(
      join(SCRATCH, 'package.json'),
      JSON.stringify({ name: 'jsdoc-smoke', version: '0.0.0', private: true }, null, 2),
    );
    execSync(`npm install --no-save "${tarball}"`, { cwd: SCRATCH, encoding: 'utf8' });
    cpSync(join(HERE, 'jsdoc-smoke.js'), join(SCRATCH, 'jsdoc-smoke.js'));
    writeFileSync(
      join(SCRATCH, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            allowJs: true,
            checkJs: true,
            noEmit: true,
            module: 'commonjs',
            moduleResolution: 'bundler',
            target: 'es2022',
            strict: true,
            types: [],
            skipLibCheck: true,
          },
          include: ['jsdoc-smoke.js'],
        },
        null,
        2,
      ),
    );
    let out = '';
    try {
      out = execSync('npx tsc -p tsconfig.json --noEmit', { cwd: SCRATCH, encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`checkJs failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
    } finally {
      rmSync(SCRATCH, { recursive: true, force: true });
    }
    expect(out).not.toMatch(/error TS/);
  }, 120_000);
});

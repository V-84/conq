import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/esm', { recursive: true });
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2));
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2));

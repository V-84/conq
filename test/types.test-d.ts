// SC-20: static type assertions. Runs under `tsc --noEmit`, not vitest.
import { type SettledResult, mapConcurrent, mapSettled } from '../src/index.js';

async function _inference() {
  const r: string[] = await mapConcurrent<number, string>([1, 2], async (n) => n.toString());
  return r;
}

async function _settledNarrow() {
  const r = await mapSettled<number, number>([1], async (n) => n);
  const first = r[0]!;
  if (first.status === 'fulfilled') {
    const v: number = first.value;
    return v;
  }
  const _reason: unknown = first.reason;
  return 0;
}

async function _rawPromiseIsTypeError() {
  await mapConcurrent(
    [1],
    // @ts-expect-error passing a raw Promise where Task is expected is a compile error
    Promise.resolve(1),
  );
}

// tests-d file is imported for typecheck coverage only
export const _ok = [_inference, _settledNarrow, _rawPromiseIsTypeError];

// SettledResult narrowing type check
const _s: SettledResult<number> = { status: 'fulfilled', value: 1, index: 0 };
if (_s.status === 'fulfilled') {
  const _v: number = _s.value;
  void _v;
}

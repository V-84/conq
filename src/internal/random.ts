// Module-internal random seam (§4.8). Tests stub via `setRandom`.
let rng: () => number = Math.random;
export const random = (): number => rng();
export const setRandom = (fn: () => number): void => {
  rng = fn;
};
export const resetRandom = (): void => {
  rng = Math.random;
};

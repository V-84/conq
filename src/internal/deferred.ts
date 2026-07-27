/**
 * `Promise.withResolvers` fallback for the Node 20 floor.
 * Prefers native when present (Node 22+).
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  type WithResolvers = { withResolvers?: <U>() => Deferred<U> };
  const native = (Promise as unknown as WithResolvers).withResolvers;
  if (typeof native === 'function') return native.call(Promise) as Deferred<T>;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

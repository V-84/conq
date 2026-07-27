/**
 * Min-heap keyed by `(-priority, sequence)`. Higher priority pops first;
 * ties broken FIFO by a monotonic sequence. §4.13.
 */
export interface HeapItem {
  priority: number;
  seq: number;
}

export class MinHeap<T extends HeapItem> {
  #a: T[] = [];

  get size(): number {
    return this.#a.length;
  }

  push(item: T): void {
    this.#a.push(item);
    this.#siftUp(this.#a.length - 1);
  }

  pop(): T | undefined {
    const a = this.#a;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  drain(): T[] {
    const out = this.#a.slice();
    this.#a.length = 0;
    return out;
  }

  #less(i: number, j: number): boolean {
    const a = this.#a;
    const ai = a[i]!;
    const aj = a[j]!;
    if (ai.priority !== aj.priority) return ai.priority > aj.priority;
    return ai.seq < aj.seq;
  }

  #siftUp(start: number): void {
    const a = this.#a;
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#less(i, parent)) {
        [a[i], a[parent]] = [a[parent]!, a[i]!];
        i = parent;
      } else {
        return;
      }
    }
  }

  #siftDown(start: number): void {
    const a = this.#a;
    const n = a.length;
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this.#less(l, best)) best = l;
      if (r < n && this.#less(r, best)) best = r;
      if (best === i) return;
      [a[i], a[best]] = [a[best]!, a[i]!];
      i = best;
    }
  }
}

/**
 * min-heap.ts — Bounded min-heap for streaming top-K selection.
 *
 * Used by the SQLite vector store to find the top-N most similar
 * drawers without loading all vectors into memory at once.
 *
 * Usage:
 *   const heap = new BoundedMinHeap<{ doc: string; sim: number }>(5, (x) => x.sim);
 *   for (const row of streamingRows) {
 *     heap.push({ doc: row.doc, sim: computeSim(row) });
 *   }
 *   const top5 = heap.toArrayDescending();  // sorted by sim, descending
 */

export class BoundedMinHeap<T> {
  private heap: T[] = [];
  private readonly capacity: number;
  private readonly score: (item: T) => number;

  constructor(capacity: number, scoreFn: (item: T) => number) {
    this.capacity = capacity;
    this.score = scoreFn;
  }

  /** Push an item. If at capacity, only keeps it if it beats the current minimum. */
  push(item: T): void {
    if (this.heap.length < this.capacity) {
      this.heap.push(item);
      this._siftUp(this.heap.length - 1);
    } else if (this.score(item) > this.score(this.heap[0])) {
      this.heap[0] = item;
      this._siftDown(0);
    }
  }

  /** Number of items currently in the heap (≤ capacity). */
  get size(): number {
    return this.heap.length;
  }

  /** Return items sorted by score descending (best first). */
  toArrayDescending(): T[] {
    return [...this.heap].sort((a, b) => this.score(b) - this.score(a));
  }

  private _siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.score(this.heap[i]) < this.score(this.heap[parent])) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private _siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.score(this.heap[left]) < this.score(this.heap[smallest])) {
        smallest = left;
      }
      if (right < n && this.score(this.heap[right]) < this.score(this.heap[smallest])) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

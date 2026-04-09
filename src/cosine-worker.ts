/**
 * cosine-worker.ts — Worker thread for parallel cosine similarity.
 *
 * Spawned by store.ts when the candidate set is large (>5000 vectors).
 * Receives a query vector + a slab of candidate vectors via SharedArrayBuffer
 * (zero-copy), computes similarities, returns top-K via min-heap.
 *
 * Message protocol:
 *   IN  { queryBuffer, queryDim, candidateBuffer, candidateCount, dim, topK }
 *   OUT { results: Array<{ index: number; similarity: number }> }
 */

import { parentPort } from 'worker_threads';

interface WorkRequest {
  queryBuffer: SharedArrayBuffer;
  queryDim: number;
  candidateBuffer: SharedArrayBuffer;
  candidateCount: number;
  dim: number;
  topK: number;
}

interface WorkResult {
  results: Array<{ index: number; similarity: number }>;
}

if (parentPort) {
  parentPort.on('message', (req: WorkRequest) => {
    const queryVec = new Float32Array(req.queryBuffer, 0, req.queryDim);
    const allCandidates = new Float32Array(req.candidateBuffer, 0, req.candidateCount * req.dim);

    // Bounded min-heap implemented inline (avoid module imports in worker)
    const heap: Array<{ index: number; similarity: number }> = [];

    const score = (item: { similarity: number }): number => item.similarity;

    const siftUp = (i: number): void => {
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (score(heap[i]) < score(heap[parent])) {
          [heap[i], heap[parent]] = [heap[parent], heap[i]];
          i = parent;
        } else break;
      }
    };

    const siftDown = (i: number): void => {
      const n = heap.length;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < n && score(heap[left]) < score(heap[smallest])) smallest = left;
        if (right < n && score(heap[right]) < score(heap[smallest])) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    };

    for (let i = 0; i < req.candidateCount; i++) {
      // Cosine similarity (dot product, vectors are already normalized)
      let dot = 0;
      const offset = i * req.dim;
      for (let j = 0; j < req.dim; j++) {
        dot += queryVec[j] * allCandidates[offset + j];
      }

      const item = { index: i, similarity: dot };
      if (heap.length < req.topK) {
        heap.push(item);
        siftUp(heap.length - 1);
      } else if (dot > score(heap[0])) {
        heap[0] = item;
        siftDown(0);
      }
    }

    const result: WorkResult = {
      results: heap.sort((a, b) => b.similarity - a.similarity),
    };
    parentPort!.postMessage(result);
  });
}

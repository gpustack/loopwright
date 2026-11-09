import { workerData } from 'node:worker_threads';
// Fixed trusted test code, reachable only by private containment tests, never by task/config or core evidence.
const mode = (workerData as Uint8Array)[0];
if (mode === 1) {
  const retained: unknown[] = [];
  while (true) retained.push(Array.from({ length: 8192 }, (_, index) => ({ index, value: 'bounded-heap-probe-' + index + '-' + retained.length })));
} else { while (true) { /* Deterministic trusted wall/termination fixture. */ } }

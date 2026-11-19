// Compute bridge: runs labs in a module Web Worker, falling back to the main thread when the
// worker cannot start. A module worker fails asynchronously, so the fallback listens for the
// error event and also gives up if the first ping is not answered in time.

import { computeLab } from './compute.js';

export function createBridge({ onMode } = {}) {
  let worker = null;
  let mode = 'pending';
  let seq = 0;
  const pending = new Map();
  let ready;
  const setMode = (m) => { mode = m; if (onMode) onMode(m); };

  const toSync = () => {
    if (mode === 'sync') return;
    if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
    worker = null;
    setMode('sync');
    // Anything that was waiting on the worker runs here instead.
    for (const [, job] of pending) job.resolve(runSync(job.circuit));
    pending.clear();
  };

  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    ready = new Promise((resolve) => {
      const timer = setTimeout(() => { toSync(); resolve(); }, 3000);
      worker.addEventListener('message', function first(e) {
        if (e.data && e.data.id === 'ping') {
          clearTimeout(timer);
          worker.removeEventListener('message', first);
          setMode('worker');
          resolve();
        }
      });
      worker.addEventListener('error', () => { clearTimeout(timer); toSync(); resolve(); });
    });
    worker.addEventListener('message', (e) => {
      const { id, result } = e.data || {};
      const job = pending.get(id);
      if (job) { pending.delete(id); job.resolve(result); }
    });
    worker.postMessage({ id: 'ping' });
  } catch {
    worker = null;
    setMode('sync');
    ready = Promise.resolve();
  }

  function runSync(circuit) {
    try {
      return computeLab(circuit);
    } catch (err) {
      return { ok: false, error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } };
    }
  }

  return {
    get mode() { return mode; },
    async run(circuit, tagSeq) {
      // Echo the caller's monotonically increasing request id onto the result so the app can
      // reject a stale response with a strict identity check.
      const stamp = (r) => { if (r && typeof r === 'object') r.seq = tagSeq; return r; };
      await ready;
      if (!worker) return stamp(runSync(circuit));
      const id = ++seq;
      return new Promise((resolve) => {
        pending.set(id, { resolve: (r) => resolve(stamp(r)), circuit });
        try {
          worker.postMessage({ id, circuit });
        } catch {
          pending.delete(id);
          resolve(stamp(runSync(circuit)));
        }
      });
    },
  };
}

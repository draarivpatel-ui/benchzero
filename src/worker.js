// Web Worker: runs the whole lab computation off the main thread.
import { computeLab } from './compute.js';

self.onmessage = (e) => {
  const { id, circuit } = e.data || {};
  if (id === 'ping') { self.postMessage({ id: 'ping', ok: true }); return; }
  let result;
  try {
    result = computeLab(circuit);
  } catch (err) {
    result = { ok: false, error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } };
  }
  self.postMessage({ id, result });
};

// Fault injection helpers for the bench: open a part (remove it) or short it (near-zero
// resistance). Returns a new circuit; the original is never mutated.

export const SHORT_VALUE = 1e-9;

export function applyFault(circuit, partId, fault) {
  if (!circuit || !Array.isArray(circuit.parts)) throw new Error('Bad circuit.');
  const out = JSON.parse(JSON.stringify(circuit));
  const idx = out.parts.findIndex((p) => p.id === partId);
  if (idx < 0) throw new Error(`Unknown part ${partId}.`);
  if (fault === 'open') {
    out.parts.splice(idx, 1);
  } else if (fault === 'short') {
    const p = out.parts[idx];
    if (p.type === 'R' || p.type === 'C' || p.type === 'L') {
      if (p.type === 'R') p.value = SHORT_VALUE;
      else if (p.type === 'C') p.value = 1e6;
      else p.value = 1e-12;
    } else {
      const n0 = p.nodes[0];
      const n1 = p.nodes[1] || '0';
      out.parts[idx] = { id: p.id, type: 'R', nodes: [n0, n1], value: SHORT_VALUE, at: p.at };
    }
  } else {
    throw new Error(`Unknown fault ${fault}.`);
  }
  return out;
}

export const FAULTS = ['open', 'short'];

// Fault injection helpers for the bench: open a part (remove it) or short it (replace it with a
// milliohm resistor). Returns a new circuit; the original is never mutated.
//
// The short value is 1 mOhm, not 1 nOhm. A nanohm short puts a 1 GOhm conductance into the matrix,
// which used to push a legitimate pivot below the solver's singularity test and report the default
// RC lab as singular when R1 was shorted. A milliohm short is still a dead short at every part
// value this bench accepts, and it keeps the system solvable and honest.

export const SHORT_VALUE = 1e-3;

/** A short is a resistor across the two terminals that carry the part's main path. */
const SHORT_PINS = { R: [0, 1], C: [0, 1], L: [0, 1], V: [0, 1], D: [0, 1], OPAMP: [2, null] };
const OPAMP_OUTPUT = 2;

export const FAULTS = ['open', 'short'];

export const FAULT_LABELS = {
  open: 'Open circuit',
  short: 'Short circuit',
};

/** Human-readable fault description, using the healthy part for its type and nodes. */
export function describeFault(part, fault) {
  if (!part) return String(fault);
  if (fault === 'open') {
    const between = part.nodes.map((n) => (n === '0' ? 'ground' : n)).join(' and ');
    return `${part.id} opened, so nothing conducts between ${between}`;
  }
  if (fault === 'short') {
    if (part.type === 'OPAMP') return `${part.id} output shorted to ground`;
    const between = part.nodes.map((n) => (n === '0' ? 'ground' : n)).join(' and ');
    return `${part.id} shorted with ${SHORT_VALUE} ohm between ${between}`;
  }
  return `${part.id}: ${fault}`;
}

/**
 * Apply one fault to a copy of the circuit.
 * open  removes the part.
 * short replaces the part with SHORT_VALUE ohms across its main two terminals. For an op-amp the
 *       main path is its output, so the fault shorts the output to ground.
 */
export function applyFault(circuit, partId, fault) {
  if (!circuit || !Array.isArray(circuit.parts)) throw new Error('Bad circuit.');
  const out = JSON.parse(JSON.stringify(circuit));
  const idx = out.parts.findIndex((p) => p.id === partId);
  if (idx < 0) throw new Error(`Unknown part ${partId}.`);
  if (!FAULTS.includes(fault)) throw new Error(`Unknown fault ${fault}.`);
  const p = out.parts[idx];
  if (fault === 'open') {
    out.parts.splice(idx, 1);
    return out;
  }
  const pins = SHORT_PINS[p.type];
  if (!pins) throw new Error(`Cannot short a ${p.type}.`);
  let nodes;
  if (p.type === 'OPAMP') nodes = [p.nodes[OPAMP_OUTPUT], '0'];
  else nodes = [p.nodes[pins[0]], p.nodes[pins[1]]];
  if (nodes[0] === nodes[1]) throw new Error(`${p.id} already has both ends on one node.`);
  out.parts[idx] = { id: p.id, type: 'R', nodes, value: SHORT_VALUE, at: p.at };
  return out;
}

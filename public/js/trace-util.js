// Deterministic hashing and digest chaining for break traces. The same code runs
// in the browser preview, the render surface, and the CLI trace tool, so a
// replayed trace can be compared by digest instead of by eyeballing dumps.

export const TRACE_SCHEMA = 'subtitle-break-trace/1';
export const STAGE_ORDER = ['shape', 'measure', 'geometry', 'candidates', 'solve', 'line-box', 'mount', 'bind'];

export function hashText(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h3 = (h3 + Math.imul(c, 0xc2b2ae35)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${h3.toString(16).padStart(8, '0')}`;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function digestStage(stage, prevChain) {
  const digest = hashText(stableStringify(stage));
  return { digest, chain: hashText(`${prevChain}|${stage?.stage || '?'}|${digest}`) };
}

// Fills each role's per-stage digest chain and the whole-trace digest in place.
export function finalizeTrace(trace) {
  trace.schema = TRACE_SCHEMA;
  const root = hashText(stableStringify({
    revision: trace.revision || null,
    scale: trace.scale || null,
    languages: trace.languages || null,
    limits: trace.limits || null,
  }));
  for (const role of trace.roles || []) {
    let chain = hashText(`${root}|${role.groupId}|${role.role}`);
    for (const stage of STAGE_ORDER) {
      const record = role.stages?.[stage];
      if (!record) continue;
      const { digest, chain: next } = digestStage(record, chain);
      record.digest = digest;
      record.chain = next;
      chain = next;
    }
    role.digest = chain;
  }
  const parts = (trace.roles || []).map((role) => `${role.groupId}/${role.role}:${role.digest}`).sort();
  trace.digest = hashText(`${root}|${parts.join(',')}`);
  return trace;
}

export function traceDigest(trace) {
  if (!trace) return null;
  if (trace.digest) return trace.digest;
  return hashText(stableStringify(trace.roles || []));
}

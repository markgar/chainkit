// Final run records normally use ordinary JSON serialization. A valid parsed JSON
// artifact can, however, be nested more deeply than V8's recursive serializer can
// walk. Preserve the run record in that exceptional case with an explicit bounded
// marker rather than crashing after every stage already completed.
export function serializeRecord(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const state = { nodes: 0, bounded: false };
    const bounded = (item, depth = 0) => {
      state.nodes += 1;
      if (depth >= 100 || state.nodes > 100_000) {
        state.bounded = true;
        return "[bounded in final record]";
      }
      if (Array.isArray(item)) {
        if (item.length > 10_000) state.bounded = true;
        return item.slice(0, 10_000).map((child) => bounded(child, depth + 1));
      }
      if (item && typeof item === "object") {
        const out = {};
        const entries = Object.entries(item);
        if (entries.length > 10_000) state.bounded = true;
        for (const [key, child] of entries.slice(0, 10_000)) out[key] = bounded(child, depth + 1);
        return out;
      }
      return item;
    };
    const safe = bounded(value);
    safe.recordSerialization = {
      bounded: state.bounded,
      reason: "value nesting exceeded the platform JSON serializer limit",
    };
    return JSON.stringify(safe, null, 2);
  }
}

export function selfTest() {
  const cases = [];
  const ordinary = { runId: "r", artifacts: { answer: { ok: true } } };
  cases.push([
    "ordinary records serialize without a bounding marker",
    JSON.parse(serializeRecord(ordinary)).recordSerialization === undefined,
  ]);

  let deep = 0;
  for (let i = 0; i < 20_000; i++) deep = [deep];
  const recovered = JSON.parse(serializeRecord({ runId: "deep", artifacts: { deep } }));
  cases.push([
    "deep valid JSON produces a bounded final record instead of crashing",
    recovered.recordSerialization?.bounded === true &&
      recovered.recordSerialization.reason.includes("nesting"),
  ]);

  let nonDepthError = null;
  try {
    serializeRecord({ unsupported: 1n });
  } catch (error) {
    nonDepthError = error;
  }
  cases.push([
    "non-depth serialization failures are not swallowed",
    nonDepthError instanceof TypeError,
  ]);
  return cases;
}

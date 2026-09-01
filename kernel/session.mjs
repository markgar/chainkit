// Session lineage for model invocations.
//
// A session is mutable conversation state, so its identity must be narrower than a
// stage id. Top-level calls share one logical scope; every foreach item has its own.
// The ledger records only successful invocations and always returns the latest one
// in execution order.

function scopeKey(iter = 0) {
  return iter ? `foreach:${iter}` : "top";
}

function ledgerKey(stageId, iter) {
  return `${scopeKey(iter)}#${stageId}`;
}

export function makeSessionLedger() {
  const latest = new Map();
  return {
    latest(stageId, iter = 0) {
      return latest.get(ledgerKey(stageId, iter)) || null;
    },
    record(invocation) {
      const entry = {
        stage: invocation.stage,
        scope: scopeKey(invocation.iter),
        iter: invocation.iter || 0,
        round: invocation.round || 0,
        attempt: invocation.attempt || 0,
        callSeq: invocation.callSeq || 0,
        sessionId: invocation.sessionId || null,
        model: invocation.model || null,
        provider: invocation.provider || null,
      };
      latest.set(ledgerKey(entry.stage, entry.iter), entry);
      return entry;
    },
  };
}

export function selectSession({ ledger, stage, iter = 0 }) {
  const previousTarget = ledger.latest(stage.id, iter);
  if (stage.resumeFrom) {
    const source = ledger.latest(stage.resumeFrom, iter);
    if (!source) {
      return {
        ok: false,
        kind: "resume",
        error:
          `stage "${stage.id}" cannot resume "${stage.resumeFrom}": ` +
          `no successful prior invocation exists in ${scopeKey(iter)} scope`,
        failure: {
          reason: "source-not-successful",
          stage: stage.id,
          resumeFrom: stage.resumeFrom,
          scope: scopeKey(iter),
          iter,
        },
      };
    }
    if (!source.sessionId) {
      return {
        ok: false,
        kind: "resume",
        error:
          `stage "${stage.id}" cannot resume "${stage.resumeFrom}": ` +
          `its latest successful invocation yielded no session id`,
        failure: {
          reason: "source-has-no-session",
          stage: stage.id,
          resumeFrom: stage.resumeFrom,
          scope: scopeKey(iter),
          iter,
          source,
        },
      };
    }
    return {
      ok: true,
      sessionId: source.sessionId,
      resumed: true,
      resumedFrom: source,
      continuedTarget: previousTarget?.sessionId === source.sessionId,
    };
  }

  if (!stage.resume) {
    return {
      ok: true,
      sessionId: null,
      resumed: false,
      resumedFrom: null,
      continuedTarget: false,
    };
  }

  if (previousTarget?.sessionId) {
    return {
      ok: true,
      sessionId: previousTarget.sessionId,
      resumed: true,
      resumedFrom: previousTarget,
      continuedTarget: true,
    };
  }

  return {
    ok: true,
    sessionId: randomId(),
    resumed: false,
    resumedFrom: null,
    continuedTarget: false,
  };
}

function randomId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function selfTest() {
  const CASES = [];
  const ledger = makeSessionLedger();
  const stage = { id: "fix", resumeFrom: "code" };

  let selected = selectSession({ ledger, stage, iter: 1 });
  CASES.push(["a missing source is refused", selected.ok === false]);
  CASES.push([
    "a missing source failure is structured",
    selected.failure.reason === "source-not-successful" && selected.failure.scope === "foreach:1",
  ]);

  ledger.record({
    stage: "code",
    iter: 1,
    round: 0,
    attempt: 0,
    callSeq: 1,
    sessionId: "s-one",
    model: "m",
    provider: "cli",
  });
  selected = selectSession({ ledger, stage, iter: 1 });
  CASES.push(["a target adopts its source session", selected.sessionId === "s-one"]);
  CASES.push(["first adoption is not same-target continuation", !selected.continuedTarget]);

  ledger.record({
    stage: "fix",
    iter: 1,
    round: 1,
    attempt: 0,
    callSeq: 2,
    sessionId: "s-one",
    model: "m",
    provider: "cli",
  });
  selected = selectSession({ ledger, stage, iter: 1 });
  CASES.push(["a later call on the same lineage is continued", selected.continuedTarget]);

  ledger.record({
    stage: "code",
    iter: 1,
    round: 2,
    attempt: 0,
    callSeq: 3,
    sessionId: "s-two",
    model: "m",
    provider: "cli",
  });
  selected = selectSession({ ledger, stage, iter: 1 });
  CASES.push(["the latest successful source wins", selected.sessionId === "s-two"]);
  CASES.push(["a new source lineage is a fresh target adoption", !selected.continuedTarget]);

  ledger.record({
    stage: "code",
    iter: 2,
    callSeq: 4,
    sessionId: "s-other-item",
    model: "m",
    provider: "cli",
  });
  CASES.push([
    "foreach items never cross sessions",
    selectSession({ ledger, stage, iter: 1 }).sessionId === "s-two",
  ]);

  const noSession = makeSessionLedger();
  noSession.record({ stage: "code", iter: 0, callSeq: 1, sessionId: null });
  selected = selectSession({ ledger: noSession, stage, iter: 0 });
  CASES.push([
    "a source with no session id is refused",
    selected.failure.reason === "source-has-no-session",
  ]);

  const own = makeSessionLedger();
  const firstOwn = selectSession({ ledger: own, stage: { id: "review", resume: true } });
  CASES.push(["same-stage resume opens a session on its first call", !!firstOwn.sessionId]);
  own.record({ stage: "review", sessionId: firstOwn.sessionId, callSeq: 1 });
  const nextOwn = selectSession({ ledger: own, stage: { id: "review", resume: true } });
  CASES.push([
    "same-stage resume preserves the existing session",
    nextOwn.sessionId === firstOwn.sessionId && nextOwn.continuedTarget,
  ]);

  return CASES;
}

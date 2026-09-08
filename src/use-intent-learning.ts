import { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, Observation } from "../shared/types";
import {
  INTENT_LEARNING_KEY,
  IntentLearner,
  loadIntentLearning,
  saveIntentLearning,
  type IntentContext,
  type IntentSnapshot,
} from "./core/intent-learning";
import { IntentAttention } from "./core/intent-attention";

const OPTIONS_KEY = "nerve.intent-options.v1";
function initialOptions() {
  try {
    const value = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "null");
    return {
      enabled: value?.enabled !== false,
      remember: value?.remember === true,
    };
  } catch {
    return { enabled: true, remember: false };
  }
}

/** Local predictions never select controls or call the browser bridge. */
export function useIntentLearning({
  candidates,
  context,
  revision,
  eligible,
  observing,
}: {
  candidates: Candidate[];
  context: IntentContext;
  revision: number;
  eligible: boolean;
  observing: boolean;
}) {
  const [options, setOptions] = useState(initialOptions);
  const [learner] = useState(
    () =>
      new IntentLearner(options.remember ? loadIntentLearning() : undefined),
  );
  const [snapshot, setSnapshot] = useState<IntentSnapshot | null>(null);
  const [prediction, setPrediction] = useState<ReturnType<
    IntentLearner["predict"]
  > | null>(null);
  const [version, setVersion] = useState(0);
  const [storageNotice, setStorageNotice] = useState("");
  const attention = useRef(new IntentAttention());
  const current = useRef({
    candidates,
    context,
    revision,
    eligible,
    observing,
    options,
    snapshot,
  });
  current.current = {
    candidates,
    context,
    revision,
    eligible,
    observing,
    options,
    snapshot,
  };

  const persist = useCallback(() => {
    if (!current.current.options.remember) return;
    setStorageNotice(
      saveIntentLearning(learner.exportProfile())
        ? ""
        : "Browser storage is unavailable. Learning continues for this session.",
    );
  }, [learner]);

  useEffect(() => {
    let notice = "";
    if (!options.remember) {
      try {
        localStorage.removeItem(INTENT_LEARNING_KEY);
      } catch {
        notice =
          "Could not remove the saved model. Clear this site’s browser data to delete it. This session will not save more learning.";
      }
    }
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // A failed options write must not leave a previous remember=true setting.
      if (!options.remember) {
        try {
          localStorage.removeItem(OPTIONS_KEY);
        } catch {}
      }
      notice ||=
        "Could not save this preference. Learning continues for this session.";
    }
    setStorageNotice(notice);
    if (options.remember && !notice) persist();
  }, [options, persist]);

  // Focus can move continuously. Freeze its value only when a new slate is exposed.
  // Never recapture the scored prediction after a hand/gaze has revealed the answer.
  useEffect(() => {
    learner.invalidate();
    attention.current.reset();
    setSnapshot(null);
    setPrediction(null);
  }, [
    learner,
    candidates,
    revision,
    context.mode,
    context.input,
    options.enabled,
  ]);

  useEffect(() => {
    if (!options.enabled || !eligible || !candidates.length) return;
    const next = learner.issue(candidates, current.current.context);
    setSnapshot(next);
    setPrediction(next?.prediction ?? null);
    attention.current.reset();
  }, [
    learner,
    candidates,
    revision,
    context.mode,
    context.input,
    options.enabled,
    eligible,
    version,
  ]);

  useEffect(() => {
    if (!options.enabled || !observing || !snapshot) {
      attention.current.reset();
      setPrediction(snapshot?.prediction ?? null);
      return;
    }
    const timer = window.setInterval(() => {
      setPrediction(
        learner.predict(snapshot, attention.current.weights(performance.now())),
      );
    }, 150);
    return () => window.clearInterval(timer);
  }, [learner, options.enabled, observing, snapshot]);

  const invalidate = useCallback(() => {
    learner.invalidate();
    attention.current.reset();
    setSnapshot(null);
    setPrediction(null);
  }, [learner]);

  const observePointer = useCallback(
    (id: string, event: { pointerType: string }) => {
      const c = current.current;
      if (
        !c.options.enabled ||
        !c.observing ||
        c.context.input !== "pointer" ||
        event.pointerType === "touch"
      )
        return;
      attention.current.observe(id, performance.now(), 1);
    },
    [],
  );

  const observeGaze = useCallback((observation: Observation) => {
    const c = current.current;
    if (!c.options.enabled || !c.observing || c.context.input !== "camera")
      return;
    const now = performance.now();
    if (
      !Number.isFinite(observation.timestamp) ||
      observation.timestamp > now + 50 ||
      now - observation.timestamp > 350
    ) {
      attention.current.reset();
      return;
    }
    const x = observation.x * window.innerWidth;
    const y = observation.y * window.innerHeight;
    const hit =
      Number.isFinite(x) && Number.isFinite(y)
        ? document.elementFromPoint(x, y)
        : null;
    const card = hit?.closest<HTMLButtonElement>("[data-intent-id]");
    const id =
      card &&
      !card.disabled &&
      c.candidates.some((item) => item.id === card.dataset.intentId)
        ? card.dataset.intentId!
        : null;
    attention.current.observe(id, observation.timestamp, observation.quality);
  }, []);

  const record = useCallback(
    (
      decision: IntentSnapshot | null,
      id: string,
      kind: "confirm" | "teach" | "check",
    ) => {
      if (!current.current.options.enabled || !decision) return false;
      const accepted = learner.feedback(decision, id, kind);
      if (accepted) {
        attention.current.reset();
        persist();
        setVersion((v) => v + 1);
      }
      return accepted;
    },
    [learner, persist],
  );

  const createTrial = useCallback(() => {
    const c = current.current;
    return c.options.enabled && c.eligible
      ? learner.issue(c.candidates, c.context)
      : null;
  }, [learner]);

  const forget = useCallback(() => {
    learner.reset();
    invalidate();
    let removed = false;
    try {
      localStorage.removeItem(INTENT_LEARNING_KEY);
      removed = true;
      setStorageNotice("");
    } catch {
      setStorageNotice(
        "This session’s learning is cleared, but saved data could not be removed. Clear this site’s browser data to delete it.",
      );
    }
    if (current.current.options.remember) {
      const saved = saveIntentLearning(learner.exportProfile());
      if (saved) setStorageNotice("");
      else if (removed)
        setStorageNotice(
          "Saved learning was removed. Browser storage is unavailable for new learning.",
        );
    }
    setVersion((v) => v + 1);
  }, [learner, invalidate]);

  const exportMetrics = useCallback(() => {
    const data = {
      schema: "nerve-intent-evaluation-v1",
      exportedAt: new Date().toISOString(),
      practice: learner.metrics("practice"),
      astra: learner.metrics("astra"),
      notice:
        "Aggregate counts and prediction scores only. No tasks, URLs, images, gaze traces, or learned weights. Predictions are scored before learning; these measurements are not a guarantee of intent accuracy.",
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "nerve-intent-evaluation.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [learner]);

  return {
    options,
    setEnabled: (enabled: boolean) => setOptions((o) => ({ ...o, enabled })),
    setRemember: (remember: boolean) => setOptions((o) => ({ ...o, remember })),
    snapshot,
    prediction,
    metrics: learner.metrics(context.mode),
    storageNotice,
    invalidate,
    observePointer,
    observeGaze,
    record,
    createTrial,
    forget,
    exportMetrics,
  };
}

export type IntentLearning = ReturnType<typeof useIntentLearning>;

import type { Candidate, InputMode, Point } from "../../shared/types";

export const NONE_ID = "__none__";
export const INTENT_LEARNING_KEY = "nerve.intent-learning.v1";
const DIMENSIONS = 512;
const MAX_CANDIDATES = 12;
const MAX_ISSUED = 24;
const MAX_AGE_MS = 10 * 60_000;
const MAX_EXAMPLES = 1_000_000;
const MAX_WEIGHT = 4;
const MAX_MOMENT = 1_000_000;
const NONE_PRIOR = 0.15;
type Mode = "practice" | "astra";
type FeedbackKind = "confirm" | "teach" | "check";

export interface IntentContext {
  mode: Mode;
  input: InputMode;
  url: string;
  title: string;
  focus: Point | null;
}
export interface IntentPrediction {
  /** Estimated ranking weights, never measured confidence or permission to act. */
  readonly scores: readonly { readonly id: string; readonly weight: number }[];
  readonly bestId: string;
  readonly topId: string | null;
  readonly margin: number;
  /** Shannon entropy in bits. */
  readonly entropy: number;
  readonly reason: string;
  readonly examples: number;
}
export interface IntentSnapshot {
  readonly id: string;
  readonly mode: Mode;
  readonly createdAt: number;
  readonly candidateIds: readonly string[];
  readonly prediction: IntentPrediction;
  readonly baseline: IntentPrediction;
}
export interface IntentMetricGroup {
  count: number;
  correct: number;
  suggested: number;
  suggestedCorrect: number;
  baselineCorrect: number;
  brierSum: number;
  logLossSum: number;
  noneCount: number;
}
export interface IntentMetrics {
  examples: number;
  confirm: IntentMetricGroup;
  teach: IntentMetricGroup;
  check: IntentMetricGroup;
}
export interface IntentModelProfile {
  weights: number[];
  squaredGradients: number[];
  examples: number;
  metrics: Record<FeedbackKind, IntentMetricGroup>;
}
export interface IntentLearningProfile {
  version: 1;
  models: Record<Mode, IntentModelProfile>;
}

type Feature = { index: number; value: number };
type Issued = {
  snapshot: IntentSnapshot;
  features: Feature[][];
  families: string[];
  logits: number[];
};

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const finite = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= low &&
  value <= high;
const integer = (value: unknown, high: number): value is number =>
  finite(value, 0, high) && Number.isInteger(value);
const group = (): IntentMetricGroup => ({
  count: 0,
  correct: 0,
  suggested: 0,
  suggestedCorrect: 0,
  baselineCorrect: 0,
  brierSum: 0,
  logLossSum: 0,
  noneCount: 0,
});
const emptyModel = (): IntentModelProfile => ({
  weights: Array(DIMENSIONS).fill(0),
  squaredGradients: Array(DIMENSIONS).fill(0),
  examples: 0,
  metrics: { confirm: group(), teach: group(), check: group() },
});
const emptyProfile = (): IntentLearningProfile => ({
  version: 1,
  models: { practice: emptyModel(), astra: emptyModel() },
});

function exactObject(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validGroup(value: unknown): value is IntentMetricGroup {
  if (
    !exactObject(value, [
      "count",
      "correct",
      "suggested",
      "suggestedCorrect",
      "baselineCorrect",
      "brierSum",
      "logLossSum",
      "noneCount",
    ])
  )
    return false;
  return (
    integer(value.count, MAX_EXAMPLES) &&
    integer(value.correct, value.count) &&
    integer(value.suggested, value.count) &&
    integer(value.suggestedCorrect, Math.min(value.suggested, value.correct)) &&
    integer(value.baselineCorrect, value.count) &&
    integer(value.noneCount, value.count) &&
    finite(value.brierSum, 0, 2 * value.count + 1e-8) &&
    finite(value.logLossSum, 0, 30 * value.count + 1e-8)
  );
}
function numericVector(
  value: unknown,
  low: number,
  high: number,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === DIMENSIONS &&
    Object.keys(value).length === DIMENSIONS &&
    Array.from(value).every((item) => finite(item, low, high))
  );
}
function validModel(value: unknown): value is IntentModelProfile {
  if (
    !exactObject(value, ["weights", "squaredGradients", "examples", "metrics"])
  )
    return false;
  if (
    !numericVector(value.weights, -MAX_WEIGHT, MAX_WEIGHT) ||
    !numericVector(value.squaredGradients, 0, MAX_MOMENT) ||
    !integer(value.examples, MAX_EXAMPLES) ||
    !exactObject(value.metrics, ["confirm", "teach", "check"]) ||
    !validGroup(value.metrics.confirm) ||
    !validGroup(value.metrics.teach) ||
    !validGroup(value.metrics.check)
  )
    return false;
  return (
    value.examples === value.metrics.confirm.count + value.metrics.teach.count
  );
}
function readProfile(value: unknown): IntentLearningProfile | null {
  try {
    if (
      !exactObject(value, ["version", "models"]) ||
      value.version !== 1 ||
      !exactObject(value.models, ["practice", "astra"]) ||
      !validModel(value.models.practice) ||
      !validModel(value.models.astra)
    )
      return null;
    return structuredClone(value) as unknown as IntentLearningProfile;
  } catch {
    return null;
  }
}

export function loadIntentLearning(
  storage?: Pick<Storage, "getItem">,
): IntentLearningProfile | null {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(
      INTENT_LEARNING_KEY,
    );
    if (!raw || raw.length > 160_000) return null;
    return readProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function saveIntentLearning(
  profile: IntentLearningProfile,
  storage?: Pick<Storage, "setItem">,
): boolean {
  try {
    const validated = readProfile(profile);
    const target = storage ?? globalThis.localStorage;
    if (!validated || !target) return false;
    target.setItem(INTENT_LEARNING_KEY, JSON.stringify(validated));
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, length: number): string {
  return typeof value === "string" ? value.slice(0, length).toLowerCase() : "";
}
function family(text: string): string {
  const classes: [string, RegExp][] = [
    ["delete", /\b(delete|remove|erase|trash)\b/],
    ["send", /\b(send|publish|post|submit)\b/],
    ["purchase", /\b(buy|purchase|pay|checkout)\b/],
    ["archive", /\barchiv(?:e|ing)\b/],
    ["draft", /\b(draft|reply|respond|compose)\b/],
    ["summarize", /\b(summary|summari[sz]e|summari[sz]ing)\b/],
    ["note", /\b(note|notes|remember)\b/],
    ["schedule", /\b(schedule|calendar|appointment)\b/],
    ["search", /\b(find|search|locate)\b/],
    ["download", /\bdownload\b/],
    ["edit", /\b(edit|update|change)\b/],
    ["navigate", /\b(open|navigate|visit)\b/],
    ["read", /\b(read|view|inspect)\b/],
  ];
  return classes.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}
function candidateFamily(candidate: Candidate): string {
  const labelFamily = family(boundedText(candidate.label, 160));
  if (labelFamily !== "other") return labelFamily;
  // Negated consequential verbs in a goal must not become its task category.
  const goal = boundedText(candidate.goal, 700).replace(
    /\b(?:do not|don't|never|without)\s+(?:send(?:ing)?|publish(?:ing)?|delet(?:e|ing)|pay(?:ing)?|purchas(?:e|ing))\b/g,
    "",
  );
  return family(goal);
}
function contextBuckets(
  context: IntentContext,
  previous: string | null,
): string[] {
  let path = "";
  try {
    path = new URL(boundedText(context.url, 2048)).pathname.slice(0, 256);
  } catch {}
  const surfaceText = `${path} ${boundedText(context.title, 256)}`;
  const surface = /\b(notes?|notebook|documents?|docs)\b/.test(surfaceText)
    ? "notes"
    : /\b(mail|email|inbox|messages?|drafts?|compose)\b/.test(surfaceText)
      ? "mail"
      : "general";
  const input = ["pointer", "switch", "camera"].includes(context.input)
    ? context.input
    : "pointer";
  const point = context.focus;
  const focus =
    point && finite(point.x, 0, 1) && finite(point.y, 0, 1)
      ? `${point.y < 0.5 ? "top" : "bottom"}-${point.x < 0.5 ? "left" : "right"}`
      : "none";
  return [
    `surface:${surface}`,
    `input:${input}`,
    `focus:${focus}`,
    `previous:${previous ?? "start"}`,
  ];
}
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
function featureVector(tokens: string[]): Feature[] {
  const values = new Map<number, number>();
  for (const token of new Set(tokens)) {
    const hashed = hash(token);
    const index = hashed % DIMENSIONS;
    values.set(
      index,
      (values.get(index) ?? 0) + (hashed & 0x80000000 ? -1 : 1),
    );
  }
  const length =
    Math.sqrt(
      [...values.values()].reduce((sum, value) => sum + value * value, 0),
    ) || 1;
  return [...values]
    .filter(([, value]) => value !== 0)
    .map(([index, value]) => ({ index, value: value / length }));
}
function features(
  candidate: Candidate,
  taskFamily: string,
  buckets: string[],
): Feature[] {
  const words =
    boundedText(candidate.label, 160)
      .match(/[a-z0-9]{2,32}/g)
      ?.slice(0, 10) ?? [];
  return featureVector([
    "candidate",
    `family:${taskFamily}`,
    `risk:${candidate.risk}`,
    ...words.map((word) => `word:${word}`),
    ...buckets.map((bucket) => `family:${taskFamily}|${bucket}`),
    ...words.map((word) => `word:${word}|${buckets[0]}`),
  ]);
}
function probabilities(logits: number[]): number[] {
  const maximum = Math.max(...logits);
  const values = logits.map((value) => Math.exp(value - maximum));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}
function prediction(
  ids: readonly string[],
  logits: number[],
  examples: number,
): IntentPrediction {
  const weights = probabilities(logits);
  const order = ids
    .map((_, index) => index)
    .sort((a, b) => weights[b] - weights[a] || a - b);
  const best = order[0];
  const margin = weights[best] - weights[order[1]];
  const accepted = weights[best] >= 0.45 && margin >= 0.1;
  return Object.freeze({
    scores: Object.freeze(
      ids.map((id, index) => Object.freeze({ id, weight: weights[index] })),
    ),
    bestId: ids[best],
    topId: accepted ? ids[best] : null,
    margin,
    entropy: -weights.reduce((sum, value) => sum + value * Math.log2(value), 0),
    reason: accepted
      ? ids[best] === NONE_ID
        ? "Something else ranks highest. Your choice is still required."
        : "One suggestion ranks highest. Your confirmation is still required."
      : "Several choices remain plausible. Choose what you mean.",
    examples,
  });
}
function unavailable(): IntentPrediction {
  return Object.freeze({
    scores: Object.freeze([]),
    bestId: NONE_ID,
    topId: null,
    margin: 0,
    entropy: 0,
    reason: "This suggestion set is no longer current.",
    examples: 0,
  });
}

/**
 * Local supervised task ranking. Signed hashing bounds the model's vocabulary;
 * it is lossy storage, not anonymization or a privacy guarantee. Raw context and
 * task text are discarded after feature extraction and never enter the profile.
 */
export class IntentLearner {
  private profile: IntentLearningProfile;
  private issued = new Map<string, Issued>();
  private previous: Record<Mode, string | null> = {
    practice: null,
    astra: null,
  };
  private sequence = 0;

  constructor(profile?: unknown) {
    this.profile = readProfile(profile) ?? emptyProfile();
  }

  issue(
    candidates: Candidate[],
    context: IntentContext,
    now = Date.now(),
  ): IntentSnapshot | null {
    if (
      !finite(now, 0, Number.MAX_SAFE_INTEGER) ||
      !context ||
      !["practice", "astra"].includes(context.mode) ||
      !Array.isArray(candidates) ||
      !candidates.length ||
      candidates.length > MAX_CANDIDATES
    )
      return null;
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        !candidate.id.length ||
        candidate.id.length > 80 ||
        candidate.id === NONE_ID ||
        ids.has(candidate.id) ||
        typeof candidate.label !== "string" ||
        typeof candidate.goal !== "string" ||
        !["low", "confirm"].includes(candidate.risk) ||
        !finite(candidate.probability, 0, 1)
      )
        return null;
      ids.add(candidate.id);
    }
    const model = this.profile.models[context.mode];
    const buckets = contextBuckets(context, this.previous[context.mode]);
    const families = candidates.map(candidateFamily);
    const vectors = candidates.map((candidate, i) =>
      features(candidate, families[i], buckets),
    );
    vectors.push(
      featureVector([
        "none",
        ...buckets.map((bucket) => `none|${bucket}`),
        ...families.map((item) => `none|family:${item}`),
      ]),
    );
    families.push("none");
    const prior = candidates.map((candidate) =>
      Math.max(0.001, candidate.probability),
    );
    const total = prior.reduce((sum, value) => sum + value, 0);
    const baselineLogits = [
      ...prior.map((value) => Math.log(((1 - NONE_PRIOR) * value) / total)),
      Math.log(NONE_PRIOR),
    ];
    const logits = baselineLogits.map(
      (value, i) =>
        value +
        clamp(
          vectors[i].reduce(
            (sum, feature) =>
              sum + model.weights[feature.index] * feature.value,
            0,
          ),
          -1.5,
          1.5,
        ),
    );
    const candidateIds = Object.freeze([...ids, NONE_ID]);
    const snapshot: IntentSnapshot = Object.freeze({
      id: `intent-${++this.sequence}`,
      mode: context.mode,
      createdAt: now,
      candidateIds,
      prediction: prediction(candidateIds, logits, model.examples),
      baseline: prediction(candidateIds, baselineLogits, 0),
    });
    for (const [id, value] of this.issued) {
      if (now - value.snapshot.createdAt > MAX_AGE_MS) this.issued.delete(id);
    }
    if (this.issued.size >= MAX_ISSUED)
      this.issued.delete(this.issued.keys().next().value!);
    this.issued.set(snapshot.id, {
      snapshot,
      features: vectors,
      families,
      logits,
    });
    return snapshot;
  }

  predict(
    snapshot: IntentSnapshot,
    attention?: Record<string, number>,
  ): IntentPrediction {
    const issued = this.issued.get(snapshot?.id);
    if (!issued || issued.snapshot !== snapshot) return unavailable();
    if (!attention) return snapshot.prediction;
    const evidence = snapshot.candidateIds.map((id) => {
      const value = Object.hasOwn(attention, id) ? attention[id] : 0;
      return typeof value === "number" && Number.isFinite(value)
        ? clamp(value, 0, 1)
        : 0;
    });
    const total = Math.max(
      1,
      evidence.reduce((sum, value) => sum + value, 0),
    );
    return prediction(
      snapshot.candidateIds,
      issued.logits.map((value, i) => value + (0.8 * evidence[i]) / total),
      snapshot.prediction.examples,
    );
  }

  feedback(
    snapshot: IntentSnapshot,
    chosenId: string,
    kind: FeedbackKind,
    now = Date.now(),
  ): boolean {
    const issued = this.issued.get(snapshot?.id);
    if (
      !issued ||
      issued.snapshot !== snapshot ||
      !["confirm", "teach", "check"].includes(kind) ||
      !finite(now, snapshot.createdAt, snapshot.createdAt + MAX_AGE_MS)
    )
      return false;
    const chosen = snapshot.candidateIds.indexOf(chosenId);
    if (chosen < 0) return false;
    const model = this.profile.models[snapshot.mode];
    const metric = model.metrics[kind];
    if (
      metric.count >= MAX_EXAMPLES ||
      (kind !== "check" && model.examples >= MAX_EXAMPLES)
    )
      return false;
    this.issued.delete(snapshot.id);

    // Score the untouched, pre-choice prediction before changing any weights.
    metric.count++;
    metric.correct += Number(snapshot.prediction.bestId === chosenId);
    metric.suggested += Number(snapshot.prediction.topId !== null);
    metric.suggestedCorrect += Number(snapshot.prediction.topId === chosenId);
    metric.baselineCorrect += Number(snapshot.baseline.bestId === chosenId);
    metric.noneCount += Number(chosenId === NONE_ID);
    metric.brierSum += snapshot.prediction.scores.reduce(
      (sum, score, i) => sum + (score.weight - Number(i === chosen)) ** 2,
      0,
    );
    metric.logLossSum += -Math.log(
      Math.max(1e-12, snapshot.prediction.scores[chosen].weight),
    );
    if (kind === "check") return true;

    const gradient = new Float64Array(DIMENSIONS);
    issued.features.forEach((vector, i) => {
      const error = Number(i === chosen) - snapshot.prediction.scores[i].weight;
      for (const feature of vector)
        gradient[feature.index] += error * feature.value;
    });
    for (let i = 0; i < DIMENSIONS; i++) {
      model.squaredGradients[i] = Math.min(
        MAX_MOMENT,
        model.squaredGradients[i] + gradient[i] ** 2,
      );
      // Mild per-example forgetting and regularized AdaGrad permit adaptation.
      model.weights[i] = clamp(
        model.weights[i] * 0.997 +
          (0.3 * gradient[i]) / Math.sqrt(0.1 + model.squaredGradients[i]),
        -MAX_WEIGHT,
        MAX_WEIGHT,
      );
    }
    model.examples++;
    this.previous[snapshot.mode] = issued.families[chosen];
    this.invalidate();
    return true;
  }

  invalidate(): void {
    this.issued.clear();
  }
  reset(): void {
    this.invalidate();
    this.profile = emptyProfile();
    this.previous = { practice: null, astra: null };
  }
  exportProfile(): IntentLearningProfile {
    return structuredClone(this.profile);
  }
  metrics(mode: Mode): IntentMetrics {
    const model = this.profile.models[mode];
    return { examples: model.examples, ...structuredClone(model.metrics) };
  }
}

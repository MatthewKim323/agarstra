import {
  IntentLearner,
  NONE_ID,
  type IntentContext,
  type IntentPrediction,
} from "../src/core/intent-learning";
import type { Candidate } from "../shared/types";

/**
 * Deterministic mechanism exercise using scripted preferences. This is not a
 * human benchmark, an accessibility evaluation, or a gaze accuracy estimate.
 * All models and examples live in memory; no camera, provider, browser session,
 * personal data, or persisted learning profile is accessed.
 */
const SEED = 0x5eed2026;
let randomState = SEED;
function random(): number {
  randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0;
  return randomState / 0x1_0000_0000;
}
type Surface = "mail" | "notes" | "unsupported";
type Choice = "reply" | "note" | "archive" | "none";
type Decision = {
  surface: Surface;
  chosenId: string;
  learner: IntentPrediction;
  baseline: IntentPrediction;
};
const surfaces: Surface[] = ["mail", "notes", "unsupported"];
const contexts: Record<Surface, IntentContext> = {
  mail: {
    mode: "practice",
    input: "pointer",
    url: "https://synthetic.example/mail",
    title: "Synthetic Mail",
    focus: { x: 0.25, y: 0.25 },
  },
  notes: {
    mode: "practice",
    input: "switch",
    url: "https://synthetic.example/notes",
    title: "Synthetic Notes",
    focus: { x: 0.75, y: 0.75 },
  },
  unsupported: {
    mode: "practice",
    input: "pointer",
    url: "https://synthetic.example/empty",
    title: "Blank workspace",
    focus: null,
  },
};
const labels: Record<Exclude<Choice, "none">, string[]> = {
  reply: ["Draft a reply", "Prepare a reply", "Compose a response"],
  note: ["Save a note", "Remember the details", "Write a note"],
  archive: ["Archive message", "Archive this email", "Archive the message"],
};

function makeCandidates(index: number) {
  const choices: Exclude<Choice, "none">[] = ["reply", "note", "archive"];
  const ids = new Map<Choice, string>([["none", NONE_ID]]);
  const candidates: Candidate[] = choices.map((choice, offset) => {
    const id = `synthetic-choice-${index * 3 + offset}`;
    ids.set(choice, id);
    return {
      id,
      label: labels[choice][Math.floor(random() * labels[choice].length)],
      description: "A synthetic candidate for offline evaluation.",
      goal:
        choice === "reply"
          ? "Draft a reply. Do not send it."
          : choice === "note"
            ? "Save a note with the details."
            : "Archive the selected message. Do not delete it.",
      probability: choice === "reply" ? 0.5 : choice === "note" ? 0.3 : 0.2,
      risk: choice === "note" ? "low" : "confirm",
    };
  });
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return { candidates, ids };
}

function scriptedChoice(surface: Surface, shifted: boolean): Choice {
  // Ten percent of labels deliberately disagree with the dominant preference.
  // The learner receives this label only after its prediction has been frozen.
  if (random() < 0.1) return "archive";
  if (surface === "unsupported") return "none";
  if (surface === "mail") return "reply";
  return shifted ? "reply" : "note";
}

function score(decisions: Decision[], source: "learner" | "baseline") {
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  let abstentions = 0;
  let suggestedCorrect = 0;
  let noneLabels = 0;
  let nonePredictions = 0;
  let correctNone = 0;
  for (const decision of decisions) {
    const prediction = decision[source];
    correct += Number(prediction.bestId === decision.chosenId);
    abstentions += Number(prediction.topId === null);
    suggestedCorrect += Number(prediction.topId === decision.chosenId);
    noneLabels += Number(decision.chosenId === NONE_ID);
    nonePredictions += Number(prediction.bestId === NONE_ID);
    correctNone += Number(
      prediction.bestId === NONE_ID && decision.chosenId === NONE_ID,
    );
    brier += prediction.scores.reduce(
      (sum, item) =>
        sum + (item.weight - Number(item.id === decision.chosenId)) ** 2,
      0,
    );
    const selected = prediction.scores.find(
      (item) => item.id === decision.chosenId,
    );
    if (!selected)
      throw new Error("The frozen outcome set lost the scripted label.");
    logLoss -= Math.log(selected.weight);
  }
  return {
    count: decisions.length,
    correct,
    top1: decisions.length ? correct / decisions.length : null,
    brier: decisions.length ? brier / decisions.length : null,
    logLoss: decisions.length ? logLoss / decisions.length : null,
    abstentions,
    suggested: decisions.length - abstentions,
    suggestedCorrect,
    coverage: decisions.length
      ? (decisions.length - abstentions) / decisions.length
      : null,
    correctnessWhenSuggested:
      decisions.length > abstentions
        ? suggestedCorrect / (decisions.length - abstentions)
        : null,
    none: {
      labels: noneLabels,
      predictions: nonePredictions,
      correct: correctNone,
      falsePositives: nonePredictions - correctNone,
      recall: noneLabels ? correctNone / noneLabels : null,
      precision: nonePredictions ? correctNone / nonePredictions : null,
    },
  };
}
function compare(decisions: Decision[]) {
  return {
    learner: score(decisions, "learner"),
    baseline: score(decisions, "baseline"),
  };
}
function report(decisions: Decision[]) {
  return {
    ...compare(decisions),
    byContext: Object.fromEntries(
      surfaces.map((surface) => [
        surface,
        compare(decisions.filter((decision) => decision.surface === surface)),
      ]),
    ),
    chosenNone: compare(
      decisions.filter((decision) => decision.chosenId === NONE_ID),
    ),
    chosenCandidate: compare(
      decisions.filter((decision) => decision.chosenId !== NONE_ID),
    ),
  };
}

const learner = new IntentLearner();
let sequence = 0;
function decision(
  surface: Surface,
  feedback: "teach" | "check",
  shifted = false,
): Decision {
  const index = sequence++;
  const { candidates, ids } = makeCandidates(index);
  const chosenId = ids.get(scriptedChoice(surface, shifted))!;
  const now = 1_700_000_000_000 + index;
  const snapshot = learner.issue(candidates, contexts[surface], now);
  if (!snapshot) throw new Error("Synthetic candidate set was rejected.");
  const result = {
    surface,
    chosenId,
    learner: snapshot.prediction,
    baseline: snapshot.baseline,
  };
  if (!learner.feedback(snapshot, chosenId, feedback, now))
    throw new Error("Synthetic feedback was rejected.");
  return result;
}
function learningParameters() {
  const profile = learner.exportProfile();
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(profile.models).map(([mode, model]) => [
        mode,
        {
          weights: model.weights,
          squaredGradients: model.squaredGradients,
          examples: model.examples,
        },
      ]),
    ),
  );
}

const training = Array.from({ length: 120 }, (_, i) =>
  decision(surfaces[i % surfaces.length], "teach"),
);
const parametersBeforeCheck = learningParameters();
const heldOut = Array.from({ length: 60 }, (_, i) =>
  decision(surfaces[i % surfaces.length], "check"),
);
const heldOutLearningParametersUnchanged =
  parametersBeforeCheck === learningParameters();
if (!heldOutLearningParametersUnchanged)
  throw new Error("Held-out checks changed model parameters.");
const shifted = Array.from({ length: 80 }, () =>
  decision("notes", "teach", true),
);

console.log(
  JSON.stringify(
    {
      syntheticOnly: true,
      purpose:
        "Mechanism exercise with a scripted oracle. No human performance, intent accuracy, accessibility, or gaze claim follows from these results.",
      seed: SEED,
      algorithm:
        "32-bit seeded LCG, frozen before-update predictions, fresh candidate IDs and seeded label/order variation",
      mode: "practice",
      baseline:
        "Original candidate probabilities with the same reserved 0.15 none prior and outcome set as the learner",
      oracle:
        "Mail prefers reply; notes prefers note; blank context prefers none. A seeded 10 percent branch chooses archive. The shift changes notes to prefer reply.",
      comparison:
        "Top1 uses bestId, even when the separate ambiguity gate abstains. Brier is the summed squared error across every candidate plus none. All predictions are scored before feedback.",
      training: report(training),
      heldOut: {
        learningParametersUnchanged: heldOutLearningParametersUnchanged,
        ...report(heldOut),
      },
      preferenceShift: {
        count: shifted.length,
        overall: compare(shifted),
        first20: compare(shifted.slice(0, 20)),
        last20: compare(shifted.slice(-20)),
      },
      finalMetrics: learner.metrics("practice"),
      limitations: [
        "The oracle and contexts are deliberately small and scripted; synthetic predictability is not evidence about people's preferences.",
        "Checks reuse the task vocabulary and context families with unseen decision IDs, order, and seeded labels. They do not test arbitrary new applications.",
        "The none scenario has a consistent coarse context cue; real unsupported suggestions may be much harder to identify.",
        "The original baseline happens to agree with the shifted dominant preference, so compare absolute results as well as adaptation.",
        "No hyperparameter search, API calls, camera input, or model persistence occurs in this run.",
      ],
    },
    null,
    2,
  ),
);

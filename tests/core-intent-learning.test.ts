import { describe, expect, it } from "vitest";
import type { Candidate } from "../shared/types";
import {
  INTENT_LEARNING_KEY,
  NONE_ID,
  IntentLearner,
  loadIntentLearning,
  saveIntentLearning,
  type IntentContext,
  type IntentLearningProfile,
  type IntentSnapshot,
} from "../src/core/intent-learning";

const context: IntentContext = {
  mode: "practice",
  input: "pointer",
  url: "http://127.0.0.1:4318/lab",
  title: "Practice Mail",
  focus: null,
};
const slate = (suffix = ""): Candidate[] => [
  {
    id: `reply${suffix}`,
    label: "Draft a reply",
    description: "Prepare a draft.",
    goal: "Draft a reply. Do not send it.",
    probability: 0.5,
    risk: "confirm",
  },
  {
    id: `note${suffix}`,
    label: "Save a note",
    description: "Keep the details.",
    goal: "Save a note with the important details.",
    probability: 0.3,
    risk: "low",
  },
  {
    id: `archive${suffix}`,
    label: "Archive message",
    description: "Move it out of the inbox.",
    goal: "Archive this message. Never delete it.",
    probability: 0.2,
    risk: "confirm",
  },
];
function issue(
  learner: IntentLearner,
  choices = slate(),
  ctx = context,
  now = 1000,
) {
  const snapshot = learner.issue(choices, ctx, now);
  expect(snapshot).not.toBeNull();
  return snapshot!;
}
function weight(snapshot: IntentSnapshot, id: string) {
  return snapshot.prediction.scores.find((score) => score.id === id)!.weight;
}
function train(
  learner: IntentLearner,
  count: number,
  choice = "note",
  ctx = context,
) {
  for (let i = 0; i < count; i++) {
    const snapshot = issue(learner, slate(String(i)), ctx, 1000 + i);
    expect(
      learner.feedback(
        snapshot,
        choice === NONE_ID ? NONE_ID : `${choice}${i}`,
        "confirm",
        1000 + i,
      ),
    ).toBe(true);
  }
}

describe("frozen local intent predictions", () => {
  it("preserves provider scores, candidate order and a none option before learning", () => {
    const learner = new IntentLearner();
    const choices = slate();
    const original = structuredClone(choices);
    const snapshot = issue(learner, choices);
    expect(snapshot.candidateIds).toEqual([
      "reply",
      "note",
      "archive",
      NONE_ID,
    ]);
    expect(snapshot.prediction.scores).toEqual(snapshot.baseline.scores);
    expect(weight(snapshot, "reply")).toBeCloseTo(0.425);
    expect(weight(snapshot, NONE_ID)).toBeCloseTo(0.15);
    expect(snapshot.prediction.bestId).toBe("reply");
    expect(snapshot.prediction.topId).toBeNull();
    expect(snapshot.prediction.examples).toBe(0);
    expect(
      snapshot.prediction.scores.reduce((sum, score) => sum + score.weight, 0),
    ).toBeCloseTo(1);
    expect(choices).toEqual(original);
  });

  it("uses original candidate order to break ties instead of candidate IDs", () => {
    const choices = slate().map((choice) => ({
      ...choice,
      probability: 1 / 3,
    }));
    choices[0].id = "z-last-alphabetically";
    choices[1].id = "a-first-alphabetically";
    const snapshot = issue(new IntentLearner(), choices);
    expect(snapshot.prediction.bestId).toBe("z-last-alphabetically");
    expect(snapshot.prediction.topId).toBeNull();
    expect(snapshot.prediction.margin).toBe(0);
  });

  it("handles all-zero provider scores without NaN or accidental certainty", () => {
    const snapshot = issue(
      new IntentLearner(),
      slate().map((choice) => ({ ...choice, probability: 0 })),
    );
    expect(
      snapshot.prediction.scores.every((score) =>
        Number.isFinite(score.weight),
      ),
    ).toBe(true);
    expect(snapshot.prediction.topId).toBeNull();
  });

  it("rejects invalid, duplicate, reserved and oversized incoming slates", () => {
    const learner = new IntentLearner();
    const invalid = [NaN, Infinity, -0.1, 1.01];
    for (const probability of invalid) {
      expect(
        learner.issue([{ ...slate()[0], probability }], context, 1000),
      ).toBeNull();
    }
    expect(learner.issue([], context, 1000)).toBeNull();
    expect(learner.issue([slate()[0], slate()[0]], context, 1000)).toBeNull();
    expect(
      learner.issue([{ ...slate()[0], id: NONE_ID }], context, 1000),
    ).toBeNull();
    expect(
      learner.issue([{ ...slate()[0], id: "x".repeat(81) }], context, 1000),
    ).toBeNull();
    expect(
      learner.issue(
        Array.from({ length: 13 }, (_, i) => ({
          ...slate()[0],
          id: String(i),
        })),
        context,
        1000,
      ),
    ).toBeNull();
    expect(learner.issue(slate(), context, NaN)).toBeNull();
  });

  it("keeps predictions frozen and attention inference-only with bounded influence", () => {
    const learner = new IntentLearner();
    const snapshot = issue(learner);
    const original = JSON.stringify(snapshot);
    const profile = learner.exportProfile();
    const result = learner.predict(snapshot, {
      note: 100,
      archive: Infinity,
      reply: -10,
    });
    const inferred = result.scores.find((score) => score.id === "note")!.weight;
    const reply = result.scores.find((score) => score.id === "reply")!.weight;
    expect(inferred).toBeGreaterThan(weight(snapshot, "note"));
    expect(
      Math.log(inferred / reply) -
        Math.log(weight(snapshot, "note") / weight(snapshot, "reply")),
    ).toBeCloseTo(0.8);
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(learner.exportProfile()).toEqual(profile);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.prediction.scores[0])).toBe(true);
    expect(learner.predict(snapshot)).toBe(snapshot.prediction);
  });

  it("shares the attention budget when multiple choices have attention", () => {
    const learner = new IntentLearner();
    const snapshot = issue(learner);
    const prediction = learner.predict(snapshot, {
      reply: 1,
      note: 1,
      archive: 1,
    });
    const none = prediction.scores.find(
      (score) => score.id === NONE_ID,
    )!.weight;
    const reply = prediction.scores.find(
      (score) => score.id === "reply",
    )!.weight;
    expect(
      Math.log(reply / none) -
        Math.log(weight(snapshot, "reply") / weight(snapshot, NONE_ID)),
    ).toBeCloseTo(0.8 / 3);
  });
});

describe("explicit online learning and independent evaluation", () => {
  it("measures an abstaining prediction separately from correct top-ranked guesses before training", () => {
    const learner = new IntentLearner();
    const snapshot = issue(learner);
    expect(snapshot.prediction.bestId).toBe("reply");
    expect(snapshot.prediction.topId).toBeNull();
    expect(learner.feedback(snapshot, "reply", "confirm", 1001)).toBe(true);
    const metric = learner.metrics("practice").confirm;
    expect(metric.count).toBe(1);
    expect(metric.correct).toBe(1);
    expect(metric.suggested).toBe(0);
    expect(metric.suggestedCorrect).toBe(0);
    expect(snapshot.prediction.topId).toBeNull();
  });

  it("counts offered guesses and their correctness on checks without updating weights", () => {
    const learner = new IntentLearner();
    const profile = learner.exportProfile();
    const correct = issue(learner, slate().slice(0, 1));
    expect(correct.prediction.topId).toBe("reply");
    expect(learner.feedback(correct, "reply", "check", 1001)).toBe(true);
    const mistaken = issue(learner, slate().slice(0, 1));
    expect(learner.feedback(mistaken, NONE_ID, "check", 1001)).toBe(true);
    const metric = learner.metrics("practice").check;
    expect(metric.count).toBe(2);
    expect(metric.correct).toBe(1);
    expect(metric.suggested).toBe(2);
    expect(metric.suggestedCorrect).toBe(1);
    expect(learner.metrics("practice").examples).toBe(0);
    expect(learner.exportProfile().models.practice.weights).toEqual(
      profile.models.practice.weights,
    );
    expect(learner.exportProfile().models.practice.squaredGradients).toEqual(
      profile.models.practice.squaredGradients,
    );
  });

  it("adapts to confirmed tasks even when provider candidate IDs change", () => {
    const learner = new IntentLearner();
    train(learner, 16);
    const snapshot = issue(learner, slate("fresh"));
    expect(snapshot.prediction.bestId).toBe("notefresh");
    expect(weight(snapshot, "notefresh")).toBeGreaterThan(0.45);
    expect(snapshot.prediction.examples).toBe(16);
    expect(snapshot.baseline.bestId).toBe("replyfresh");
  });

  it("shares canonical task evidence across different wording without learning candidate IDs", () => {
    const learner = new IntentLearner();
    train(learner, 25, "archive");
    const choices = slate("new");
    choices[2].label = "Archive this email";
    choices[2].goal = "Move the open item into the archive.";
    const snapshot = issue(learner, choices);
    expect(snapshot.prediction.bestId).toBe("archivenew");
  });

  it("keeps practice training out of the live Astra model", () => {
    const learner = new IntentLearner();
    train(learner, 12);
    const astra = issue(learner, slate(), { ...context, mode: "astra" });
    expect(astra.prediction.scores).toEqual(astra.baseline.scores);
    expect(learner.metrics("astra").examples).toBe(0);
    expect(learner.metrics("practice").examples).toBe(12);
  });

  it("learns different preferences for coarse contexts", () => {
    const learner = new IntentLearner();
    const noteContext: IntentContext = {
      ...context,
      title: "Notes",
      url: "https://example.test/notes",
      input: "switch",
      focus: { x: 0.9, y: 0.9 },
    };
    for (let i = 0; i < 80; i++) {
      const ctx = i % 2 ? noteContext : context;
      const selected = i % 2 ? "note" : "reply";
      const snapshot = issue(learner, slate(), ctx, 1000 + i);
      expect(learner.feedback(snapshot, selected, "teach", 1000 + i)).toBe(
        true,
      );
    }
    expect(issue(learner).prediction.bestId).toBe("reply");
    expect(issue(learner, slate(), noteContext).prediction.bestId).toBe("note");
  });

  it("learns an explicit none choice and measures it against the same outcome set", () => {
    const learner = new IntentLearner();
    train(learner, 25, NONE_ID);
    const snapshot = issue(learner);
    expect(snapshot.prediction.bestId).toBe(NONE_ID);
    expect(snapshot.prediction.topId).toBe(NONE_ID);
    expect(learner.metrics("practice").confirm.noneCount).toBe(25);
  });

  it("evaluates the prediction before training rather than its improved post-choice result", () => {
    const learner = new IntentLearner();
    const snapshot = issue(learner);
    const expectedBrier = snapshot.prediction.scores.reduce(
      (sum, score) => sum + (score.weight - Number(score.id === "note")) ** 2,
      0,
    );
    expect(learner.feedback(snapshot, "note", "confirm", 1001)).toBe(true);
    const metrics = learner.metrics("practice");
    expect(metrics.examples).toBe(1);
    expect(metrics.confirm.count).toBe(1);
    expect(metrics.confirm.correct).toBe(0);
    expect(metrics.confirm.baselineCorrect).toBe(0);
    expect(metrics.confirm.brierSum).toBeCloseTo(expectedBrier);
    expect(metrics.confirm.logLossSum).toBeCloseTo(-Math.log(0.255));
    expect(metrics.teach.count).toBe(0);
    expect(metrics.check.count).toBe(0);
  });

  it("check feedback measures once without training or changing prior action context", () => {
    const learner = new IntentLearner();
    train(learner, 8);
    const before = learner.exportProfile();
    const check = issue(learner);
    expect(learner.feedback(check, "archive", "check", 1000)).toBe(true);
    const after = learner.exportProfile();
    expect(after.models.practice.weights).toEqual(
      before.models.practice.weights,
    );
    expect(after.models.practice.squaredGradients).toEqual(
      before.models.practice.squaredGradients,
    );
    expect(after.models.practice.examples).toBe(
      before.models.practice.examples,
    );
    expect(issue(learner).prediction).toEqual(check.prediction);
    expect(learner.metrics("practice").check.count).toBe(1);
    expect(learner.metrics("practice").confirm.count).toBe(8);
    expect(learner.feedback(check, "archive", "check", 1001)).toBe(false);
  });

  it("keeps teach measurements separate from real confirmed decisions", () => {
    const learner = new IntentLearner();
    expect(learner.feedback(issue(learner), "note", "teach", 1001)).toBe(true);
    const metrics = learner.metrics("practice");
    expect(metrics.examples).toBe(1);
    expect(metrics.teach.count).toBe(1);
    expect(metrics.confirm.count).toBe(0);
    expect(metrics.check.count).toBe(0);
  });

  it("rejects forged snapshots, unknown choices, stale feedback and replay", () => {
    const learner = new IntentLearner();
    const snapshot = issue(learner);
    const profile = learner.exportProfile();
    expect(
      learner.feedback(structuredClone(snapshot), "note", "confirm", 1001),
    ).toBe(false);
    expect(learner.feedback(snapshot, "missing", "confirm", 1001)).toBe(false);
    expect(learner.feedback(snapshot, "note", "confirm", 999)).toBe(false);
    expect(learner.feedback(snapshot, "note", "confirm", 601001)).toBe(false);
    expect(learner.feedback(snapshot, "note", "confirm", NaN)).toBe(false);
    expect(learner.exportProfile()).toEqual(profile);
    expect(learner.feedback(snapshot, "note", "confirm", 1001)).toBe(true);
    expect(learner.feedback(snapshot, "note", "confirm", 1002)).toBe(false);
    expect(learner.predict(snapshot).scores).toEqual([]);
  });

  it("prevents snapshots from another learner or superseded model from training", () => {
    const first = new IntentLearner();
    const second = new IntentLearner();
    const snapshot = issue(first);
    const foreign = issue(second);
    expect(first.feedback(foreign, "note", "confirm", 1001)).toBe(false);
    const sibling = issue(first);
    expect(first.feedback(snapshot, "note", "confirm", 1001)).toBe(true);
    expect(first.feedback(sibling, "note", "confirm", 1001)).toBe(false);
    const next = issue(first);
    first.invalidate();
    expect(first.feedback(next, "note", "confirm", 1001)).toBe(false);
  });

  it("bounds outstanding snapshots and forgets earlier sets", () => {
    const learner = new IntentLearner();
    const first = issue(learner);
    for (let i = 0; i < 25; i++) issue(learner);
    expect(learner.feedback(first, "note", "confirm", 1001)).toBe(false);
    expect(learner.metrics("practice").examples).toBe(0);
  });

  it("keeps learned influence bounded and adapts when explicit choices change", () => {
    const learner = new IntentLearner();
    train(learner, 140, "note");
    expect(issue(learner).prediction.bestId).toBe("note");
    train(learner, 220, "reply");
    const snapshot = issue(learner);
    expect(snapshot.prediction.bestId).toBe("reply");
    const learnedOdds = weight(snapshot, "reply") / weight(snapshot, "note");
    const baselineOdds = 0.5 / 0.3;
    expect(Math.abs(Math.log(learnedOdds / baselineOdds))).toBeLessThanOrEqual(
      3 + 1e-12,
    );
    const profile = learner.exportProfile();
    expect(
      profile.models.practice.weights.every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 4,
      ),
    ).toBe(true);
    expect(
      profile.models.practice.squaredGradients.every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000,
      ),
    ).toBe(true);
  });
});

describe("bounded numeric persistence", () => {
  it("round-trips a numeric-only profile and never serializes task or screen details", () => {
    const learner = new IntentLearner();
    const choices = slate();
    choices[1].label = "Save confidential-rosebud note";
    choices[1].goal = "Remember personal secret: sapphire passport.";
    const snapshot = issue(learner, choices, {
      ...context,
      url: "https://private.example/mail?secret=rosebud",
      title: "Private email from secret-person",
    });
    expect(learner.feedback(snapshot, "note", "confirm", 1001)).toBe(true);
    let saved = "";
    expect(
      saveIntentLearning(learner.exportProfile(), {
        setItem(key, value) {
          expect(key).toBe(INTENT_LEARNING_KEY);
          saved = value;
        },
      }),
    ).toBe(true);
    expect(saved).not.toMatch(
      /rosebud|sapphire|passport|private|secret-person|https|Draft a reply/,
    );
    const loaded = loadIntentLearning({ getItem: () => saved });
    expect(loaded).toEqual(learner.exportProfile());
    expect(new IntentLearner(loaded).metrics("practice").examples).toBe(1);
  });

  it("returns independent exports and resets all learned state", () => {
    const learner = new IntentLearner();
    train(learner, 3);
    const exported = learner.exportProfile();
    exported.models.practice.weights.fill(4);
    exported.models.practice.metrics.confirm.count = 700;
    expect(learner.metrics("practice").confirm.count).toBe(3);
    expect(learner.exportProfile().models.practice.weights).not.toEqual(
      exported.models.practice.weights,
    );
    const pending = issue(learner);
    learner.reset();
    expect(learner.metrics("practice").examples).toBe(0);
    expect(learner.metrics("practice").confirm.count).toBe(0);
    expect(learner.feedback(pending, "note", "confirm", 1001)).toBe(false);
    expect(issue(learner).prediction.scores).toEqual(
      issue(new IntentLearner()).prediction.scores,
    );
  });

  it("rejects malformed or oversized profiles instead of loading partial weights", () => {
    const fresh = new IntentLearner().exportProfile();
    const corruptions: ((profile: IntentLearningProfile) => void)[] = [
      (p) => {
        p.models.practice.weights[0] = NaN;
      },
      (p) => {
        p.models.practice.weights[0] = 4.001;
      },
      (p) => {
        p.models.practice.squaredGradients[0] = -1;
      },
      (p) => {
        p.models.practice.weights.push(0);
      },
      (p) => {
        delete p.models.practice.weights[0];
      },
      (p) => {
        Object.assign(p.models.practice.weights, { rawTask: "must not load" });
      },
      (p) => {
        p.models.practice.examples = 1;
      },
      (p) => {
        p.models.practice.metrics.confirm.correct = 1;
      },
      (p) => {
        p.models.practice.metrics.check.suggested = 1;
      },
      (p) => {
        p.models.practice.metrics.check.suggestedCorrect = 1;
      },
      (p) => {
        Object.assign(p.models.practice.metrics.check, {
          count: 1,
          suggested: 1,
          suggestedCorrect: 1,
          correct: 0,
        });
      },
      (p) => {
        Object.assign(p.models.practice.metrics.check, {
          count: 1,
          suggested: 0,
          suggestedCorrect: 1,
          correct: 1,
        });
      },
      (p) => {
        p.models.practice.metrics.check.brierSum = 5;
      },
      (p) => {
        Object.assign(p, { screenshots: ["must never load"] });
      },
    ];
    for (const corrupt of corruptions) {
      const profile = structuredClone(fresh);
      corrupt(profile);
      expect(new IntentLearner(profile).exportProfile()).toEqual(fresh);
      expect(
        saveIntentLearning(profile, {
          setItem() {
            throw new Error("must not save");
          },
        }),
      ).toBe(false);
    }
    expect(loadIntentLearning({ getItem: () => "{" })).toBeNull();
    expect(
      loadIntentLearning({ getItem: () => " ".repeat(160001) }),
    ).toBeNull();
    expect(
      loadIntentLearning({ getItem: () => '{"__proto__":{"weights":[1]}}' }),
    ).toBeNull();
    expect(
      new IntentLearner(Object.assign(new Date(), fresh)).exportProfile(),
    ).toEqual(fresh);
  });

  it("handles unavailable storage and thrown access without disabling in-memory learning", () => {
    const learner = new IntentLearner();
    expect(
      loadIntentLearning({
        getItem() {
          throw new Error("denied");
        },
      }),
    ).toBeNull();
    expect(
      saveIntentLearning(learner.exportProfile(), {
        setItem() {
          throw new Error("quota");
        },
      }),
    ).toBe(false);
    expect(() => loadIntentLearning()).not.toThrow();
    expect(() => saveIntentLearning(learner.exportProfile())).not.toThrow();
    expect(learner.feedback(issue(learner), "note", "confirm", 1001)).toBe(
      true,
    );
    expect(learner.metrics("practice").examples).toBe(1);
  });
});

import {
  existsSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPersonalContext,
  personalContextPrompt,
  type PersonalContext,
} from "../server/personal-context";
import { AstraProvider } from "../server/provider";
import { IntentLearner } from "../src/core/intent-learning";

// Only synthetic context is used. Never inspect the developer's private file.
const context: PersonalContext = {
  version: 1,
  name: "Synthetic Tester",
  context: ["PRIVATE_BACKGROUND_CANARY: works on a fictional calendar tool."],
  preferences: ["PRIVATE_PREFERENCE_CANARY: prefers saving drafts."],
  source: "EXPLICIT_SOURCE_CANARY: supplied for this test only.",
};
const directories: string[] = [];
function fixture(raw?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "nerve-personal-context-test-"));
  directories.push(directory);
  const path = join(directory, "context.json");
  if (raw !== undefined) writeFileSync(path, raw, "utf8");
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const path = join(directory, "context.json");
    if (existsSync(path)) unlinkSync(path);
    rmdirSync(directory);
  }
  vi.restoreAllMocks();
});

const candidates = [
  {
    id: "draft",
    label: "Draft a reply",
    description: "Prepare a reply.",
    goal: "Save a draft reply without sending it.",
    probability: 0.5,
    risk: "confirm",
  },
  {
    id: "note",
    label: "Save a note",
    description: "Keep visible details.",
    goal: "Save a note about the visible meeting.",
    probability: 0.3,
    risk: "low",
  },
  {
    id: "read",
    label: "Read this message",
    description: "Open the visible message.",
    goal: "Open the visible message.",
    probability: 0.2,
    risk: "low",
  },
];
function candidateResponse(extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ candidates, ...extra }),
            },
          ],
        },
      ],
    }),
  );
}

describe("explicit personal context files", () => {
  it("loads and normalizes a valid file without inventing fields or examples", () => {
    const raw = {
      ...context,
      name: ` ${context.name} `,
      context: [` ${context.context[0]} `],
      preferences: [` ${context.preferences[0]} `],
      source: ` ${context.source} `,
    };
    expect(loadPersonalContext(fixture(JSON.stringify(raw)))).toEqual(context);
  });

  it("treats a missing file as no personal context", () => {
    expect(loadPersonalContext(fixture())).toBeNull();
    expect(personalContextPrompt(null)).toBe("");
  });

  it.each(["{broken-json", "null", "[]", '"not a context object"'])(
    "rejects corrupt or non-object content (%#)",
    (raw) => {
      expect(loadPersonalContext(fixture(raw))).toBeNull();
    },
  );

  it("rejects an oversized file even if its JSON would otherwise be valid", () => {
    const raw = JSON.stringify(context) + " ".repeat(12_001);
    expect(loadPersonalContext(fixture(raw))).toBeNull();
  });

  it.each([
    { version: 2 },
    { name: " " },
    { name: "x".repeat(81) },
    { context: Array(13).fill("A fact") },
    { context: ["x".repeat(301)] },
    { context: [3] },
    { preferences: Array(13).fill("A preference") },
    { preferences: ["x".repeat(201)] },
    { preferences: [""] },
    { source: "x".repeat(301) },
    { source: " " },
  ])("rejects invalid schema values (%#)", (invalid) => {
    expect(
      loadPersonalContext(fixture(JSON.stringify({ ...context, ...invalid }))),
    ).toBeNull();
  });

  it.each([
    { trainingExamples: 1000 },
    { accuracy: 0.99 },
    { autoApprove: true },
    { currentGoal: "Execute something now" },
  ])(
    "rejects unknown fields, including invented evidence or authorization (%#)",
    (unknown) => {
      expect(
        loadPersonalContext(
          fixture(JSON.stringify({ ...context, ...unknown })),
        ),
      ).toBeNull();
    },
  );
});

describe("personal context suggestion boundary", () => {
  it.each([undefined, { x: 0.2, y: 0.7 }])(
    "adds explicit context only to the suggestion input, with or without coarse attention (%#)",
    async (point) => {
      const transport = vi
        .fn()
        .mockImplementation(async () => candidateResponse());
      const provider = new AstraProvider(
        "synthetic-test-key",
        transport,
        context,
      );
      const result = await provider.candidates(
        "data:image/png;base64,synthetic-screen",
        point,
        new AbortController().signal,
      );
      expect(result).toEqual(candidates);
      const body = JSON.parse(transport.mock.calls[0][1].body);
      const prompt = body.input[0].content[0].text;
      expect(prompt).toContain(JSON.stringify(context));
      expect(prompt).toContain(
        "not a confirmed current goal, authorization, or measured training examples",
      );
      expect(prompt).toContain("grounded in the visible screen");
      expect(prompt).toContain(
        "Do not invent personal facts or expose background details in labels",
      );
      expect(body.instructions).not.toContain("PRIVATE_BACKGROUND_CANARY");
      expect(body.instructions).toContain("not calibrated confidence");
      expect(body.tools).toBeUndefined();
      expect(body.store).toBe(false);
      expect(body.input[0].content[1]).toEqual({
        type: "input_image",
        image_url: "data:image/png;base64,synthetic-screen",
        detail: "original",
      });
      expect(context.context).toHaveLength(1);
    },
  );

  it("does not add background when context is explicitly disabled", async () => {
    const transport = vi
      .fn()
      .mockImplementation(async () => candidateResponse());
    const provider = new AstraProvider("synthetic-test-key", transport, null);
    await provider.candidates(
      "synthetic-screen",
      undefined,
      new AbortController().signal,
    );
    const body = JSON.parse(transport.mock.calls[0][1].body);
    expect(body.input[0].content[0].text).toBe(
      "Suggest three useful next intents for this screen.",
    );
    expect(JSON.stringify(body)).not.toContain("CANARY");
  });

  it("never carries private background into the following computer-action request", async () => {
    const transport = vi
      .fn()
      .mockImplementationOnce(async () => candidateResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "computer_call",
                call_id: "synthetic-call",
                actions: [{ type: "click", x: 12, y: 34 }],
              },
            ],
          }),
        ),
      );
    const provider = new AstraProvider(
      "synthetic-test-key",
      transport,
      context,
    );
    await provider.candidates(
      "synthetic-screen",
      undefined,
      new AbortController().signal,
    );
    const chosenInput = [
      { role: "user", content: "Open the visible message." },
    ];
    const result = await provider.next(
      chosenInput,
      new AbortController().signal,
    );
    const body = JSON.parse(transport.mock.calls[1][1].body);
    expect(body.input).toEqual(chosenInput);
    expect(body.tools).toEqual([{ type: "computer" }]);
    expect(body.instructions).toContain(
      "Work only on the user's selected goal",
    );
    expect(body.instructions).toContain("explicit approval BEFORE execution");
    expect(JSON.stringify(body)).not.toContain("CANARY");
    expect(JSON.stringify(body)).not.toContain(context.name);
    expect(result.actions).toEqual([{ type: "click", x: 12, y: 34 }]);
  });

  it("does not turn supplied context or provider claims into measured learning", async () => {
    const transport = vi
      .fn()
      .mockImplementation(async () =>
        candidateResponse({ trainingExamples: 1000, accuracy: 0.99 }),
      );
    const provider = new AstraProvider(
      "synthetic-test-key",
      transport,
      context,
    );
    const learner = new IntentLearner();
    const before = learner.exportProfile();
    const result = await provider.candidates(
      "synthetic-screen",
      undefined,
      new AbortController().signal,
    );
    const snapshot = learner.issue(
      result,
      {
        mode: "astra",
        input: "camera",
        url: "https://example.test/inbox",
        title: "Visible inbox",
        focus: null,
      },
      1000,
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot!.prediction.examples).toBe(0);
    expect(result).toEqual(candidates);
    expect(learner.exportProfile()).toEqual(before);
    expect(learner.metrics("astra")).toMatchObject({
      examples: 0,
      confirm: { count: 0 },
      teach: { count: 0 },
      check: { count: 0 },
    });
    expect(learner.feedback(snapshot!, result[0].id, "confirm", 1001)).toBe(
      true,
    );
    expect(learner.metrics("astra")).toMatchObject({
      examples: 1,
      confirm: { count: 1 },
      teach: { count: 0 },
      check: { count: 0 },
    });
  });
});

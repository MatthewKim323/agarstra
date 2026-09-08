import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate, ComputerAction } from "../shared/types";
import type { ComputerBrowser } from "../server/browser";
import type { ComputerProvider, ProviderTurn } from "../server/provider";
import type { LabState } from "../server/lab";
import { NerveSession } from "../server/session";

const candidates: Candidate[] = [
  {
    id: "draft",
    label: "Draft a reply",
    description: "Save a reply without sending it.",
    goal: "Draft a reply. Do not send it.",
    probability: 0.6,
    risk: "confirm",
  },
  {
    id: "note",
    label: "Save a note",
    description: "Keep the details.",
    goal: "Save a note with the meeting details.",
    probability: 0.4,
    risk: "low",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ContextBrowser implements ComputerBrowser {
  version = 0;
  url = "http://127.0.0.1:4318/lab";
  title = "Practice Mail";
  performed: ComputerAction[] = [];
  open = vi.fn(async () => {});
  snapshot = vi.fn(async () => ({
    screenshot: `data:image/png;base64,${this.version}`,
    title: this.title,
    url: this.url,
    width: 1280,
    height: 800,
  }));
  perform = vi.fn(async (action: ComputerAction, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    this.performed.push(action);
    this.version++;
  });
  pointFor = vi.fn(async () => ({ x: 100, y: 100 }));
  describe = vi.fn(async () => ({
    summary: "Click the visible control.",
    warnings: [],
  }));
  labState = vi.fn(
    async (): Promise<LabState> => ({
      view: "mail",
      selectedId: "main",
      draft: "",
      notes: [],
      archivedIds: [],
      composerOpen: false,
    }),
  );
  close = vi.fn(async () => {});
}

const proposedTurn: ProviderTurn = {
  output: [{ type: "computer_call", call_id: "context-call" }],
  callId: "context-call",
  actions: [{ type: "click", x: 100, y: 100 }],
  safetyChecks: [],
  text: "",
};
const completedTurn: ProviderTurn = {
  output: [],
  safetyChecks: [],
  text: "The requested step is complete.",
};

describe("suggested intent screen binding", () => {
  let browser: ContextBrowser;
  let provider: ComputerProvider & {
    next: ReturnType<typeof vi.fn>;
    candidates: ReturnType<typeof vi.fn>;
  };
  let session: NerveSession;
  let now: number;

  beforeEach(() => {
    browser = new ContextBrowser();
    now = 1000;
    provider = {
      configured: true,
      model: "gpt-6-astra",
      next: vi
        .fn()
        .mockResolvedValueOnce(proposedTurn)
        .mockResolvedValue(completedTurn),
      candidates: vi.fn(async () => structuredClone(candidates)),
    };
    session = new NerveSession({ browser, provider, now: () => now });
  });
  afterEach(async () => {
    await session.close();
  });

  it.each(["practice", "astra"] as const)(
    "returns the fresh observed %s state with its candidate set without dispatching browser input",
    async (mode) => {
      await session.start({ mode, screenConsent: mode === "astra" });
      const initial = session.getState();
      browser.version = 8;
      browser.url = "http://127.0.0.1:4318/lab#notes";
      browser.title = "Practice Notes";
      const result = await session.candidates({ x: 0.1, y: 0.7 });
      expect(result.state.screenshot).toBe("data:image/png;base64,8");
      expect(result.state.url).toBe(browser.url);
      expect(result.state.title).toBe("Practice Notes");
      expect(result.state.revision).toBeGreaterThan(initial.revision);
      expect(result.state).toEqual(session.getState());
      expect(result.source).toBe(mode);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(browser.performed).toEqual([]);
      expect(provider.next).not.toHaveBeenCalled();
      if (mode === "astra") {
        expect(provider.candidates).toHaveBeenCalledWith(
          result.state.screenshot,
          { x: 0.1, y: 0.7 },
          expect.any(AbortSignal),
        );
      } else {
        expect(provider.candidates).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a candidate from an earlier observation before changing task state or calling the provider", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const older = await session.candidates();
    now += 3000;
    browser.version++;
    const current = await session.candidates();
    const snapshots = browser.snapshot.mock.calls.length;
    const before = session.getState();
    expect(() =>
      session.intent(older.candidates[0].goal, older.state.revision),
    ).toThrow("screen changed");
    expect(session.getState()).toEqual(before);
    expect(current.state.revision).toBeGreaterThan(older.state.revision);
    expect(older.state.screenshot).toBe("data:image/png;base64,0");
    expect(browser.snapshot).toHaveBeenCalledTimes(snapshots);
    expect(provider.next).not.toHaveBeenCalled();
    expect(browser.performed).toEqual([]);
  });

  it("a rejected old intent cannot cancel a newer candidate request that is still running", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const older = await session.candidates();
    const pending = deferred<Candidate[]>();
    provider.candidates.mockReturnValueOnce(pending.promise);
    now += 3000;
    browser.version++;
    const newer = session.candidates();
    await vi.waitFor(() =>
      expect(provider.candidates).toHaveBeenCalledTimes(2),
    );
    const signal = provider.candidates.mock.calls[1][2] as AbortSignal;
    expect(() =>
      session.intent(older.candidates[0].goal, older.state.revision),
    ).toThrow("screen changed");
    expect(signal.aborted).toBe(false);
    pending.resolve(structuredClone(candidates));
    const result = await newer;
    expect(result.state.screenshot).toBe("data:image/png;base64,1");
    expect(result.state).toEqual(session.getState());
    expect(provider.next).not.toHaveBeenCalled();
    expect(browser.performed).toEqual([]);
  });

  it("accepts the current revision while preserving separate one-use action approval", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const result = await session.candidates();
    const accepted = session.intent(
      result.candidates[0].goal,
      result.state.revision,
    );
    expect(accepted.goal).toBe(result.candidates[0].goal);
    await session.settle();
    const proposed = session.getState();
    expect(proposed.status).toBe("approval");
    expect(provider.next).toHaveBeenCalledTimes(1);
    expect(browser.performed).toEqual([]);
    const proposal = proposed.proposal!;
    expect(() => session.approve(proposal.id, result.state.revision)).toThrow(
      "stale",
    );
    expect(browser.performed).toEqual([]);
    session.approve(proposal.id, proposal.revision);
    await session.settle();
    expect(browser.performed).toEqual(proposedTurn.actions);
    expect(session.getState().status).toBe("completed");
    expect(() => session.approve(proposal.id, proposal.revision)).toThrow(
      "stale",
    );
    expect(browser.performed).toHaveLength(1);
  });

  it.each(["stop", "reset", "new session"])(
    "%s invalidates an older suggestion revision",
    async (transition) => {
      await session.start({ mode: "astra", screenConsent: true });
      const result = await session.candidates();
      if (transition === "stop") session.stop();
      else if (transition === "reset") await session.reset();
      else await session.start({ mode: "practice", screenConsent: false });
      const current = session.getState();
      expect(current.revision).toBeGreaterThan(result.state.revision);
      expect(() =>
        session.intent(result.candidates[0].goal, result.state.revision),
      ).toThrow("screen changed");
      expect(session.getState()).toEqual(current);
      expect(provider.next).not.toHaveBeenCalled();
      expect(browser.performed).toEqual([]);
    },
  );

  it("returns an independent state copy so client-side enrichment cannot alter server authorization", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const result = await session.candidates();
    const actual = session.getState();
    result.state.revision = 999_999;
    result.state.screenshot = "client changed pixels";
    result.state.url = "https://another.example/";
    result.state.events[0].message = "client changed event";
    result.state.events.push({
      id: "made-up",
      time: now,
      kind: "action",
      message: "never happened",
    });
    expect(session.getState()).toEqual(actual);
    expect(() =>
      session.intent(result.candidates[0].goal, result.state.revision),
    ).toThrow("screen changed");
    expect(browser.performed).toEqual([]);
  });

  it("retains legacy explicit task submission without an expected revision", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    session.intent("Inspect the visible button.");
    await session.settle();
    expect(session.getState().status).toBe("approval");
    expect(provider.next).toHaveBeenCalledTimes(1);
    expect(browser.performed).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerAction } from "../shared/types";
import type { ComputerBrowser } from "../server/browser";
import type { ComputerProvider, ProviderTurn } from "../server/provider";
import { NerveSession } from "../server/session";
import type { LabState } from "../server/lab";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class FakeBrowser implements ComputerBrowser {
  version = 0;
  performed: ComputerAction[] = [];
  gate: ReturnType<typeof deferred<void>> | null = null;
  state: LabState = {
    view: "mail",
    selectedId: "main",
    draft: "",
    notes: [],
    archivedIds: [],
    composerOpen: false,
  };
  open = vi.fn(async () => {});
  snapshot = vi.fn(async () => ({
    screenshot: `data:image/png;base64,${this.version}`,
    title: "Lab",
    url: "http://127.0.0.1:4318/lab",
    width: 1280,
    height: 800,
  }));
  async perform(action: ComputerAction, signal: AbortSignal) {
    this.performed.push(action);
    if (this.gate) await this.gate.promise;
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    this.version++;
  }
  pointFor = vi.fn(async () => ({ x: 123, y: 234 }));
  describe = vi.fn(async () => ({
    summary: "Click the practice button.",
    warnings: [],
  }));
  labState = vi.fn(async () => structuredClone(this.state));
  close = vi.fn(async () => {});
}
function turn(
  actions: ComputerAction[] = [{ type: "click", x: 1, y: 1 }],
): ProviderTurn {
  return {
    output: [{ type: "computer_call", call_id: "call_1", actions }],
    callId: "call_1",
    actions,
    safetyChecks: [],
    text: "",
  };
}

describe("approval and cancellation state machine", () => {
  let browser: FakeBrowser,
    provider: ComputerProvider & { next: ReturnType<typeof vi.fn> },
    session: NerveSession,
    clock: number;
  beforeEach(() => {
    browser = new FakeBrowser();
    clock = 1000;
    provider = {
      configured: true,
      model: "gpt-6-astra",
      next: vi.fn().mockResolvedValue(turn()),
      candidates: vi.fn().mockResolvedValue([]),
    };
    session = new NerveSession({ browser, provider, now: () => clock });
  });
  const start = async () => {
    await session.start({ mode: "astra", screenConsent: true });
    session.intent("Click the visible button");
    await session.settle();
    return session.getState().proposal!;
  };

  it("does not launch a browser or send data during state/health reads", () => {
    expect(session.getState().screenshot).toBeNull();
    expect(browser.open).not.toHaveBeenCalled();
    expect(provider.next).not.toHaveBeenCalled();
  });
  it("requires explicit screenshot consent and configured Astra", async () => {
    await expect(
      session.start({ mode: "astra", screenConsent: false }),
    ).rejects.toThrow("consent");
    expect(browser.open).not.toHaveBeenCalled();
    const missing = new NerveSession({
      browser,
      provider: { ...provider, configured: false },
    });
    await expect(
      missing.start({ mode: "astra", screenConsent: true }),
    ).rejects.toThrow("not configured");
  });
  it("never sends practice screenshots to the provider", async () => {
    await session.start({ mode: "practice", screenConsent: false });
    await session.candidates();
    session.intent("Draft a reply");
    await session.settle();
    expect(provider.next).not.toHaveBeenCalled();
    expect(provider.candidates).not.toHaveBeenCalled();
    expect(browser.performed).toHaveLength(0);
  });
  it("requires exact one-use proposal ID and revision", async () => {
    const proposal = await start();
    expect(browser.performed).toHaveLength(0);
    expect(() => session.approve("different", proposal.revision)).toThrow(
      "stale",
    );
    expect(() => session.approve(proposal.id, proposal.revision - 1)).toThrow(
      "stale",
    );
    provider.next.mockResolvedValueOnce({
      output: [],
      text: "Done",
      safetyChecks: [],
    });
    session.approve(proposal.id, proposal.revision);
    expect(() => session.approve(proposal.id, proposal.revision)).toThrow();
    await session.settle();
    expect(browser.performed).toHaveLength(1);
    expect(session.getState().status).toBe("completed");
    expect(session.getState().revision).toBeGreaterThan(proposal.revision);
  });
  it("expires approvals without any execution", async () => {
    const proposal = await start();
    clock = proposal.expiresAt;
    expect(() => session.approve(proposal.id, proposal.revision)).toThrow(
      "expired",
    );
    expect(browser.performed).toHaveLength(0);
  });
  it("rejects an approval if the underlying screen changed", async () => {
    const proposal = await start();
    browser.version++;
    session.approve(proposal.id, proposal.revision);
    await session.settle();
    expect(browser.performed).toHaveLength(0);
    expect(session.getState().message).toContain("screen changed");
  });
  it("stop invalidates an unapproved proposal", async () => {
    const proposal = await start();
    session.stop();
    expect(() => session.approve(proposal.id, proposal.revision)).toThrow(
      "stale",
    );
    expect(browser.performed).toHaveLength(0);
  });
  it("stop aborts the provider and ignores late results", async () => {
    const pending = deferred<ProviderTurn>();
    provider.next.mockReturnValueOnce(pending.promise);
    await session.start({ mode: "astra", screenConsent: true });
    session.intent("Click something");
    await vi.waitFor(() => expect(provider.next).toHaveBeenCalled());
    const signal = provider.next.mock.calls[0][1] as AbortSignal;
    session.stop();
    expect(signal.aborted).toBe(true);
    pending.resolve(turn());
    await session.settle();
    expect(session.getState().status).toBe("stopped");
    expect(session.getState().proposal).toBeNull();
    expect(browser.performed).toHaveLength(0);
  });
  it("stop during a batch prevents every subsequent primitive and screenshot update", async () => {
    provider.next.mockResolvedValueOnce(
      turn([
        { type: "click", x: 1, y: 1 },
        { type: "type", text: "never type this" },
      ]),
    );
    const proposal = await start();
    browser.gate = deferred<void>();
    session.approve(proposal.id, proposal.revision);
    await vi.waitFor(() => expect(browser.performed).toHaveLength(1));
    const stopped = session.stop();
    browser.gate.resolve();
    await session.settle();
    expect(browser.performed).toHaveLength(1);
    expect(session.getState().revision).toBe(stopped.revision);
    expect(session.getState().status).toBe("stopped");
  });
  it("preserves encrypted output history and returns the matching computer call result only after approval", async () => {
    const encrypted = {
      type: "reasoning",
      id: "r1",
      encrypted_content: "opaque",
    };
    const initial = turn();
    initial.output.unshift(encrypted);
    provider.next
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ output: [], text: "Done", safetyChecks: [] });
    const proposal = await start();
    session.approve(proposal.id, proposal.revision);
    await session.settle();
    const history = provider.next.mock.calls[1][0] as Record<string, unknown>[];
    expect(history).toContainEqual(encrypted);
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "computer_call_output",
        call_id: "call_1",
        output: expect.objectContaining({ detail: "original" }),
      }),
    );
  });
  it("reset drains work, closes the browser, and clears screenshots", async () => {
    await start();
    const oldRevision = session.getState().revision;
    await session.reset();
    expect(browser.close).toHaveBeenCalled();
    expect(session.getState().screenshot).toBeNull();
    expect(session.getState().revision).toBeGreaterThan(oldRevision);
    expect(session.getState().status).toBe("idle");
    expect(session.getState().screenConsent).toBe(false);
  });
  it("does not label a first-turn plan-only message as task completion", async () => {
    provider.next.mockResolvedValueOnce({
      output: [],
      text: "I can help with that.",
      safetyChecks: [],
    });
    await start();
    expect(session.getState().status).toBe("idle");
    expect(session.getState().message).toContain("No actions were proposed");
    expect(browser.performed).toHaveLength(0);
  });
  it("enforces the primitive-action budget before approving an oversized next batch", async () => {
    provider.next.mockResolvedValue(
      turn(Array.from({ length: 12 }, () => ({ type: "click", x: 1, y: 1 }))),
    );
    let proposal = await start();
    session.approve(proposal.id, proposal.revision);
    await session.settle();
    proposal = session.getState().proposal!;
    session.approve(proposal.id, proposal.revision);
    await session.settle();
    expect(session.getState().status).toBe("error");
    expect(session.getState().message).toContain("safety budget");
    expect(browser.performed).toHaveLength(24);
  });
  it("a fresh intent invalidates a previous unapproved plan", async () => {
    const old = await start();
    session.intent("A different user-selected task");
    await session.settle();
    expect(() => session.approve(old.id, old.revision)).toThrow("stale");
    expect(browser.performed).toHaveLength(0);
  });
  it("holds provider safety checks for the approval and acknowledges them only after execution", async () => {
    const initial = turn();
    initial.safetyChecks = [
      {
        id: "check1",
        code: "sensitive",
        message: "Review this synthetic action carefully.",
      },
    ];
    provider.next
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ output: [], text: "Done", safetyChecks: [] });
    const proposal = await start();
    expect(proposal.safetyWarnings).toContain(
      "Review this synthetic action carefully.",
    );
    session.approve(proposal.id, proposal.revision);
    await session.settle();
    const history = provider.next.mock.calls[1][0] as Record<string, unknown>[];
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "computer_call_output",
        acknowledged_safety_checks: initial.safetyChecks,
      }),
    );
  });
  it("rejects unknown practice goals instead of faking completion", async () => {
    await session.start({ mode: "practice", screenConsent: false });
    expect(() => session.intent("Book an international flight")).toThrow(
      "Practice mode supports",
    );
    expect(browser.performed).toHaveLength(0);
  });
  it("accepts explicitly negated destructive actions while rejecting affirmative requests", async () => {
    await session.start({ mode: "practice", screenConsent: false });
    session.intent("Archive this email. Do not delete it.");
    await session.settle();
    expect(session.getState().status).toBe("approval");
    expect(() =>
      session.intent("Draft a reply. Do not delete it, but send it."),
    ).toThrow("never sends");
    expect(() => session.intent("Draft a reply and send it")).toThrow(
      "never sends",
    );
  });
  it("captures fresh pixels before Astra intent suggestions without executing anything", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const oldRevision = session.getState().revision;
    browser.version = 7;
    await session.candidates({ x: 0.4, y: 0.6 });
    expect(provider.candidates).toHaveBeenCalledWith(
      "data:image/png;base64,7",
      { x: 0.4, y: 0.6 },
      expect.any(AbortSignal),
    );
    expect(session.getState().screenshot).toBe("data:image/png;base64,7");
    expect(session.getState().revision).toBeGreaterThan(oldRevision);
    expect(browser.performed).toHaveLength(0);
  });
  it("refreshes the practice screenshot locally without a provider request", async () => {
    await session.start({ mode: "practice", screenConsent: false });
    browser.version = 9;
    const result = await session.candidates();
    expect(result.source).toBe("practice");
    expect(result.candidates).toHaveLength(3);
    expect(session.getState().screenshot).toBe("data:image/png;base64,9");
    expect(provider.candidates).not.toHaveBeenCalled();
    expect(browser.performed).toHaveLength(0);
  });
  it("never refreshes a screen with a pending approval or invalidates that proposal", async () => {
    const proposal = await start(),
      revision = session.getState().revision;
    const screenshots = browser.snapshot.mock.calls.length;
    await expect(session.candidates()).rejects.toThrow("approval");
    expect(browser.snapshot).toHaveBeenCalledTimes(screenshots);
    expect(session.getState().revision).toBe(revision);
    expect(session.getState().proposal).toEqual(proposal);
    expect(provider.candidates).not.toHaveBeenCalled();
  });
  it("drops an in-flight fresh capture after Stop and never sends it to Astra", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const gate = deferred<Awaited<ReturnType<ComputerBrowser["snapshot"]>>>();
    browser.snapshot.mockReturnValueOnce(gate.promise);
    const candidateRequest = session.candidates();
    const cancelled =
      expect(candidateRequest).rejects.toThrow("session changed");
    const stopped = session.stop();
    gate.resolve({
      screenshot: "late pixels",
      title: "Late",
      url: stopped.url,
      width: 1280,
      height: 800,
    });
    await cancelled;
    expect(session.getState()).toEqual(stopped);
    expect(provider.candidates).not.toHaveBeenCalled();
  });
  it("drops a fresh capture superseded by a new intent without changing its proposal", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const gate = deferred<Awaited<ReturnType<ComputerBrowser["snapshot"]>>>();
    browser.snapshot.mockReturnValueOnce(gate.promise);
    const candidateRequest = session.candidates();
    const cancelled =
      expect(candidateRequest).rejects.toThrow("session changed");
    session.intent("Click a visible control");
    await session.settle();
    const current = session.getState();
    gate.resolve({
      screenshot: "late pixels",
      title: "Late",
      url: current.url,
      width: 1280,
      height: 800,
    });
    await cancelled;
    expect(session.getState()).toEqual(current);
    expect(provider.candidates).not.toHaveBeenCalled();
  });
  it("cancels suggestions returned after Stop even when the capture was fresh", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const gate =
      deferred<Awaited<ReturnType<ComputerProvider["candidates"]>>>();
    vi.mocked(provider.candidates).mockReturnValueOnce(gate.promise);
    const candidateRequest = session.candidates();
    const cancelled =
      expect(candidateRequest).rejects.toThrow("session changed");
    await vi.waitFor(() => expect(provider.candidates).toHaveBeenCalled());
    const stopped = session.stop();
    gate.resolve([]);
    await cancelled;
    expect(session.getState()).toEqual(stopped);
    expect(browser.performed).toHaveLength(0);
  });
  it("allows only one candidate capture at a time", async () => {
    await session.start({ mode: "astra", screenConsent: true });
    const gate = deferred<Awaited<ReturnType<ComputerBrowser["snapshot"]>>>();
    browser.snapshot.mockReturnValueOnce(gate.promise);
    const candidateRequest = session.candidates();
    const cancelled =
      expect(candidateRequest).rejects.toThrow("session changed");
    await expect(session.candidates()).rejects.toThrow(
      "already being generated",
    );
    const stopped = session.stop();
    gate.resolve({
      screenshot: "late",
      title: "Late",
      url: stopped.url,
      width: 1280,
      height: 800,
    });
    await cancelled;
    expect(provider.candidates).not.toHaveBeenCalled();
  });
});

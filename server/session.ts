import { randomUUID } from "node:crypto";
import type {
  Candidate,
  ComputerAction,
  Point,
  Proposal,
  SessionState,
} from "../shared/types";
import { VIEWPORT, describeAction, parseActions } from "./actions";
import { PlaywrightComputer, type ComputerBrowser } from "./browser";
import { AppError, publicError } from "./errors";
import { createNetworkPolicy, type NetworkPolicy } from "./security";
import {
  AstraProvider,
  type ComputerProvider,
  type ProviderTurn,
} from "./provider";
import { PracticePlan, PRACTICE_CANDIDATES } from "./practice";

export type SessionOptions = {
  browser?: ComputerBrowser;
  provider?: ComputerProvider;
  now?: () => number;
  localOrigin?: string;
  policyFactory?: (url: string, origin: string) => Promise<NetworkPolicy>;
};

export class NerveSession {
  private browser: ComputerBrowser;
  private provider: ComputerProvider;
  private now: () => number;
  private localOrigin: string;
  private policyFactory: NonNullable<SessionOptions["policyFactory"]>;
  private state: SessionState;
  private generation = 0;
  private controller: AbortController | null = null;
  private candidateController: AbortController | null = null;
  private operation: Promise<void> | null = null;
  private closing = false;
  private practice: PracticePlan | null = null;
  private history: unknown[] = [];
  private turn: ProviderTurn | null = null;
  private proposalScreen: string | null = null;
  private providerCalls = 0;
  private candidateCalls = 0;
  private candidateAt = 0;
  private deadline = 0;

  constructor(options: SessionOptions = {}) {
    this.browser = options.browser ?? new PlaywrightComputer();
    this.provider = options.provider ?? new AstraProvider();
    this.now = options.now ?? Date.now;
    this.localOrigin = options.localOrigin ?? "http://127.0.0.1:4318";
    this.policyFactory = options.policyFactory ?? createNetworkPolicy;
    this.state = this.initial();
  }

  private initial(): SessionState {
    return {
      mode: "practice",
      status: "idle",
      model: this.provider.model,
      configured: this.provider.configured,
      screenshot: null,
      url: "",
      title: "Your private workspace",
      ...VIEWPORT,
      revision: 0,
      proposal: null,
      events: [],
      message:
        "Start a private browser session. Nothing moves without your approval.",
      goal: "",
      steps: 0,
      maxSteps: 32,
      screenConsent: false,
    };
  }

  getState(): SessionState {
    return structuredClone(this.state);
  }
  private update(change: Partial<SessionState>): void {
    this.state = {
      ...this.state,
      ...change,
      revision: this.state.revision + 1,
    };
  }
  private event(
    kind: SessionState["events"][number]["kind"],
    message: string,
  ): void {
    this.state.events = [
      ...this.state.events,
      { id: randomUUID(), time: this.now(), kind, message },
    ].slice(-80);
  }
  private active(token: number, signal: AbortSignal): void {
    if (token !== this.generation || signal.aborted)
      throw new DOMException("Operation cancelled", "AbortError");
    if (this.deadline && this.now() > this.deadline)
      throw new AppError(
        408,
        "This task reached its 10-minute safety limit. Start a fresh intent to continue.",
      );
  }
  private assertAvailable(): void {
    if (this.closing || this.operation)
      throw new AppError(
        409,
        "The current operation is still settling. Stop it or wait before starting another.",
      );
  }
  private begin(): { token: number; signal: AbortSignal } {
    this.controller?.abort();
    this.candidateController?.abort();
    this.controller = new AbortController();
    return { token: ++this.generation, signal: this.controller.signal };
  }
  private launch(task: () => Promise<void>, token: number): Promise<void> {
    const work = task()
      .catch((error) => {
        if (token !== this.generation) return;
        const message = publicError(error);
        this.update({ status: "error", proposal: null, message });
        this.turn = null;
        this.proposalScreen = null;
        this.event("error", message);
      })
      .finally(() => {
        if (this.operation === work) this.operation = null;
      });
    this.operation = work;
    return work;
  }

  async start(options: {
    mode: "practice" | "astra";
    screenConsent: boolean;
    url?: string;
  }): Promise<SessionState> {
    this.assertAvailable();
    if (options.mode === "astra" && !options.screenConsent)
      throw new AppError(
        400,
        "Enable screenshot sharing consent before starting Astra. Webcam frames are never shared.",
      );
    if (options.mode === "astra" && !this.provider.configured)
      throw new AppError(
        503,
        "Astra is not configured. Set OPENAI_API_KEY in the server environment, or use Practice mode.",
      );
    const url =
      options.mode === "practice"
        ? `${this.localOrigin}/lab`
        : options.url?.trim() || `${this.localOrigin}/lab`;
    const { token, signal } = this.begin();
    this.deadline = 0;
    this.history = [];
    this.turn = null;
    this.practice = null;
    this.proposalScreen = null;
    this.candidateCalls = 0;
    this.candidateAt = 0;
    this.update({
      status: "thinking",
      proposal: null,
      mode: options.mode,
      screenConsent: options.mode === "astra" && options.screenConsent,
      screenshot: null,
      url: "",
      goal: "",
      steps: 0,
      message:
        "Opening an isolated browser. Your personal browser stays untouched.",
    });
    await this.launch(async () => {
      const policy = await this.policyFactory(url, this.localOrigin);
      this.active(token, signal);
      await this.browser.open(url, policy, signal);
      this.active(token, signal);
      const screen = await this.browser.snapshot();
      this.active(token, signal);
      this.update({
        ...screen,
        status: "idle",
        message:
          options.mode === "practice"
            ? "Practice workspace ready. Choose an intent. These recipes run locally without a model."
            : "Astra is ready. Only this isolated browser’s screenshots will be shared when you request suggestions or choose an intent.",
      });
      this.event(
        "info",
        options.mode === "practice"
          ? "Opened the local practice browser. No API request was made."
          : "Opened Astra mode with explicit screenshot-sharing consent.",
      );
    }, token);
    return this.getState();
  }

  intent(goal: string): SessionState {
    this.assertAvailable();
    if (!this.state.screenshot)
      throw new AppError(
        409,
        "Start a browser session before choosing an intent.",
      );
    const practice =
      this.state.mode === "practice" ? new PracticePlan(goal) : null;
    const { token, signal } = this.begin();
    this.practice = practice;
    this.turn = null;
    this.history = [];
    this.providerCalls = 0;
    this.deadline = this.now() + 10 * 60_000;
    this.update({
      goal,
      status: "thinking",
      proposal: null,
      steps: 0,
      message: "Preparing a small, reviewable next step.",
    });
    this.event(
      "info",
      "A new user-selected intent replaced any previous unapproved plan.",
    );
    void this.launch(async () => {
      const screen = await this.browser.snapshot();
      this.active(token, signal);
      this.update(screen);
      if (practice) await practice.initialize(this.browser, goal);
      else {
        if (!this.state.screenConsent)
          throw new AppError(403, "Screenshot sharing is not enabled.");
        this.history = [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `User-selected goal: ${goal}\nApproved website: ${new URL(this.state.url).origin}\nReturn a computer tool call proposing the next step. The host will show that call to the user for approval before it executes. Do not merely describe a plan or ask for approval in prose.`,
              },
              {
                type: "input_image",
                image_url: this.state.screenshot,
                detail: "original",
              },
            ],
          },
        ];
      }
      this.active(token, signal);
      await this.next(token, signal);
    }, token);
    return this.getState();
  }

  private async next(token: number, signal: AbortSignal): Promise<void> {
    this.active(token, signal);
    if (this.practice) {
      const plan = await this.practice.next(this.browser);
      this.active(token, signal);
      if (!plan) {
        const message = await this.practice.verify(this.browser);
        this.active(token, signal);
        this.update({ status: "completed", proposal: null, message });
        this.event("result", message);
        return;
      }
      await this.propose(plan.actions, plan.summary, [], token, signal);
      return;
    }
    if (++this.providerCalls > 12)
      throw new AppError(
        408,
        "This task reached its 12-response API limit. Review progress and choose a fresh intent.",
      );
    const turn = await this.provider.next(this.history, signal);
    this.active(token, signal);
    this.history.push(...turn.output);
    this.turn = turn;
    if (!turn.actions?.length || !turn.callId) {
      this.update({
        status: this.state.steps ? "completed" : "idle",
        proposal: null,
        message: this.state.steps
          ? `Astra reports: ${turn.text} Review the screen to verify the result.`
          : `No actions were proposed. Astra says: ${turn.text}`,
      });
      this.event(
        "result",
        this.state.steps
          ? "Astra finished its action loop. The current screenshot is available for user verification."
          : "Astra returned text without a computer action. No action was executed.",
      );
      return;
    }
    await this.propose(
      turn.actions,
      "",
      turn.safetyChecks.map((check) => check.message),
      token,
      signal,
    );
  }

  private async propose(
    raw: ComputerAction[],
    summary: string,
    warnings: string[],
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    const actions = parseActions(raw);
    if (this.state.steps + actions.length > this.state.maxSteps)
      throw new AppError(
        408,
        "This task reached its action safety budget. Review progress and choose a fresh intent.",
      );
    const description = await this.browser.describe(actions);
    this.active(token, signal);
    const proposal: Proposal = {
      id: randomUUID(),
      summary: summary || description.summary,
      actions,
      createdAt: this.now(),
      expiresAt: this.now() + 120_000,
      revision: this.state.revision + 1,
      safetyWarnings: [...new Set([...warnings, ...description.warnings])],
    };
    this.proposalScreen = this.state.screenshot;
    this.update({
      status: "approval",
      proposal,
      message: "Review this exact step. Nothing runs until you approve.",
    });
    this.event("proposal", proposal.summary);
  }

  approve(proposalId: string, revision: number): SessionState {
    this.assertAvailable();
    const proposal = this.state.proposal;
    if (
      !proposal ||
      this.state.status !== "approval" ||
      proposal.id !== proposalId ||
      proposal.revision !== revision ||
      this.state.revision !== revision
    ) {
      throw new AppError(
        409,
        "This approval is stale or was already used. Review the current proposal.",
      );
    }
    if (proposal.expiresAt <= this.now()) {
      this.update({
        status: "idle",
        proposal: null,
        message:
          "The proposal expired without executing. Choose the intent again for a fresh preview.",
      });
      throw new AppError(
        409,
        "This proposal expired. Choose the intent again for a fresh preview.",
      );
    }
    const token = this.generation,
      signal = this.controller!.signal;
    const expectedScreen = this.proposalScreen;
    this.candidateController?.abort();
    this.update({
      status: "executing",
      proposal: null,
      message:
        "Executing only the approved actions. Stop cancels the remaining steps.",
    });
    void this.launch(async () => {
      this.active(token, signal);
      const current = await this.browser.snapshot();
      this.active(token, signal);
      if (current.screenshot !== expectedScreen) {
        this.update(current);
        throw new AppError(
          409,
          "The screen changed after this proposal was made. No action was executed. Choose the intent again for a fresh preview.",
        );
      }
      for (const action of proposal.actions) {
        this.active(token, signal);
        await this.browser.perform(action, signal);
        this.active(token, signal);
        const screen = await this.browser.snapshot();
        this.active(token, signal);
        this.update({ ...screen, steps: this.state.steps + 1 });
        this.event("action", describeAction(action));
      }
      this.active(token, signal);
      if (!this.practice && this.turn?.callId) {
        const output: Record<string, unknown> = {
          type: "computer_call_output",
          call_id: this.turn.callId,
          output: {
            type: "computer_screenshot",
            image_url: this.state.screenshot,
            detail: "original",
          },
        };
        if (this.turn.safetyChecks.length)
          output.acknowledged_safety_checks = this.turn.safetyChecks;
        this.history.push(output);
      }
      this.update({
        status: "thinking",
        message: "Checking the result and preparing the next step.",
      });
      await this.next(token, signal);
    }, token);
    return this.getState();
  }

  stop(): SessionState {
    this.generation++;
    this.controller?.abort();
    this.candidateController?.abort();
    this.turn = null;
    this.history = [];
    this.practice = null;
    this.proposalScreen = null;
    this.deadline = 0;
    this.update({
      status: "stopped",
      proposal: null,
      message:
        "Stopped. Queued actions are cancelled; dispatched input cannot be undone. This image is the last capture. Resume input, then Read this screen to refresh without actions.",
    });
    this.event(
      "stop",
      "User stopped the run. All approvals invalidated; model requests cancelled.",
    );
    return this.getState();
  }

  async reset(): Promise<SessionState> {
    if (this.closing)
      throw new AppError(409, "The session is already resetting.");
    this.closing = true;
    this.stop();
    try {
      await this.operation;
      await this.browser.close();
      const revision = this.state.revision + 1;
      this.state = { ...this.initial(), revision };
      return this.getState();
    } finally {
      this.closing = false;
    }
  }

  async candidates(
    point?: Point,
  ): Promise<{ candidates: Candidate[]; source: "practice" | "astra" }> {
    this.assertAvailable();
    if (!this.state.screenshot)
      throw new AppError(
        409,
        "Start a browser session before requesting intent suggestions.",
      );
    if (this.state.proposal || this.state.status === "approval")
      throw new AppError(
        409,
        "A proposal is waiting for approval. Approve it or stop the plan before refreshing the screen.",
      );
    if (this.candidateController && !this.candidateController.signal.aborted)
      throw new AppError(
        409,
        "Intent suggestions are already being generated.",
      );
    const mode = this.state.mode;
    if (mode === "astra") {
      if (!this.state.screenConsent)
        throw new AppError(403, "Screenshot sharing is not enabled.");
      if (this.candidateCalls >= 20)
        throw new AppError(
          429,
          "This session reached its suggestion-request budget. Start a new session to continue.",
        );
      if (this.candidateAt && this.now() - this.candidateAt < 2000)
        throw new AppError(
          429,
          "Wait a moment before requesting more suggestions.",
        );
    }
    const controller = new AbortController(),
      token = this.generation;
    let revision = this.state.revision;
    this.candidateController = controller;
    const checkCurrent = () => {
      if (
        token !== this.generation ||
        revision !== this.state.revision ||
        controller.signal.aborted ||
        this.closing ||
        this.state.proposal
      ) {
        throw new AppError(
          409,
          "These suggestions were cancelled because the session changed.",
        );
      }
    };
    try {
      // Capture current pixels, not a cached image from a prior task or before Stop.
      // This is observation only: no browser input, navigation, or new session is started.
      const screen = await this.browser.snapshot();
      checkCurrent();
      this.update(screen);
      revision = this.state.revision;
      if (mode === "practice") {
        const candidates = structuredClone(PRACTICE_CANDIDATES);
        if (point && point.x < 0.22 && point.y > 0.2) {
          candidates[0].probability = 0.29;
          candidates[1].probability = 0.53;
        }
        return {
          candidates: candidates.sort((a, b) => b.probability - a.probability),
          source: "practice",
        };
      }
      this.candidateCalls++;
      this.candidateAt = this.now();
      const candidates = await this.provider.candidates(
        screen.screenshot,
        point,
        controller.signal,
      );
      checkCurrent();
      return { candidates, source: "astra" };
    } finally {
      if (this.candidateController === controller)
        this.candidateController = null;
    }
  }

  async labState() {
    return this.browser.labState();
  }
  async settle(): Promise<void> {
    await this.operation;
  }
  async close(): Promise<void> {
    await this.reset();
  }
}

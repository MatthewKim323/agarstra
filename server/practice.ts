import type { Candidate, ComputerAction } from "../shared/types";
import type { ComputerBrowser } from "./browser";
import { AppError } from "./errors";

export const PRACTICE_CANDIDATES: Candidate[] = [
  {
    id: "reply",
    label: "Draft a reply",
    description: "Confirm tomorrow at 3pm. Save a draft, never send.",
    goal: "Draft a friendly reply confirming tomorrow at 3pm. Save it as a draft; do not send.",
    probability: 0.53,
    risk: "low",
  },
  {
    id: "note",
    label: "Save a note",
    description: "Keep the meeting details in your local notes.",
    goal: "Save a note with the meeting details: Catch-up with Alex tomorrow at 3pm.",
    probability: 0.29,
    risk: "low",
  },
  {
    id: "archive",
    label: "Archive message",
    description: "Move the selected practice message out of the inbox.",
    goal: "Archive the selected practice email.",
    probability: 0.18,
    risk: "confirm",
  },
];

type Step = { summary: string; selector: string; text?: string };
export type PracticeProposal = { summary: string; actions: ComputerAction[] };

/** Intentionally deterministic practice recipes, not model-generated intelligence. */
export class PracticePlan {
  private index = 0;
  private steps: Step[] = [];
  private task: "draft" | "note" | "archive";
  private initialArchiveCount = 0;
  private initialNoteCount = 0;
  private expectedDraft = "";
  private expectedNote = "";

  constructor(goal: string) {
    if (/archive/i.test(goal)) this.task = "archive";
    else if (/note|remember/i.test(goal)) this.task = "note";
    else if (/draft|reply|respond/i.test(goal)) this.task = "draft";
    else
      throw new AppError(
        422,
        "Practice mode supports drafting a reply, saving a note, or archiving a message. Use Astra for open-ended tasks.",
      );
    const affirmativeGoal = goal
      .replace(
        /\b(?:do not|don['’]t|never)\s+(?:send|delete|purchase|pay)\b/gi,
        "",
      )
      .replace(/\bwithout\s+(?:sending|deleting|purchasing|paying)\b/gi, "");
    if (/\b(send|delete|purchase|pay)\b/i.test(affirmativeGoal)) {
      throw new AppError(
        422,
        "Practice mode never sends messages, deletes data, or makes purchases. Choose a draft, note, or archive task.",
      );
    }
  }

  async initialize(browser: ComputerBrowser, goal: string): Promise<void> {
    const state = await browser.labState();
    this.initialArchiveCount = state.archivedIds.length;
    this.initialNoteCount = state.notes.length;
    if (this.task === "note") {
      const quoted = goal.match(/["“]([^"”]{1,1500})["”]/)?.[1];
      const body =
        quoted ??
        "Catch-up with Alex tomorrow at 3pm. Meet at our usual spot or join a call.";
      this.expectedNote = body;
      if (state.view !== "notes")
        this.steps.push({
          summary: "Open the local Notes app.",
          selector: "#nav-notes",
        });
      this.steps.push({
        summary: "Name the note “Meeting with Alex”.",
        selector: "#note-title",
        text: "Meeting with Alex",
      });
      this.steps.push({
        summary: "Write the meeting details into the note.",
        selector: "#note-body",
        text: body,
      });
      this.steps.push({
        summary: "Save the note in this local practice workspace.",
        selector: "#save-note",
      });
    } else {
      if (state.view !== "mail")
        this.steps.push({
          summary: "Open the local Mail app.",
          selector: "#nav-mail",
        });
      if (this.task === "archive") {
        if (state.archivedIds.length >= 3)
          throw new AppError(
            409,
            "All practice messages are already archived. Reset to restore them.",
          );
        this.steps.push({
          summary: "Archive the selected message in this local workspace.",
          selector: "#archive-button",
        });
      } else {
        if (state.archivedIds.includes("main"))
          throw new AppError(
            409,
            "Alex’s practice message was archived. Reset the session to restore it.",
          );
        if (state.selectedId !== "main")
          this.steps.push({
            summary: "Open Alex’s message about tomorrow.",
            selector: "#message-main",
          });
        if (!state.composerOpen || state.selectedId !== "main")
          this.steps.push({
            summary: "Open a reply to Alex. Nothing is sent.",
            selector: "#reply-button",
          });
        const quoted = goal.match(/["“]([^"”]{1,1500})["”]/)?.[1];
        const body =
          quoted ??
          "Hi Alex,\n\nTomorrow at 3pm works for me. Looking forward to catching up!\n\nBest,\nMatt";
        this.expectedDraft = body;
        this.steps.push({
          summary:
            "Write a friendly reply confirming tomorrow at 3pm. Draft only.",
          selector: "#reply-body",
          text: body,
        });
        this.steps.push({
          summary:
            "Save this reply as a private draft. No message will be sent.",
          selector: "#save-draft",
        });
      }
    }
  }

  async next(browser: ComputerBrowser): Promise<PracticeProposal | null> {
    const step = this.steps[this.index++];
    if (!step) return null;
    const point = await browser.pointFor(step.selector);
    const actions: ComputerAction[] = [{ type: "click", ...point }];
    if (step.text !== undefined)
      actions.push(
        { type: "keypress", keys: ["ControlOrMeta", "A"] },
        { type: "type", text: step.text },
      );
    // Chromium runs on the host OS. Use its actual select-all modifier without platform-dependent model guessing.
    if (step.text !== undefined)
      actions[1].keys = [
        process.platform === "darwin" ? "Meta" : "Control",
        "A",
      ];
    return { summary: step.summary, actions };
  }

  async verify(browser: ComputerBrowser): Promise<string> {
    const state = await browser.labState();
    if (this.task === "draft" && state.draft === this.expectedDraft)
      return "Verified: your reply is saved as a local draft. Nothing was sent.";
    if (
      this.task === "note" &&
      state.notes.length === this.initialNoteCount + 1 &&
      state.notes.at(-1)?.body === this.expectedNote
    )
      return "Verified: the meeting note is saved in your local workspace.";
    if (
      this.task === "archive" &&
      state.archivedIds.length === this.initialArchiveCount + 1
    )
      return "Verified: the selected practice message is archived.";
    throw new AppError(
      409,
      "The expected practice result could not be verified. Review the screen before retrying.",
    );
  }
}

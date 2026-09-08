import { z } from "zod";
import type { ComputerAction } from "../shared/types";
import { AppError } from "./errors";

export const VIEWPORT = { width: 1280, height: 800 };
const x = z
  .number()
  .finite()
  .min(0)
  .max(VIEWPORT.width - 1);
const y = z
  .number()
  .finite()
  .min(0)
  .max(VIEWPORT.height - 1);
const point = z.object({ x, y }).strict();
const keys = z.array(z.string().min(1).max(24)).min(1).max(5);
export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      x,
      y,
      button: z.enum(["left", "right", "middle", "back", "forward"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("double_click"), x, y }).strict(),
  z.object({ type: z.literal("move"), x, y }).strict(),
  z
    .object({
      type: z.literal("scroll"),
      x,
      y,
      scroll_x: z.number().finite().int().min(-2000).max(2000),
      scroll_y: z.number().finite().int().min(-2000).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("keypress"), keys }).strict(),
  z
    .object({ type: z.literal("type"), text: z.string().min(1).max(6000) })
    .strict(),
  z.object({ type: z.literal("wait") }).strict(),
  z.object({ type: z.literal("screenshot") }).strict(),
  z
    .object({ type: z.literal("drag"), path: z.array(point).min(2).max(30) })
    .strict(),
]);

const keyMap: Record<string, string> = {
  CTRL: "Control",
  CONTROL: "Control",
  ALT: "Alt",
  SHIFT: "Shift",
  META: "Meta",
  CMD: "Meta",
  COMMAND: "Meta",
  ENTER: "Enter",
  RETURN: "Enter",
  TAB: "Tab",
  ESC: "Escape",
  ESCAPE: "Escape",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  SPACE: "Space",
  ARROWUP: "ArrowUp",
  UP: "ArrowUp",
  ARROWDOWN: "ArrowDown",
  DOWN: "ArrowDown",
  ARROWLEFT: "ArrowLeft",
  LEFT: "ArrowLeft",
  ARROWRIGHT: "ArrowRight",
  RIGHT: "ArrowRight",
  HOME: "Home",
  END: "End",
  PAGEUP: "PageUp",
  PAGEDOWN: "PageDown",
};

export function normalizeKeys(input: string[]): string[] {
  const normalized = input.map(
    (key) =>
      keyMap[key.toUpperCase()] ?? (/^[a-zA-Z0-9]$/.test(key) ? key : null),
  );
  if (normalized.some((key) => key === null))
    throw new AppError(422, "The model requested an unsupported keyboard key.");
  const result = normalized as string[];
  const lower = result.map((key) => key.toLowerCase());
  const modifier = lower.some((key) =>
    ["control", "meta", "alt"].includes(key),
  );
  // Only select-all and editing undo/redo are allowed with browser-level modifiers.
  // An allowlist also blocks less obvious address-bar shortcuts such as Alt+D.
  const safeEditingShortcut =
    result.length === 2 &&
    ["control", "meta"].includes(lower[0]) &&
    ["a", "z", "y"].includes(lower[1]);
  if (modifier && !safeEditingShortcut) {
    throw new AppError(
      422,
      "Browser, clipboard, file, and developer-tool shortcuts are blocked.",
    );
  }
  return result;
}

export function parseActions(raw: unknown): ComputerAction[] {
  // Native computer calls can attach a nullable modifier-key field to pointer actions.
  // Empty modifiers have no behavior; nonempty modifiers remain unsupported and are rejected.
  const normalized = Array.isArray(raw)
    ? raw.map((value) => {
        if (
          value &&
          typeof value === "object" &&
          ["click", "double_click", "move", "scroll", "drag"].includes(
            value.type,
          ) &&
          (value.keys === null ||
            (Array.isArray(value.keys) && value.keys.length === 0))
        ) {
          const { keys: _keys, ...action } = value;
          return action;
        }
        return value;
      })
    : raw;
  const parsed = z.array(actionSchema).min(1).max(12).safeParse(normalized);
  if (!parsed.success)
    throw new AppError(
      422,
      "The model returned an invalid or unsupported computer action.",
    );
  for (const action of parsed.data) {
    if (action.type === "keypress") normalizeKeys(action.keys);
    if (action.type === "click" && action.button && action.button !== "left")
      throw new AppError(
        422,
        "Only left-click actions are permitted in this browser.",
      );
  }
  return parsed.data;
}

export function describeAction(action: ComputerAction): string {
  switch (action.type) {
    case "click":
      return `Click at (${Math.round(action.x!)}, ${Math.round(action.y!)}).`;
    case "double_click":
      return `Double-click at (${Math.round(action.x!)}, ${Math.round(action.y!)}).`;
    case "move":
      return `Move the pointer to (${Math.round(action.x!)}, ${Math.round(action.y!)}).`;
    case "type":
      return `Type ${action.text!.length} characters in the focused field.`;
    case "keypress":
      return `Press ${action.keys!.join(" + ")}.`;
    case "scroll":
      return `Scroll ${action.scroll_y! >= 0 ? "down" : "up"} ${Math.abs(action.scroll_y!)} pixels.`;
    case "drag":
      return "Drag along the highlighted path.";
    case "wait":
      return "Wait briefly for the page to settle.";
    case "screenshot":
      return "Observe the current screen without changing it.";
  }
}

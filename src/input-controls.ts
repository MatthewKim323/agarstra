import type { IntentTarget } from "./core";
export type AccessibleControl =
  | HTMLButtonElement
  | HTMLInputElement
  | HTMLSelectElement;

// Keep task and safety choices ahead of secondary navigation in a scan cycle.
const scanPriority = [
  "resume",
  "approve",
  "confirm-intent",
  "intent-0",
  "intent-1",
  "intent-2",
  "start",
  "cancel",
  "back",
  "suggest",
  "pause",
  "stop",
];

/** Dialog controls are the only active controls while a modal is open. */
export function scanControls(paused = false): AccessibleControl[] {
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  const root = dialog ?? document;
  const selector = dialog
    ? 'button,input[type="checkbox"],input[type="range"],select'
    : "[data-scan-id]";
  const controls = Array.from(
    root.querySelectorAll<AccessibleControl>(selector),
  ).filter((element, index) => {
    if (!element.dataset.scanId)
      element.dataset.scanId = `dialog-control-${index}`;
    if (
      element.disabled ||
      element.closest("[inert]") ||
      !element.getClientRects().length
    )
      return false;
    if (getComputedStyle(element).visibility === "hidden") return false;
    if (
      !dialog &&
      paused &&
      !["resume", "pause", "stop"].includes(element.dataset.scanId)
    )
      return false;
    return true;
  });
  if (dialog)
    controls.sort(
      (a, b) =>
        Number(b.dataset.scanId === "dialog-emergency-stop") -
        Number(a.dataset.scanId === "dialog-emergency-stop"),
    );
  else
    controls.sort((a, b) => {
      const rank = (id: string) => {
        const index = scanPriority.indexOf(id);
        return index < 0 ? scanPriority.length : index;
      };
      return rank(a.dataset.scanId!) - rank(b.dataset.scanId!);
    });
  return controls;
}
export function activateControl(element: AccessibleControl): void {
  if (element.disabled) return;
  if (element instanceof HTMLInputElement && element.type === "range") {
    const next = Number(element.value) + (Number(element.step) || 1);
    const value = next > Number(element.max) ? element.min : String(next);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element instanceof HTMLSelectElement) {
    const next = (element.selectedIndex + 1) % element.options.length;
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(element, element.options[next].value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else element.click();
}
export function controlLabel(element: AccessibleControl): string {
  return (
    element.getAttribute("aria-label") ||
    element.closest("label")?.textContent?.trim() ||
    element.textContent?.trim() ||
    "Select"
  );
}
export function gazeTargets(controls: AccessibleControl[]): IntentTarget[] {
  const w = window.innerWidth,
    h = window.innerHeight;
  return controls.flatMap((element) => {
    const r = element.getBoundingClientRect();
    const left = Math.max(0, r.left),
      right = Math.min(w, r.right),
      top = Math.max(0, r.top),
      bottom = Math.min(h, r.bottom);
    if (right <= left || bottom <= top) return [];
    const centerX = (left + right) / 2,
      centerY = (top + bottom) / 2,
      hit = document.elementFromPoint(centerX, centerY);
    if (!hit || (hit !== element && !element.contains(hit))) return [];
    return [
      {
        id: element.dataset.scanId!,
        label: controlLabel(element),
        point: { x: centerX / w, y: centerY / h },
        rect: {
          x: left / w,
          y: top / h,
          width: (right - left) / w,
          height: (bottom - top) / h,
        },
      },
    ];
  });
}

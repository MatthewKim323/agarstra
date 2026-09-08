import type { Candidate, SessionState } from "../shared/types";
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(70000),
  });
  const result = await response.json().catch(() => ({
    error: "The local bridge returned an unreadable response.",
  }));
  if (!response.ok)
    throw new Error(result.error || `Local bridge error (${response.status}).`);
  return result as T;
}
export const api = {
  state: () => request<SessionState>("state"),
  session: (mode: "practice" | "astra", screenConsent: boolean, url?: string) =>
    request<SessionState>("session", { mode, screenConsent, url }),
  intent: (goal: string) => request<SessionState>("intent", { goal }),
  approve: (proposalId: string, revision: number) =>
    request<SessionState>("approve", { proposalId, revision }),
  stop: () => request<SessionState>("stop", {}),
  reset: () => request<SessionState>("reset", {}),
  candidates: (point?: { x: number; y: number }) =>
    request<{ candidates: Candidate[]; source: string }>("candidates", {
      point,
    }),
};

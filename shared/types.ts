export type InputMode = "pointer" | "switch" | "camera";
export type Point = { x: number; y: number };
export type Candidate = {
  id: string;
  label: string;
  description: string;
  goal: string;
  probability: number;
  risk: "low" | "confirm";
};
export type ComputerAction = {
  type:
    | "click"
    | "double_click"
    | "move"
    | "scroll"
    | "keypress"
    | "type"
    | "wait"
    | "screenshot"
    | "drag";
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  keys?: string[];
  scroll_x?: number;
  scroll_y?: number;
  path?: Point[];
};
export type Proposal = {
  id: string;
  summary: string;
  actions: ComputerAction[];
  createdAt: number;
  expiresAt: number;
  revision: number;
  safetyWarnings: string[];
};
export type RunStatus =
  | "idle"
  | "thinking"
  | "approval"
  | "executing"
  | "completed"
  | "stopped"
  | "error";
export type AuditEvent = {
  id: string;
  time: number;
  kind: "info" | "proposal" | "action" | "stop" | "error" | "result";
  message: string;
};
export type SessionState = {
  mode: "practice" | "astra";
  status: RunStatus;
  model: string;
  configured: boolean;
  screenshot: string | null;
  url: string;
  title: string;
  width: number;
  height: number;
  revision: number;
  proposal: Proposal | null;
  events: AuditEvent[];
  message: string;
  goal: string;
  steps: number;
  maxSteps: number;
  screenConsent: boolean;
};
export type CandidateResponse = {
  candidates: Candidate[];
  source: "practice" | "astra";
  /** The exact observed state that these suggestions describe. */
  state: SessionState;
};
export type Observation = {
  x: number;
  y: number;
  quality: number;
  timestamp: number;
  gesture: boolean;
  gestureStrength?: number;
  features: number[];
};
export type CalibrationSample = { features: number[]; target: Point };

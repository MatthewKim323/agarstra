import { useState } from "react";
import { Brain, Download, RotateCcw } from "lucide-react";
import type { Candidate } from "../../shared/types";
import {
  NONE_ID,
  type IntentMetricGroup,
  type IntentSnapshot,
} from "../core/intent-learning";
import type { IntentLearning } from "../use-intent-learning";
import { Dialog } from "./Dialog";
import "./IntentLearning.css";

function goalName(id: string | null | undefined, candidates: Candidate[]) {
  return id === NONE_ID
    ? "Something else or just reading"
    : (candidates.find((c) => c.id === id)?.label ?? "No clear guess");
}

export function IntentLearningStatus({
  learning,
  candidates,
  onOpen,
}: {
  learning: IntentLearning;
  candidates: Candidate[];
  onOpen: () => void;
}) {
  const guess = learning.prediction?.topId;
  return (
    <section
      className="intent-learning-status"
      aria-label="Personal intent learning"
    >
      <div>
        <Brain size={18} />
        <strong>
          {!learning.options.enabled
            ? "Intent learning paused"
            : guess
              ? `Current guess: ${goalName(guess, candidates)}`
              : "No clear guess yet."}
        </strong>
      </div>
      <p>
        {!learning.options.enabled
          ? "Your learned preferences are kept for when you resume."
          : learning.metrics.examples
            ? `${learning.metrics.examples} learned examples. Context and fresh attention guide this guess; your confirmation teaches it.`
            : "Use Nerve normally. Confirmed goals teach it automatically; no separate training session is needed."}
      </p>
      <button
        className="text-button"
        data-scan-id="intent-learning"
        onClick={onOpen}
      >
        Intent learning
      </button>
    </section>
  );
}

function MetricRow({
  label,
  value,
}: {
  label: string;
  value: IntentMetricGroup;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {value.count ? `${value.correct} / ${value.count}` : "No checks yet"}
      </td>
      <td>
        {value.count
          ? `${value.baselineCorrect} / ${value.count}`
          : "No checks yet"}
      </td>
    </tr>
  );
}

export function IntentLearningDialog({
  learning,
  candidates,
  mode,
  canTeach,
  onClose,
}: {
  learning: IntentLearning;
  candidates: Candidate[];
  mode: "practice" | "astra";
  canTeach: boolean;
  onClose: () => void;
}) {
  const [trial, setTrial] = useState<IntentSnapshot | null>(null);
  const [kind, setKind] = useState<"teach" | "check">("teach");
  const [answer, setAnswer] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [scored, setScored] = useState(false);
  const evaluated =
    learning.metrics.confirm.count + learning.metrics.check.count;
  const suggested =
    learning.metrics.confirm.suggested + learning.metrics.check.suggested;
  const suggestedCorrect =
    learning.metrics.confirm.suggestedCorrect +
    learning.metrics.check.suggestedCorrect;
  const begin = (next: "teach" | "check") => {
    setKind(next);
    setAnswer(null);
    setResult("");
    setScored(false);
    const decision = learning.createTrial();
    setTrial(decision);
    if (!decision)
      setResult(
        "Start a workspace and read its current screen before teaching.",
      );
  };
  const submit = () => {
    if (!trial || !answer || scored) return;
    if (learning.record(trial, answer, kind)) {
      setScored(true);
      setResult(
        kind === "teach"
          ? "Example saved."
          : "Check scored. The model was not trained.",
      );
    } else {
      setTrial(null);
      setResult(
        "This example expired or the screen changed. Start a new example.",
      );
    }
  };
  return (
    <Dialog title="Learn your intent" onClose={onClose} wide>
      <p className="dialog-intro">
        Help Nerve anticipate what you want. It learns from confirmed goals,
        including choosing a different goal after a wrong guess. Looking,
        cancelling, or stopping does not teach a preference.
      </p>
      <label className="toggle-row">
        <span>
          <strong>Learn from confirmed choices</strong>
          <small>
            Update guesses for you. Every computer action still needs approval.
          </small>
        </span>
        <input
          aria-label="Learn from confirmed choices"
          data-scan-id="learn-enabled"
          type="checkbox"
          checked={learning.options.enabled}
          onChange={(e) => {
            learning.setEnabled(e.target.checked);
            setTrial(null);
            setResult("");
          }}
        />
      </label>
      <label className="toggle-row">
        <span>
          <strong>Remember on this device</strong>
          <small>
            {learning.options.remember
              ? "Learned weights and counts are saved in this browser."
              : "Session only. Close or reload to forget this session’s learning."}{" "}
            Turning this off removes the saved model.
          </small>
        </span>
        <input
          aria-label="Remember on this device"
          data-scan-id="learn-remember"
          type="checkbox"
          checked={learning.options.remember}
          onChange={(e) => learning.setRemember(e.target.checked)}
        />
      </label>
      {learning.storageNotice && <p role="status">{learning.storageNotice}</p>}
      <div className="intent-learning-total">
        <span>Learned examples</span>
        <strong data-testid="intent-learned-count">
          {learning.metrics.examples}
        </strong>
        <small>
          {mode === "practice" ? "Practice" : "Astra"} learning stays separate.
        </small>
      </div>
      <section className="intent-teaching" aria-label="Intent calibration">
        <h3>Teach on this screen</h3>
        <p>
          Decide what you would want here, then label it. These exercises never
          run a task. Checks measure a fresh prediction without training on your
          answer.
        </p>
        <div className="dialog-actions">
          <button
            className="secondary"
            disabled={!canTeach || !learning.options.enabled}
            onClick={() => begin("teach")}
            data-scan-id="learn-teach"
          >
            Teach without running
          </button>
          <button
            className="secondary"
            disabled={!canTeach || !learning.options.enabled}
            onClick={() => begin("check")}
            data-scan-id="learn-check"
          >
            Check without learning
          </button>
        </div>
        {!canTeach && (
          <p>
            Start a workspace and use Read this screen to get current choices.
            Finish or cancel any pending action first.
          </p>
        )}
        {trial && (
          <div className="intent-trial">
            <p>
              <strong>What would you want to do?</strong> The prediction is
              already frozen and will be shown after your answer.
            </p>
            <div className="intent-trial-choices">
              {candidates
                .filter((c) => trial.candidateIds.includes(c.id))
                .map((candidate, index) => (
                  <button
                    key={candidate.id}
                    data-scan-id={`learn-choice-${index}`}
                    className="secondary"
                    aria-pressed={answer === candidate.id}
                    disabled={scored || !canTeach}
                    onClick={() => setAnswer(candidate.id)}
                  >
                    {candidate.label}
                  </button>
                ))}
              <button
                className="secondary"
                aria-pressed={answer === NONE_ID}
                data-scan-id="learn-none"
                disabled={scored || !canTeach}
                onClick={() => setAnswer(NONE_ID)}
              >
                None of these / just reading
              </button>
            </div>
            {!scored && (
              <button
                className="primary"
                disabled={!answer || !canTeach || !learning.options.enabled}
                onClick={submit}
                data-scan-id="learn-submit"
              >
                {kind === "teach" ? "Save example" : "Score this check"}
              </button>
            )}
            {scored && (
              <p>
                Before your answer:{" "}
                <strong>{goalName(trial.prediction.bestId, candidates)}</strong>
                . You chose <strong>{goalName(answer, candidates)}</strong>.
              </p>
            )}
          </div>
        )}
        {result && (
          <p className="intent-trial-result" role="status">
            {result}
          </p>
        )}
        {scored && (
          <button
            className="secondary"
            disabled={!canTeach || !learning.options.enabled}
            onClick={() => begin(kind)}
            data-scan-id="learn-another"
          >
            {kind === "teach" ? "Another example" : "Another check"}
          </button>
        )}
      </section>
      <section className="intent-measurements" aria-label="Intent measurements">
        <h3>Did the early guess match?</h3>
        <p>
          Each guess is recorded before your choice. Live attention is excluded
          from these scores. A match measures agreement with your answer, not
          certainty about your thoughts.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Decisions</th>
              <th scope="col">Personalized</th>
              <th scope="col">Original suggestions</th>
            </tr>
          </thead>
          <tbody>
            <MetricRow
              label="Confirmed goals"
              value={learning.metrics.confirm}
            />
            <MetricRow
              label="Teaching (before update)"
              value={learning.metrics.teach}
            />
            <MetricRow
              label="Checks (never trained)"
              value={learning.metrics.check}
            />
          </tbody>
        </table>
        <p>
          {evaluated
            ? `${suggested} of ${evaluated} early guesses on confirmed goals and checks were clear enough to suggest; ${suggestedCorrect} of those matched. Unclear guesses are withheld.`
            : "As you confirm goals and run checks, this will also measure how often a guess is clear enough to suggest."}
        </p>
        <p>
          <span data-testid="intent-check-count">
            {learning.metrics.check.count}
          </span>{" "}
          checks recorded. “Something else” answers:{" "}
          {learning.metrics.confirm.noneCount +
            learning.metrics.check.noneCount}
          . Repeated answers on the same screen are practice measurements; try
          new tasks and later sessions before judging improvement.
        </p>
      </section>
      <div className="dialog-actions">
        <button
          className="secondary"
          data-scan-id="learn-export"
          onClick={learning.exportMetrics}
        >
          <Download size={16} />
          Export intent measurements
        </button>
        <button
          className="text-button danger"
          data-scan-id="learn-forget"
          onClick={() => {
            learning.forget();
            setTrial(null);
            setScored(false);
            setResult("Learned intent forgotten.");
          }}
        >
          <RotateCcw size={16} />
          Forget learned intent
        </button>
      </div>
      <p className="intent-privacy">
        Learning runs here in your browser. Saved models contain numerical
        weights and counts, not task text, URLs, camera images, or gaze
        recordings. Weights are not anonymous data. Exports contain aggregate
        measurements only.
      </p>
    </Dialog>
  );
}

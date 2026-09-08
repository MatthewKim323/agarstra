import { useEffect, useMemo, useState } from "react";
import type {
  Candidate,
  Observation,
  Point,
  SessionState,
} from "../../shared/types";
import type { IntentLearning } from "../use-intent-learning";
import { NONE_ID } from "../core/intent-learning";
import { EyesWorkspace } from "./EyesWorkspace";
import { GazeAttentionView } from "./GazeAttentionView";

type Props = {
  observation: Observation | null;
  active: boolean;
  state: SessionState;
  candidates: Candidate[];
  currentCandidates: boolean;
  selected: Candidate | undefined;
  busy: boolean;
  paused: boolean;
  error: string;
  learning: IntentLearning;
  actionDescriptions: string[];
  onChoose: (candidate: Candidate) => void;
  onConfirm: () => void;
  onBack: () => void;
  onApprove: () => void;
  onRefresh: (point?: Point) => void;
  onNone: () => boolean;
  onStart: () => void;
  onResume: () => void;
  onStop: () => void;
  onFinish: () => void;
  onRecalibrate: () => void;
};

/** Frozen choices share the ordinary reviewed action and accepted-feedback path. */
export function EyesIntentFlow(props: Props) {
  const { state, learning } = props;
  const [browsing, setBrowsing] = useState({ key: "", index: 0 });
  const [review, setReview] = useState({ key: "", page: 0 });
  const [readingRevision, setReadingRevision] = useState<number | null>(null);
  const [controlsChecked, setControlsChecked] = useState(false);
  const [firstScreenSeen, setFirstScreenSeen] = useState(false);
  const reviewKey = state.proposal
    ? `${state.proposal.id}:${state.proposal.revision}`
    : "";
  const reviewText = [
    ...props.actionDescriptions.map((action, i) => `${i + 1}. ${action}`),
    ...(state.proposal?.safetyWarnings ?? []),
  ].join("\n\n");
  const reviewPages = reviewText.match(/[\s\S]{1,300}/gu) ?? [
    "No action details supplied.",
  ];
  const reviewPage =
    review.key === reviewKey
      ? Math.min(review.page, reviewPages.length - 1)
      : 0;
  // Rank once when the scored slate is issued. Attention never moves a target.
  const slate = useMemo(() => {
    const scores = learning.snapshot?.prediction.scores;
    const ranked: {
      candidate: Candidate | null;
      index: number;
      score: number;
    }[] = props.candidates.map((candidate, index) => ({
      candidate,
      index,
      score:
        scores?.find((item) => item.id === candidate.id)?.weight ??
        candidate.probability,
    }));
    ranked.push({
      candidate: null,
      index: ranked.length,
      score: scores?.find((item) => item.id === NONE_ID)?.weight ?? 0.15,
    });
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    return ranked.map(({ candidate }) => candidate);
  }, [props.candidates, learning.snapshot]);
  const slateKey = `${state.mode}:${state.revision}:${learning.snapshot?.id ?? "unscored"}`;
  const index = browsing.key === slateKey ? browsing.index % slate.length : 0;
  const candidate = slate[index];
  const waiting =
    props.busy || state.status === "thinking" || state.status === "executing";
  const reading =
    readingRevision === state.revision &&
    Boolean(state.screenshot) &&
    !waiting &&
    !props.paused &&
    !state.proposal &&
    !props.selected;
  useEffect(() => {
    if (controlsChecked && state.screenshot && !firstScreenSeen) {
      setFirstScreenSeen(true);
      if (!state.proposal && !props.selected && !props.paused)
        setReadingRevision(state.revision);
    }
  }, [
    controlsChecked,
    state.screenshot,
    state.revision,
    state.proposal,
    props.selected,
    props.paused,
    firstScreenSeen,
  ]);
  const readScreen = () => setReadingRevision(state.revision);
  let title = "What would you like to do?";
  let description = props.error || state.message;
  let primary = {
    label: "Start practice",
    description: "Open the practice inbox.",
    onSelect: props.onStart,
    disabled: waiting,
  };
  let secondary = {
    label: "Finish session",
    description: "Stop the task and camera.",
    onSelect: props.onFinish,
    disabled: false,
  };
  let stage = "start";

  if (props.paused) {
    stage = "paused";
    title = "Stopped";
    description =
      "No new actions will run. Your saved learning stays on this device.";
    primary = {
      label: "Resume",
      description: "Return to choosing a goal.",
      onSelect: props.onResume,
      disabled: waiting,
    };
  } else if (state.proposal) {
    stage = `approval:${state.proposal.id}:${reviewPage}`;
    title = "Review this action";
    description = state.proposal.summary;
    primary = {
      label: "Approve action",
      description: `${reviewPages.length > 1 ? `Detail ${reviewPage + 1} of ${reviewPages.length}\n\n` : ""}${reviewPages[reviewPage]}`,
      onSelect: props.onApprove,
      disabled:
        waiting ||
        reviewPage < reviewPages.length - 1 ||
        Date.now() >= state.proposal.expiresAt,
    };
    secondary =
      reviewPage < reviewPages.length - 1
        ? {
            label: "More action details",
            description:
              "Read the next part before approving. Stop remains available above.",
            onSelect: () => setReview({ key: reviewKey, page: reviewPage + 1 }),
            disabled: false,
          }
        : {
            label: "Cancel action",
            description: "Stop without approving this action.",
            onSelect: props.onStop,
            disabled: false,
          };
  } else if (waiting) {
    stage = "working";
    title = "Nerve is working";
    primary = {
      label: "Preparing your next step",
      description: "A new action will need your approval.",
      onSelect: () => {},
      disabled: true,
    };
    secondary = {
      label: "Stop task",
      description: "Cancel further steps.",
      onSelect: props.onStop,
      disabled: false,
    };
  } else if (props.selected) {
    stage = `confirm:${props.selected.id}`;
    title = "Is this what you want?";
    description = props.selected.goal;
    primary = {
      label: "Confirm intent",
      description: props.selected.label,
      onSelect: props.onConfirm,
      disabled: !props.currentCandidates,
    };
    secondary = {
      label: "Choose something else",
      description: "Return to the available goals.",
      onSelect: props.onBack,
      disabled: false,
    };
  } else if (
    state.screenshot &&
    (!props.currentCandidates || !props.candidates.length)
  ) {
    stage = "refresh";
    title = "Find your next goal";
    primary = {
      label: "Read this screen",
      description: "Look at what you want to work on.",
      onSelect: readScreen,
      disabled: false,
    };
  } else if (state.screenshot) {
    stage = `choice:${slateKey}:${index}`;
    title =
      state.status === "completed"
        ? "Task complete. What next?"
        : "What would you like to do?";
    description =
      props.error ||
      `Choice ${index + 1} of ${slate.length}. Look at the center between choices.`;
    primary = candidate
      ? {
          label: candidate.label,
          description: candidate.description,
          onSelect: () => props.onChoose(candidate),
          disabled: !props.currentCandidates,
        }
      : {
          label: "None of these",
          description:
            "Tell Nerve these goals do not fit, then look at your screen again.",
          onSelect: () => {
            if (props.onNone()) readScreen();
          },
          disabled: false,
        };
    secondary = {
      label: "Next choice",
      description: "See another available goal.",
      onSelect: () =>
        setBrowsing({ key: slateKey, index: (index + 1) % slate.length }),
      disabled: false,
    };
  }

  return (
    <>
      <EyesWorkspace
        observation={props.observation}
        active={props.active}
        suspended={reading}
        onCheckPassed={() => setControlsChecked(true)}
        stageKey={`${state.revision}:${stage}`}
        title={title}
        description={description}
        primary={primary}
        secondary={secondary}
        onStop={props.onStop}
        onExit={props.onFinish}
        onRecalibrate={props.onRecalibrate}
      >
        {state.screenshot ? (
          <img
            src={state.screenshot}
            alt="Current isolated browser screenshot in eyes-only mode"
          />
        ) : null}
        <p className="eyes-learning-note">
          {learning.options.enabled
            ? `Learning from your confirmed choices. ${learning.metrics.examples} learned.`
            : "Intent learning is off."}{" "}
          {learning.options.remember
            ? "Saved on this device."
            : "Learning lasts for this visit."}
          {learning.storageNotice && ` ${learning.storageNotice}`}
        </p>
      </EyesWorkspace>
      {reading && state.screenshot && (
        <GazeAttentionView
          observation={props.observation}
          screenshot={state.screenshot}
          screenWidth={state.width}
          screenHeight={state.height}
          active={props.active}
          onAttention={(point) => {
            setReadingRevision(null);
            props.onRefresh(point);
          }}
          onStop={() => {
            setReadingRevision(null);
            props.onStop();
          }}
          onBack={() => setReadingRevision(null)}
          onShowChoices={() => {
            setReadingRevision(null);
            props.onRefresh();
          }}
        />
      )}
    </>
  );
}

/** Explicitly opt-in, paid API test. Only synthetic data in an isolated /lab browser is used. */
import assert from "node:assert/strict";
import { NerveSession } from "../server/session";
import { AstraProvider, type ComputerProvider } from "../server/provider";
import { AppError, publicError } from "../server/errors";

if (process.env.NERVE_LIVE_TEST !== "1") {
  console.info(
    "Live test skipped. Opt in with NERVE_LIVE_TEST=1 npx tsx tests/server-live-smoke.ts. This uses paid Astra API calls and shares synthetic lab screenshots.",
  );
} else {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is required for this opt-in test.");
  const statuses: number[] = [];
  let apiRequests = 0;
  let suggestionsVerified = false;
  const actual = new AstraProvider(
    process.env.OPENAI_API_KEY,
    async (input, init) => {
      if (++apiRequests > 12)
        throw new AppError(
          408,
          "Live smoke reached its total twelve-request API budget.",
        );
      const response = await fetch(input, init);
      statuses.push(response.status);
      if (response.ok) {
        const result = (await response.clone().json()) as {
          output?: { type: string; actions?: unknown; action?: unknown }[];
        };
        console.info(
          JSON.stringify({
            stage: "provider-response",
            outputTypes: result.output?.map((item) => item.type) ?? [],
            syntheticActions: result.output
              ?.filter((item) => item.type === "computer_call")
              .map((item) => item.actions ?? item.action),
          }),
        );
      }
      return response;
    },
    // This harness shares synthetic lab content only, never local user context.
    null,
  );
  const records: {
    goal: string;
    providerCalls: number;
    approvals: number;
    actions: number;
    elapsedMs: number;
    verified: boolean;
  }[] = [];
  const goals = [
    {
      goal: "Archive the currently selected message in this practice inbox. Do not delete any message or navigate away.",
      verify: (state: Awaited<ReturnType<NerveSession["labState"]>>) =>
        state.archivedIds.includes("main"),
    },
    {
      goal: "Draft a reply to Alex confirming tomorrow at 3pm. Save it using Save draft. Do not send a message.",
      verify: (state: Awaited<ReturnType<NerveSession["labState"]>>) =>
        state.draft.length > 15 && /3\s*(?:pm|p\.m\.)/i.test(state.draft),
    },
  ];
  try {
    for (const test of goals) {
      let calls = 0;
      const provider: ComputerProvider = {
        model: actual.model,
        configured: actual.configured,
        next: async (input, signal) => {
          if (++calls > 6)
            throw new AppError(
              408,
              "Live smoke reached its six-response budget for this goal.",
            );
          return actual.next(input, signal);
        },
        candidates: (...args) => actual.candidates(...args),
      };
      const session = new NerveSession({ provider });
      const began = Date.now();
      let approvals = 0;
      try {
        const started = await session.start({
          mode: "astra",
          screenConsent: true,
        });
        assert.equal(started.status, "idle", started.message);
        assert.equal(started.url, "http://127.0.0.1:4318/lab");
        if (!suggestionsVerified) {
          const suggestions = await session.candidates({ x: 0.73, y: 0.65 });
          assert.equal(suggestions.source, "astra");
          assert.equal(suggestions.candidates.length, 3);
          assert.ok(
            suggestions.candidates.every(
              (candidate) => candidate.goal.length > 0,
            ),
          );
          assert.equal(
            session.getState().steps,
            0,
            "Requesting suggestions must never execute an action.",
          );
          suggestionsVerified = true;
          console.info(
            JSON.stringify({
              stage: "synthetic-suggestions-verified",
              labels: suggestions.candidates.map(
                (candidate) => candidate.label,
              ),
              actionsExecuted: 0,
            }),
          );
        }
        session.intent(test.goal);
        while (approvals < 12) {
          await session.settle();
          const state = session.getState();
          assert.equal(
            state.url,
            "http://127.0.0.1:4318/lab",
            "Smoke tests may not approve any external browser.",
          );
          if (state.status === "completed") break;
          assert.equal(state.status, "approval", state.message);
          assert.ok(state.proposal);
          approvals++;
          console.info(
            JSON.stringify({
              stage: "synthetic-only-approval",
              goal: records.length + 1,
              batch: approvals,
              actions: state.proposal.actions.map((action) => action.type),
            }),
          );
          session.approve(state.proposal.id, state.proposal.revision);
        }
        await session.settle();
        const final = session.getState();
        assert.equal(final.status, "completed", final.message);
        const verified = test.verify(await session.labState());
        assert.ok(
          verified,
          `The real browser did not contain the expected saved result. Final report: ${final.message}`,
        );
        records.push({
          goal: test.goal,
          providerCalls: calls,
          approvals,
          actions: final.steps,
          elapsedMs: Date.now() - began,
          verified,
        });
      } finally {
        await session.close();
      }
    }
    console.info(
      JSON.stringify(
        {
          success: true,
          model: actual.model,
          httpStatuses: statuses,
          suggestionsVerified,
          results: records,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,
          model: actual.model,
          httpStatuses: statuses,
          results: records,
          error:
            error instanceof assert.AssertionError
              ? error.message
              : publicError(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

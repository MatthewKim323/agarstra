import { describe, expect, it, vi } from "vitest";
import { AstraProvider } from "../server/provider";

const response = (output: unknown[]) =>
  new Response(JSON.stringify({ status: "completed", output }), {
    headers: { "Content-Type": "application/json" },
  });
describe("Astra Responses adapter", () => {
  it("uses native computer actions, original images, store:false and encrypted reasoning", async () => {
    const transport = vi.fn().mockResolvedValue(
      response([
        { type: "reasoning", encrypted_content: "opaque" },
        {
          type: "computer_call",
          call_id: "call_1",
          actions: [{ type: "click", x: 12, y: 34 }],
        },
      ]),
    );
    const provider = new AstraProvider("test-key-only", transport);
    const result = await provider.next(
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
    );
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(request.body);
    expect(body.model).toBe("gpt-6-astra");
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([{ type: "computer" }]);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(result.actions).toEqual([{ type: "click", x: 12, y: 34 }]);
    expect(result.callId).toBe("call_1");
  });
  it("supports a legacy singular action but never executable code", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            type: "computer_call",
            call_id: "call_1",
            action: { type: "screenshot" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        response([
          {
            type: "computer_call",
            call_id: "call_2",
            actions: [{ type: "exec", code: "bad" }],
          },
        ]),
      );
    const provider = new AstraProvider("test-key-only", transport);
    expect(
      (await provider.next([], new AbortController().signal)).actions,
    ).toEqual([{ type: "screenshot" }]);
    await expect(
      provider.next([], new AbortController().signal),
    ).rejects.toThrow("invalid or unsupported");
  });
  it("never exposes provider response bodies or keys in errors", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response("private data test-key-only", { status: 401 }),
      );
    const provider = new AstraProvider("test-key-only", transport);
    await expect(
      provider.next([], new AbortController().signal),
    ).rejects.toThrow("does not currently have access");
  });
  it("rejects incomplete results even if they contain plausible actions", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "incomplete", output: [] })),
      );
    await expect(
      new AstraProvider("test", transport).next(
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not finish");
  });
  it("rejects multiple computer calls rather than silently ignoring actions", async () => {
    const call = {
      type: "computer_call",
      call_id: "c",
      actions: [{ type: "screenshot" }],
    };
    const provider = new AstraProvider(
      "test",
      vi.fn().mockResolvedValue(response([call, call])),
    );
    await expect(
      provider.next([], new AbortController().signal),
    ).rejects.toThrow("parallel");
  });
  it("normalizes heuristic candidate rankings and never sends webcam data", async () => {
    const candidates = ["a", "b", "c"].map((id) => ({
      id,
      label: id,
      description: "test",
      goal: "test",
      probability: 0.2,
      risk: "low",
    }));
    const transport = vi
      .fn()
      .mockResolvedValue(
        response([
          {
            type: "message",
            content: [
              { type: "output_text", text: JSON.stringify({ candidates }) },
            ],
          },
        ]),
      );
    const provider = new AstraProvider("test", transport);
    const result = await provider.candidates(
      "data:image/png;base64,screen",
      { x: 0.3, y: 0.4 },
      new AbortController().signal,
    );
    expect(result.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(
      1,
    );
    const body = JSON.parse(transport.mock.calls[0][1].body);
    expect(body.input[0].content[1].detail).toBe("original");
    expect(body.tools).toBeUndefined();
  });
});

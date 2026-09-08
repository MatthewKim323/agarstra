import express, { type ErrorRequestHandler } from "express";
import { resolve } from "node:path";
import { z } from "zod";
import { AppError, publicError } from "./errors";
import { localhostGuard } from "./security";
import { registerLab } from "./lab";
import { NerveSession } from "./session";

const sessionSchema = z
  .object({
    mode: z.enum(["practice", "astra"]),
    screenConsent: z.boolean(),
    url: z.string().max(2000).optional(),
  })
  .strict();
const intentSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
const approvalSchema = z
  .object({
    proposalId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const candidateSchema = z
  .object({
    point: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export function createApp(
  options: {
    session?: NerveSession;
    allowedPorts?: number[];
    production?: boolean;
    distPath?: string;
  } = {},
) {
  const app = express();
  const session = options.session ?? new NerveSession();
  app.disable("x-powered-by");
  app.use(localhostGuard(options.allowedPorts));
  app.use(express.json({ limit: "24kb", strict: true }));
  registerLab(app);
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      model: session.getState().model,
      configured: session.getState().configured,
      isolation: "single-user localhost",
      screenSharing: "explicit-consent",
      webcamUpload: false,
    }),
  );
  app.get("/api/state", (_req, res) => res.json(session.getState()));
  app.get("/api/lab-state", async (_req, res) =>
    res.json(await session.labState()),
  );
  app.post("/api/session", async (req, res) =>
    res.json(await session.start(sessionSchema.parse(req.body))),
  );
  app.post("/api/intent", (req, res) => {
    const data = intentSchema.parse(req.body);
    res.json(session.intent(data.goal, data.expectedRevision));
  });
  app.post("/api/approve", (req, res) => {
    const data = approvalSchema.parse(req.body);
    res.json(session.approve(data.proposalId, data.revision));
  });
  app.post("/api/stop", (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(session.stop());
  });
  app.post("/api/reset", async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await session.reset());
  });
  app.post("/api/candidates", async (req, res) =>
    res.json(await session.candidates(candidateSchema.parse(req.body).point)),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Unknown local API route." }),
  );
  if (options.production ?? process.env.NODE_ENV === "production") {
    const dist = options.distPath ?? resolve(process.cwd(), "dist");
    app.use(
      express.static(dist, {
        index: "index.html",
        etag: false,
        cacheControl: false,
      }),
    );
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      res.status(400).json({
        error:
          "Invalid request. Check the required fields and their allowed values.",
      });
      return;
    }
    const status =
      error instanceof AppError
        ? error.statusCode
        : error?.type === "entity.too.large"
          ? 413
          : 500;
    res.status(status).json({
      error: status === 413 ? "Request is too large." : publicError(error),
    });
  };
  app.use(errors);
  return { app, session };
}

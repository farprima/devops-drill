import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { Cache } from "./cache.js";
import { log } from "./log.js";
import type { Store } from "./store.js";

export const LEADERBOARD_KEY = "leaderboard";
export const LEADERBOARD_TTL_SECONDS = 30;
const LEADERBOARD_SIZE = 10;
const HEALTH_TIMEOUT_MS = 1000;

const submissionSchema = z.object({
  student: z.string().trim().min(1).max(80),
  score: z.number().int().min(0).max(100),
});

export interface AppDeps {
  store: Store;
  cache: Cache;
}

async function check(probe: () => Promise<void>): Promise<"ok" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ store, cache }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", async (_req, res) => {
    const [db, redis] = await Promise.all([check(() => store.ping()), check(() => cache.ping())]);
    // Redis is only a cache, so the API is still usable without it; Postgres is not optional.
    res.status(db === "ok" ? 200 : 503).json({ status: db === "ok" ? "ok" : "error", db, redis });
  });

  app.post("/api/submissions", async (req, res) => {
    const input = submissionSchema.parse(req.body);
    const row = await store.addSubmission(input);
    await cache.del(LEADERBOARD_KEY).catch((err: unknown) => {
      log.error("cache invalidation failed", { err: String(err) });
    });
    res.status(201).json(row);
  });

  app.get("/api/leaderboard", async (_req, res) => {
    const cached = await cache.get(LEADERBOARD_KEY).catch(() => null);
    if (cached !== null) {
      res.set("X-Cache", "HIT").type("json").send(cached);
      return;
    }
    const body = JSON.stringify(await store.topScores(LEADERBOARD_SIZE));
    await cache.set(LEADERBOARD_KEY, body, LEADERBOARD_TTL_SECONDS).catch(() => {});
    res.set("X-Cache", "MISS").type("json").send(body);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      res.status(400).json({ error: "validation_failed", issues });
      return;
    }
    // body-parser errors (bad JSON, body too large) carry a 4xx status and a safe message.
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error("unhandled error", { err: String(err?.stack ?? err) });
    res.status(status).json({ error: status === 500 ? "internal_error" : err.message });
  };
  app.use(errorHandler);

  return app;
}

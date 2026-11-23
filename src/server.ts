import http from "node:http";
import pg from "pg";
import { createClient } from "redis";
import { z } from "zod";
import { createApp } from "./app.js";
import { createRedisCache } from "./cache.js";
import { log } from "./log.js";
import { migrate } from "./migrate.js";
import { createPgStore } from "./store.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
  })
  .safeParse(process.env);
if (!env.success) {
  log.error("invalid environment", { issues: z.flattenError(env.error).fieldErrors });
  process.exit(1);
}
const { PORT, HOST, DATABASE_URL, REDIS_URL } = env.data;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 2000 });
pool.on("error", (err) => log.error("postgres pool error", { err: err.message }));

// Fail fast while Redis is unreachable instead of queueing commands forever.
const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true });
redis.on("error", (err: Error) => log.error("redis error", { err: err.message }));

const app = createApp({ store: createPgStore(pool), cache: createRedisCache(redis) });

const server = http.createServer((req, res) => {
  const start = performance.now();
  res.on("finish", () => {
    log.info("request", {
      method: req.method,
      path: new URL(req.url ?? "/", "http://localhost").pathname,
      status: res.statusCode,
      ms: Math.round((performance.now() - start) * 10) / 10,
    });
  });
  app(req, res);
});

async function closeClients(): Promise<void> {
  // close() lets queued commands finish; destroy() is for a client still stuck reconnecting.
  const closeRedis = redis.isReady ? redis.close() : redis.isOpen ? Promise.resolve(redis.destroy()) : undefined;
  await Promise.allSettled([pool.end(), closeRedis]);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  setTimeout(() => {
    log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting connections and let in-flight requests finish before closing the clients they use.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeClients();
  log.info("bye");
  process.exit(0);
}
process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

// Redis is only a cache: start without it and let the client keep reconnecting in the background.
redis.connect().catch((err: unknown) => log.error("redis connect failed", { err: String(err) }));

try {
  await migrate(pool);
  server.listen(PORT, HOST, () => log.info("listening", { host: HOST, port: PORT }));
} catch (err) {
  log.error("startup failed", { err: String(err) });
  await closeClients();
  process.exit(1);
}

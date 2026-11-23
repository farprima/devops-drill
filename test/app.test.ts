import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, LEADERBOARD_KEY, LEADERBOARD_TTL_SECONDS } from "../src/app.js";
import { FakeCache, FakeStore } from "./fakes.js";

let store: FakeStore;
let cache: FakeCache;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new FakeStore();
  cache = new FakeCache();
  app = createApp({ store, cache });
});

const submit = (body: unknown) => request(app).post("/api/submissions").send(body as object);

describe("GET /health", () => {
  it("is ok when postgres and redis answer", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok", redis: "ok" });
  });

  it("returns 503 when postgres is down", async () => {
    store.down = true;
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error", db: "down", redis: "ok" });
  });

  it("stays 200 when only redis is down", async () => {
    cache.down = true;
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok", redis: "down" });
  });
});

describe("POST /api/submissions", () => {
  it("stores a valid submission and returns 201 with the row", async () => {
    const res = await submit({ student: "Budi", score: 87 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, student: "Budi", score: 87 });
    expect(typeof res.body.createdAt).toBe("string");
    expect(store.rows).toHaveLength(1);
  });

  it.each([
    ["missing student", { score: 50 }],
    ["empty student", { student: "   ", score: 50 }],
    ["student too long", { student: "x".repeat(81), score: 50 }],
    ["score above 100", { student: "Ani", score: 101 }],
    ["negative score", { student: "Ani", score: -1 }],
    ["fractional score", { student: "Ani", score: 7.5 }],
    ["score as string", { student: "Ani", score: "90" }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await submit(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(store.rows).toHaveLength(0);
  });

  it("still accepts submissions when redis is down", async () => {
    cache.down = true;
    const res = await submit({ student: "Budi", score: 60 });
    expect(res.status).toBe(201);
  });

  it("rejects malformed JSON with a JSON 400", async () => {
    const res = await request(app)
      .post("/api/submissions")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.type).toBe("application/json");
  });
});

describe("GET /api/leaderboard", () => {
  it("is a MISS first, then a HIT served from redis", async () => {
    await submit({ student: "Ani", score: 70 });
    await submit({ student: "Budi", score: 95 });

    const first = await request(app).get("/api/leaderboard");
    expect(first.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.body.map((row: { student: string }) => row.student)).toEqual(["Budi", "Ani"]);
    expect(cache.entries.get(LEADERBOARD_KEY)?.ttlSeconds).toBe(LEADERBOARD_TTL_SECONDS);

    const second = await request(app).get("/api/leaderboard");
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.body).toEqual(first.body);
    expect(store.topScoresCalls).toBe(1);
  });

  it("returns only the top 10 by score", async () => {
    for (let score = 0; score <= 100; score += 5) await submit({ student: `s${score}`, score });
    const res = await request(app).get("/api/leaderboard");
    expect(res.body).toHaveLength(10);
    expect(res.body[0].score).toBe(100);
    expect(res.body[9].score).toBe(55);
  });

  it("is invalidated by a new submission", async () => {
    await submit({ student: "Ani", score: 70 });
    await request(app).get("/api/leaderboard");
    expect((await request(app).get("/api/leaderboard")).headers["x-cache"]).toBe("HIT");

    await submit({ student: "Citra", score: 99 });
    const res = await request(app).get("/api/leaderboard");
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.body[0].student).toBe("Citra");
  });

  it("still answers from postgres when redis is down", async () => {
    await submit({ student: "Ani", score: 70 });
    cache.down = true;
    const res = await request(app).get("/api/leaderboard");
    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.body).toHaveLength(1);
  });
});

it("answers unknown routes with a JSON 404", async () => {
  const res = await request(app).get("/nope");
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: "not_found" });
});

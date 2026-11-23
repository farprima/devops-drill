import type { Cache } from "../src/cache.js";
import type { NewSubmission, Store, Submission } from "../src/store.js";

const unavailable = (what: string) => new Error(`${what} unavailable`);

export class FakeStore implements Store {
  down = false;
  rows: Submission[] = [];
  topScoresCalls = 0;

  async ping() {
    if (this.down) throw unavailable("postgres");
  }

  async addSubmission(input: NewSubmission) {
    if (this.down) throw unavailable("postgres");
    const row = { id: this.rows.length + 1, ...input, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }

  async topScores(limit: number) {
    if (this.down) throw unavailable("postgres");
    this.topScoresCalls += 1;
    return [...this.rows].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit);
  }
}

export class FakeCache implements Cache {
  down = false;
  entries = new Map<string, { value: string; ttlSeconds: number }>();

  async ping() {
    if (this.down) throw unavailable("redis");
  }

  async get(key: string) {
    if (this.down) throw unavailable("redis");
    return this.entries.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (this.down) throw unavailable("redis");
    this.entries.set(key, { value, ttlSeconds });
  }

  async del(key: string) {
    if (this.down) throw unavailable("redis");
    this.entries.delete(key);
  }
}

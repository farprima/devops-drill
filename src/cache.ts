import type { createClient } from "redis";

export interface Cache {
  ping(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export type RedisClient = ReturnType<typeof createClient>;

export function createRedisCache(client: RedisClient): Cache {
  return {
    async ping() {
      await client.ping();
    },
    async get(key) {
      return client.get(key);
    },
    async set(key, value, ttlSeconds) {
      await client.set(key, value, { expiration: { type: "EX", value: ttlSeconds } });
    },
    async del(key) {
      await client.del(key);
    },
  };
}

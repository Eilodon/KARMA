import { Redis } from "ioredis";
import { ENV } from "../config/env.js";

let commandClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!ENV.REDIS_URL) {
    throw new Error("REDIS_URL is required for Redis-backed components");
  }
  if (!commandClient) {
    commandClient = new Redis(ENV.REDIS_URL);
  }
  return commandClient;
}

export async function closeRedisClient(): Promise<void> {
  if (!commandClient) return;
  const client = commandClient;
  commandClient = null;
  await client.quit();
}

import { Redis } from "ioredis";
import { config } from "../config";

let client: Redis | null = null;

/** One shared connection, created on first use. */
export function getRedis(): Redis {
  client ??= new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  client.on("error", () => undefined); // surfaced per command; avoids unhandled 'error' events
  return client;
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.quit().catch(() => c.disconnect());
}

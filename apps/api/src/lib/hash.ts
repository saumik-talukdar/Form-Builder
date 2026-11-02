import { createHmac } from "node:crypto";
import { config } from "../config";

/** Keyed hash so IPs / tokens can be compared and counted but not recovered. */
export function hmac(value: string): string {
  return createHmac("sha256", config.IP_HASH_SECRET)
    .update(value)
    .digest("hex")
    .slice(0, 32);
}

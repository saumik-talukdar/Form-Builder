import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().default(4000),

  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017/form-builder"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  
  IP_HASH_SECRET: z
    .string()
    .min(16, "IP_HASH_SECRET must be at least 16 characters"),

  
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).default(900),

  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),

  REFRESH_REUSE_GRACE_MS: z.coerce.number().int().min(0).default(10_000),

  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /**
   * Per-IP rate limits. Raise them if many respondents share one address (a campus or office
   * behind NAT), otherwise they would be throttled as if they were a single client.
   */
  READ_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
  SUBMIT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_PER_15MIN: z.coerce.number().int().min(1).default(30),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === "production";

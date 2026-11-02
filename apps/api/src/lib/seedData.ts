import { fieldSchema, type Field } from "@fb/shared";
import type { Types } from "mongoose";

/**
 * Deterministic demo data for load-testing and `explain()` work.
 * Same seed, same output. Everything here is pure (no database), so it is unit-tested.
 */

// ---- Random numbers -------------------------------------------------------

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** Integer in [lo, hi] */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** Standard normal */
  normal(): number;
}

/** mulberry32: tiny, fast, good enough for fake traffic. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const weighted = <T>(entries: readonly (readonly [T, number])[]): T => {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r < 0) return value;
    }
    return entries[entries.length - 1]![0];
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted,
    normal: () =>
      Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  };
}

const mix = (x: number) => {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
};

/** A stable 32-character hex id for (salt, n), shaped like the real HMAC hashes. */
export function hex32(n: number, salt: number): string {
  return [0, 1, 2, 3]
    .map((k) =>
      mix(n * 2654435761 + salt * 40503 + k * 97)
        .toString(16)
        .padStart(8, "0"),
    )
    .join("");
}

export const DEMO_SLUG = "seed-demo";
export const DEMO_EMAIL = "demo@tallymark.dev";

// ---- The demo form --------------------------------------------------------

const opt = (id: string, label: string) => ({ id, label });

/** Covers every answer shape the analytics code handles, plus one conditional question. */
export const DEMO_FIELDS: Field[] = [
  {
    id: "src",
    type: "select",
    label: "How did you hear about us?",
    required: true,
    options: [
      opt("friend", "A friend"),
      opt("social", "Social media"),
      opt("search", "Search"),
      opt("other", "Something else"),
    ],
  },
  {
    id: "which",
    type: "short_text",
    label: "Which one?",
    required: true,
    showIf: { fieldId: "src", op: "eq", value: "other" },
  },
  {
    id: "rate",
    type: "rating",
    label: "How was the event overall?",
    required: true,
    max: 5,
  },
  {
    id: "sessions",
    type: "multi_select",
    label: "Which sessions did you attend?",
    required: false,
    options: [
      opt("a", "Opening talk"),
      opt("b", "Workshop"),
      opt("c", "Panel"),
      opt("d", "Closing party"),
    ],
  },
  {
    id: "group",
    type: "number",
    label: "How many people were in your group?",
    required: false,
    integer: true,
    min: 1,
    max: 20,
  },
  {
    id: "day",
    type: "date",
    label: "Which day did you come?",
    required: false,
  },
  {
    id: "more",
    type: "long_text",
    label: "Anything else you'd like us to know?",
    required: false,
  },
].map((f) => fieldSchema.parse(f));

const OTHER_SOURCES = [
  "A poster at the library",
  "My professor",
  "Newsletter",
  "Coding club",
  "Hackathon",
  "Saw it on a bus",
  "Family",
  "Job fair",
  "Podcast",
  "Group chat",
];
const COMMENTS = [
  "Loved the workshop, would come again.",
  "Needed more seating near the stage.",
  "Great speakers. The schedule ran about twenty minutes late.",
  "Please share the slides afterwards.",
  "Food was good. More vegetarian options would help.",
  "The venue was hard to find.",
  "Wish it had been longer.",
  "Brilliant, thank you!",
];

// ---- Traffic shape --------------------------------------------------------

const DAY_MS = 86_400_000;
const WEEKDAY = [1.0, 1.1, 1.1, 1.05, 0.9, 0.5, 0.7]; // Sun..Sat: quieter on the Bangladeshi weekend
/** Relative traffic by hour of day (UTC): peaks around 10:00-12:00 and 20:00-23:00 Dhaka time. */
const HOUR_WEIGHTS = Array.from({ length: 24 }, (_, utc) => {
  const dhaka = (utc + 6) % 24;
  if (dhaka >= 9 && dhaka <= 12) return 5;
  if (dhaka >= 19 && dhaka <= 23) return 6;
  if (dhaka >= 13 && dhaka <= 18) return 3;
  if (dhaka >= 6 && dhaka <= 8) return 1.5;
  return 0.4;
});

export interface SeedOptions {
  /** Number of responses the caller intends to generate (sizes the pools of repeat visitors). */
  count: number;
  /** How many days back from `end` traffic is spread over. */
  days: number;
  /** End of the window; nothing is generated after it. */
  end: Date;
  seed: number;
  formId: Types.ObjectId;
  version: number;
}

export interface SeedResponse {
  formId: Types.ObjectId;
  version: number;
  answers: Record<string, string | number | string[]>;
  submittedAt: Date;
  meta: {
    ipHash: string;
    tokenHash: string;
    userAgent: string;
    browser: string;
    os: string;
    device: "desktop" | "mobile" | "tablet";
    language?: string;
    referrer?: string;
    country?: string;
    durationMs?: number;
  };
}

export interface SeedView {
  formId: Types.ObjectId;
  ipHash: string;
  createdAt: Date;
}

const BROWSERS: Record<
  SeedResponse["meta"]["device"],
  {
    browser: readonly (readonly [string, number])[];
    os: readonly (readonly [string, number])[];
  }
> = {
  mobile: {
    browser: [
      ["Chrome", 0.55],
      ["Mobile Safari", 0.25],
      ["Samsung Internet", 0.12],
      ["Firefox", 0.04],
      ["Opera", 0.04],
    ],
    os: [
      ["Android", 0.68],
      ["iOS", 0.32],
    ],
  },
  desktop: {
    browser: [
      ["Chrome", 0.64],
      ["Edge", 0.14],
      ["Firefox", 0.1],
      ["Safari", 0.1],
      ["Opera", 0.02],
    ],
    os: [
      ["Windows", 0.72],
      ["macOS", 0.15],
      ["Linux", 0.07],
      ["Chrome OS", 0.06],
    ],
  },
  tablet: {
    browser: [
      ["Mobile Safari", 0.6],
      ["Chrome", 0.4],
    ],
    os: [
      ["iOS", 0.6],
      ["Android", 0.4],
    ],
  },
};

const COUNTRIES: readonly (readonly [string | undefined, number])[] = [
  ["BD", 0.72],
  ["IN", 0.1],
  ["US", 0.05],
  ["GB", 0.03],
  ["SA", 0.03],
  ["AE", 0.02],
  ["MY", 0.02],
  [undefined, 0.03],
];
const LANGUAGES: Record<string, readonly (readonly [string, number])[]> = {
  BD: [
    ["bn-BD", 0.5],
    ["en-US", 0.4],
    ["en-GB", 0.1],
  ],
  IN: [
    ["en-IN", 0.6],
    ["hi-IN", 0.3],
    ["bn-IN", 0.1],
  ],
  US: [["en-US", 1]],
  GB: [["en-GB", 1]],
  SA: [
    ["ar-SA", 0.7],
    ["en-US", 0.3],
  ],
  AE: [
    ["ar-AE", 0.5],
    ["en-US", 0.5],
  ],
  MY: [
    ["ms-MY", 0.6],
    ["en-US", 0.4],
  ],
};
const REFERRERS: readonly (readonly [string | undefined, number])[] = [
  [undefined, 0.46],
  ["https://www.facebook.com", 0.2],
  ["https://www.google.com", 0.1],
  ["https://t.co", 0.1],
  ["https://www.linkedin.com", 0.08],
  ["https://github.com", 0.03],
  ["https://www.reddit.com", 0.03],
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Drops undefined keys: the MongoDB driver would otherwise store them as null. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

export interface SeedGenerator {
  nextResponse(): SeedResponse;
  nextView(): SeedView;
}

/** Call nextResponse()/nextView() in order; the sequence is fully determined by the seed. */
export function createSeedGenerator(opts: SeedOptions): SeedGenerator {
  const rngR = makeRng(opts.seed);
  const rngV = makeRng((opts.seed ^ 0x9e3779b9) >>> 0);
  const rngShape = makeRng((opts.seed ^ 0x85ebca6b) >>> 0);

  // One weight per day: weekday pattern, a slow upward trend, and a few campaign spikes.
  const spikes = new Set(
    Array.from({ length: Math.max(1, Math.round(opts.days / 25)) }, () =>
      rngShape.int(Math.floor(opts.days / 4), opts.days - 1),
    ),
  );
  const startMs = opts.end.getTime() - opts.days * DAY_MS;
  const dayWeights = Array.from({ length: opts.days }, (_, d) => {
    const date = new Date(startMs + d * DAY_MS);
    const trend = 0.6 + 0.8 * (d / Math.max(1, opts.days - 1));
    return WEEKDAY[date.getUTCDay()]! * trend * (spikes.has(d) ? 4 : 1);
  });
  const cumulative: number[] = [];
  dayWeights.reduce((sum, w, i) => (cumulative[i] = sum + w), 0);
  const totalWeight = cumulative[cumulative.length - 1]!;
  const hourCumulative: number[] = [];
  HOUR_WEIGHTS.reduce((sum, w, i) => (hourCumulative[i] = sum + w), 0);
  const hourTotal = hourCumulative[23]!;

  function sampleTime(rng: Rng): Date {
    const r = rng.next() * totalWeight;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    const hr = rng.next() * hourTotal;
    const hour = hourCumulative.findIndex((c) => c > hr);
    const t =
      startMs +
      lo * DAY_MS +
      (hour < 0 ? 12 : hour) * 3_600_000 +
      Math.floor(rng.next() * 3_600_000);
    return new Date(Math.min(t, opts.end.getTime() - 1));
  }

  // Visitors share addresses (campus NAT): a skewed pool, so a few hashes appear many times.
  const ipPool = Math.max(10, Math.round(opts.count * 0.7));
  const tokenPool = Math.max(10, Math.round(opts.count * 0.95));
  const ipIndex = (rng: Rng) => Math.floor(ipPool * Math.pow(rng.next(), 1.6));

  function answers(rng: Rng): SeedResponse["answers"] {
    const out: SeedResponse["answers"] = {};
    const src = rng.weighted([
      ["friend", 0.42],
      ["social", 0.31],
      ["search", 0.15],
      ["other", 0.12],
    ] as const);
    out.src = src;
    if (src === "other") out.which = rng.pick(OTHER_SOURCES);
    out.rate = rng.weighted([
      [1, 0.02],
      [2, 0.04],
      [3, 0.14],
      [4, 0.34],
      [5, 0.46],
    ] as const);
    if (rng.chance(0.85)) {
      const ids = ["a", "b", "c", "d"];
      const chosen = ids.filter((id) =>
        rng.chance(id === "a" ? 0.8 : id === "d" ? 0.55 : 0.4),
      );
      if (chosen.length > 0) out.sessions = chosen;
    }
    if (rng.chance(0.8))
      out.group = rng.chance(0.03)
        ? rng.int(10, 20)
        : 1 + Math.floor(Math.pow(rng.next(), 2) * 8);
    if (rng.chance(0.65))
      out.day = ymd(
        new Date(
          opts.end.getTime() - Math.floor(rng.next() * opts.days) * DAY_MS,
        ),
      );
    if (rng.chance(0.22)) out.more = rng.pick(COMMENTS);
    return out;
  }

  return {
    nextResponse(): SeedResponse {
      const rng = rngR;
      const submittedAt = sampleTime(rng);
      const device = rng.weighted([
        ["mobile", 0.62],
        ["desktop", 0.33],
        ["tablet", 0.05],
      ] as const);
      const browser = rng.weighted(BROWSERS[device].browser);
      const os = rng.weighted(BROWSERS[device].os);
      const country = rng.weighted(COUNTRIES);
      const language = country
        ? rng.weighted(LANGUAGES[country]!)
        : rng.chance(0.7)
          ? "en-US"
          : undefined;
      const duration = rng.chance(0.05)
        ? undefined
        : Math.round(
            Math.min(
              1_200_000,
              Math.max(6000, Math.exp(Math.log(75_000) + 0.6 * rng.normal())),
            ),
          );

      return {
        formId: opts.formId,
        version: opts.version,
        answers: answers(rng),
        submittedAt,
        meta: compact({
          ipHash: hex32(ipIndex(rng), 1),
          tokenHash: hex32(Math.floor(rng.next() * tokenPool), 2),
          userAgent: `Mozilla/5.0 (${os}; ${device}) ${browser}/${rng.int(120, 127)}.0`,
          browser,
          os,
          device,
          language,
          referrer: rng.weighted(REFERRERS),
          country,
          durationMs: duration,
        }),
      };
    },

    nextView(): SeedView {
      return {
        formId: opts.formId,
        ipHash: hex32(
          Math.floor(opts.count * 1.5 * Math.pow(rngV.next(), 1.4)),
          1,
        ),
        createdAt: sampleTime(rngV),
      };
    },
  };
}

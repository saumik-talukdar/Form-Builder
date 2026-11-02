/** Rate limiting, with deliberately low limits. See flows.test.ts for how to run. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startApp, type RunningApp } from "./helpers";

describe.skipIf(!process.env.TEST_MONGODB_URI)(
  "rate limits (real database)",
  () => {
    let app: RunningApp;

    beforeAll(async () => {
      app = await startApp({
        READ_RATE_LIMIT_PER_MIN: "1000",
        SUBMIT_RATE_LIMIT_PER_MIN: "5",
        AUTH_RATE_LIMIT_PER_15MIN: "4",
      });
    }, 60_000);

    afterAll(async () => {
      await app?.stop();
    }, 30_000);

    it("throttles a client that floods the submit endpoint, and tells it so", async () => {
      const owner = new Client(app.base);
      expect(
        (
          await owner.post("/api/auth/register", {
            email: "owner@example.com",
            password: "a long password",
          })
        ).status,
      ).toBe(201);
      const form = await owner.post("/api/forms", {
        title: "Flood target",
        fields: [{ id: "q", type: "short_text", label: "Q" }],
      });
      expect(
        (await owner.post(`/api/forms/${form.body.id}/publish`)).status,
      ).toBe(201);

      const statuses: number[] = [];
      let last;
      for (let i = 0; i < 8; i++) {
        last = await new Client(app.base).post(
          `/api/public/forms/${form.body.slug}/responses`,
          { answers: { q: "hi" }, version: 1 },
        );
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
      expect(last?.body.error).toMatch(/slow down/i);
      expect(last?.headers.get("ratelimit")).toBeTruthy(); // standard header so clients can back off
    }, 30_000);

    it("throttles repeated login attempts", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (
            await new Client(app.base).post("/api/auth/login", {
              email: "owner@example.com",
              password: "wrong password!",
            })
          ).status,
        );
      }
      // The register call in the first test already used one of the 4 allowed attempts.
      expect(statuses).toEqual([401, 401, 401, 429]);
    }, 30_000);
  },
);

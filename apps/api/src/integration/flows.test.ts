/**
 * End-to-end API flows against a real database.
 *
 *   TEST_MONGODB_URI=mongodb://127.0.0.1:27019 npm run test:integration -w @fb/api
 *
 * Skipped when TEST_MONGODB_URI is unset, so `npm test` stays database-free.
 * Each run uses its own throwaway database and drops it afterwards.
 * Set TEST_STANDIN=1 when running against a MongoDB-compatible stand-in such as FerretDB 1.x.
 * That skips the tests that need real MongoDB behaviour: $facet analytics, and atomic
 * conditional updates under concurrency (FerretDB 1.x grants every concurrent request).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startApp, type Json, type RunningApp } from "./helpers";
import { User } from "../models/user";
import { Form } from "../models/form";
import { FormVersion } from "../models/formVersion";
import { ResponseModel } from "../models/response";
import { FormView } from "../models/formView";

const URI = process.env.TEST_MONGODB_URI;
const STANDIN = process.env.TEST_STANDIN === "1";

const opt = (id: string, label: string) => ({ id, label });
const surveyFields = () => [
  {
    id: "src",
    type: "select",
    label: "How did you hear about us?",
    required: true,
    options: [opt("friend", "A friend"), opt("other", "Something else")],
  },
  {
    id: "which",
    type: "short_text",
    label: "Which one?",
    required: true,
    showIf: { fieldId: "src", op: "eq", value: "other" },
  },
  { id: "rate", type: "rating", label: "Rate us", required: true, max: 5 },
  {
    id: "group",
    type: "number",
    label: "Group size",
    integer: true,
    min: 1,
    max: 20,
  },
];

describe.skipIf(!URI)("API flows (real database)", () => {
  let app: RunningApp;
  let base: string;

  const A = () => new Client(base); // owner A
  let a: Client;
  let b: Client; // owner B
  let formId = "";
  let slug = "";

  /** Creates a published form owned by `owner` and returns its ids. */
  async function publishedForm(owner: Client, extra: Json = {}) {
    const created = await owner.post("/api/forms", {
      title: "Fresh form",
      fields: surveyFields(),
      ...extra,
    });
    expect(created.status).toBe(201);
    const pub = await owner.post(`/api/forms/${created.body.id}/publish`);
    expect(pub.status).toBe(201);
    return { id: created.body.id as string, slug: created.body.slug as string };
  }

  const answer = (over: Json = {}) => ({
    src: "friend",
    rate: 5,
    group: 3,
    ...over,
  });

  beforeAll(async () => {
    app = await startApp({
      READ_RATE_LIMIT_PER_MIN: "100000",
      SUBMIT_RATE_LIMIT_PER_MIN: "100000",
      AUTH_RATE_LIMIT_PER_15MIN: "100000",
    });
    base = app.base;
    a = A();
    b = A();
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
  }, 30_000);

  // ---- Accounts ----------------------------------------------------------

  it("registers owners, rejects duplicates and weak passwords, and hides which emails exist", async () => {
    const reg = await a.post("/api/auth/register", {
      email: "Ada@Example.com",
      password: "correct horse battery",
    });
    expect(reg.status).toBe(201);
    expect(reg.body.email).toBe("ada@example.com"); // normalised
    expect(reg.headers.getSetCookie().join(";")).toMatch(
      /fb_token=.*HttpOnly/i,
    );
    expect(reg.text).not.toMatch(/passwordHash|correct horse/);

    expect(
      (
        await A().post("/api/auth/register", {
          email: "ada@example.com",
          password: "another password",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await A().post("/api/auth/register", {
          email: "x@example.com",
          password: "short",
        })
      ).status,
    ).toBe(400);

    const wrongPw = await A().post("/api/auth/login", {
      email: "ada@example.com",
      password: "not the password",
    });
    const noUser = await A().post("/api/auth/login", {
      email: "nobody@example.com",
      password: "not the password",
    });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error).toBe(noUser.body.error);

    expect(
      (
        await b.post("/api/auth/register", {
          email: "bob@example.com",
          password: "bobs long password",
        })
      ).status,
    ).toBe(201);
    expect((await a.get("/api/auth/me")).body.email).toBe("ada@example.com");
  }, 30_000);

  it("logs in with the right password and logs out", async () => {
    const c = A();
    expect(
      (
        await c.post("/api/auth/login", {
          email: "ada@example.com",
          password: "correct horse battery",
        })
      ).status,
    ).toBe(200);
    expect((await c.get("/api/auth/me")).status).toBe(200);
    expect((await c.post("/api/auth/logout")).status).toBe(204);
    expect((await c.get("/api/auth/me")).status).toBe(401);
  }, 30_000);

  it("requires a session for owner routes", async () => {
    expect((await A().get("/api/forms")).status).toBe(401);
  });

  // ---- Forms, ownership, versions ---------------------------------------

  it("creates a form and validates its definition", async () => {
    const created = await a.post("/api/forms", {
      title: "Spring meetup",
      fields: surveyFields(),
    });
    expect(created.status).toBe(201);
    formId = created.body.id;
    slug = created.body.slug;
    expect(slug).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(created.body.status).toBe("draft");

    const dupIds = await a.post("/api/forms", {
      title: "x",
      fields: [surveyFields()[0], surveyFields()[0]],
    });
    expect(dupIds.status).toBe(400);
    const forwardRef = await a.post("/api/forms", {
      title: "x",
      fields: [
        {
          id: "a",
          type: "short_text",
          label: "A",
          showIf: { fieldId: "b", op: "answered" },
        },
        { id: "b", type: "short_text", label: "B" },
      ],
    });
    expect(forwardRef.status).toBe(400);
  });

  it("keeps other owners out: every route answers 404, not 403", async () => {
    expect((await b.get(`/api/forms/${formId}`)).status).toBe(404);
    expect(
      (await b.patch(`/api/forms/${formId}`, { title: "hijack" })).status,
    ).toBe(404);
    expect((await b.post(`/api/forms/${formId}/publish`)).status).toBe(404);
    expect((await b.get(`/api/forms/${formId}/responses`)).status).toBe(404);
    expect((await b.get(`/api/forms/${formId}/export.csv`)).status).toBe(404);
    expect((await b.del(`/api/forms/${formId}`)).status).toBe(404);
    expect((await b.get("/api/forms")).body).toEqual([]);
    expect((await a.get("/api/forms/not-an-id")).status).toBe(404);
  });

  it("keeps drafts private, then publishes immutable versions", async () => {
    expect((await A().get(`/api/public/forms/${slug}`)).status).toBe(404); // draft

    const empty = await a.post("/api/forms", { title: "Empty" });
    expect((await a.post(`/api/forms/${empty.body.id}/publish`)).status).toBe(
      400,
    );

    const v1 = await a.post(`/api/forms/${formId}/publish`);
    expect(v1.status).toBe(201);
    expect(v1.body.publishedVersion).toBe(1);
    expect(v1.body.status).toBe("published");

    const again = await a.post(`/api/forms/${formId}/publish`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/No changes/);

    // Edit the draft: the live form must not change until it is published.
    expect(
      (
        await a.patch(`/api/forms/${formId}`, {
          title: "Spring meetup (edited)",
        })
      ).status,
    ).toBe(200);
    expect((await A().get(`/api/public/forms/${slug}`)).body.title).toBe(
      "Spring meetup",
    );

    const v2 = await a.post(`/api/forms/${formId}/publish`);
    expect(v2.status).toBe(201);
    expect(v2.body.publishedVersion).toBe(2);
    expect((await A().get(`/api/public/forms/${slug}`)).body.title).toBe(
      "Spring meetup (edited)",
    );

    const versions = await a.get(`/api/forms/${formId}/versions`);
    expect(versions.body.map((v: Json) => v.version)).toEqual([2, 1]);
    expect((await a.get(`/api/forms/${formId}/versions/1`)).body.title).toBe(
      "Spring meetup",
    );
    expect(await FormVersion.countDocuments({ formId })).toBe(2);
  }, 30_000);

  // ---- Anonymous submission ---------------------------------------------

  it("serves the published form to anyone and sets an anonymous respondent cookie", async () => {
    const r = A();
    const res = await r.get(`/api/public/forms/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.fields).toHaveLength(4);
    expect(res.text).not.toMatch(/ownerId|draftFields/);
    expect(res.headers.getSetCookie().join(";")).toMatch(/fb_rt=.*HttpOnly/i);
    expect((await A().get("/api/public/forms/doesnotexist")).status).toBe(404);
    await new Promise((r2) => setTimeout(r2, 100)); // the view is recorded fire-and-forget
    expect(await FormView.countDocuments({ formId })).toBeGreaterThanOrEqual(1);
  });

  it("accepts a valid anonymous response and stores analytics without the raw IP", async () => {
    const r = A();
    await r.get(`/api/public/forms/${slug}`);
    const res = await r.post(`/api/public/forms/${slug}/responses`, {
      answers: answer(),
      version: 2,
      startedAt: Date.now() - 4000,
      referrer: "https://example.com/post?x=1",
    });
    expect(res.status).toBe(201);

    const stored = await ResponseModel.findOne({ formId }).lean();
    expect(stored?.version).toBe(2);
    expect(stored?.answers).toEqual({ src: "friend", rate: 5, group: 3 });
    expect(stored?.meta.ipHash).toMatch(/^[a-f0-9]{32}$/);
    expect(stored?.meta.tokenHash).toMatch(/^[a-f0-9]{32}$/);
    expect(stored?.meta.referrer).toBe("https://example.com");
    expect(stored?.meta.durationMs).toBeGreaterThanOrEqual(3500);
    expect(JSON.stringify(stored)).not.toContain("127.0.0.1");
    expect((await Form.findById(formId).lean())?.responseCount).toBe(1);
  });

  it("rejects bad answers with per-field errors and stores nothing", async () => {
    const before = await ResponseModel.countDocuments({ formId });
    const missing = await A().post(`/api/public/forms/${slug}/responses`, {
      answers: { src: "other" },
      version: 2,
    });
    expect(missing.status).toBe(422);
    expect(missing.body.details.map((d: Json) => d.fieldId).sort()).toEqual([
      "rate",
      "which",
    ]); // "which" became required

    const unknown = await A().post(`/api/public/forms/${slug}/responses`, {
      answers: answer({ hacker: "x" }),
      version: 2,
    });
    expect(unknown.status).toBe(422);
    const outOfRange = await A().post(`/api/public/forms/${slug}/responses`, {
      answers: answer({ group: 999 }),
      version: 2,
    });
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.details[0].message).toMatch(/20/);

    expect(
      (
        await A().post(`/api/public/forms/${slug}/responses`, {
          answers: "nope",
        })
      ).status,
    ).toBe(400);
    expect(await ResponseModel.countDocuments({ formId })).toBe(before);
  });

  it("tells a respondent on an old version to reload, and drops hidden answers", async () => {
    const stale = await A().post(`/api/public/forms/${slug}/responses`, {
      answers: answer(),
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.currentVersion).toBe(2);

    // "which" is hidden when src = friend, so a sneaked-in answer is discarded.
    const res = await A().post(`/api/public/forms/${slug}/responses`, {
      answers: answer({ which: "sneaky" }),
      version: 2,
    });
    expect(res.status).toBe(201);
    const newest = await ResponseModel.findOne({ formId })
      .sort({ _id: -1 })
      .lean();
    expect(newest?.answers).not.toHaveProperty("which");
  });

  it("pretends to accept bots that fill the honeypot, but stores nothing", async () => {
    const before = await ResponseModel.countDocuments({ formId });
    const res = await A().post(`/api/public/forms/${slug}/responses`, {
      answers: answer(),
      version: 2,
      website: "http://spam.example",
    });
    expect(res.status).toBe(201);
    expect(await ResponseModel.countDocuments({ formId })).toBe(before);
  });

  // ---- Owner views --------------------------------------------------------

  it("lists responses newest first with a cursor, and never leaks hashes or addresses", async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await A().post(`/api/public/forms/${slug}/responses`, {
            answers: answer({ rate: 1 + i }),
            version: 2,
          })
        ).status,
      ).toBe(201);
    }
    const total = await ResponseModel.countDocuments({ formId });
    const first = await a.get(`/api/forms/${formId}/responses?limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    expect(first.text).not.toMatch(/ipHash|tokenHash|127\.0\.0\.1|userAgent/);

    const seen = new Set<string>(first.body.items.map((i: Json) => i.id));
    let cursor: string | null = first.body.nextCursor;
    while (cursor) {
      const page = await a.get(
        `/api/forms/${formId}/responses?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      for (const item of page.body.items) {
        expect(seen.has(item.id)).toBe(false); // no duplicates across pages
        seen.add(item.id);
      }
      cursor = page.body.nextCursor;
    }
    expect(seen.size).toBe(total);
    expect(
      (await a.get(`/api/forms/${formId}/responses?cursor=garbage`)).status,
    ).toBe(400);
  });

  it.skipIf(STANDIN)(
    "computes analytics (needs $facet) that agree with the stored data",
    async () => {
      const total = await ResponseModel.countDocuments({ formId });
      const res = await a.get(`/api/forms/${formId}/analytics?timezone=UTC`);
      expect(res.status).toBe(200);
      expect(res.body.summary.totalResponses).toBe(total);
      expect(
        res.body.overTime.reduce((s: number, d: Json) => s + d.count, 0),
      ).toBe(total);
      const src = res.body.questions.items.find(
        (q: Json) => q.fieldId === "src",
      );
      expect(src.options.reduce((s: number, o: Json) => s + o.count, 0)).toBe(
        total,
      );
      expect(res.body.funnel.views).toBeGreaterThanOrEqual(1);
      expect(
        (await a.get(`/api/forms/${formId}/analytics?timezone=Not/AZone`))
          .status,
      ).toBe(400);
    },
  );

  it("exports CSV with option labels and safe cells", async () => {
    await A().post(`/api/public/forms/${slug}/responses`, {
      answers: answer({ src: "other", which: '=HYPERLINK("http://evil")' }),
      version: 2,
    });
    const res = await a.get(`/api/forms/${formId}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.text.startsWith("﻿response_id,submitted_at,version,")).toBe(
      true,
    );
    const lines = res.text.trim().split("\r\n");
    expect(lines.length).toBe(
      1 + (await ResponseModel.countDocuments({ formId, version: 2 })),
    );
    expect(res.text).toContain("A friend"); // label, not the id "friend"
    expect(res.text).toContain("'=HYPERLINK"); // formula neutralised
  });

  // ---- Limits and lifecycle ----------------------------------------------

  it("blocks repeat responses when the owner turns multiple responses off", async () => {
    const f = await publishedForm(a, { settings: { allowMultiple: false } });
    const r = A();
    await r.get(`/api/public/forms/${f.slug}`);
    expect(
      (
        await r.post(`/api/public/forms/${f.slug}/responses`, {
          answers: answer(),
          version: 1,
        })
      ).status,
    ).toBe(201);
    const second = await r.post(`/api/public/forms/${f.slug}/responses`, {
      answers: answer(),
      version: 1,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already responded/);
    expect(await ResponseModel.countDocuments({ formId: f.id })).toBe(1);
  });

  it.skipIf(STANDIN)(
    "never exceeds maxResponses, even with simultaneous submissions (needs atomic updates)",
    async () => {
      const f = await publishedForm(a, { settings: { maxResponses: 3 } });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          A().post(`/api/public/forms/${f.slug}/responses`, {
            answers: answer(),
            version: 1,
          }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 410)).toHaveLength(5);
      expect(await ResponseModel.countDocuments({ formId: f.id })).toBe(3);
      expect((await Form.findById(f.id).lean())?.responseCount).toBe(3);
    },
  );

  it("stops accepting responses when closed or past its close date, and reopens on publish", async () => {
    const f = await publishedForm(a);
    expect((await a.post(`/api/forms/${f.id}/close`)).body.status).toBe(
      "closed",
    );
    expect((await A().get(`/api/public/forms/${f.slug}`)).status).toBe(410);
    expect(
      (
        await A().post(`/api/public/forms/${f.slug}/responses`, {
          answers: answer(),
          version: 1,
        })
      ).status,
    ).toBe(410);

    const reopened = await a.post(`/api/forms/${f.id}/publish`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe("published");
    expect((await A().get(`/api/public/forms/${f.slug}`)).status).toBe(200);

    expect(
      (
        await a.patch(`/api/forms/${f.id}`, {
          settings: { closesAt: new Date(Date.now() - 60_000).toISOString() },
        })
      ).status,
    ).toBe(200);
    expect((await A().get(`/api/public/forms/${f.slug}`)).status).toBe(410);
  });

  it("deletes a form together with its versions, responses and views", async () => {
    const f = await publishedForm(a);
    await A().get(`/api/public/forms/${f.slug}`);
    await A().post(`/api/public/forms/${f.slug}/responses`, {
      answers: answer(),
      version: 1,
    });
    expect((await a.del(`/api/forms/${f.id}`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(await Form.countDocuments({ _id: f.id })).toBe(0);
    expect(await FormVersion.countDocuments({ formId: f.id })).toBe(0);
    expect(await ResponseModel.countDocuments({ formId: f.id })).toBe(0);
    expect(await FormView.countDocuments({ formId: f.id })).toBe(0);
    expect((await A().get(`/api/public/forms/${f.slug}`)).status).toBe(404);
  });
});

/**
 * Sessions and account management. Needs MongoDB and Redis:
 *   TEST_MONGODB_URI=mongodb://127.0.0.1:27017 TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:integration -w @fb/api
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { Client, startApp, type RunningApp } from "./helpers";
import { User } from "../models/user";
import { Form } from "../models/form";
import { ResponseModel } from "../models/response";

const ready = !!process.env.TEST_MONGODB_URI && !!process.env.TEST_REDIS_URL;
const PW = "a long password";

describe.skipIf(!ready)("sessions and accounts (real MongoDB + Redis)", () => {
  let app: RunningApp;
  let n = 0;
  const signUp = async (client = new Client(app.base)) => {
    const email = `user${++n}@example.com`;
    const r = await client.post("/api/auth/register", { email, password: PW });
    expect(r.status).toBe(201);
    return { client, email };
  };

  beforeAll(async () => {
    app = await startApp({
      AUTH_RATE_LIMIT_PER_15MIN: "1000",
      READ_RATE_LIMIT_PER_MIN: "1000",
      REFRESH_REUSE_GRACE_MS: "300",
      SUBMIT_RATE_LIMIT_PER_MIN: "1000",
    });
  }, 60_000);
  afterAll(async () => {
    await app?.stop();
  }, 30_000);

  it("issues a short-lived access token that carries the session id", async () => {
    const { client } = await signUp();
    expect((await client.get("/api/auth/me")).status).toBe(200);
    const sessions = (await client.get("/api/auth/sessions")).body;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
  });

  it("refreshes: rotates the refresh token and keeps working", async () => {
    const { client } = await signUp();
    for (let i = 0; i < 3; i++) {
      expect((await client.post("/api/auth/refresh")).status).toBe(204);
      expect((await client.get("/api/auth/me")).status).toBe(200);
    }
    expect((await client.get("/api/auth/sessions")).body).toHaveLength(1); // same session throughout
  });

  it("refuses to refresh without a session", async () => {
    expect((await new Client(app.base).post("/api/auth/refresh")).status).toBe(
      401,
    );
  });

  it("treats a quick replay as a race, but a late replay as theft and ends the whole session", async () => {
    const { client } = await signUp();
    const stolen = client.cookie("fb_refresh")!;
    expect((await client.post("/api/auth/refresh")).status).toBe(204); // victim rotates

    const thief = new Client(app.base);
    thief.setCookie("fb_refresh", stolen);
    expect((await thief.post("/api/auth/refresh")).status).toBe(409); // inside the grace window

    await new Promise((r) => setTimeout(r, 400));
    expect((await thief.post("/api/auth/refresh")).status).toBe(401); // replayed later: theft
    expect((await client.post("/api/auth/refresh")).status).toBe(401); // the victim's session is revoked too
  });

  it("an access token alone cannot be refreshed, and a garbage refresh token is rejected", async () => {
    const { client } = await signUp();
    const bad = new Client(app.base);
    bad.setCookie("fb_refresh", "garbage");
    const r = await bad.post("/api/auth/refresh");
    expect(r.status).toBe(401);
    expect((await client.get("/api/auth/me")).status).toBe(200);
  });

  it("logout ends the session on the server, not just in the browser", async () => {
    const { client } = await signUp();
    const refresh = client.cookie("fb_refresh")!;
    expect((await client.post("/api/auth/logout")).status).toBe(204);
    const replay = new Client(app.base);
    replay.setCookie("fb_refresh", refresh);
    expect((await replay.post("/api/auth/refresh")).status).toBe(401);
  });

  it("lists devices, and a user can end one of their own sessions but not someone else's", async () => {
    const { client, email } = await signUp();
    const phone = new Client(app.base);
    expect(
      (await phone.post("/api/auth/login", { email, password: PW })).status,
    ).toBe(200);

    const list = (await client.get("/api/auth/sessions")).body;
    expect(list).toHaveLength(2);
    const other = list.find((s: { current: boolean }) => !s.current);

    const stranger = (await signUp()).client;
    expect((await stranger.del(`/api/auth/sessions/${other.id}`)).status).toBe(
      404,
    );

    expect((await client.del(`/api/auth/sessions/${other.id}`)).status).toBe(
      204,
    );
    expect((await phone.post("/api/auth/refresh")).status).toBe(401);
    expect((await client.get("/api/auth/sessions")).body).toHaveLength(1);
    expect((await client.del("/api/auth/sessions/not-an-id")).status).toBe(404);
  });

  it("changing the password signs out every other device but not this one", async () => {
    const { client, email } = await signUp();
    const other = new Client(app.base);
    await other.post("/api/auth/login", { email, password: PW });

    expect(
      (
        await client.post("/api/auth/password", {
          currentPassword: "wrong password",
          newPassword: "another long one",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.post("/api/auth/password", {
          currentPassword: PW,
          newPassword: PW,
        })
      ).status,
    ).toBe(400);
    const ok = await client.post("/api/auth/password", {
      currentPassword: PW,
      newPassword: "another long one",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.signedOutElsewhere).toBe(1);

    expect((await other.post("/api/auth/refresh")).status).toBe(401);
    expect((await client.post("/api/auth/refresh")).status).toBe(204);
    expect(
      (
        await new Client(app.base).post("/api/auth/login", {
          email,
          password: PW,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await new Client(app.base).post("/api/auth/login", {
          email,
          password: "another long one",
        })
      ).status,
    ).toBe(200);
  });

  it("changes the email only with the right password, and not to one already taken", async () => {
    const { client, email } = await signUp();
    const { email: taken } = await signUp();
    expect(
      (
        await client.patch("/api/auth/me", {
          email: "new@example.com",
          currentPassword: "nope nope nope",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.patch("/api/auth/me", {
          email: taken,
          currentPassword: PW,
        })
      ).status,
    ).toBe(409);
    const r = await client.patch("/api/auth/me", {
      email: "  New@Example.com ",
      currentPassword: PW,
    });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe("new@example.com");
    expect(
      (
        await new Client(app.base).post("/api/auth/login", {
          email,
          password: PW,
        })
      ).status,
    ).toBe(401);
  });

  it("lists, revokes all others, and keeps the current one", async () => {
    const { client, email } = await signUp();
    const d1 = new Client(app.base);
    const d2 = new Client(app.base);
    await d1.post("/api/auth/login", { email, password: PW });
    await d2.post("/api/auth/login", { email, password: PW });
    expect(
      (await client.post("/api/auth/sessions/revoke-others")).body.revoked,
    ).toBe(2);
    expect((await d1.post("/api/auth/refresh")).status).toBe(401);
    expect((await client.get("/api/auth/sessions")).body).toHaveLength(1);
  });

  it("deletes the account with everything it owns, after confirming the password", async () => {
    const { client, email } = await signUp();
    const form = await client.post("/api/forms", {
      title: "Mine",
      fields: [{ id: "q", type: "short_text", label: "Q" }],
    });
    await client.post(`/api/forms/${form.body.id}/publish`);
    await new Client(app.base).post(
      `/api/public/forms/${form.body.slug}/responses`,
      { answers: { q: "hi" }, version: 1 },
    );
    const bystander = await signUp();
    const theirForm = await bystander.client.post("/api/forms", {
      title: "Theirs",
      fields: [],
    });

    expect((await client.del("/api/auth/me")).status).toBe(400); // no password sent
    const wrong = await client.req("DELETE", "/api/auth/me", {
      password: "wrong password",
    });
    expect(wrong.status).toBe(400);
    expect(await User.countDocuments({ email })).toBe(1);

    const gone = await client.req("DELETE", "/api/auth/me", { password: PW });
    expect(gone.status).toBe(204);
    expect(await User.countDocuments({ email })).toBe(0);
    expect(await Form.countDocuments({ _id: form.body.id })).toBe(0);
    expect(await ResponseModel.countDocuments({ formId: form.body.id })).toBe(
      0,
    );
    expect(await Form.countDocuments({ _id: theirForm.body.id })).toBe(1); // others untouched
    expect((await client.post("/api/auth/refresh")).status).toBe(401);
  });

  it("access tokens expire on their own", async () => {
    const { client } = await signUp();
    const expired = jwt.sign({ sid: "x" }, process.env.JWT_SECRET!, {
      subject: "000000000000000000000000",
      expiresIn: -10,
    });
    const c = new Client(app.base);
    c.setCookie("fb_token", expired);
    expect((await c.get("/api/auth/me")).status).toBe(401);
    expect((await client.get("/api/auth/me")).status).toBe(200);
  });
});

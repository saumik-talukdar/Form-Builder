import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import { attachRealtime, closeRealtime, emitNewResponse } from "./realtime";

const SECRET = "test-secret-1234567890";
const OWNED = "a".repeat(24);
const OTHERS = "b".repeat(24);

let http: HttpServer;
let url: string;

const cookieFor = (userId: string, secret = SECRET) =>
  `fb_token=${jwt.sign({}, secret, { subject: userId, expiresIn: 60 })}`;

function client(cookie?: string): Socket {
  return connect(url, {
    extraHeaders: cookie ? { cookie } : {},
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
}

const opened = (s: Socket) =>
  new Promise<void>((resolve, reject) => {
    s.on("connect", resolve);
    s.on("connect_error", reject);
  });

const subscribe = (s: Socket, formId: unknown) =>
  new Promise<{ ok: boolean; error?: string }>((resolve) =>
    s.emit("subscribe", formId, resolve),
  );

beforeAll(async () => {
  http = createServer();
  attachRealtime(http, {
    origins: ["http://localhost"],
    jwtSecret: SECRET,
    cookieName: "fb_token",
    // user "owner" owns OWNED only
    canSubscribe: async (userId, formId) =>
      userId === "owner" && formId === OWNED,
  });
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeRealtime();
  http.close();
});

describe("realtime", () => {
  it("rejects sockets without a valid session cookie", async () => {
    await expect(opened(client())).rejects.toThrow("unauthorized");
    await expect(
      opened(client(cookieFor("owner", "wrong-secret-0000000000"))),
    ).rejects.toThrow("unauthorized");
  });

  it("lets an owner subscribe and receive new-response events", async () => {
    const s = client(cookieFor("owner"));
    await opened(s);
    expect(await subscribe(s, OWNED)).toEqual({ ok: true });

    const received = new Promise<unknown>((r) => s.once("response:new", r));
    emitNewResponse(OWNED, {
      id: "r1",
      count: 7,
      submittedAt: "2026-10-27T00:00:00.000Z",
      device: "mobile",
      country: "BD",
    });
    expect(await received).toMatchObject({
      id: "r1",
      count: 7,
      device: "mobile",
    });
    s.close();
  });

  it("refuses forms the user doesn't own and malformed ids", async () => {
    const s = client(cookieFor("owner"));
    await opened(s);
    expect(await subscribe(s, OTHERS)).toEqual({
      ok: false,
      error: "not found",
    });
    expect(await subscribe(s, "not-an-id")).toMatchObject({ ok: false });
    expect(await subscribe(s, { $gt: "" })).toMatchObject({ ok: false });
    s.close();
  });

  it("does not leak events to sockets that didn't subscribe", async () => {
    const watcher = client(cookieFor("owner"));
    const bystander = client(cookieFor("someone-else"));
    await Promise.all([opened(watcher), opened(bystander)]);
    expect(await subscribe(watcher, OWNED)).toEqual({ ok: true });
    expect(await subscribe(bystander, OWNED)).toMatchObject({ ok: false });

    let leaked = false;
    bystander.on("response:new", () => (leaked = true));
    const got = new Promise((r) => watcher.once("response:new", r));
    emitNewResponse(OWNED, {
      id: "r2",
      count: 1,
      submittedAt: "x",
      device: "desktop",
      country: null,
    });
    await got;
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
    watcher.close();
    bystander.close();
  });
});

import mongoose from "mongoose";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { User } from "../models/user";
import { Form } from "../models/form";
import { FormVersion } from "../models/formVersion";
import { ResponseModel } from "../models/response";
import { FormView } from "../models/formView";

export type Json = any;

export interface Reply {
  status: number;
  body: Json;
  text: string;
  headers: Headers;
}

/** A browser-like client: keeps cookies between calls. */
export class Client {
  private jar = new Map<string, string>();
  constructor(private base: string) {}

  async req(method: string, path: string, body?: unknown): Promise<Reply> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /expires=thu, 01 jan 1970/i.test(line))
        this.jar.delete(name);
      else this.jar.set(name, value);
    }
    // res.text() silently drops a leading BOM; decode ourselves so tests can see it.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      new Uint8Array(await res.arrayBuffer()),
    );
    let parsed: Json = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON (csv) */
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }
  cookie = (name: string) => this.jar.get(name);
  setCookie = (name: string, value: string) => void this.jar.set(name, value);
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  del = (p: string, b?: unknown) => this.req("DELETE", p, b);
}

export interface RunningApp {
  base: string;
  stop: () => Promise<void>;
}

/**
 * Starts the real app against a throwaway database. `env` is applied before the app
 * is imported, because configuration (including rate limits) is read at import time.
 */
export async function startApp(
  env: Record<string, string> = {},
): Promise<RunningApp> {
  Object.assign(process.env, env);
  if (process.env.TEST_REDIS_URL)
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
  const dbName = `fb_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await mongoose.connect(process.env.TEST_MONGODB_URI!, { dbName });

  await Promise.all(
    [User, Form, FormVersion, ResponseModel, FormView].map((m) =>
      m.init().catch((err: Error) => {
        // Stand-in servers such as FerretDB 1.x can't build TTL indexes. Real MongoDB can, so anything else is a failure.
        if (!/expireAfterSeconds.*not implemented/i.test(err.message))
          throw err;
      }),
    ),
  );

  const { createApp } = await import("../app");
  const { closeRedis } = await import("../lib/redis");
  const server: Server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    async stop() {
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await mongoose.disconnect();
      await closeRedis();
      server.closeAllConnections(); // fetch keeps connections alive; without this close() waits on them
      await new Promise((r) => server.close(r));
    },
  };
}

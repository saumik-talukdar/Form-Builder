import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

/**
 * Live updates for form owners.
 *
 * - Sockets authenticate with the same httpOnly JWT cookie as the REST API.
 * - An owner can only join the room of a form they own (checked per subscribe).
 * - Respondents never connect; the server pushes `response:new` when one is stored.
 *
 * The session token is checked when the socket connects; a socket that stays
 * open past token expiry keeps working until it reconnects.
 */

export interface RealtimeDeps {
  origins: string[];
  jwtSecret: string;
  cookieName: string;
  canSubscribe: (userId: string, formId: string) => Promise<boolean>;
}

export interface NewResponseEvent {
  id: string;
  count: number;
  submittedAt: string;
  device: string;
  country: string | null;
}

type Ack = (result: { ok: boolean; error?: string }) => void;

const MAX_ROOMS_PER_SOCKET = 50;
const room = (formId: string) => `form:${formId}`;

let io: Server | null = null;

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function attachRealtime(
  httpServer: HttpServer,
  deps: RealtimeDeps,
): Server {
  const server = new Server(httpServer, {
    cors: { origin: deps.origins, credentials: true },
    serveClient: false,
  });

  server.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, deps.cookieName);
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = jwt.verify(token, deps.jwtSecret);
      if (typeof payload === "string" || !payload.sub)
        throw new Error("bad token");
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  server.on("connection", (socket) => {
    socket.on("subscribe", async (formId: unknown, ack?: Ack) => {
      const reply: Ack = typeof ack === "function" ? ack : () => undefined;
      if (typeof formId !== "string" || !/^[a-f0-9]{24}$/i.test(formId)) {
        return reply({ ok: false, error: "invalid form id" });
      }
      if (socket.rooms.size > MAX_ROOMS_PER_SOCKET)
        return reply({ ok: false, error: "too many subscriptions" });

      let allowed = false;
      try {
        allowed = await deps.canSubscribe(socket.data.userId as string, formId);
      } catch (err) {
        console.error("subscribe check failed", err);
        return reply({ ok: false, error: "server error" });
      }
      if (!allowed) return reply({ ok: false, error: "not found" });

      await socket.join(room(formId));
      reply({ ok: true });
    });

    socket.on("unsubscribe", (formId: unknown) => {
      if (typeof formId === "string") void socket.leave(room(formId));
    });
  });

  io = server;
  return server;
}

/** No-op when realtime isn't attached (tests, scripts). */
export function emitNewResponse(formId: string, event: NewResponseEvent): void {
  io?.to(room(formId)).emit("response:new", event);
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  const current = io;
  io = null;
  await current.close();
}

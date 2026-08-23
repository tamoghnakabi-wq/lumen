import type { Server as HttpServer } from "node:http";
import { Server as IOServer, type Socket } from "socket.io";
import { all, get, run } from "./db.ts";
import { SESSION_COOKIE, userForToken } from "./lib/auth.ts";
import { setEmitter, setCallBreaker } from "./lib/bus.ts";
import { endCallBetween, endCallsForSocket, registerCallHandlers, type EndReason } from "./lib/calls.ts";
import { log } from "./lib/log.ts";
import { broadcastMessage } from "./routes/messages.ts";

const room = (userId: string) => `user:${userId}`;

/** Sockets one account may hold open at once (tabs, phone + laptop, reconnect churn). */
const MAX_SOCKETS_PER_USER = 12;
/** Events a socket may send per window before it is ignored. */
const EVENT_LIMIT = 40;
const EVENT_WINDOW_MS = 10_000;
/**
 * Call signalling gets its own, much larger budget. Trickle ICE emits a burst
 * of small candidate messages while a call connects, which would otherwise eat
 * the ordinary event allowance in a couple of seconds.
 */
const SIGNAL_LIMIT = 400;
/** How often to confirm each socket's session still exists. */
const SESSION_RECHECK_MS = 60_000;

function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** userId -> number of open sockets */
const online = new Map<string, number>();

/**
 * Wraps every listener on a socket in a try/catch.
 *
 * Without this, one throwing handler reaches the process-level
 * uncaughtException hook — which deliberately exits — so a single bad payload
 * from a single client takes the server down for everyone. That is exactly what
 * a FOREIGN KEY failure in the call recorder used to do. Handlers are expected
 * to validate their own input; this is the backstop for the ones that do not.
 */
function guardListeners(socket: Socket, userId: string) {
  const register = socket.on.bind(socket);
  socket.on = ((event: string, listener: (...args: unknown[]) => unknown) =>
    register(event, (...args: unknown[]) => {
      try {
        const result = listener(...args);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch((err: unknown) => {
            log.error("socket handler rejected", { event, userId, message: String((err as Error)?.message ?? err) });
          });
        }
      } catch (err) {
        log.error("socket handler threw", { event, userId, message: String((err as Error)?.message ?? err) });
      }
    })) as typeof socket.on;
}


export function isOnline(userId: string) {
  return (online.get(userId) ?? 0) > 0;
}

function conversationPartners(userId: string): string[] {
  return all<{ user_id: string }>(
    `SELECT DISTINCT other.user_id FROM conversation_members mine
     JOIN conversation_members other ON other.conversation_id = mine.conversation_id AND other.user_id != mine.user_id
     WHERE mine.user_id = ?`,
    userId,
  ).map((r) => r.user_id);
}

export function createRealtime(server: HttpServer) {
  const io = new IOServer(server, {
    path: "/socket.io",
    // Same-origin in every deployment (dev goes through the Vite proxy), so no CORS config needed.
    serveClient: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Large enough for a WebRTC session description, small enough that a client
    // still cannot make the server allocate anything significant.
    maxHttpBufferSize: 64 * 1024,
    connectTimeout: 20_000,
  });

  setEmitter((userId, event, payload) => {
    io.to(room(userId)).emit(event, payload);
  });

  setCallBreaker((userId, otherId, reason) => {
    endCallBetween(io, userId, otherId, reason as EndReason, broadcastMessage);
  });

  io.use((socket, next) => {
    const header = socket.handshake.headers.cookie ?? "";
    const token = readCookie(header, SESSION_COOKIE);
    if (!token) return next(new Error("unauthorized"));
    const user = userForToken(token);
    if (!user) return next(new Error("unauthorized"));
    if ((online.get(user.id) ?? 0) >= MAX_SOCKETS_PER_USER) {
      return next(new Error("too_many_connections"));
    }
    socket.data.userId = user.id;
    // Kept so the session can be re-verified while the socket is open.
    socket.data.token = token;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const userId: string = socket.data.userId;
    guardListeners(socket, userId);
    socket.join(room(userId));

    const count = (online.get(userId) ?? 0) + 1;
    online.set(userId, count);
    run("UPDATE users SET last_seen_at = ? WHERE id = ?", Date.now(), userId);
    if (count === 1) {
      for (const partner of conversationPartners(userId)) {
        io.to(room(partner)).emit("presence:changed", { userId, online: true });
      }
    }

    // Per-socket event budget: a client flooding `typing` would otherwise run
    // two queries per event on the single-threaded server.
    let events = 0;
    let windowStart = Date.now();
    function overBudget(): boolean {
      const now = Date.now();
      if (now - windowStart > EVENT_WINDOW_MS) {
        windowStart = now;
        events = 0;
      }
      return ++events > EVENT_LIMIT;
    }

    // Signalling shares the socket but not the ordinary event budget.
    let signals = 0;
    let signalWindow = Date.now();
    registerCallHandlers({
      io,
      socket,
      userId,
      isOnline,
      broadcastMessage,
      overBudget: () => {
        const now = Date.now();
        if (now - signalWindow > EVENT_WINDOW_MS) {
          signalWindow = now;
          signals = 0;
        }
        return ++signals > SIGNAL_LIMIT;
      },
    });

    socket.on("typing", (payload: { conversationId?: string; typing?: boolean }) => {
      if (overBudget()) return;
      const conversationId = String(payload?.conversationId ?? "").slice(0, 40);
      if (!conversationId) return;
      const isMember = get(
        "SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
        conversationId,
        userId,
      );
      if (!isMember) return;
      const others = all<{ user_id: string }>(
        "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?",
        conversationId,
        userId,
      );
      for (const o of others) {
        io.to(room(o.user_id)).emit("typing", {
          conversationId,
          userId,
          typing: !!payload?.typing,
        });
      }
    });

    // NOTE: there is deliberately no presence lookup event. An earlier version
    // answered "is this user id online?" for arbitrary ids, which leaked
    // activity for accounts that had blocked the asker. Presence now only
    // travels to existing conversation partners.

    socket.on("disconnect", () => {
      const remaining = (online.get(userId) ?? 1) - 1;
      // Ends a call this tab was actually on; a spare tab closing is ignored.
      endCallsForSocket(io, socket.id, userId, remaining > 0, broadcastMessage);
      if (remaining <= 0) {
        online.delete(userId);
        run("UPDATE users SET last_seen_at = ? WHERE id = ?", Date.now(), userId);
        for (const partner of conversationPartners(userId)) {
          io.to(room(partner)).emit("presence:changed", { userId, online: false });
        }
      } else {
        online.set(userId, remaining);
      }
    });
  });

  /**
   * Signing out, changing a password or deleting an account revokes sessions in
   * the database; a socket opened earlier would otherwise keep receiving events
   * indefinitely. Re-check periodically and drop the ones that are no longer valid.
   */
  const recheck = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      const token = socket.data.token as string | undefined;
      if (!token || !userForToken(token)) {
        log.debug("closing socket with revoked session", { user: socket.data.userId });
        socket.emit("session:expired");
        socket.disconnect(true);
      }
    }
  }, SESSION_RECHECK_MS);
  recheck.unref();

  // Keep last_seen_at fresh for connected users so "online" reads true across the API.
  const presence = setInterval(() => {
    const now = Date.now();
    for (const userId of online.keys()) run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, userId);
  }, 45_000);
  presence.unref();

  return io;
}

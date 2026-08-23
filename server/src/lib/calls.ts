import type { Server as IOServer, Socket } from "socket.io";
import { all, get, run } from "../db.ts";
import { newId } from "./ids.ts";
import { log } from "./log.ts";
import { userCard, type UserRow } from "./shape.ts";
import { blockedBetween } from "./visibility.ts";

/**
 * One-to-one audio and video calling.
 *
 * Video is not a second system: it is the same peer connection with a camera
 * track added, so signalling, busy state, blocking and history are shared. The
 * server only needs to know which kind was requested, so the callee's device
 * can ask for a camera before answering and label the incoming call correctly.
 *
 * The media itself is peer-to-peer WebRTC — no media ever reaches this server.
 * All this layer does is broker the handshake over the socket that is already
 * authenticated, keep the authoritative state of who is in a call, and write a
 * durable record when the call finishes.
 *
 * Live state is deliberately in memory: a call is meaningless once the process
 * restarts, so persisting it would only create rows that need reaping.
 */

export const RING_TIMEOUT_MS = 35_000;
/** Backstop against a call entry leaking if both peers vanish without a disconnect. */
const MAX_CALL_MS = 2 * 60 * 60 * 1000;

type CallState = "ringing" | "connected";
export type CallKind = "audio" | "video";

type LiveCall = {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  /** The specific tab that started the call, and the one that answered. */
  callerSocket: string;
  calleeSocket: string | null;
  kind: CallKind;
  state: CallState;
  startedAt: number;
  answeredAt: number | null;
  timer: NodeJS.Timeout;
};

const calls = new Map<string, LiveCall>();
/** userId -> callId, so a second caller gets a busy signal instead of a second ring. */
const busy = new Map<string, string>();

export type EndReason =
  | "hangup"
  | "declined"
  | "cancelled"
  | "missed"
  | "offline"
  | "busy"
  | "blocked"
  | "disconnected"
  | "failed";

/** Terminal reasons that mean the call never carried audio. */
const STATUS_FOR: Record<EndReason, string> = {
  hangup: "completed",
  declined: "declined",
  cancelled: "cancelled",
  missed: "missed",
  offline: "missed",
  busy: "missed",
  blocked: "failed",
  disconnected: "completed",
  failed: "failed",
};

export function callInProgressFor(userId: string): string | undefined {
  return busy.get(userId);
}

function room(userId: string) {
  return `user:${userId}`;
}

function otherMember(conversationId: string, userId: string): UserRow | undefined {
  return get<UserRow>(
    `SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? AND cm.user_id != ? LIMIT 1`,
    conversationId,
    userId,
  );
}

/**
 * Writes the history row and posts it into the thread as a message, so a call
 * appears in the conversation exactly like any other event and inherits unread
 * counts, realtime delivery and deletion for free.
 */
function recordCall(
  call: LiveCall,
  reason: EndReason,
  broadcast: (conversationId: string, messageId: string) => void,
) {
  const endedAt = Date.now();
  // A call that carried audio is completed however it ended; only one that never
  // connected is described by the reason it did not.
  const status = call.answeredAt && reason !== "failed" ? "completed" : STATUS_FOR[reason];

  // An account can be deleted while its call is still up. Every column here is
  // a foreign key, so writing the row would throw inside a socket handler — and
  // there is nothing worth recording once a participant and their conversation
  // have been cascaded away.
  const bothPresent = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)",
    call.callerId,
    call.calleeId,
  );
  const conversationPresent = get("SELECT 1 AS x FROM conversations WHERE id = ?", call.conversationId);
  if (bothPresent?.n !== 2 || !conversationPresent) {
    log.debug("call not recorded: participant or conversation is gone", { callId: call.id, reason });
    return;
  }

  run(
    `INSERT INTO calls (id, conversation_id, caller_id, callee_id, status, kind, started_at, answered_at, ended_at, end_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    call.id,
    call.conversationId,
    call.callerId,
    call.calleeId,
    status,
    call.kind,
    call.startedAt,
    call.answeredAt,
    endedAt,
    reason,
  );

  // A call that never reached the other side is not worth a thread entry. One
  // that connected is, even if a block is what ended it.
  if ((reason === "blocked" || reason === "busy") && !call.answeredAt) return;

  const messageId = newId();
  run(
    `INSERT INTO messages (id, conversation_id, sender_id, body, call_id, created_at)
     VALUES (?,?,?,'',?,?)`,
    messageId,
    call.conversationId,
    call.callerId,
    call.id,
    endedAt,
  );
  run("UPDATE conversations SET last_message_at = ? WHERE id = ?", endedAt, call.conversationId);
  // The caller has obviously seen their own call.
  run(
    "UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?",
    endedAt,
    call.conversationId,
    call.callerId,
  );
  broadcast(call.conversationId, messageId);
}

function teardown(call: LiveCall) {
  clearTimeout(call.timer);
  calls.delete(call.id);
  if (busy.get(call.callerId) === call.id) busy.delete(call.callerId);
  if (busy.get(call.calleeId) === call.id) busy.delete(call.calleeId);
}

/** Ends a call and tells both sides. Safe to call more than once. */
export function endCall(
  io: IOServer,
  callId: string,
  reason: EndReason,
  broadcast: (conversationId: string, messageId: string) => void,
) {
  const call = calls.get(callId);
  if (!call) return;
  teardown(call);

  const duration = call.answeredAt ? Date.now() - call.answeredAt : 0;
  for (const participant of [call.callerId, call.calleeId]) {
    io.to(room(participant)).emit("call:ended", { callId, reason, durationMs: duration });
  }
  recordCall(call, reason, broadcast);
  log.debug("call ended", { callId, reason, durationMs: duration });
}

export type CallHandlerDeps = {
  io: IOServer;
  socket: Socket;
  userId: string;
  isOnline: (userId: string) => boolean;
  broadcastMessage: (conversationId: string, messageId: string) => void;
  /** Shared signalling budget, generous enough for a burst of ICE candidates. */
  overBudget: () => boolean;
};

export function registerCallHandlers({
  io,
  socket,
  userId,
  isOnline,
  broadcastMessage,
  overBudget,
}: CallHandlerDeps) {
  const fail = (reason: string, message: string) => socket.emit("call:failed", { reason, message });

  socket.on("call:start", (payload: { conversationId?: string; kind?: string }) => {
    if (overBudget()) return;
    const conversationId = String(payload?.conversationId ?? "").slice(0, 40);
    if (!conversationId) return;
    const kind: CallKind = payload?.kind === "video" ? "video" : "audio";

    const member = get(
      "SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
      conversationId,
      userId,
    );
    if (!member) return fail("not_allowed", "That conversation does not exist.");

    const callee = otherMember(conversationId, userId);
    if (!callee) return fail("not_allowed", "There is nobody to call in this conversation.");

    // Same rule as messaging: a block closes the channel in both directions.
    if (blockedBetween(userId, callee.id)) return fail("blocked", "You cannot call this account.");
    if (busy.has(userId)) return fail("busy", "You are already in a call.");
    if (busy.has(callee.id)) return fail("busy", `${callee.username} is on another call.`);
    if (!isOnline(callee.id)) return fail("offline", `${callee.username} is not available right now.`);

    const call: LiveCall = {
      id: newId(),
      conversationId,
      callerId: userId,
      calleeId: callee.id,
      callerSocket: socket.id,
      calleeSocket: null,
      kind,
      state: "ringing",
      startedAt: Date.now(),
      answeredAt: null,
      timer: setTimeout(() => endCall(io, call.id, "missed", broadcastMessage), RING_TIMEOUT_MS),
    };
    calls.set(call.id, call);
    busy.set(userId, call.id);
    busy.set(callee.id, call.id);

    const caller = get<UserRow>("SELECT * FROM users WHERE id = ?", userId);
    // Every device the callee has open rings; whichever answers first wins.
    io.to(room(callee.id)).emit("call:incoming", {
      callId: call.id,
      conversationId,
      kind,
      from: caller ? userCard(caller) : null,
    });
    socket.emit("call:ringing", { callId: call.id, to: userCard(callee), conversationId, kind });
    log.debug("call started", { callId: call.id, kind, from: userId, to: callee.id });
  });

  socket.on("call:accept", (payload: { callId?: string }) => {
    const call = calls.get(String(payload?.callId ?? ""));
    if (!call || call.calleeId !== userId || call.state !== "ringing") return;

    clearTimeout(call.timer);
    call.state = "connected";
    call.answeredAt = Date.now();
    call.calleeSocket = socket.id;
    call.timer = setTimeout(() => endCall(io, call.id, "hangup", broadcastMessage), MAX_CALL_MS);

    // Stop the other tabs ringing, then tell the caller to make the offer.
    socket.to(room(userId)).emit("call:handled", { callId: call.id });
    io.to(call.callerSocket).emit("call:accepted", { callId: call.id });
    socket.emit("call:connecting", { callId: call.id });
  });

  socket.on("call:decline", (payload: { callId?: string }) => {
    const call = calls.get(String(payload?.callId ?? ""));
    if (!call || call.calleeId !== userId) return;
    socket.to(room(userId)).emit("call:handled", { callId: call.id });
    endCall(io, call.id, "declined", broadcastMessage);
  });

  socket.on("call:hangup", (payload: { callId?: string }) => {
    const call = calls.get(String(payload?.callId ?? ""));
    if (!call) return;
    if (call.callerId !== userId && call.calleeId !== userId) return;
    // Hanging up before an answer is a cancel from the caller's side.
    const reason: EndReason = call.answeredAt ? "hangup" : call.callerId === userId ? "cancelled" : "declined";
    endCall(io, call.id, reason, broadcastMessage);
  });

  /**
   * Relays one SDP or ICE payload to the other participant's socket. The server
   * never inspects it beyond a size check — it is opaque WebRTC data.
   */
  socket.on("call:signal", (payload: { callId?: string; data?: unknown }) => {
    if (overBudget()) return;
    const call = calls.get(String(payload?.callId ?? ""));
    if (!call) return;
    if (call.callerId !== userId && call.calleeId !== userId) return;
    if (typeof payload?.data !== "object" || payload.data === null) return;
    if (JSON.stringify(payload.data).length > 32_000) return;

    const target = call.callerId === userId ? call.calleeSocket : call.callerSocket;
    if (!target) return;
    io.to(target).emit("call:signal", { callId: call.id, data: payload.data });
  });

  /** The peer could not establish media (ICE failed, no mic, etc). */
  socket.on("call:failure", (payload: { callId?: string }) => {
    const call = calls.get(String(payload?.callId ?? ""));
    if (!call) return;
    if (call.callerId !== userId && call.calleeId !== userId) return;
    endCall(io, call.id, "failed", broadcastMessage);
  });
}

/**
 * A dropped socket ends any call that tab was in — but only if it was actually
 * the tab on the call, so a background tab closing cannot hang up on you.
 */
export function endCallsForSocket(
  io: IOServer,
  socketId: string,
  userId: string,
  stillOnline: boolean,
  broadcast: (conversationId: string, messageId: string) => void,
) {
  const callId = busy.get(userId);
  if (!callId) return;
  const call = calls.get(callId);
  if (!call) return;

  const wasParticipatingTab = call.callerSocket === socketId || call.calleeSocket === socketId;
  // A ringing call belongs to every one of the callee's tabs, so only drop it
  // when the account has gone offline entirely.
  if (!wasParticipatingTab && stillOnline) return;

  endCall(io, callId, call.answeredAt ? "disconnected" : "cancelled", broadcast);
}

/**
 * Ends any live call between two people. Called when one blocks the other: a
 * block closes every channel immediately, and an open audio stream is the most
 * direct channel there is.
 */
export function endCallBetween(
  io: IOServer,
  userId: string,
  otherId: string,
  reason: EndReason,
  broadcast: (conversationId: string, messageId: string) => void,
) {
  const callId = busy.get(userId);
  if (!callId) return;
  const call = calls.get(callId);
  if (!call) return;
  const pair = [call.callerId, call.calleeId];
  if (!pair.includes(userId) || !pair.includes(otherId)) return;
  endCall(io, callId, reason, broadcast);
}

/** Recent call history for a conversation, newest first. */
export function callsForConversation(conversationId: string, limit = 50) {
  return all(
    `SELECT id, caller_id, callee_id, status, kind, started_at, answered_at, ended_at
     FROM calls WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ?`,
    conversationId,
    limit,
  );
}

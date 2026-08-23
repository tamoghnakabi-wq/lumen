import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronLeft,
  ImagePlus,
  Info,
  MessageCircle,
  MoreHorizontal,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Send,
  Trash2,
  X,
  Video,
} from "lucide-react";
import { ApiError, del, get, post, upload } from "../lib/api.ts";
import { clockTime, dayLabel, shortAgo } from "../lib/time.ts";
import { getSocket } from "../lib/socket.ts";
import { useCall } from "../lib/call.tsx";
import { useToast } from "../lib/toast.tsx";
import { validateImage } from "../lib/uploadProgress.ts";
import type { Conversation, Message } from "../lib/types.ts";
import { Avatar } from "../components/Avatar.tsx";
import { Menu } from "../components/Menu.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { EmptyState, ErrorState, RowSkeleton, Spinner } from "../components/States.tsx";
import { PostLink } from "../components/PostLink.tsx";

export function MessagesPage() {
  const { id } = useParams();
  return (
    <div className="mx-auto flex h-[calc(100dvh-var(--tabbar-h))] w-full max-w-[72rem] md:h-dvh md:px-4 lg:px-6">
      <ConversationList activeId={id} />
      <div className={`min-w-0 flex-1 ${id ? "flex" : "hidden md:flex"}`}>
        {id ? (
          <Thread conversationId={id} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<MessageCircle size={22} />}
              title="Your messages"
              message="Pick a conversation, or start one from someone’s profile."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationList({ activeId }: { activeId?: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => get<{ conversations: Conversation[] }>("/conversations"),
  });

  useEffect(() => {
    const socket = getSocket();
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    socket.on("message:new", refresh);
    socket.on("presence:changed", refresh);
    return () => {
      socket.off("message:new", refresh);
      socket.off("presence:changed", refresh);
    };
  }, [queryClient]);

  const conversations = data?.conversations ?? [];

  return (
    <aside
      className={`w-full shrink-0 border-line md:w-[20rem] md:border-r lg:w-[22rem] ${
        activeId ? "hidden md:block" : "block"
      }`}
    >
      <div className="flex h-full flex-col">
        <PageHeader title="Messages" />
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {isLoading ? (
            <RowSkeleton count={6} />
          ) : error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : conversations.length === 0 ? (
            <EmptyState
              icon={<MessageCircle size={22} />}
              title="No conversations yet"
              message="Open someone’s profile and tap Message to start one."
            />
          ) : (
            conversations.map((conversation) => (
              <Link
                key={conversation.id}
                to={`/messages/${conversation.id}`}
                className={`flex items-center gap-3 px-3 py-2.5 transition ${
                  activeId === conversation.id ? "bg-raised" : "hover:bg-surface"
                }`}
              >
                {conversation.partner && <Avatar user={conversation.partner} size={50} link={false} showOnline />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="truncate text-sm font-semibold">{conversation.partner?.username}</p>
                    {conversation.lastMessage && (
                      <span className="shrink-0 text-[11px] text-faint">
                        {shortAgo(conversation.lastMessage.createdAt)}
                      </span>
                    )}
                  </div>
                  <p className={`truncate text-[13px] ${conversation.unread > 0 ? "font-medium text-fg" : "text-muted"}`}>
                    {conversation.lastMessage
                      ? `${conversation.lastMessage.mine && !conversation.lastMessage.hasCall ? "You: " : ""}${
                          conversation.lastMessage.hasCall
                            ? "Audio call"
                            : conversation.lastMessage.hasMedia
                              ? "Photo"
                              : conversation.lastMessage.hasPost
                                ? "Shared a post"
                                : conversation.lastMessage.body
                        }`
                      : "Say hello"}
                  </p>
                </div>
                {conversation.unread > 0 && (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" aria-label={`${conversation.unread} unread`} />
                )}
              </Link>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function Thread({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate();
  const call = useCall();
  const callBusy = call.phase !== "idle" && call.phase !== "ended";
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<{ file: File; url: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingSent = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const conversation = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => get<{ conversation: Conversation }>(`/conversations/${conversationId}`),
  });

  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => get<{ messages: Message[]; nextCursor: string | null }>(`/conversations/${conversationId}/messages`),
  });

  const markRead = useMutation({
    mutationFn: () => post(`/conversations/${conversationId}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["unread", "messages"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  // Mark read on open and whenever a new message lands while the thread is visible.
  useEffect(() => {
    if (messages.data) markRead.mutate();
  }, [messages.data?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const socket = getSocket();

    const onMessage = (payload: { message: Message; conversation: Conversation }) => {
      if (payload.message.conversationId !== conversationId) return;
      queryClient.setQueryData(
        ["messages", conversationId],
        (old: { messages: Message[]; nextCursor: string | null } | undefined) => {
          if (!old) return old;
          if (old.messages.some((m) => m.id === payload.message.id)) return old;
          return { ...old, messages: [...old.messages, payload.message] };
        },
      );
      setPartnerTyping(false);
    };

    const onTyping = (payload: { conversationId: string; typing: boolean }) => {
      if (payload.conversationId === conversationId) setPartnerTyping(payload.typing);
    };

    const onDeleted = (payload: { conversationId: string; messageId: string }) => {
      if (payload.conversationId !== conversationId) return;
      queryClient.setQueryData(
        ["messages", conversationId],
        (old: { messages: Message[]; nextCursor: string | null } | undefined) =>
          old
            ? {
                ...old,
                messages: old.messages.map((m) =>
                  m.id === payload.messageId ? { ...m, deleted: true, body: "", media: null, sharedPost: null } : m,
                ),
              }
            : old,
      );
    };

    const onRead = (payload: { conversationId: string; at: number }) => {
      if (payload.conversationId !== conversationId) return;
      queryClient.setQueryData(["conversation", conversationId], (old: { conversation: Conversation } | undefined) =>
        old ? { conversation: { ...old.conversation, theirLastReadAt: payload.at } } : old,
      );
    };

    const onPresence = () => void conversation.refetch();

    socket.on("message:new", onMessage);
    socket.on("typing", onTyping);
    socket.on("message:deleted", onDeleted);
    socket.on("conversation:read", onRead);
    socket.on("presence:changed", onPresence);
    return () => {
      socket.off("message:new", onMessage);
      socket.off("typing", onTyping);
      socket.off("message:deleted", onDeleted);
      socket.off("conversation:read", onRead);
      socket.off("presence:changed", onPresence);
    };
  }, [conversationId, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.data?.messages.length, partnerTyping]);

  function signalTyping(typing: boolean) {
    const now = Date.now();
    if (typing && now - typingSent.current < 1800) return;
    typingSent.current = typing ? now : 0;
    getSocket().emit("typing", { conversationId, typing });
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text && !attachment) return;
    setSending(true);
    signalTyping(false);
    try {
      const body = new FormData();
      body.append("body", text);
      if (attachment) body.append("image", attachment.file, attachment.file.name);
      const data = await upload<{ message: Message }>(`/conversations/${conversationId}/messages`, body);
      queryClient.setQueryData(
        ["messages", conversationId],
        (old: { messages: Message[]; nextCursor: string | null } | undefined) =>
          old
            ? old.messages.some((m) => m.id === data.message.id)
              ? old
              : { ...old, messages: [...old.messages, data.message] }
            : old,
      );
      setDraft("");
      if (attachment) URL.revokeObjectURL(attachment.url);
      setAttachment(null);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send the message.", "error");
    } finally {
      setSending(false);
    }
  }

  if (conversation.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} className="text-muted" />
      </div>
    );
  }

  if (conversation.error) {
    const notFound = conversation.error instanceof ApiError && conversation.error.status === 404;
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          title={notFound ? "Conversation not available" : "Could not load this conversation"}
          message={notFound ? "It may have been removed, or you may not have access." : undefined}
          action={
            <button className="btn btn-ghost" onClick={() => navigate("/messages")}>
              Back to messages
            </button>
          }
        />
      </div>
    );
  }

  const partner = conversation.data?.conversation.partner;
  const theirLastRead = conversation.data?.conversation.theirLastReadAt ?? 0;
  const blocked = conversation.data?.conversation.blocked;
  const list = messages.data?.messages ?? [];
  const lastMine = [...list].reverse().find((m) => m.mine);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b border-line bg-bg/90 px-3 py-2.5 backdrop-blur-md">
        <button onClick={() => navigate("/messages")} className="press -ml-1 rounded-full p-1.5 md:hidden" aria-label="Back">
          <ChevronLeft size={22} />
        </button>
        {partner && (
          <>
            <Avatar user={partner} size={38} showOnline />
            <Link to={`/${partner.username}`} className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{partner.username}</p>
              <p className="truncate text-xs text-muted">
                {partnerTyping ? "typing…" : partner.isOnline ? "Active now" : partner.displayName}
              </p>
            </Link>
            <button
              onClick={() => void call.startCall(conversationId, partner, "audio")}
              disabled={callBusy || blocked}
              aria-label={`Call ${partner.username}`}
              title={blocked ? "You cannot call this account" : `Call ${partner.username}`}
              className="press rounded-full p-2 text-fg transition hover:bg-raised disabled:opacity-40"
            >
              <Phone size={19} />
            </button>
            <button
              onClick={() => void call.startCall(conversationId, partner, "video")}
              disabled={callBusy || blocked}
              aria-label={`Video call ${partner.username}`}
              title={blocked ? "You cannot call this account" : `Video call ${partner.username}`}
              className="press rounded-full p-2 text-fg transition hover:bg-raised disabled:opacity-40"
            >
              <Video size={19} />
            </button>
            <Menu
              trigger={<MoreHorizontal size={19} />}
              items={[{ label: "View profile", icon: <Info size={15} />, onSelect: () => navigate(`/${partner.username}`) }]}
            />
          </>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {messages.isLoading ? (
          <div className="space-y-3 py-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`flex ${i % 2 ? "justify-end" : ""}`}>
                <div className="skeleton h-9 w-40 rounded-2xl" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState title="No messages yet" message={`Say hello to @${partner?.username ?? ""}.`} />
          </div>
        ) : (
          list.map((message, index) => {
            const previous = list[index - 1];
            const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
            return (
              <div key={message.id}>
                {newDay && (
                  <p className="py-3 text-center text-[11px] font-medium uppercase tracking-wide text-faint">
                    {dayLabel(message.createdAt)}
                  </p>
                )}
                <MessageBubble
                  message={message}
                  showRead={message.id === lastMine?.id && theirLastRead >= message.createdAt}
                />
              </div>
            );
          })
        )}

        <AnimatePresence>
          {partnerTyping && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-1.5 px-1 py-2"
            >
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-faint"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.16 }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {blocked ? (
        <div className="border-t border-line px-4 py-4 text-center text-sm text-muted">
          You can’t message this account.
        </div>
      ) : (
        <form onSubmit={send} className="border-t border-line p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          {attachment && (
            <div className="relative mb-2 ml-1 inline-block">
              <img src={attachment.url} alt="" className="h-20 w-20 rounded-xl object-cover" />
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(attachment.url);
                  setAttachment(null);
                }}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-fg p-1 text-bg"
                aria-label="Remove attachment"
              >
                <X size={11} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="press rounded-full p-2 text-muted transition hover:text-fg"
              aria-label="Attach a photo"
            >
              <ImagePlus size={21} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const error = validateImage(file);
                if (error) return toast(error, "error");
                setAttachment({ file, url: URL.createObjectURL(file) });
              }}
            />
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value.slice(0, 2000));
                signalTyping(e.target.value.length > 0);
              }}
              onBlur={() => signalTyping(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Message…"
              aria-label="Message"
              className="field max-h-32 min-h-[2.6rem] flex-1 resize-none rounded-2xl py-2.5"
            />
            <button
              type="submit"
              disabled={sending || (!draft.trim() && !attachment)}
              className="btn btn-primary h-10 w-10 shrink-0 !p-0"
              aria-label="Send message"
            >
              {sending ? <Spinner size={16} /> : <Send size={17} />}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function callLabel(call: NonNullable<Message["call"]>): string {
  if (call.status === "completed") {
    const total = Math.floor(call.durationMs / 1000);
    const stamp = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    return `${call.outgoing ? "Outgoing" : "Incoming"} audio call · ${stamp}`;
  }
  const noun = call.kind === "video" ? "video call" : "audio call";
  if (call.status === "missed") return call.outgoing ? "No answer" : `Missed ${noun}`;
  if (call.status === "declined") return call.outgoing ? "Call declined" : "You declined a call";
  if (call.status === "cancelled") return call.outgoing ? "You cancelled the call" : `Missed ${noun}`;
  return "Call failed";
}

/** A finished call is an event in the timeline, not a message from either side. */
function CallEvent({ message }: { message: Message }) {
  const call = message.call!;
  const missed = call.status === "missed" || call.status === "failed";
  const Icon = call.kind === "video" ? Video : missed ? PhoneMissed : call.outgoing ? PhoneOutgoing : PhoneIncoming;

  return (
    <div className="flex justify-center py-2">
      <span
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
          missed ? "border-danger/30 text-danger" : "border-line text-muted"
        }`}
      >
        <Icon size={13} />
        {callLabel(call)}
        <span className="text-faint">{clockTime(message.createdAt)}</span>
      </span>
    </div>
  );
}

function MessageBubble({ message, showRead }: { message: Message; showRead: boolean }) {
  if (message.call) return <CallEvent message={message} />;
  const queryClient = useQueryClient();
  const toast = useToast();

  async function remove() {
    try {
      await del(`/messages/${message.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the message.", "error");
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  }

  return (
    <div className={`group flex items-end gap-1.5 py-0.5 ${message.mine ? "justify-end" : ""}`}>
      {message.mine && !message.deleted && (
        <Menu
          align="left"
          trigger={<MoreHorizontal size={15} />}
          items={[{ label: "Delete message", icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove() }]}
        />
      )}
      <div className={`max-w-[min(78%,26rem)] ${message.mine ? "items-end" : "items-start"} flex flex-col gap-1`}>
        {message.isStoryReply && (
          <div className={`flex items-center gap-2 px-1 ${message.mine ? "flex-row-reverse" : ""}`}>
            <span className="text-[11px] text-faint">
              {message.story
                ? message.mine
                  ? message.story.mine
                    ? "Replied to your story"
                    : "Replied to their story"
                  : "Replied to your story"
                : "Replied to a story that has expired"}
            </span>
            {message.story && (
              <img
                src={message.story.thumb}
                alt=""
                className="h-10 w-7 shrink-0 rounded-md object-cover ring-1 ring-line"
              />
            )}
          </div>
        )}

        {message.sharedPost && (
          <PostLink
            postId={message.sharedPost.id}
            className="block overflow-hidden rounded-2xl border border-line bg-surface"
          >
            {message.sharedPost.media[0] && (
              <img src={message.sharedPost.media[0].url} alt="" className="max-h-64 w-full object-cover" />
            )}
            <p className="px-3 py-2 text-xs text-muted">
              <span className="font-semibold text-fg">{message.sharedPost.author.username}</span>
              {message.sharedPost.caption ? ` · ${message.sharedPost.caption.slice(0, 60)}` : ""}
            </p>
          </PostLink>
        )}

        {message.media && (
          <img
            src={message.media.url}
            alt=""
            className="max-h-72 rounded-2xl object-cover"
            style={{ maxWidth: "100%" }}
          />
        )}

        {(message.body || message.deleted) && (
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[15px] leading-snug ${
              message.deleted
                ? "border border-dashed border-line text-faint"
                : message.mine
                  ? "bg-accent text-white"
                  : "bg-raised text-fg"
            }`}
          >
            {message.deleted ? "Message deleted" : message.body}
          </div>
        )}

        <span className="px-1 text-[10px] text-faint opacity-0 transition group-hover:opacity-100">
          {clockTime(message.createdAt)}
          {showRead && message.mine ? " · Seen" : ""}
        </span>
      </div>
    </div>
  );
}

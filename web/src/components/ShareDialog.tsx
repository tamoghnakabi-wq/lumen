import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Link2, Search, Send } from "lucide-react";
import { get, post, upload } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import type { Conversation, Suggestion, UserCard } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";
import { RowSkeleton, Spinner } from "./States.tsx";

/** Share sheet: copy the link, use the OS share sheet, or send the post as a DM. */
export function ShareDialog({ open, onClose, postId }: { open: boolean; onClose: () => void; postId: string }) {
  const [query, setQuery] = useState("");
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const url = `${window.location.origin}/p/${postId}`;

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => get<{ conversations: Conversation[] }>("/conversations"),
    enabled: open,
  });
  const suggestions = useQuery({
    queryKey: ["suggestions"],
    queryFn: () => get<{ users: Suggestion[] }>("/users/-/suggestions"),
    enabled: open,
  });
  const search = useQuery({
    queryKey: ["share-search", query],
    queryFn: () => get<{ users: UserCard[] }>(`/explore/search?q=${encodeURIComponent(query)}`),
    enabled: open && query.trim().length > 0,
  });

  const people: UserCard[] = query.trim()
    ? (search.data?.users ?? [])
    : [
        ...(conversations.data?.conversations ?? []).map((c) => c.partner).filter(Boolean as unknown as (u: UserCard | null) => u is UserCard),
        ...(suggestions.data?.users ?? []),
      ].filter((user, i, list) => list.findIndex((u) => u.id === user.id) === i);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast("Could not copy the link.", "error");
    }
  }

  async function sendTo(user: UserCard) {
    setSending(user.id);
    try {
      const { conversation } = await post<{ conversation: Conversation }>("/conversations", { userId: user.id });
      const body = new FormData();
      body.append("sharedPostId", postId);
      await upload(`/conversations/${conversation.id}/messages`, body);
      setSentTo((s) => new Set(s).add(user.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send.", "error");
    } finally {
      setSending(null);
    }
  }

  const loading = !query.trim() && (conversations.isLoading || suggestions.isLoading);

  return (
    <Modal open={open} onClose={onClose} title="Share post" size="sm">
      <div className="flex min-h-0 flex-col">
        <div className="flex gap-2 px-5 pt-4">
          <button className="btn btn-ghost flex-1 justify-center" onClick={copyLink}>
            {copied ? <Check size={15} className="text-online" /> : <Link2 size={15} />}
            {copied ? "Link copied" : "Copy link"}
          </button>
          {typeof navigator.share === "function" && (
            <button
              className="btn btn-ghost flex-1 justify-center"
              onClick={() => navigator.share({ url, title: "A post on Lumen" }).catch(() => {})}
            >
              <Send size={15} /> Share…
            </button>
          )}
        </div>

        <div className="relative px-5 pt-3">
          <Search size={15} className="pointer-events-none absolute left-8 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people"
            className="field pl-9"
            aria-label="Search people to share with"
          />
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <RowSkeleton count={4} />
          ) : people.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No one to show yet.</p>
          ) : (
            people.slice(0, 20).map((user) => (
              <div key={user.id} className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-raised">
                <Avatar user={user} size={40} link={false} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{user.username}</p>
                  <p className="truncate text-xs text-muted">{user.displayName}</p>
                </div>
                <button
                  className={`btn ${sentTo.has(user.id) ? "btn-ghost" : "btn-primary"} px-3.5 py-1.5 text-[13px]`}
                  onClick={() => sendTo(user)}
                  disabled={sending === user.id || sentTo.has(user.id)}
                >
                  {sending === user.id ? <Spinner size={14} /> : sentTo.has(user.id) ? "Sent" : "Send"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

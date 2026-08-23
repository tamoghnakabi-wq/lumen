import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Eye, Plus, Send, Trash2, X } from "lucide-react";
import { del, get, post } from "../lib/api.ts";
import { shortAgo, timeLeft } from "../lib/time.ts";
import { useAuth } from "../lib/auth.tsx";
import { useToast } from "../lib/toast.tsx";
import type { Story, StoryGroup, UserCard } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";
import { Skeleton, Spinner } from "./States.tsx";

const STORY_MS = 5200;

export function useStories() {
  return useQuery({
    queryKey: ["stories"],
    queryFn: () => get<{ groups: StoryGroup[] }>("/stories"),
    staleTime: 30_000,
  });
}

export function StoryRail({ onAddStory }: { onAddStory: () => void }) {
  const { user } = useAuth();
  const { data, isLoading } = useStories();
  const [viewer, setViewer] = useState<{ groups: StoryGroup[]; index: number } | null>(null);

  if (isLoading) {
    return (
      <div className="hide-scroll flex gap-3.5 overflow-x-auto px-4 py-3.5 sm:px-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex w-[68px] shrink-0 flex-col items-center gap-1.5">
            <Skeleton className="h-16 w-16 rounded-full" />
            <Skeleton className="h-2.5 w-12" />
          </div>
        ))}
      </div>
    );
  }

  const groups = data?.groups ?? [];
  const mine = groups.find((g) => g.isSelf);
  const others = groups.filter((g) => !g.isSelf);

  return (
    <>
      <div className="hide-scroll flex gap-3.5 overflow-x-auto px-4 py-3.5 sm:px-1">
        {/* Your story: opens the viewer if you have one, otherwise the composer. */}
        <button
          onClick={() => (mine ? setViewer({ groups, index: groups.indexOf(mine) }) : onAddStory())}
          className="flex w-[68px] shrink-0 flex-col items-center gap-1.5"
        >
          <span className="relative">
            <Avatar
              user={user ?? { username: "you", displayName: "You", avatar: null }}
              size={64}
              ring={mine?.hasUnseen ? "unseen" : mine ? "seen" : "none"}
              link={false}
            />
            {!mine && (
              <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-bg bg-accent text-white">
                <Plus size={12} strokeWidth={3} />
              </span>
            )}
          </span>
          <span className="w-full truncate text-center text-[11px] text-muted">Your story</span>
        </button>

        {others.map((group) => (
          <button
            key={group.author.id}
            onClick={() => setViewer({ groups, index: groups.indexOf(group) })}
            className="flex w-[68px] shrink-0 flex-col items-center gap-1.5"
          >
            <Avatar user={group.author} size={64} ring={group.hasUnseen ? "unseen" : "seen"} link={false} />
            <span className={`w-full truncate text-center text-[11px] ${group.hasUnseen ? "text-fg" : "text-muted"}`}>
              {group.author.username}
            </span>
          </button>
        ))}

        {others.length === 0 && !mine && (
          <p className="flex items-center px-1 text-sm text-muted">
            Stories from people you follow show up here.
          </p>
        )}
      </div>

      {viewer && (
        <StoryViewer
          groups={viewer.groups}
          startIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}

export function StoryViewer({
  groups,
  startIndex,
  onClose,
}: {
  groups: StoryGroup[];
  startIndex: number;
  onClose: () => void;
}) {
  const [groupIndex, setGroupIndex] = useState(startIndex);
  const [storyIndex, setStoryIndex] = useState(() => {
    const first = groups[startIndex]?.stories.findIndex((s) => !s.seen);
    return first !== undefined && first >= 0 ? first : 0;
  });
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showViewers, setShowViewers] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const group = groups[groupIndex];
  const story = group?.stories[storyIndex];

  const markViewed = useMutation({
    mutationFn: (storyId: string) => post(`/stories/${storyId}/view`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["stories"] }),
  });

  const removeStory = useMutation({
    mutationFn: (storyId: string) => del(`/stories/${storyId}`),
    onSuccess: () => {
      toast("Story deleted", "success");
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
      onClose();
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not delete story.", "error"),
  });

  const next = useCallback(() => {
    if (!group) return;
    if (storyIndex < group.stories.length - 1) {
      setStoryIndex((i) => i + 1);
    } else if (groupIndex < groups.length - 1) {
      setGroupIndex((i) => i + 1);
      setStoryIndex(0);
    } else {
      onClose();
    }
    setElapsed(0);
  }, [group, groupIndex, groups.length, storyIndex, onClose]);

  const previous = useCallback(() => {
    if (storyIndex > 0) {
      setStoryIndex((i) => i - 1);
    } else if (groupIndex > 0) {
      const target = groups[groupIndex - 1];
      setGroupIndex((i) => i - 1);
      setStoryIndex(Math.max(0, target.stories.length - 1));
    }
    setElapsed(0);
  }, [groupIndex, groups, storyIndex]);

  // Record the view as soon as a story is on screen.
  useEffect(() => {
    if (story && !story.seen && !group.isSelf) markViewed.mutate(story.id);
  }, [story?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Progress timer.
  useEffect(() => {
    if (paused || !story) return;
    const startedAt = Date.now() - elapsed;
    const id = window.setInterval(() => {
      const value = Date.now() - startedAt;
      if (value >= STORY_MS) next();
      else setElapsed(value);
    }, 50);
    return () => window.clearInterval(id);
  }, [paused, story?.id, next]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") previous();
      if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [next, previous, onClose]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);

  if (!group || !story) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black"
      // Clicking the letterbox beside the story closes it, the way every other
      // overlay in the app behaves. Only a direct hit counts, so taps that land
      // on the story itself still page forward and back.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => (touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dy) > 90 && Math.abs(dy) > Math.abs(dx)) onClose();
        touchStart.current = null;
      }}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-20 rounded-full bg-white/10 p-2 text-white backdrop-blur transition hover:bg-white/20"
        aria-label="Close stories"
      >
        <X size={20} />
      </button>

      {groupIndex > 0 && (
        <button
          onClick={previous}
          className="absolute left-4 z-20 hidden rounded-full bg-white/10 p-2.5 text-white backdrop-blur transition hover:bg-white/20 md:block"
          aria-label="Previous story"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {groupIndex < groups.length - 1 && (
        <button
          onClick={() => {
            setGroupIndex((i) => i + 1);
            setStoryIndex(0);
            setElapsed(0);
          }}
          className="absolute right-4 z-20 hidden rounded-full bg-white/10 p-2.5 text-white backdrop-blur transition hover:bg-white/20 md:block"
          aria-label="Next story"
        >
          <ChevronRight size={22} />
        </button>
      )}

      <div className="relative flex h-full w-full max-w-[26rem] flex-col md:h-[92vh] md:rounded-2xl md:overflow-hidden">
        <div className="absolute inset-x-0 top-0 z-10 flex gap-1 p-2.5">
          {group.stories.map((s, i) => (
            <div key={s.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full rounded-full bg-white"
                style={{
                  width: i < storyIndex ? "100%" : i === storyIndex ? `${Math.min(100, (elapsed / STORY_MS) * 100)}%` : "0%",
                  transition: i === storyIndex ? "width 60ms linear" : undefined,
                }}
              />
            </div>
          ))}
        </div>

        <header className="absolute inset-x-0 top-5 z-10 flex items-center gap-2.5 px-3.5 pt-2">
          <Avatar user={group.author} size={34} link={false} />
          <div className="min-w-0 flex-1">
            <Link to={`/${group.author.username}`} onClick={onClose} className="block truncate text-sm font-semibold text-white">
              {group.author.username}
            </Link>
            <p className="text-[11px] text-white/70">
              {shortAgo(story.createdAt)} · {timeLeft(story.expiresAt)}
            </p>
          </div>
          {group.isSelf && (
            <button
              onClick={() => setDeleteOpen(true)}
              className="rounded-full bg-white/10 p-2 text-white backdrop-blur transition hover:bg-white/20"
              aria-label="Delete story"
            >
              <Trash2 size={16} />
            </button>
          )}
        </header>

        <AnimatePresence>
          {sentTo && (
            <motion.p
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              onAnimationComplete={() => window.setTimeout(() => setSentTo(null), 1600)}
              className="absolute inset-x-0 top-1/2 z-30 mx-auto w-fit rounded-full bg-white/15 px-4 py-2 text-sm text-white backdrop-blur"
            >
              Sent to @{sentTo}
            </motion.p>
          )}
        </AnimatePresence>

        <div
          className="relative flex-1 select-none overflow-hidden"
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
        >
          {/* A blurred copy fills the letterbox so portrait and landscape
              stories both sit on something better than flat black. */}
          <img
            src={story.media.preview ?? story.media.url}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full scale-125 object-cover opacity-45 blur-2xl"
            draggable={false}
          />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.img
              key={story.id}
              src={story.media.full}
              alt=""
              initial={{ opacity: 0.4 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 h-full w-full object-contain"
              draggable={false}
            />
          </AnimatePresence>

          {/* Tap zones for previous / next */}
          <button className="absolute inset-y-0 left-0 w-1/3 cursor-default" onClick={previous} aria-label="Previous" />
          <button className="absolute inset-y-0 right-0 w-2/3 cursor-default" onClick={next} aria-label="Next" />

          {story.caption && (
            <p
              className={`pointer-events-none absolute inset-x-4 rounded-xl bg-black/50 px-3.5 py-2.5 text-center text-[15px] leading-snug text-white backdrop-blur-sm ${
                group.isSelf ? "bottom-20" : "bottom-36"
              }`}
            >
              {story.caption}
            </p>
          )}
        </div>

        {group.isSelf ? (
          <footer className="absolute inset-x-0 bottom-0 z-10 flex justify-center p-4">
            <button
              onClick={() => {
                setPaused(true);
                setShowViewers(true);
              }}
              className="btn bg-white/12 text-white backdrop-blur hover:bg-white/22"
            >
              <Eye size={15} /> Viewers
              {story.reactionCount > 0 && <span className="text-white/70">· {story.reactionCount}</span>}
            </button>
          </footer>
        ) : (
          <StoryComposerBar
            story={story}
            authorName={group.author.username}
            onFocusChange={setPaused}
            onSent={() => setSentTo(group.author.username)}
          />
        )}
      </div>

      <StoryViewersDialog
        open={showViewers}
        onClose={() => {
          setShowViewers(false);
          setPaused(false);
        }}
        storyId={story.id}
      />

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} size="sm">
        <div className="p-6 text-center">
          <h3 className="text-lg font-semibold">Delete this story?</h3>
          <p className="mt-2 text-sm text-muted">It will be removed for everyone straight away.</p>
          <div className="mt-5 flex flex-col gap-2">
            <button className="btn btn-danger w-full justify-center" onClick={() => removeStory.mutate(story.id)}>
              Delete story
            </button>
            <button className="btn btn-ghost w-full justify-center" onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </motion.div>,
    document.body,
  );
}

const QUICK_REACTIONS = ["😂", "😮", "😍", "😢", "👏", "🔥", "🎉", "💯"] as const;

/**
 * Reply bar under someone else's story: a row of quick reactions and a message
 * field. A reply becomes an ordinary DM carrying the story as context, so the
 * conversation continues in the normal inbox.
 */
function StoryComposerBar({
  story,
  authorName,
  onFocusChange,
  onSent,
}: {
  story: Story;
  authorName: string;
  onFocusChange: (paused: boolean) => void;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [reaction, setReaction] = useState<string | null>(story.myReaction);
  const [showAll, setShowAll] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  // Reset when the viewer advances to a different story.
  useEffect(() => {
    setReaction(story.myReaction);
    setBody("");
    setShowAll(false);
  }, [story.id, story.myReaction]);

  async function react(emoji: string) {
    const next = reaction === emoji ? null : emoji;
    setReaction(next);
    setShowAll(false);
    try {
      if (next) await post(`/stories/${story.id}/react`, { emoji });
      else await del(`/stories/${story.id}/react`);
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
    } catch (err) {
      setReaction(story.myReaction);
      toast(err instanceof Error ? err.message : "Could not react.", "error");
    }
  }

  async function send() {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try {
      await post(`/stories/${story.id}/reply`, { body: text });
      setBody("");
      onSent();
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["unread", "messages"] });
      toast(`Sent to @${authorName}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send the reply.", "error");
    } finally {
      setSending(false);
    }
  }

  const visible = showAll ? QUICK_REACTIONS : QUICK_REACTIONS.slice(0, 5);

  return (
    <footer
      className="absolute inset-x-0 bottom-0 z-20 space-y-2 bg-gradient-to-t from-black/70 to-transparent p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-center gap-1.5">
        {visible.map((emoji) => (
          <button
            key={emoji}
            onClick={() => void react(emoji)}
            aria-label={`React ${emoji}`}
            className={`press rounded-full text-2xl leading-none transition ${
              reaction === emoji ? "scale-110 bg-white/25 p-1.5" : "p-1.5 hover:bg-white/15"
            }`}
          >
            {emoji}
          </button>
        ))}
        {!showAll && (
          <button
            onClick={() => setShowAll(true)}
            aria-label="More reactions"
            className="press rounded-full p-2 text-white/70 hover:bg-white/15"
          >
            <Plus size={16} />
          </button>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-center gap-2"
      >
        <input
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 1000))}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          placeholder={`Reply to ${authorName}…`}
          aria-label="Reply to story"
          className="min-w-0 flex-1 rounded-full border border-white/30 bg-white/10 px-4 py-2.5 text-sm text-white placeholder:text-white/60 focus:border-white/60 focus:outline-none"
        />
        {body.trim() && (
          <button
            type="submit"
            disabled={sending}
            aria-label="Send reply"
            className="press shrink-0 rounded-full bg-white p-2.5 text-black disabled:opacity-60"
          >
            {sending ? <Spinner size={16} /> : <Send size={16} />}
          </button>
        )}
      </form>
    </footer>
  );
}

function StoryViewersDialog({ open, onClose, storyId }: { open: boolean; onClose: () => void; storyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["story-viewers", storyId],
    queryFn: () => get<{ users: (UserCard & { viewedAt: number; reaction: string | null })[] }>(`/stories/${storyId}/viewers`),
    enabled: open,
  });

  return (
    <Modal open={open} onClose={onClose} title="Viewers" size="sm">
      <div className="min-h-[10rem] overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-xl" />
            ))}
          </div>
        ) : data?.users.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">No views yet.</p>
        ) : (
          data?.users.map((user) => (
            <Link
              key={user.id}
              to={`/${user.username}`}
              onClick={onClose}
              className="flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-raised"
            >
              <Avatar user={user} size={38} link={false} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{user.username}</p>
                <p className="truncate text-xs text-muted">{user.displayName}</p>
              </div>
              {user.reaction && <span className="text-lg leading-none">{user.reaction}</span>}
              <span className="text-xs text-faint">{shortAgo(user.viewedAt)}</span>
            </Link>
          ))
        )}
      </div>
    </Modal>
  );
}

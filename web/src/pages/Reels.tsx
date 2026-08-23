import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  Bookmark,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Flag,
  FolderPlus,
  Heart,
  Link as LinkIcon,
  MessageCircle,
  MoreHorizontal,
  Repeat2,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { get } from "../lib/api.ts";
import { compactCount } from "../lib/time.ts";
import { RichText } from "../lib/text.tsx";
import { useComposer } from "../lib/ui.tsx";
import { useToast } from "../lib/toast.tsx";
import type { Post } from "../lib/types.ts";
import { useIsDesktop } from "../hooks/useMediaQuery.ts";
import { usePostActions } from "../hooks/usePostActions.ts";
import { Avatar } from "../components/Avatar.tsx";
import { CollectionPicker } from "../components/CollectionPicker.tsx";
import { usePostNavState } from "../components/PostLink.tsx";
import { FollowButton } from "../components/FollowButton.tsx";
import { Menu } from "../components/Menu.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { ReportDialog } from "../components/ReportDialog.tsx";
import { ShareDialog } from "../components/ShareDialog.tsx";
import { CommentsDialog } from "../components/CommentsDialog.tsx";
import { EmptyState, Spinner } from "../components/States.tsx";
import { VideoPlayer, useSoundPreference } from "../components/VideoPlayer.tsx";

type ReelsPage = { reels: Post[]; nextOffset: number | null };

/**
 * Reels: one video per screen, advanced by scrolling.
 *
 * Built on CSS scroll-snap rather than a JS pager so the gesture is the
 * platform's own — momentum, trackpads, keyboards and touch all behave
 * correctly for free. Only the reel in view plays; the next one is mounted but
 * paused so its first frames are already buffered when it arrives.
 */
export function ReelsPage() {
  const [params] = useSearchParams();
  const seed = params.get("post") ?? "";
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Held here rather than inside a Reel: when the comments column opens, the
  // whole scroller narrows so the video slides out from under it.
  const [commentsFor, setCommentsFor] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["reels", seed],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      get<ReelsPage>(`/reels?offset=${pageParam}${seed ? `&seed=${encodeURIComponent(seed)}` : ""}`),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });

  const reels = useMemo(() => query.data?.pages.flatMap((p) => p.reels) ?? [], [query.data]);

  // Track which reel fills the viewport; that one plays.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            const index = Number((entry.target as HTMLElement).dataset.index);
            if (!Number.isNaN(index)) setActiveIndex(index);
          }
        }
      },
      { root, threshold: [0.6] },
    );
    for (const child of root.querySelectorAll("[data-index]")) observer.observe(child);
    return () => observer.disconnect();
  }, [reels.length]);

  // Fetch more once the viewer is near the end.
  useEffect(() => {
    if (activeIndex >= reels.length - 3 && query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [activeIndex, reels.length, query]);

  const go = useCallback(
    (delta: number) => {
      const root = containerRef.current;
      if (!root) return;
      const next = Math.max(0, Math.min(activeIndex + delta, reels.length - 1));
      root.children[next]?.scrollIntoView({ behavior: "smooth" });
    },
    [activeIndex, reels.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      }
      if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  if (query.isLoading) {
    return (
      <div className="flex h-[calc(100dvh-var(--tabbar-h))] items-center justify-center md:h-dvh">
        <Spinner size={24} className="text-muted" />
      </div>
    );
  }

  if (reels.length === 0) {
    return (
      <div className="flex h-[calc(100dvh-var(--tabbar-h))] items-center justify-center md:h-dvh">
        <ReelsEmpty />
      </div>
    );
  }

  return (
    <div
      className={`relative h-[calc(100dvh-var(--tabbar-h))] transition-[padding] duration-300 md:h-dvh ${
        commentsFor ? "lg:pr-[var(--reel-comments-w)]" : ""
      }`}
    >
      <div
        ref={containerRef}
        className="hide-scroll h-full snap-y snap-mandatory overflow-y-auto overscroll-contain"
      >
        {reels.map((reel, index) => (
          <div key={reel.id} data-index={index} className="flex h-full w-full snap-start snap-always items-center justify-center">
            <Reel
              post={reel}
              active={index === activeIndex}
              // The next reel stays mounted so its opening frames are buffered.
              preload={index === activeIndex + 1}
              commentsOpen={commentsFor === reel.id}
              onOpenComments={() => setCommentsFor(reel.id)}
              onCloseComments={() => setCommentsFor(null)}
            />
          </div>
        ))}
        {query.isFetchingNextPage && (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={20} className="text-muted" />
          </div>
        )}
      </div>

      {/* Desktop affordance: touch users just swipe. */}
      <div className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 flex-col gap-2 lg:flex">
        <button
          onClick={() => go(-1)}
          disabled={activeIndex === 0}
          aria-label="Previous reel"
          className="press pointer-events-auto rounded-full bg-surface/80 p-2.5 text-fg shadow-lg backdrop-blur transition hover:bg-surface disabled:opacity-30"
        >
          <ChevronUp size={18} />
        </button>
        <button
          onClick={() => go(1)}
          disabled={activeIndex >= reels.length - 1}
          aria-label="Next reel"
          className="press pointer-events-auto rounded-full bg-surface/80 p-2.5 text-fg shadow-lg backdrop-blur transition hover:bg-surface disabled:opacity-30"
        >
          <ChevronDown size={18} />
        </button>
      </div>
    </div>
  );
}

function ReelsEmpty() {
  const { openPostComposer } = useComposer();
  return (
    <EmptyState
      icon={<Sparkles size={22} />}
      title="No reels yet"
      message="Reels are posts with video. Share one and it will show up here."
      action={
        <button className="btn btn-primary" onClick={openPostComposer}>
          Post a video
        </button>
      }
    />
  );
}

function Reel({
  post,
  active,
  preload,
  commentsOpen,
  onOpenComments,
  onCloseComments,
}: {
  post: Post;
  active: boolean;
  preload: boolean;
  commentsOpen: boolean;
  onOpenComments: () => void;
  onCloseComments: () => void;
}) {
  const media = post.media[0];
  const { toggleLike, toggleRepost, toggleSave, remove, deleting } = usePostActions(post);
  const [sound, setSound] = useSoundPreference();
  const [showShare, setShowShare] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [burst, setBurst] = useState(0);
  const lastTap = useRef(0);
  const navigate = useNavigate();
  const postNavState = usePostNavState();
  const toast = useToast();
  const isDesktop = useIsDesktop();

  // A phone puts the thread on top of the clip, so playback pauses. On desktop
  // the video is merely beside it and should keep running.
  const playing = active && (isDesktop || !commentsOpen);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/p/${post.id}`);
      toast("Link copied", "success");
    } catch {
      toast("Could not copy the link.", "error");
    }
  }

  function onTap() {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      if (!post.viewer.liked) void toggleLike();
      setBurst((n) => n + 1);
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  }

  if (!media) return null;

  return (
    // Everything inside is absolutely positioned, so the card needs its own
    // size: a 9:16 column on desktop, capped so it never outgrows the window,
    // and edge-to-edge on a phone.
    <article className="relative h-full w-full overflow-hidden bg-black sm:mx-auto sm:my-auto sm:aspect-[9/16] sm:h-[min(100%,calc(100dvh-2rem),calc(26.5rem*16/9))] sm:w-auto sm:rounded-2xl">
      <div className="absolute inset-0" onClick={onTap}>
        <VideoPlayer
          media={media}
          active={playing}
          bufferAhead={preload}
          loop
          objectFit="contain"
          showControls={false}
          className="h-full w-full"
        />
      </div>

      {/* Double-tap heart */}
      <AnimatePresence>
        {burst > 0 && (
          <motion.div
            key={burst}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: [0, 1, 1, 0], scale: [0.4, 1.15, 1, 1.3] }}
            transition={{ duration: 0.85, times: [0, 0.2, 0.6, 1] }}
            onAnimationComplete={() => setBurst(0)}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <Heart size={96} className="fill-white text-white drop-shadow-[0_2px_14px_rgba(0,0,0,0.5)]" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Readability scrims, so white text works over any frame. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/50 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/75 to-transparent" />

      <button
        onClick={() => setSound(!sound)}
        aria-label={sound ? "Mute" : "Unmute"}
        className="press absolute right-3 top-3 z-10 rounded-full bg-black/45 p-2 text-white backdrop-blur"
      >
        {sound && media.hasAudio ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>

      {/* Action rail. Above the caption block, which shares its bottom edge. */}
      <div className="absolute bottom-24 right-3 z-20 flex flex-col items-center gap-4 text-white sm:bottom-6">
        <RailButton
          label={post.viewer.liked ? "Unlike" : "Like"}
          onClick={() => void toggleLike()}
          count={post.counts.likes}
        >
          <Heart size={26} className={post.viewer.liked ? "fill-[var(--danger)] text-danger" : ""} />
        </RailButton>
        <RailButton label="Comments" onClick={onOpenComments} count={post.counts.comments}>
          <MessageCircle size={26} />
        </RailButton>
        <RailButton
          label={post.viewer.reposted ? "Undo repost" : "Repost"}
          onClick={() => void toggleRepost()}
          count={post.counts.reposts}
        >
          <Repeat2 size={26} className={post.viewer.reposted ? "text-online" : ""} />
        </RailButton>
        <RailButton label="Share" onClick={() => setShowShare(true)}>
          <Send size={24} />
        </RailButton>
        <RailButton label={post.viewer.saved ? "Remove from saved" : "Save"} onClick={() => void toggleSave()}>
          <Bookmark size={24} className={post.viewer.saved ? "fill-white" : ""} />
        </RailButton>
        {/* Opens upward: the trigger sits at the bottom of a card that clips
            its overflow, so a downward menu would be invisible. */}
        <Menu
          side="top"
          trigger={<MoreHorizontal size={22} />}
          triggerClassName="press rounded-full p-1.5 text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.5)] transition hover:bg-white/15"
          items={[
            { label: "Open post", icon: <ExternalLink size={15} />, onSelect: () => navigate(`/p/${post.id}`, { state: postNavState }) },
            { label: "Copy link", icon: <LinkIcon size={15} />, onSelect: copyLink },
            {
              label: "Save to collection…",
              icon: <FolderPlus size={15} />,
              onSelect: () => setShowCollections(true),
            },
            {
              label: "Delete post",
              icon: <Trash2 size={15} />,
              danger: true,
              hidden: !post.viewer.isAuthor,
              onSelect: () => setShowDelete(true),
            },
            {
              label: "Report post",
              icon: <Flag size={15} />,
              danger: true,
              hidden: post.viewer.isAuthor,
              onSelect: () => setShowReport(true),
            },
          ]}
        />
      </div>

      {/* Author and caption. The block spans the full width for its gradient,
          but `pr-16` only moves the text — the box itself still sat over the
          bottom of the action rail and swallowed taps on Save and the menu, so
          it takes no pointer events except on the parts you can actually use. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-4 pb-6 pr-16 text-white sm:pb-5">
        <div className="pointer-events-auto flex w-fit items-center gap-2.5">
          <Avatar user={post.author} size={34} />
          <Link to={`/${post.author.username}`} className="-my-1 py-1 text-sm font-semibold hover:underline">
            {post.author.username}
          </Link>
          <FollowButton
            userId={post.author.id}
            isPrivate={post.author.isPrivate}
            size="sm"
            relation={{
              isSelf: post.viewer.isAuthor,
              isFollowing: post.viewer.followsAuthor,
              isRequested: post.viewer.requestedAuthor,
              followsYou: false,
              isBlocked: false,
              blockedYou: false,
              isMuted: false,
            }}
            className="!border-white/60 !bg-transparent !text-white"
          />
        </div>
        {post.caption && (
          <p
            className={`pointer-events-auto mt-2 text-sm leading-snug ${expanded ? "" : "line-clamp-2"}`}
            onClick={() => setExpanded((v) => !v)}
          >
            <RichText text={post.caption} />
          </p>
        )}
      </div>

      <ShareDialog open={showShare} onClose={() => setShowShare(false)} postId={post.id} />
      <CommentsDialog open={commentsOpen} onClose={onCloseComments} post={post} />
      <CollectionPicker open={showCollections} onClose={() => setShowCollections(false)} postId={post.id} />
      <ReportDialog
        open={showReport}
        onClose={() => setShowReport(false)}
        targetType="post"
        targetId={post.id}
        targetLabel={`@${post.author.username}'s reel`}
      />
      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={async () => {
          if (await remove()) setShowDelete(false);
        }}
        busy={deleting}
        title="Delete this reel?"
        message="This removes the post, its video, likes and comments. It cannot be undone."
        confirmLabel="Delete post"
      />
    </article>
  );
}

function RailButton({
  children,
  label,
  count,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} aria-label={label} className="press flex flex-col items-center gap-1">
      <span className="drop-shadow-[0_1px_4px_rgba(0,0,0,0.5)]">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[11px] font-semibold drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
          {compactCount(count)}
        </span>
      )}
    </button>
  );
}

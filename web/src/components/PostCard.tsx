import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  Bookmark,
  Flag,
  FolderPlus,
  Heart,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Quote,
  Repeat2,
  Send,
  Trash2,
  VolumeX,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { patch, post as post_ } from "../lib/api.ts";
import { patchPost } from "../lib/postCache.ts";
import { compactCount, longAgo, shortAgo } from "../lib/time.ts";
import { RichText } from "../lib/text.tsx";
import { useAuth } from "../lib/auth.tsx";
import { useComposer } from "../lib/ui.tsx";
import { useToast } from "../lib/toast.tsx";
import type { Post } from "../lib/types.ts";
import { usePostActions } from "../hooks/usePostActions.ts";
import { Avatar } from "./Avatar.tsx";
import { Carousel } from "./Carousel.tsx";
import { CollectionPicker } from "./CollectionPicker.tsx";
import { CommentComposer, CommentPreview } from "./Comments.tsx";
import { LikesDialog } from "./LikesDialog.tsx";
import { Menu } from "./Menu.tsx";
import { ConfirmDialog, Modal } from "./Modal.tsx";
import { QuotedPost } from "./QuotedPost.tsx";
import { ReportDialog } from "./ReportDialog.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { Spinner } from "./States.tsx";
import { PostLink, usePostNavState } from "./PostLink.tsx";

export function PostCard({ post, eager = false }: { post: Post; eager?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { openQuoteComposer } = useComposer();
  const { toggleLike, toggleRepost, toggleSave, remove, deleting } = usePostActions(post);
  const queryClient = useQueryClient();
  const toast = useToast();
  const postNavState = usePostNavState();

  async function mute() {
    try {
      await post_(`/users/${post.author.id}/mute`);
      toast(`You will not see @${post.author.username} in your feed`, "success");
      // Drop them out of every list this viewer is looking at.
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
      void queryClient.invalidateQueries({ queryKey: ["explore"] });
      void queryClient.invalidateQueries({ queryKey: ["reels"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not mute.", "error");
    }
  }
  const [showLikes, setShowLikes] = useState(false);
  const [showReposts, setShowReposts] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [burst, setBurst] = useState(0);
  const lastTap = useRef(0);

  const isMine = user?.id === post.author.id;
  const longCaption = post.caption.length > 180 || post.caption.split("\n").length > 3;

  function heartBurst() {
    setBurst((n) => n + 1);
    if (!post.viewer.liked) void toggleLike();
    if (navigator.vibrate) navigator.vibrate(8);
  }

  /** Double-tap on touch, double-click on pointer devices. */
  function onMediaTap() {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      heartBurst();
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  }

  return (
    <article className="card animate-[rise_0.34s_cubic-bezier(0.22,1,0.36,1)] overflow-hidden">
      {/* Why this post is in your feed, when it arrived via someone's repost. */}
      {post.repostedBy && (
        <Link
          to={`/${post.repostedBy.username}`}
          className="flex items-center gap-2 border-b border-line px-3.5 py-2 text-xs font-medium text-muted transition hover:text-fg"
        >
          <Repeat2 size={14} />
          {post.repostedBy.isSelf ? "You reposted" : `${post.repostedBy.username} reposted`}
        </Link>
      )}

      <header className="flex items-center gap-3 px-3.5 py-3">
        <Avatar user={post.author} size={38} showOnline />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5">
            {/* -my-1 py-1: a bigger finger target without a taller row. */}
            <Link to={`/${post.author.username}`} className="-my-1 truncate py-1 text-sm font-semibold hover:underline">
              {post.author.username}
            </Link>
            <span className="text-faint">·</span>
            <PostLink postId={post.id} className="-my-1 shrink-0 px-1.5 py-1 text-xs text-muted hover:underline" title={longAgo(post.createdAt)}>
              {shortAgo(post.createdAt)}
            </PostLink>
          </div>
          {post.location ? (
            <p className="flex items-center gap-1 truncate text-xs text-muted">
              <MapPin size={11} className="shrink-0" />
              {post.location}
            </p>
          ) : (
            <p className="truncate text-xs text-muted">{post.author.displayName}</p>
          )}
        </div>
        <Menu
          trigger={<MoreHorizontal size={19} />}
          items={[
            { label: "Edit post", icon: <Pencil size={15} />, onSelect: () => setShowEdit(true), hidden: !isMine },
            { label: "Delete post", icon: <Trash2 size={15} />, danger: true, onSelect: () => setShowDelete(true), hidden: !isMine },
            { label: "Save to collection…", icon: <FolderPlus size={15} />, onSelect: () => setShowCollections(true) },
            { label: "Share", icon: <Send size={15} />, onSelect: () => setShowShare(true) },
            {
              label: `Mute @${post.author.username}`,
              icon: <VolumeX size={15} />,
              hidden: isMine || post.viewer.isMuted,
              onSelect: () => void mute(),
            },
            { label: "Report post", icon: <Flag size={15} />, danger: true, onSelect: () => setShowReport(true), hidden: isMine },
          ]}
        />
      </header>

      {/* A quote repost may carry no images of its own; the quoted card below
          supplies the visual instead of an empty carousel. */}
      <div className={`relative ${post.media.length === 0 ? "hidden" : ""}`} onClick={onMediaTap}>
        <Carousel media={post.media} onDoubleClick={heartBurst} eager={eager} />
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
              <Heart size={92} className="fill-white text-white drop-shadow-[0_2px_14px_rgba(0,0,0,0.45)]" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="px-3.5 pb-3.5 pt-2.5">
        <div className="flex items-center gap-1">
          <ActionButton
            label={post.viewer.liked ? "Unlike" : "Like"}
            onClick={() => void toggleLike()}
            active={post.viewer.liked}
          >
            <Heart size={22} className={post.viewer.liked ? "fill-[var(--danger)] text-danger" : ""} />
          </ActionButton>
          <ActionButton label="Comments" onClick={() => navigate(`/p/${post.id}`, { state: postNavState })}>
            <MessageCircle size={22} />
          </ActionButton>
          <Menu
            align="left"
            label="Repost options"
            trigger={
              <Repeat2
                size={22}
                className={post.viewer.reposted ? "text-online" : ""}
                strokeWidth={post.viewer.reposted ? 2.5 : 2}
              />
            }
            items={[
              {
                label: post.viewer.reposted ? "Undo repost" : "Repost",
                icon: <Repeat2 size={15} />,
                onSelect: () => void toggleRepost(),
                hidden: isMine,
              },
              { label: "Quote post", icon: <Quote size={15} />, onSelect: () => openQuoteComposer(post) },
            ]}
          />
          <ActionButton label="Share" onClick={() => setShowShare(true)}>
            <Send size={21} />
          </ActionButton>
          <div className="flex-1" />
          <ActionButton
            label={post.viewer.saved ? "Remove from saved" : "Save"}
            onClick={() => void toggleSave()}
            active={post.viewer.saved}
          >
            <Bookmark size={21} className={post.viewer.saved ? "fill-current" : ""} />
          </ActionButton>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {post.counts.likes > 0 && (
            <button onClick={() => setShowLikes(true)} className="-my-1 py-1 text-sm font-semibold transition hover:text-muted">
              {compactCount(post.counts.likes)} {post.counts.likes === 1 ? "like" : "likes"}
            </button>
          )}
          {post.counts.reposts > 0 && (
            <button onClick={() => setShowReposts(true)} className="-my-1 py-1 text-sm font-semibold transition hover:text-muted">
              {compactCount(post.counts.reposts)} {post.counts.reposts === 1 ? "repost" : "reposts"}
            </button>
          )}
          {post.counts.quotes > 0 && (
            <span className="text-sm text-muted">
              {compactCount(post.counts.quotes)} {post.counts.quotes === 1 ? "quote" : "quotes"}
            </span>
          )}
        </div>

        {post.caption && (
          <div className="mt-1.5 text-sm leading-relaxed">
            <Link to={`/${post.author.username}`} className="mr-1.5 font-semibold hover:underline">
              {post.author.username}
            </Link>
            <RichText
              text={longCaption && !expanded ? `${post.caption.slice(0, 180).trimEnd()}…` : post.caption}
            />
            {longCaption && !expanded && (
              <button onClick={() => setExpanded(true)} className="ml-1 text-muted hover:underline">
                more
              </button>
            )}
            {post.editedAt && <span className="ml-1.5 text-xs text-faint">(edited)</span>}
          </div>
        )}

        {(post.quotedPost || post.quotedUnavailable) && (
          <QuotedPost post={post.quotedPost} unavailable={post.quotedUnavailable} />
        )}

        <CommentPreview post={post} />

        <PostLink
          postId={post.id}
          className="mt-2 block text-[11px] uppercase tracking-wide text-faint transition hover:text-muted"
          title={longAgo(post.createdAt)}
        >
          {longAgo(post.createdAt)}
        </PostLink>
      </div>

      <div className="hidden border-t border-line px-3.5 sm:block">
        <CommentComposer postId={post.id} />
      </div>

      <LikesDialog open={showLikes} onClose={() => setShowLikes(false)} postId={post.id} />
      <LikesDialog open={showReposts} onClose={() => setShowReposts(false)} postId={post.id} kind="reposts" />
      <CollectionPicker open={showCollections} onClose={() => setShowCollections(false)} postId={post.id} />
      <ShareDialog open={showShare} onClose={() => setShowShare(false)} postId={post.id} />
      <ReportDialog open={showReport} onClose={() => setShowReport(false)} targetType="post" targetId={post.id} targetLabel="post" />
      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={async () => {
          const ok = await remove();
          if (ok) setShowDelete(false);
        }}
        busy={deleting}
        title="Delete this post?"
        message={`This removes the post, its ${post.media[0]?.kind === "video" ? "video" : "images"}, likes and comments. It cannot be undone.`}
        confirmLabel="Delete post"
      />
      <EditPostDialog post={post} open={showEdit} onClose={() => setShowEdit(false)} />
    </article>
  );
}

function ActionButton({
  children,
  label,
  onClick,
  active = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`press -m-0.5 rounded-full p-2 transition-colors ${
        active ? "text-fg" : "text-fg hover:text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function EditPostDialog({ post, open, onClose }: { post: Post; open: boolean; onClose: () => void }) {
  const [caption, setCaption] = useState(post.caption);
  const [location, setLocation] = useState(post.location);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  async function save() {
    setBusy(true);
    try {
      const data = await patch<{ post: Post }>(`/posts/${post.id}`, { caption, location });
      patchPost(queryClient, data.post);
      toast("Post updated", "success");
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update post.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit post" size="md">
      <div className="space-y-3 overflow-y-auto p-5">
        <div className="flex gap-3">
          {post.media[0] && (
            <img src={post.media[0].thumb} alt="" className="h-20 w-20 rounded-xl object-cover" />
          )}
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value.slice(0, 2200))}
            rows={4}
            placeholder="Write a caption…"
            className="field flex-1 resize-none"
          />
        </div>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value.slice(0, 80))}
          placeholder="Add a location"
          className="field"
        />
        <p className="text-right text-xs text-faint">{caption.length}/2200</p>
        <div className="flex gap-2">
          <button className="btn btn-ghost flex-1 justify-center" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary flex-1 justify-center" onClick={save} disabled={busy}>
            {busy ? <Spinner size={15} /> : "Save changes"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, Flag, Heart, MapPin, MessageCircle, MoreHorizontal, Quote, Repeat2, Send, Trash2 } from "lucide-react";
import { ApiError, get } from "../lib/api.ts";
import { compactCount, longAgo } from "../lib/time.ts";
import { RichText } from "../lib/text.tsx";
import { useAuth } from "../lib/auth.tsx";
import { useComposer } from "../lib/ui.tsx";
import type { Post } from "../lib/types.ts";
import { usePostActions } from "../hooks/usePostActions.ts";
import { Avatar } from "../components/Avatar.tsx";
import { Carousel, frameRatio } from "../components/Carousel.tsx";
import { CommentComposer, CommentList } from "../components/Comments.tsx";
import { LikesDialog } from "../components/LikesDialog.tsx";
import { Menu } from "../components/Menu.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { QuotedPost } from "../components/QuotedPost.tsx";
import { ReportDialog } from "../components/ReportDialog.tsx";
import { ShareDialog } from "../components/ShareDialog.tsx";
import { EmptyState, ErrorState, Skeleton } from "../components/States.tsx";

export function PostPage({ postId, inDialog = false }: { postId?: string; inDialog?: boolean } = {}) {
  const params = useParams();
  // In the overlay there is no matched route to read params from, so the id is
  // handed in by whoever opened it.
  const id = postId ?? params.id ?? "";
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["post", id],
    queryFn: () => get<{ post: Post }>(`/posts/${id}`),
    retry: (count, err) => !(err instanceof ApiError && [403, 404].includes(err.status)) && count < 2,
  });

  if (isLoading) return <PostPageSkeleton inDialog={inDialog} />;

  if (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <div className="mx-auto max-w-lg">
        <PageHeader title="Post" back />
        <EmptyState
          title={status === 403 ? "This post is private" : "This post isn’t available"}
          message={
            status === 403
              ? "Only people the author approves can see it."
              : "It may have been deleted, or the link may be wrong."
          }
          action={
            <Link to="/" className="btn btn-ghost">
              Back to feed
            </Link>
          }
        />
      </div>
    );
  }

  if (!data) return <ErrorState error={new Error("No data")} onRetry={() => void refetch()} />;
  return <PostDetail post={data.post} inDialog={inDialog} />;
}

function PostDetail({ post, inDialog = false }: { post: Post; inDialog?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { openQuoteComposer } = useComposer();
  const { toggleLike, toggleRepost, toggleSave, remove, deleting } = usePostActions(post);
  const [showLikes, setShowLikes] = useState(false);
  const [showReposts, setShowReposts] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const isMine = user?.id === post.author.id;
  // The same ratio the carousel uses, so the column and the picture agree.
  const mediaRatio = post.media.length > 0 ? frameRatio(post.media, 0.5) : 1;

  return (
    <div className={`mx-auto w-full max-w-[70rem] ${inDialog ? "" : "pb-8 sm:px-6"}`}>
      {/* Standalone, this is the only way back — so unlike other pages it stays
          visible at every width, not just on a phone. */}
      {!inDialog && <PageHeader title="Post" back backAlways />}

      <div className={inDialog ? "" : "sm:py-6"}>
        <div
          className="post-layout overflow-hidden border-y border-line bg-surface sm:rounded-2xl sm:border"
          // The media's own shape drives the column width; see .post-layout.
          style={{ "--post-media-ratio": String(mediaRatio) } as React.CSSProperties}
        >
          {/* ------------------------------------------------------- media */}
          <div className="flex items-center bg-black/[0.03] dark:bg-black/25">
            {/* The post is the whole page here, so tall media is allowed to
                stay tall — only the window height caps it. */}
            {post.media.length > 0 ? (
              <Carousel
                media={post.media}
                onDoubleClick={() => !post.viewer.liked && toggleLike()}
                eager
                className="w-full"
                minRatio={0.5}
                maxHeight="var(--post-media-h, 82dvh)"
              />
            ) : (
              // A quote repost with no images of its own leads with the quote.
              <div className="w-full p-5">
                <QuotedPost post={post.quotedPost} unavailable={post.quotedUnavailable} />
              </div>
            )}
          </div>

          {/* ------------------------------------------------------ details */}
          <div className="flex min-h-0 flex-col lg:max-h-[min(80vh,44rem)] lg:h-full">
            <header className="flex items-center gap-3 border-b border-line px-4 py-3">
              <Avatar user={post.author} size={38} showOnline />
              <div className="min-w-0 flex-1">
                <Link to={`/${post.author.username}`} className="block truncate text-sm font-semibold hover:underline">
                  {post.author.username}
                </Link>
                {post.location ? (
                  <p className="flex items-center gap-1 truncate text-xs text-muted">
                    <MapPin size={11} /> {post.location}
                  </p>
                ) : (
                  <p className="truncate text-xs text-muted">{post.author.displayName}</p>
                )}
              </div>
              <Menu
                trigger={<MoreHorizontal size={19} />}
                items={[
                  { label: "Share", icon: <Send size={15} />, onSelect: () => setShowShare(true) },
                  {
                    label: "Delete post",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    hidden: !isMine,
                    onSelect: () => setShowDelete(true),
                  },
                  {
                    label: "Report post",
                    icon: <Flag size={15} />,
                    danger: true,
                    hidden: isMine,
                    onSelect: () => setShowReport(true),
                  },
                ]}
              />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4">
              {post.caption && (
                <div className="flex gap-2.5 py-3.5">
                  <Avatar user={post.author} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed">
                      <Link to={`/${post.author.username}`} className="mr-1.5 font-semibold hover:underline">
                        {post.author.username}
                      </Link>
                      <RichText text={post.caption} />
                    </p>
                    <p className="mt-1 text-xs text-faint">
                      {longAgo(post.createdAt)}
                      {post.editedAt && " · edited"}
                    </p>
                  </div>
                </div>
              )}

              {post.media.length > 0 && (post.quotedPost || post.quotedUnavailable) && (
                <div className="pb-3">
                  <QuotedPost post={post.quotedPost} unavailable={post.quotedUnavailable} />
                </div>
              )}

              <div className="border-t border-line">
                <CommentList postId={post.id} postAuthorId={post.author.id} />
              </div>
            </div>

            <div className="border-t border-line px-4 pt-2.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void toggleLike()}
                  aria-label={post.viewer.liked ? "Unlike" : "Like"}
                  className="press -m-0.5 rounded-full p-2"
                >
                  <Heart size={22} className={post.viewer.liked ? "fill-[var(--danger)] text-danger" : ""} />
                </button>
                <span className="press -m-0.5 rounded-full p-2 text-muted">
                  <MessageCircle size={22} />
                </span>
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
                <button onClick={() => setShowShare(true)} aria-label="Share" className="press -m-0.5 rounded-full p-2">
                  <Send size={21} />
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => void toggleSave()}
                  aria-label={post.viewer.saved ? "Remove from saved" : "Save"}
                  className="press -m-0.5 rounded-full p-2"
                >
                  <Bookmark size={21} className={post.viewer.saved ? "fill-current" : ""} />
                </button>
              </div>

              <div className="mt-1.5 flex items-baseline gap-3 pb-1">
                {post.counts.likes > 0 ? (
                  <button onClick={() => setShowLikes(true)} className="text-sm font-semibold hover:text-muted">
                    {compactCount(post.counts.likes)} {post.counts.likes === 1 ? "like" : "likes"}
                  </button>
                ) : (
                  <span className="text-sm text-muted">Be the first to like this</span>
                )}
                {post.counts.reposts > 0 && (
                  <button onClick={() => setShowReposts(true)} className="text-sm font-semibold hover:text-muted">
                    {compactCount(post.counts.reposts)} {post.counts.reposts === 1 ? "repost" : "reposts"}
                  </button>
                )}
                <span className="text-xs text-faint">{longAgo(post.createdAt)}</span>
              </div>

              <div className="border-t border-line">
                <CommentComposer postId={post.id} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <LikesDialog open={showLikes} onClose={() => setShowLikes(false)} postId={post.id} />
      <LikesDialog open={showReposts} onClose={() => setShowReposts(false)} postId={post.id} kind="reposts" />
      <ShareDialog open={showShare} onClose={() => setShowShare(false)} postId={post.id} />
      <ReportDialog open={showReport} onClose={() => setShowReport(false)} targetType="post" targetId={post.id} targetLabel="post" />
      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={async () => {
          const ok = await remove();
          if (ok) navigate("/");
        }}
        busy={deleting}
        title="Delete this post?"
        message={`This removes the post, its ${post.media[0]?.kind === "video" ? "video" : "images"}, likes and comments. It cannot be undone.`}
        confirmLabel="Delete post"
      />
    </div>
  );
}

function PostPageSkeleton({ inDialog = false }: { inDialog?: boolean }) {
  return (
    <div className={`mx-auto w-full max-w-[70rem] ${inDialog ? "" : "sm:px-6 sm:py-6"}`}>
      <div className="overflow-hidden border-y border-line bg-surface sm:rounded-2xl sm:border lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(21rem,0.65fr)]">
        <Skeleton className="aspect-square w-full rounded-none" />
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-3.5 w-28" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    </div>
  );
}

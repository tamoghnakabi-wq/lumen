import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Flag, Heart, MoreHorizontal, Trash2 } from "lucide-react";
import { del, get, post as postJson } from "../lib/api.ts";
import { patchPost } from "../lib/postCache.ts";
import { shortAgo } from "../lib/time.ts";
import { RichText } from "../lib/text.tsx";
import { useAuth } from "../lib/auth.tsx";
import { useToast } from "../lib/toast.tsx";
import type { Comment, CommentSort, Post } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { MentionInput } from "./MentionInput.tsx";
import { Menu } from "./Menu.tsx";
import { ReportDialog } from "./ReportDialog.tsx";
import { EmptyState, Spinner } from "./States.tsx";
import { PostLink } from "./PostLink.tsx";

type CommentPage = { comments: Comment[]; nextCursor: number | null; sort: CommentSort };

/** The one or two most recent comments shown under a feed post. */
export function CommentPreview({ post }: { post: Post }) {
  if (post.counts.comments === 0) return null;
  return (
    <PostLink postId={post.id} className="mt-1.5 block text-sm text-muted transition hover:text-fg">
      View {post.counts.comments === 1 ? "1 comment" : `all ${post.counts.comments} comments`}
    </PostLink>
  );
}

/** Nudges the post's comment counter after a write, wherever that post is cached. */
function bumpCommentCount(queryClient: ReturnType<typeof useQueryClient>, postId: string, delta: number) {
  for (const [, data] of queryClient.getQueriesData({ predicate: () => true })) {
    const any = data as any;
    if (!any || typeof any !== "object") continue;
    const lists: Post[][] = [];
    if (Array.isArray(any.pages)) for (const page of any.pages) if (Array.isArray(page?.posts)) lists.push(page.posts);
    if (Array.isArray(any.posts)) lists.push(any.posts);
    if (any.post) lists.push([any.post]);
    for (const list of lists) {
      const hit = list.find((p) => p?.id === postId);
      if (hit) {
        patchPost(queryClient, {
          ...hit,
          counts: { ...hit.counts, comments: Math.max(0, hit.counts.comments + delta) },
        });
        return;
      }
    }
  }
}

export function CommentComposer({
  postId,
  parentId = null,
  autoFocus = false,
  placeholder = "Add a comment…",
  onDone,
}: {
  postId: string;
  parentId?: string | null;
  autoFocus?: boolean;
  placeholder?: string;
  onDone?: (comment: Comment) => void;
}) {
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();

  const mutation = useMutation({
    mutationFn: () => postJson<{ comment: Comment }>(`/posts/${postId}/comments`, { body, parentId }),
    onSuccess: ({ comment }) => {
      setBody("");
      if (parentId) {
        // Drop it into the open reply thread and bump the parent's reply count.
        queryClient.setQueryData(["replies", parentId], (old: { replies: Comment[] } | undefined) =>
          old ? { ...old, replies: [...old.replies, comment] } : old,
        );
        queryClient.setQueriesData({ queryKey: ["comments", postId] }, (old: any) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page: CommentPage) => ({
              ...page,
              comments: page.comments.map((c) =>
                c.id === parentId ? { ...c, counts: { ...c.counts, replies: c.counts.replies + 1 } } : c,
              ),
            })),
          };
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: ["comments", postId] });
      }
      bumpCommentCount(queryClient, postId, 1);
      onDone?.(comment);
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Could not post comment.", "error"),
  });

  if (!user) return null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) mutation.mutate();
      }}
      className="flex items-center gap-2 py-2.5"
    >
      <Avatar user={user} size={28} link={false} />
      <MentionInput
        value={body}
        onChange={setBody}
        maxLength={1000}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label="Write a comment"
        onSubmit={() => body.trim() && mutation.mutate()}
      />
      {body.trim() && (
        <button
          type="submit"
          disabled={mutation.isPending}
          className="shrink-0 text-sm font-semibold text-accent transition hover:opacity-70 disabled:opacity-50"
        >
          {mutation.isPending ? <Spinner size={14} /> : "Post"}
        </button>
      )}
    </form>
  );
}

export function CommentList({ postId, postAuthorId }: { postId: string; postAuthorId: string }) {
  const [sort, setSort] = useState<CommentSort>("top");
  const [replyTo, setReplyTo] = useState<{ id: string; username: string } | null>(null);

  // Only top-level comments are paged in; replies load when a thread is opened.
  const query = useInfiniteQuery({
    queryKey: ["comments", postId, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<CommentPage>(`/posts/${postId}/comments?sort=${sort}&cursor=${pageParam}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const comments = query.data?.pages.flatMap((p) => p.comments) ?? [];

  if (query.isLoading) {
    return (
      <div className="space-y-3 py-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-2.5">
            <div className="skeleton h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (comments.length === 0) {
    return <EmptyState title="No comments yet" message="Start the conversation." />;
  }

  return (
    <div className="py-3">
      <div className="mb-1 flex items-center gap-1 text-xs">
        <span className="text-muted">Sort</span>
        {(["top", "new"] as const).map((option) => (
          <button
            key={option}
            onClick={() => setSort(option)}
            className={`rounded-full px-2 py-0.5 font-medium transition ${
              sort === option ? "bg-raised text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {option === "top" ? "Top" : "Newest"}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {comments.map((comment) => (
          <div key={comment.id}>
            <CommentRow
              comment={comment}
              postId={postId}
              postAuthorId={postAuthorId}
              sort={sort}
              onReply={() => setReplyTo({ id: comment.id, username: comment.author.username })}
            />
            <ReplyThread
              parent={comment}
              postId={postId}
              postAuthorId={postAuthorId}
              sort={sort}
              replyingTo={replyTo?.id === comment.id ? replyTo.username : null}
              onReply={(username) => setReplyTo({ id: comment.id, username })}
              onDone={() => setReplyTo(null)}
            />
          </div>
        ))}
      </div>

      {query.hasNextPage && (
        <button
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="mt-4 text-sm font-medium text-muted transition hover:text-fg"
        >
          {query.isFetchingNextPage ? <Spinner size={14} /> : "Load more comments"}
        </button>
      )}
    </div>
  );
}

/** Replies stay collapsed until asked for — a long thread should not bury the post. */
function ReplyThread({
  parent,
  postId,
  postAuthorId,
  sort,
  replyingTo,
  onReply,
  onDone,
}: {
  parent: Comment;
  postId: string;
  postAuthorId: string;
  sort: CommentSort;
  replyingTo: string | null;
  onReply: (username: string) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasReplies = parent.counts.replies > 0;

  const query = useQuery({
    queryKey: ["replies", parent.id],
    queryFn: () => get<{ replies: Comment[]; nextCursor: number | null }>(`/comments/${parent.id}/replies`),
    enabled: open,
  });

  if (!hasReplies && !replyingTo) return null;

  return (
    <div className="ml-10 mt-2 space-y-3 border-l border-line pl-3">
      {hasReplies && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted transition hover:text-fg"
        >
          <ChevronDown size={13} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
          {open ? "Hide" : "View"} {parent.counts.replies} {parent.counts.replies === 1 ? "reply" : "replies"}
        </button>
      )}

      {open && query.isLoading && <Spinner size={14} className="text-muted" />}
      {open &&
        query.data?.replies.map((reply) => (
          <CommentRow
            key={reply.id}
            comment={reply}
            postId={postId}
            postAuthorId={postAuthorId}
            sort={sort}
            parentId={parent.id}
            onReply={() => onReply(reply.author.username)}
            compact
          />
        ))}

      {replyingTo && (
        <CommentComposer
          postId={postId}
          parentId={parent.id}
          autoFocus
          placeholder={`Reply to @${replyingTo}…`}
          onDone={() => {
            setOpen(true);
            onDone();
          }}
        />
      )}
    </div>
  );
}

function CommentRow({
  comment,
  postId,
  postAuthorId,
  sort,
  parentId,
  onReply,
  compact = false,
}: {
  comment: Comment;
  postId: string;
  postAuthorId: string;
  sort: CommentSort;
  parentId?: string;
  onReply: () => void;
  compact?: boolean;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [showReport, setShowReport] = useState(false);
  const canDelete = user?.id === comment.author.id || user?.id === postAuthorId;

  function replaceComment(next: Comment) {
    if (parentId) {
      queryClient.setQueryData(["replies", parentId], (old: { replies: Comment[] } | undefined) =>
        old ? { ...old, replies: old.replies.map((c) => (c.id === next.id ? next : c)) } : old,
      );
      return;
    }
    queryClient.setQueriesData({ queryKey: ["comments", postId, sort] }, (old: any) => {
      if (!old?.pages) return old;
      return {
        ...old,
        pages: old.pages.map((page: CommentPage) => ({
          ...page,
          comments: page.comments.map((c) => (c.id === next.id ? next : c)),
        })),
      };
    });
  }

  async function toggleLike() {
    const liked = comment.viewer.liked;
    replaceComment({
      ...comment,
      viewer: { liked: !liked },
      counts: { ...comment.counts, likes: Math.max(0, comment.counts.likes + (liked ? -1 : 1)) },
    });
    try {
      const data = liked
        ? await del<{ comment: Comment }>(`/comments/${comment.id}/like`)
        : await postJson<{ comment: Comment }>(`/comments/${comment.id}/like`);
      replaceComment(data.comment);
    } catch (err) {
      replaceComment(comment);
      toast(err instanceof Error ? err.message : "Could not like comment.", "error");
    }
  }

  async function remove() {
    try {
      await del(`/comments/${comment.id}`);
      // A deleted parent takes its replies with it, so refetch rather than guess.
      void queryClient.invalidateQueries({ queryKey: ["comments", postId] });
      if (parentId) void queryClient.invalidateQueries({ queryKey: ["replies", parentId] });
      bumpCommentCount(queryClient, postId, -1 - (parentId ? 0 : comment.counts.replies));
      toast("Comment deleted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete comment.", "error");
    }
  }

  return (
    <div className="group flex gap-2.5">
      <Avatar user={comment.author} size={compact ? 26 : 32} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed">
          <Link to={`/${comment.author.username}`} className="mr-1.5 font-semibold hover:underline">
            {comment.author.username}
          </Link>
          <RichText text={comment.body} />
        </p>
        <div className="mt-1 flex items-center gap-3.5 text-xs text-muted">
          <span>{shortAgo(comment.createdAt)}</span>
          {comment.counts.likes > 0 && (
            <span>
              {comment.counts.likes} {comment.counts.likes === 1 ? "like" : "likes"}
            </span>
          )}
          <button onClick={onReply} className="font-medium transition hover:text-fg">
            Reply
          </button>
          <Menu
            align="left"
            trigger={<MoreHorizontal size={14} />}
            items={[
              { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove(), hidden: !canDelete },
              {
                label: "Report",
                icon: <Flag size={14} />,
                danger: true,
                onSelect: () => setShowReport(true),
                hidden: user?.id === comment.author.id,
              },
            ]}
          />
        </div>
      </div>
      <button
        onClick={() => void toggleLike()}
        aria-label={comment.viewer.liked ? "Unlike comment" : "Like comment"}
        className="press mt-1 h-fit p-1 text-muted transition hover:text-fg"
      >
        <Heart size={13} className={comment.viewer.liked ? "fill-[var(--danger)] text-danger" : ""} />
      </button>
      <ReportDialog
        open={showReport}
        onClose={() => setShowReport(false)}
        targetType="comment"
        targetId={comment.id}
        targetLabel="comment"
      />
    </div>
  );
}

import { Repeat2 } from "lucide-react";
import { shortAgo } from "../lib/time.ts";
import type { Post } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Img } from "./Img.tsx";
import { PostLink } from "./PostLink.tsx";

/**
 * The post embedded inside a quote repost. Compact on purpose — it is context
 * for the quote, not a second full post competing with it.
 */
export function QuotedPost({ post, unavailable }: { post: Post | null; unavailable?: boolean }) {
  if (unavailable || !post) {
    return (
      <div className="mt-2.5 rounded-xl border border-line px-3.5 py-3 text-sm text-muted">
        This post is unavailable. It may have been deleted, or the account may be private.
      </div>
    );
  }

  return (
    <PostLink
      postId={post.id}
      onClick={(e) => e.stopPropagation()}
      className="mt-2.5 block overflow-hidden rounded-xl border border-line transition hover:bg-raised"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Avatar user={post.author} size={20} link={false} />
        <span className="truncate text-[13px] font-semibold">{post.author.username}</span>
        <span className="text-[11px] text-faint">· {shortAgo(post.createdAt)}</span>
      </div>
      {post.caption && <p className="line-clamp-2 px-3 pt-1 text-[13px] leading-snug text-muted">{post.caption}</p>}
      {post.media[0] && (
        <div className="mt-2">
          <Img media={post.media[0]} variant="url" cover className="max-h-72 w-full" />
        </div>
      )}
      {post.media.length === 0 && post.quotedPost && (
        <p className="flex items-center gap-1.5 px-3 pb-2.5 pt-1 text-[11px] text-faint">
          <Repeat2 size={12} /> quoting @{post.quotedPost.author.username}
        </p>
      )}
    </PostLink>
  );
}

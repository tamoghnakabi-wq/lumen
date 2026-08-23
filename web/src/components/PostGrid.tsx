import { Copy, Heart, MessageCircle, Play, Quote } from "lucide-react";
import { compactCount } from "../lib/time.ts";
import type { Post } from "../lib/types.ts";
import { Img } from "./Img.tsx";
import { PostLink } from "./PostLink.tsx";

export function PostGrid({ posts, className = "" }: { posts: Post[]; className?: string }) {
  return (
    <div className={`grid grid-cols-3 gap-0.5 sm:gap-1 ${className}`}>
      {posts.map((post) => (
        <PostLink
          key={post.id}
          postId={post.id}
          className="group relative block overflow-hidden bg-raised sm:rounded-md"
          aria-label={post.caption ? post.caption.slice(0, 60) : `Post by ${post.author.username}`}
        >
          {post.media[0] ? (
            <Img media={post.media[0]} variant="thumb" cover ratio={1} className="h-full w-full" />
          ) : (
            // A quote repost can have no image of its own; show its words rather
            // than an empty square.
            <div className="flex aspect-square flex-col justify-between bg-raised p-3">
              <Quote size={14} className="shrink-0 text-faint" />
              <p className="line-clamp-4 text-[12px] leading-snug text-muted">
                {post.caption || (post.quotedPost ? `Quoting @${post.quotedPost.author.username}` : "Post")}
              </p>
              {post.quotedPost && (
                <p className="truncate text-[10px] text-faint">@{post.quotedPost.author.username}</p>
              )}
            </div>
          )}

          {post.media[0]?.kind === "video" ? (
            <span className="absolute right-1.5 top-1.5 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
              <Play size={15} className="fill-white" />
            </span>
          ) : post.media.length > 1 ? (
            <span className="absolute right-1.5 top-1.5 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
              <Copy size={15} />
            </span>
          ) : null}

          <div className="absolute inset-0 hidden items-center justify-center gap-5 bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100 sm:flex">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
              <Heart size={17} className="fill-white" /> {compactCount(post.counts.likes)}
            </span>
            <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
              <MessageCircle size={17} className="fill-white" /> {compactCount(post.counts.comments)}
            </span>
          </div>
        </PostLink>
      ))}
    </div>
  );
}

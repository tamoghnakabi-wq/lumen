import type { QueryClient } from "@tanstack/react-query";
import type { Post } from "./types.ts";

/**
 * A post shows up in several caches at once (feed, profile grid, explore,
 * saved, detail view). Rather than invalidating everything on a like — which
 * would reshuffle the feed under the user's cursor — these helpers rewrite the
 * one post in place wherever it appears. Unchanged branches keep their identity
 * so React re-renders only what actually moved.
 */

type AnyData = any;

function mapPostList(list: Post[], fn: (p: Post) => Post | null): Post[] | null {
  let changed = false;
  const next: Post[] = [];
  for (const post of list) {
    const result = fn(post);
    if (result !== post) changed = true;
    if (result) next.push(result);
  }
  return changed ? next : null;
}

function walk(data: AnyData, fn: (p: Post) => Post | null): AnyData {
  if (!data || typeof data !== "object") return data;

  if (Array.isArray((data as any).pages)) {
    let changed = false;
    const pages = (data as any).pages.map((page: AnyData) => {
      const next = walk(page, fn);
      if (next !== page) changed = true;
      return next;
    });
    return changed ? { ...data, pages } : data;
  }

  // Feeds name their array differently — `posts` almost everywhere, `reels` on
  // the Reels page. Both hold the same Post shape, so both must be patchable or
  // liking from that screen would leave its own copy of the post untouched.
  for (const key of ["posts", "reels"]) {
    if (Array.isArray((data as any)[key])) {
      const next = mapPostList((data as any)[key], fn);
      return next ? { ...data, [key]: next } : data;
    }
  }

  if ((data as any).post && typeof (data as any).post === "object" && "id" in (data as any).post) {
    const next = fn((data as any).post as Post);
    if (next === (data as any).post) return data;
    return next ? { ...data, post: next } : data;
  }

  return data;
}

export function patchPost(queryClient: QueryClient, updated: Post) {
  queryClient.setQueriesData({ predicate: () => true }, (data: AnyData) =>
    walk(data, (post) => (post.id === updated.id ? updated : post)),
  );
}

export function removePost(queryClient: QueryClient, postId: string) {
  queryClient.setQueriesData({ predicate: () => true }, (data: AnyData) =>
    walk(data, (post) => (post.id === postId ? null : post)),
  );
}

/** Adds a freshly created post to the top of the feed without a refetch. */
export function prependPost(queryClient: QueryClient, post: Post) {
  queryClient.setQueriesData({ queryKey: ["feed"] }, (data: AnyData) => {
    if (!data || !Array.isArray(data.pages) || data.pages.length === 0) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first, posts: [post, ...(first.posts ?? [])] }, ...rest] };
  });
}

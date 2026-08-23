import { useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Hash } from "lucide-react";
import { get } from "../lib/api.ts";
import { compactCount } from "../lib/time.ts";
import type { Post } from "../lib/types.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { PostGrid } from "../components/PostGrid.tsx";
import { EmptyState, ErrorState, GridSkeleton, Spinner } from "../components/States.tsx";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll.ts";

export function TagPage() {
  const { tag = "" } = useParams();

  const query = useInfiniteQuery({
    queryKey: ["tag", tag],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      get<{ tag: string; posts: Post[]; nextOffset: number | null }>(
        `/explore/tags/${encodeURIComponent(tag)}?offset=${pageParam}`,
      ),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });

  const sentinel = useInfiniteScroll(
    () => !query.isFetchingNextPage && query.hasNextPage && query.fetchNextPage(),
    !!query.hasNextPage,
  );

  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];

  return (
    <div className="mx-auto w-full max-w-[62rem] pb-10 sm:px-6">
      <PageHeader title={`#${tag}`} back />

      <div className="flex items-center gap-4 px-4 py-5 sm:px-0">
        <div className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface text-accent">
          <Hash size={26} />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">#{tag}</h1>
          <p className="text-sm text-muted">
            {query.isLoading ? "Loading…" : `${compactCount(posts.length)}${query.hasNextPage ? "+" : ""} posts`}
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <GridSkeleton count={9} />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : posts.length === 0 ? (
        <EmptyState icon={<Hash size={22} />} title={`Nothing tagged #${tag} yet`} message="Be the first to use it." />
      ) : (
        <PostGrid posts={posts} />
      )}

      <div ref={sentinel} className="flex justify-center py-8">
        {query.isFetchingNextPage && <Spinner size={20} className="text-muted" />}
      </div>
    </div>
  );
}

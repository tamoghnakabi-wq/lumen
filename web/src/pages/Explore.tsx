import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Hash, Search, TrendingUp, X } from "lucide-react";
import { get } from "../lib/api.ts";
import { compactCount } from "../lib/time.ts";
import type { Post, SearchResults } from "../lib/types.ts";
import { Avatar } from "../components/Avatar.tsx";
import { FollowButton } from "../components/FollowButton.tsx";
import { PostGrid } from "../components/PostGrid.tsx";
import { EmptyState, ErrorState, GridSkeleton, RowSkeleton, Spinner } from "../components/States.tsx";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll.ts";

export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (params.get("focus")) inputRef.current?.focus();
  }, [params]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(query.trim());
      setParams(query.trim() ? { q: query.trim() } : {}, { replace: true });
    }, 260);
    return () => clearTimeout(handle);
  }, [query, setParams]);

  const searching = debounced.length > 0;

  return (
    <div className="mx-auto w-full max-w-[62rem] px-0 pb-10 sm:px-6">
      <div className="sticky top-0 z-30 bg-bg/90 px-4 py-3 backdrop-blur-md sm:static sm:px-0 sm:py-6 sm:backdrop-blur-none">
        <div className="relative">
          <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people, #hashtags, captions"
            aria-label="Search"
            className="field py-2.5 pl-10 pr-9"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-faint transition hover:text-fg"
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {searching ? <SearchResultsView query={debounced} /> : <DiscoverView />}
    </div>
  );
}

function SearchResultsView({ query }: { query: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["search", query],
    queryFn: () => get<SearchResults>(`/explore/search?q=${encodeURIComponent(query)}`),
  });

  if (isLoading) return <RowSkeleton count={5} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const empty = !data || (data.users.length === 0 && data.tags.length === 0 && data.posts.length === 0);
  if (empty) {
    return (
      <EmptyState
        icon={<Search size={22} />}
        title={`No results for “${query}”`}
        message="Try a different name, hashtag or word from a caption."
      />
    );
  }

  return (
    <div className="space-y-8 px-4 sm:px-0">
      {data.users.length > 0 && (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-muted">People</h2>
          <div className="space-y-1">
            {data.users.map((user) => (
              <div key={user.id} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-surface">
                <Avatar user={user} size={44} showOnline />
                <Link to={`/${user.username}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{user.username}</p>
                  <p className="truncate text-xs text-muted">{user.bio || user.displayName}</p>
                </Link>
                <FollowButton
                  userId={user.id}
                  isPrivate={user.isPrivate}
                  size="sm"
                  relation={{
                    isSelf: false,
                    isFollowing: user.isFollowing,
                    isRequested: false,
                    followsYou: false,
                    isBlocked: false,
                    blockedYou: false,
                    isMuted: false,
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {data.tags.length > 0 && (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-muted">Hashtags</h2>
          <div className="flex flex-wrap gap-2">
            {data.tags.map((tag) => (
              <Link
                key={tag.tag}
                to={`/tags/${tag.tag}`}
                className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2 text-sm transition hover:bg-raised"
              >
                <Hash size={14} className="text-accent" />
                <span className="font-medium">{tag.tag}</span>
                <span className="text-xs text-muted">{compactCount(tag.posts)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {data.posts.length > 0 && (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-muted">Posts</h2>
          <PostGrid posts={data.posts} />
        </section>
      )}
    </div>
  );
}

function DiscoverView() {
  const tags = useQuery({
    queryKey: ["trending-tags"],
    queryFn: () => get<{ tags: { tag: string; posts: number }[] }>("/explore/tags"),
    staleTime: 120_000,
  });

  const grid = useInfiniteQuery({
    queryKey: ["explore"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<{ posts: Post[]; nextOffset: number | null }>(`/explore?offset=${pageParam}`),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });

  const sentinel = useInfiniteScroll(
    () => !grid.isFetchingNextPage && grid.hasNextPage && grid.fetchNextPage(),
    !!grid.hasNextPage,
  );

  const posts = grid.data?.pages.flatMap((page) => page.posts) ?? [];

  return (
    <div>
      {(tags.data?.tags.length ?? 0) > 0 && (
        <section className="mb-5 px-4 sm:px-0">
          <h2 className="mb-2.5 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
            <TrendingUp size={14} /> Trending
          </h2>
          <div className="hide-scroll -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
            {tags.data?.tags.map((tag) => (
              <Link
                key={tag.tag}
                to={`/tags/${tag.tag}`}
                className="shrink-0 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm transition hover:bg-raised"
              >
                <span className="text-accent">#</span>
                {tag.tag}
                <span className="ml-1.5 text-xs text-muted">{compactCount(tag.posts)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {grid.isLoading ? (
        <GridSkeleton count={12} />
      ) : grid.error ? (
        <ErrorState error={grid.error} onRetry={() => void grid.refetch()} />
      ) : posts.length === 0 ? (
        <EmptyState
          title="Nothing to explore yet"
          message="When other people post publicly, their work shows up here."
        />
      ) : (
        <PostGrid posts={posts} />
      )}

      <div ref={sentinel} className="flex justify-center py-8">
        {grid.isFetchingNextPage && <Spinner size={20} className="text-muted" />}
      </div>
    </div>
  );
}

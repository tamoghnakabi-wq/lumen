import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Compass, Sparkles } from "lucide-react";
import { get } from "../lib/api.ts";
import { useComposer } from "../lib/ui.tsx";
import { getSocket } from "../lib/socket.ts";
import { useAuth } from "../lib/auth.tsx";
import type { Post } from "../lib/types.ts";
import { PostCard } from "../components/PostCard.tsx";
import { StoryRail } from "../components/Stories.tsx";
import { ProfileCard, SuggestionsPanel } from "../components/Suggestions.tsx";
import { EmptyState, ErrorState, PostSkeleton, Spinner } from "../components/States.tsx";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll.ts";

type FeedPage = { posts: Post[]; nextCursor: string | null; source: "following" | "discover" };

export function FeedPage() {
  const { openPostComposer, openStoryComposer } = useComposer();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ["feed"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => get<FeedPage>(`/feed${pageParam ? `?cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // A new story from someone you follow should light up the rail immediately.
  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    const onStory = () => void queryClient.invalidateQueries({ queryKey: ["stories"] });
    socket.on("story:new", onStory);
    return () => {
      socket.off("story:new", onStory);
    };
  }, [user, queryClient]);

  const sentinel = useInfiniteScroll(
    () => !query.isFetchingNextPage && query.hasNextPage && query.fetchNextPage(),
    !!query.hasNextPage,
  );

  const posts = query.data?.pages.flatMap((page) => page.posts) ?? [];
  const isDiscover = query.data?.pages[0]?.source === "discover";

  return (
    <div className="mx-auto flex w-full max-w-[64rem] gap-8 px-0 sm:px-6 xl:px-8">
      {/* A photo column this wide makes every post taller than the window: at
          38rem a 4:5 image alone came to 760px and pushed the like row off
          screen. 32rem keeps a whole card — author, media, actions — in view. */}
      <div className="mx-auto w-full max-w-[32rem] min-w-0 py-0 sm:py-6">
        <div className="border-b border-line sm:mb-6 sm:rounded-2xl sm:border sm:bg-surface">
          <StoryRail onAddStory={openStoryComposer} />
        </div>

        {isDiscover && posts.length > 0 && (
          <div className="mx-4 mb-4 mt-4 flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 sm:mx-0 sm:mt-0">
            <Sparkles size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="text-sm font-medium">You’re seeing recent posts from around Lumen</p>
              <p className="mt-0.5 text-xs text-muted">
                Follow a few people and this becomes your own feed.{" "}
                <Link to="/explore" className="text-accent hover:underline">
                  Find people to follow
                </Link>
              </p>
            </div>
          </div>
        )}

        <div className="space-y-4 px-0 sm:space-y-6">
          {query.isLoading ? (
            <>
              <PostSkeleton />
              <PostSkeleton />
            </>
          ) : query.error ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={<Camera size={22} />}
              title="Your feed is empty"
              message="Follow a few people, or post the first thing yourself."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <button className="btn btn-primary" onClick={openPostComposer}>
                    Create a post
                  </button>
                  <Link to="/explore" className="btn btn-ghost">
                    <Compass size={15} /> Explore
                  </Link>
                </div>
              }
            />
          ) : (
            posts.map((post, index) => <PostCard key={post.id} post={post} eager={index === 0} />)
          )}
        </div>

        <div ref={sentinel} className="flex justify-center py-8">
          {query.isFetchingNextPage && <Spinner size={20} className="text-muted" />}
          {!query.hasNextPage && posts.length > 0 && (
            <p className="text-sm text-muted">You’re all caught up.</p>
          )}
        </div>
      </div>

      <aside className="sticky top-6 hidden h-fit w-[19rem] shrink-0 py-6 xl:block">
        <ProfileCard />
        <SuggestionsPanel />
        <footer className="mt-8 text-xs leading-relaxed text-faint">
          <p>Lumen · a small social network</p>
          <p className="mt-1">Photos stay yours. Be good to each other.</p>
        </footer>
      </aside>
    </div>
  );
}

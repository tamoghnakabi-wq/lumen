import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Bookmark,
  Flag,
  Grid3x3,
  Link2,
  Lock,
  Repeat2,
  MoreHorizontal,
  Settings,
  UserMinus,
  UserX,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ApiError, del, get, post } from "../lib/api.ts";
import { compactCount, fullDate } from "../lib/time.ts";
import { RichText, externalHref } from "../lib/text.tsx";
import { useAuth } from "../lib/auth.tsx";
import { useToast } from "../lib/toast.tsx";
import type { Post, Profile, StoryGroup } from "../lib/types.ts";
import { Avatar } from "../components/Avatar.tsx";
import { FollowButton } from "../components/FollowButton.tsx";
import { Menu } from "../components/Menu.tsx";
import { ConfirmDialog } from "../components/Modal.tsx";
import { PostGrid } from "../components/PostGrid.tsx";
import { ReportDialog } from "../components/ReportDialog.tsx";
import { StoryViewer } from "../components/Stories.tsx";
import { EmptyState, ErrorState, GridSkeleton, Skeleton, Spinner } from "../components/States.tsx";
import { UserListDialog } from "../components/UserListDialog.tsx";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll.ts";

export function ProfilePage() {
  const { username = "" } = useParams();
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [listOpen, setListOpen] = useState<"followers" | "following" | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [tab, setTab] = useState<"posts" | "reposts" | "saved">("posts");

  const profile = useQuery({
    queryKey: ["profile", username],
    queryFn: () => get<{ user: Profile }>(`/users/${encodeURIComponent(username)}`),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  const user = profile.data?.user;
  const isSelf = !!user && !!me && user.id === me.id;

  const stories = useQuery({
    queryKey: ["user-stories", username],
    queryFn: () => get<{ group: StoryGroup | null }>(`/stories/user/${encodeURIComponent(username)}`),
    enabled: !!user && user.canViewPosts,
  });

  const posts = useInfiniteQuery({
    queryKey: ["profile-posts", username],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      get<{ posts: Post[]; nextCursor: string | null }>(
        `/users/${encodeURIComponent(username)}/posts${pageParam ? `?cursor=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!user && user.canViewPosts && tab === "posts",
  });

  const reposts = useInfiniteQuery({
    queryKey: ["profile-reposts", username],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      get<{ posts: Post[]; nextCursor: string | null }>(
        `/users/${encodeURIComponent(username)}/reposts${pageParam ? `?cursor=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!user && user.canViewPosts && tab === "reposts",
  });

  const saved = useInfiniteQuery({
    queryKey: ["saved"],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      get<{ posts: Post[]; nextCursor: string | null }>(`/me/saved${pageParam ? `?cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isSelf && tab === "saved",
  });

  const active = tab === "saved" ? saved : tab === "reposts" ? reposts : posts;
  const sentinel = useInfiniteScroll(
    () => !active.isFetchingNextPage && active.hasNextPage && active.fetchNextPage(),
    !!active.hasNextPage,
  );

  async function block() {
    if (!user) return;
    try {
      await post(`/users/${user.id}/block`);
      toast(`@${user.username} is blocked`, "success");
      setBlockOpen(false);
      queryClient.clear();
      navigate("/");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not block.", "error");
    }
  }

  async function toggleMute() {
    if (!user) return;
    const muting = !user.relation.isMuted;
    try {
      if (muting) await post(`/users/${user.id}/mute`);
      else await del(`/users/${user.id}/mute`);
      toast(muting ? `You will not see @${user.username} in your feed` : `@${user.username} is unmuted`, "success");
      void profile.refetch();
      // Their posts and stories enter or leave the feeds this viewer sees.
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
      void queryClient.invalidateQueries({ queryKey: ["reels"] });
      void queryClient.invalidateQueries({ queryKey: ["explore"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update mute.", "error");
    }
  }

  async function unblock() {
    if (!user) return;
    try {
      await del(`/users/${user.id}/block`);
      toast(`@${user.username} is unblocked`, "success");
      void profile.refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not unblock.", "error");
    }
  }

  async function openConversation() {
    if (!user) return;
    try {
      const data = await post<{ conversation: { id: string } }>("/conversations", { userId: user.id });
      navigate(`/messages/${data.conversation.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open the conversation.", "error");
    }
  }

  if (profile.isLoading) return <ProfileSkeleton />;

  if (profile.error) {
    const notFound = profile.error instanceof ApiError && profile.error.status === 404;
    return (
      <div className="mx-auto max-w-lg">
        <EmptyState
          icon={<UserX size={22} />}
          title={notFound ? "This account isn’t available" : "Could not load this profile"}
          message={
            notFound
              ? "The link may be broken, or the account may have been removed."
              : (profile.error as Error).message
          }
          action={
            <Link to="/explore" className="btn btn-ghost">
              Explore Lumen
            </Link>
          }
        />
      </div>
    );
  }

  if (!user) return null;

  const storyGroup = stories.data?.group ?? null;
  const gridPosts = active.data?.pages.flatMap((page) => page.posts) ?? [];

  return (
    <div className="mx-auto w-full max-w-[58rem] pb-12 sm:px-6">
      {/* ------------------------------------------------------------ header */}
      <header className="px-4 pb-6 pt-5 sm:px-0 sm:pt-8">
        <div className="flex items-start gap-5 sm:gap-10">
          <button
            onClick={() => storyGroup && setStoryOpen(true)}
            disabled={!storyGroup}
            className="shrink-0"
            aria-label={storyGroup ? `View ${user.username}'s story` : user.username}
          >
            <Avatar
              user={user}
              size={86}
              link={false}
              ring={storyGroup ? (storyGroup.hasUnseen ? "unseen" : "seen") : "none"}
              className="sm:!h-[132px] sm:!w-[132px]"
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight">{user.username}</h1>
              {user.isPrivate && (
                <span className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                  <Lock size={10} /> Private
                </span>
              )}
              {user.relation.followsYou && !user.relation.isSelf && (
                <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted">Follows you</span>
              )}
            </div>

            {/* On a phone the two primary actions share the row with the overflow
                menu; from sm up they size to their content. */}
            <div className="mt-3 flex items-center gap-2">
              {isSelf ? (
                <>
                  <Link to="/settings" className="btn btn-ghost flex-1 justify-center sm:flex-none">
                    Edit profile
                  </Link>
                  <Link to="/saved" className="btn btn-ghost flex-1 justify-center sm:hidden">
                    Saved
                  </Link>
                  <Link to="/settings" className="btn btn-ghost hidden sm:inline-flex" aria-label="Settings">
                    <Settings size={16} />
                  </Link>
                </>
              ) : user.relation.isBlocked ? (
                <button className="btn btn-outline flex-1 justify-center sm:flex-none" onClick={unblock}>
                  Unblock
                </button>
              ) : (
                <>
                  <FollowButton
                    userId={user.id}
                    relation={user.relation}
                    isPrivate={user.isPrivate}
                    className="flex-1 justify-center sm:flex-none"
                  />
                  <button className="btn btn-ghost flex-1 justify-center sm:flex-none" onClick={openConversation}>
                    Message
                  </button>
                </>
              )}
              <Menu
                trigger={<MoreHorizontal size={19} />}
                items={[
                  {
                    label: "Copy profile link",
                    icon: <Link2 size={15} />,
                    onSelect: () => {
                      void navigator.clipboard.writeText(`${window.location.origin}/${user.username}`);
                      toast("Profile link copied", "success");
                    },
                  },
                  {
                    label: "Remove follower",
                    icon: <UserMinus size={15} />,
                    hidden: isSelf || !user.relation.followsYou,
                    onSelect: async () => {
                      await del(`/users/${user.id}/follower`);
                      toast("Follower removed", "success");
                      void profile.refetch();
                    },
                  },
                  {
                    label: user.relation.isMuted ? "Unmute account" : "Mute account",
                    icon: user.relation.isMuted ? <Volume2 size={15} /> : <VolumeX size={15} />,
                    hidden: isSelf || user.relation.isBlocked,
                    onSelect: () => void toggleMute(),
                  },
                  {
                    label: user.relation.isBlocked ? "Unblock account" : "Block account",
                    icon: <Ban size={15} />,
                    danger: true,
                    hidden: isSelf,
                    onSelect: () => (user.relation.isBlocked ? unblock() : setBlockOpen(true)),
                  },
                  {
                    label: "Report account",
                    icon: <Flag size={15} />,
                    danger: true,
                    hidden: isSelf,
                    onSelect: () => setReportOpen(true),
                  },
                ]}
              />
            </div>

            <dl className="mt-5 hidden gap-8 sm:flex">
              <Stat label="posts" value={user.counts.posts} />
              <Stat
                label="followers"
                value={user.counts.followers}
                onClick={user.canViewPosts ? () => setListOpen("followers") : undefined}
              />
              <Stat
                label="following"
                value={user.counts.following}
                onClick={user.canViewPosts ? () => setListOpen("following") : undefined}
              />
            </dl>
          </div>
        </div>

        <div className="mt-4 sm:mt-5">
          <p className="text-sm font-semibold">{user.displayName}</p>
          {user.bio && (
            <p className="mt-1 max-w-prose text-sm leading-relaxed">
              <RichText text={user.bio} />
            </p>
          )}
          {user.website && (
            <a
              href={externalHref(user.website)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
            >
              <Link2 size={13} />
              {user.website.replace(/^https?:\/\//, "")}
            </a>
          )}
          <p className="mt-1.5 text-xs text-faint">Joined {fullDate(user.createdAt)}</p>
        </div>

        <dl className="mt-5 grid grid-cols-3 border-y border-line py-3 sm:hidden">
          <Stat label="posts" value={user.counts.posts} centered />
          <Stat
            label="followers"
            value={user.counts.followers}
            centered
            onClick={user.canViewPosts ? () => setListOpen("followers") : undefined}
          />
          <Stat
            label="following"
            value={user.counts.following}
            centered
            onClick={user.canViewPosts ? () => setListOpen("following") : undefined}
          />
        </dl>
      </header>

      {/* -------------------------------------------------------------- body */}
      {user.relation.isBlocked ? (
        <EmptyState
          icon={<Ban size={22} />}
          title="You blocked this account"
          message="Unblock to see their posts and let them see yours again."
        />
      ) : !user.canViewPosts ? (
        <EmptyState
          icon={<Lock size={22} />}
          title="This account is private"
          message="Follow this account to see their photos and videos."
        />
      ) : (
        <>
          <div className="mb-1 flex justify-center gap-8 border-t border-line">
            <TabButton active={tab === "posts"} onClick={() => setTab("posts")} icon={<Grid3x3 size={13} />} label="Posts" />
            <TabButton active={tab === "reposts"} onClick={() => setTab("reposts")} icon={<Repeat2 size={13} />} label="Reposts" />
            {isSelf && (
              <TabButton active={tab === "saved"} onClick={() => setTab("saved")} icon={<Bookmark size={13} />} label="Saved" />
            )}
          </div>

          {active.isLoading ? (
            <GridSkeleton count={9} />
          ) : active.error ? (
            <ErrorState error={active.error} onRetry={() => void active.refetch()} />
          ) : gridPosts.length === 0 ? (
            <EmptyState
              icon={tab === "saved" ? <Bookmark size={22} /> : tab === "reposts" ? <Repeat2 size={22} /> : <Grid3x3 size={22} />}
              title={
                tab === "saved"
                  ? "Nothing saved yet"
                  : tab === "reposts"
                    ? isSelf
                      ? "You haven't reposted anything"
                      : "No reposts yet"
                    : isSelf
                      ? "Share your first photo"
                      : "No posts yet"
              }
              message={
                tab === "saved"
                  ? "Posts you save are kept here, visible only to you."
                  : tab === "reposts"
                    ? "Posts repeated from other accounts appear here."
                    : isSelf
                      ? "Your posts will show up in this grid."
                      : undefined
              }
            />
          ) : (
            <PostGrid posts={gridPosts} />
          )}

          <div ref={sentinel} className="flex justify-center py-8">
            {active.isFetchingNextPage && <Spinner size={20} className="text-muted" />}
          </div>
        </>
      )}

      <UserListDialog
        open={listOpen !== null}
        onClose={() => setListOpen(null)}
        username={user.username}
        kind={listOpen ?? "followers"}
        canRemove={isSelf}
      />
      <ReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        targetType="user"
        targetId={user.id}
        targetLabel={`@${user.username}`}
      />
      <ConfirmDialog
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        onConfirm={block}
        title={`Block @${user.username}?`}
        message="They won’t be able to find your profile, posts or messages. You will not be told if they try."
        confirmLabel="Block account"
      />
      {storyOpen && storyGroup && (
        <StoryViewer groups={[storyGroup]} startIndex={0} onClose={() => setStoryOpen(false)} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  onClick,
  centered = false,
}: {
  label: string;
  value: number;
  onClick?: () => void;
  centered?: boolean;
}) {
  const content = (
    <div className={centered ? "text-center" : ""}>
      <dd className="text-[15px] font-semibold">{compactCount(value)}</dd>
      <dt className="text-[13px] text-muted">{label}</dt>
    </div>
  );
  if (!onClick) return content;
  return (
    <button onClick={onClick} className="transition hover:opacity-70">
      {content}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mt-px flex items-center gap-1.5 border-t-2 px-2 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] transition ${
        active ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[58rem] px-4 pt-6 sm:px-6 sm:pt-8">
      <div className="flex items-start gap-5 sm:gap-10">
        <Skeleton className="h-[86px] w-[86px] rounded-full sm:h-[132px] sm:w-[132px]" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-52 rounded-full" />
          <div className="hidden gap-8 sm:flex">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      </div>
      <div className="mt-5 space-y-2">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-3 w-64" />
      </div>
      <div className="mt-8">
        <GridSkeleton count={9} />
      </div>
    </div>
  );
}

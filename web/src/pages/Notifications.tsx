import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Heart, MessageCircle, Repeat2, UserPlus, X } from "lucide-react";
import { get, post } from "../lib/api.ts";
import { shortAgo } from "../lib/time.ts";
import { getSocket } from "../lib/socket.ts";
import { useAuth } from "../lib/auth.tsx";
import { useToast } from "../lib/toast.tsx";
import type { Notification, UserCard } from "../lib/types.ts";
import { Avatar } from "../components/Avatar.tsx";
import { FollowButton } from "../components/FollowButton.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { EmptyState, ErrorState, RowSkeleton, Spinner } from "../components/States.tsx";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll.ts";

type Page = { notifications: Notification[]; nextCursor: string | null; unread: number };

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const query = useInfiniteQuery({
    queryKey: ["notifications"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => get<Page>(`/notifications${pageParam ? `?cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const requests = useQuery({
    queryKey: ["follow-requests"],
    queryFn: () => get<{ users: (UserCard & { bio: string; requestedAt: number })[] }>("/me/requests"),
    enabled: !!user?.isPrivate,
  });

  // Opening the page is the read receipt.
  useEffect(() => {
    void post("/notifications/read").then(() => {
      queryClient.setQueryData(["unread", "notifications"], { unread: 0 });
    });
  }, [queryClient]);

  useEffect(() => {
    const socket = getSocket();
    const onNew = () => void query.refetch();
    socket.on("notification:new", onNew);
    return () => {
      socket.off("notification:new", onNew);
    };
  }, [query]);

  const sentinel = useInfiniteScroll(
    () => !query.isFetchingNextPage && query.hasNextPage && query.fetchNextPage(),
    !!query.hasNextPage,
  );

  const items = query.data?.pages.flatMap((page) => page.notifications) ?? [];
  const now = Date.now();
  const groups: { label: string; items: Notification[] }[] = [
    { label: "Today", items: items.filter((n) => now - n.createdAt < 86_400_000) },
    {
      label: "This week",
      items: items.filter((n) => now - n.createdAt >= 86_400_000 && now - n.createdAt < 7 * 86_400_000),
    },
    { label: "Earlier", items: items.filter((n) => now - n.createdAt >= 7 * 86_400_000) },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto w-full max-w-[38rem] pb-10 sm:px-6">
      <PageHeader title="Notifications" back />

      {(requests.data?.users.length ?? 0) > 0 && (
        <section className="px-2 pb-4 pt-2 sm:px-0">
          <h2 className="mb-1.5 px-2 text-[13px] font-semibold text-muted">Follow requests</h2>
          {requests.data?.users.map((requester) => (
            <FollowRequestRow key={requester.id} requester={requester} />
          ))}
        </section>
      )}

      {query.isLoading ? (
        <RowSkeleton count={7} />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title="No notifications yet"
          message="Likes, comments and new followers will show up here."
        />
      ) : (
        groups.map((group) => (
          <section key={group.label} className="px-2 pb-2 sm:px-0">
            <h2 className="mb-1 px-2 pt-3 text-[13px] font-semibold text-muted">{group.label}</h2>
            {group.items.map((item) => (
              <NotificationRow key={item.id} notification={item} />
            ))}
          </section>
        ))
      )}

      <div ref={sentinel} className="flex justify-center py-6">
        {query.isFetchingNextPage && <Spinner size={20} className="text-muted" />}
      </div>
    </div>
  );
}

const TEXT: Record<Notification["type"], string> = {
  like: "liked your post.",
  comment: "commented:",
  comment_like: "liked your comment.",
  follow: "started following you.",
  follow_request: "requested to follow you.",
  follow_accepted: "accepted your follow request.",
  mention: "mentioned you.",
  repost: "reposted your post.",
  quote: "quoted your post.",
  story_reaction: "reacted to your story.",
};

function NotificationRow({ notification }: { notification: Notification }) {
  const isFollow = notification.type === "follow" || notification.type === "follow_accepted";
  const target = notification.postId ? `/p/${notification.postId}` : `/${notification.actor.username}`;

  return (
    <Link
      to={target}
      className={`flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition hover:bg-surface ${
        notification.read ? "" : "bg-accent-soft/60"
      }`}
    >
      <span className="relative shrink-0">
        <Avatar user={notification.actor} size={44} link={false} />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-bg">
          {notification.type === "like" || notification.type === "comment_like" ? (
            <Heart size={9} className="fill-white text-white" strokeWidth={3} />
          ) : notification.type === "repost" || notification.type === "quote" ? (
            <Repeat2 size={9} className="text-white" strokeWidth={3} />
          ) : notification.type === "comment" || notification.type === "mention" ? (
            <MessageCircle size={9} className="fill-white text-white" strokeWidth={3} />
          ) : (
            <UserPlus size={9} className="text-white" strokeWidth={3} />
          )}
          <span
            className="absolute inset-0 -z-10 rounded-full"
            style={{
              background:
                notification.type === "like" || notification.type === "comment_like"
                  ? "var(--danger)"
                  : notification.type === "comment" || notification.type === "mention"
                    ? "var(--accent)"
                    : "var(--online)",
            }}
          />
        </span>
      </span>

      <p className="min-w-0 flex-1 text-sm leading-snug">
        <span className="font-semibold">{notification.actor.username}</span> {TEXT[notification.type]}
        {notification.commentBody && (
          <span className="text-muted"> “{notification.commentBody.slice(0, 70)}”</span>
        )}
        <span className="ml-1.5 text-xs text-faint">{shortAgo(notification.createdAt)}</span>
      </p>

      {notification.postThumb ? (
        <img src={notification.postThumb} alt="" className="h-11 w-11 shrink-0 rounded-md object-cover" />
      ) : isFollow ? (
        <FollowButton
          userId={notification.actor.id}
          isPrivate={notification.actor.isPrivate}
          size="sm"
          relation={{
            isSelf: false,
            isFollowing: false,
            isRequested: false,
            followsYou: true,
            isBlocked: false,
            blockedYou: false,
            isMuted: false,
          }}
        />
      ) : null}
    </Link>
  );
}

function FollowRequestRow({ requester }: { requester: UserCard & { bio: string } }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  async function respond(action: "accept" | "decline") {
    try {
      await post(`/me/requests/${requester.id}/${action}`);
      void queryClient.invalidateQueries({ queryKey: ["follow-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast(action === "accept" ? `@${requester.username} can now see your posts` : "Request declined", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update the request.", "error");
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition hover:bg-surface">
      <Avatar user={requester} size={44} />
      <div className="min-w-0 flex-1">
        <Link to={`/${requester.username}`} className="block truncate text-sm font-semibold hover:underline">
          {requester.username}
        </Link>
        <p className="truncate text-xs text-muted">{requester.displayName}</p>
      </div>
      <button className="btn btn-primary px-3 py-1.5 text-[13px]" onClick={() => respond("accept")}>
        <Check size={14} /> Confirm
      </button>
      <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => respond("decline")} aria-label="Decline">
        <X size={14} />
      </button>
    </div>
  );
}

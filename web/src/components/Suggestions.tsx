import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import type { Suggestion } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { FollowButton } from "./FollowButton.tsx";
import { Skeleton } from "./States.tsx";

export function useSuggestions() {
  return useQuery({
    queryKey: ["suggestions"],
    queryFn: () => get<{ users: Suggestion[] }>("/users/-/suggestions"),
    staleTime: 60_000,
  });
}

export function SuggestionsPanel({ limit = 5, title = "Suggested for you" }: { limit?: number; title?: string }) {
  const { data, isLoading } = useSuggestions();
  const users = (data?.users ?? []).slice(0, limit);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-32" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (users.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold text-muted">{title}</h2>
      <div className="space-y-3">
        {users.map((user) => (
          <div key={user.id} className="flex items-center gap-3">
            <Avatar user={user} size={40} showOnline />
            <div className="min-w-0 flex-1">
              <Link to={`/${user.username}`} className="block truncate text-sm font-semibold hover:underline">
                {user.username}
              </Link>
              <p className="truncate text-xs text-muted">
                {user.mutuals > 0
                  ? `Followed by ${user.mutuals} ${user.mutuals === 1 ? "person" : "people"} you follow`
                  : user.displayName}
              </p>
            </div>
            <FollowButton
              userId={user.id}
              isPrivate={user.isPrivate}
              size="sm"
              relation={{
                isSelf: false,
                isFollowing: false,
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
  );
}

export function ProfileCard() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="mb-6 flex items-center gap-3">
      <Avatar user={user} size={52} />
      <div className="min-w-0 flex-1">
        <Link to={`/${user.username}`} className="block truncate text-sm font-semibold hover:underline">
          {user.username}
        </Link>
        <p className="truncate text-sm text-muted">{user.displayName}</p>
      </div>
    </div>
  );
}

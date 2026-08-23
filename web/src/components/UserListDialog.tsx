import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { useToast } from "../lib/toast.tsx";
import type { UserCard } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";
import { EmptyState, ErrorState, RowSkeleton } from "./States.tsx";

type ListUser = UserCard & { bio: string; relation: { isFollowing: boolean; isSelf: boolean } | null };

export function UserListDialog({
  open,
  onClose,
  username,
  kind,
  canRemove = false,
}: {
  open: boolean;
  onClose: () => void;
  username: string;
  kind: "followers" | "following";
  canRemove?: boolean;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [kind, username],
    queryFn: () => get<{ users: ListUser[] }>(`/users/${username}/${kind}`),
    enabled: open,
  });
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  async function removeFollower(id: string) {
    try {
      await del(`/users/${id}/follower`);
      setRemoved((s) => new Set(s).add(id));
      void queryClient.invalidateQueries({ queryKey: ["profile", username] });
      toast("Follower removed", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove follower.", "error");
    }
  }

  const users = (data?.users ?? []).filter((u) => !removed.has(u.id));

  return (
    <Modal open={open} onClose={onClose} title={kind === "followers" ? "Followers" : "Following"} size="sm">
      <div className="min-h-[14rem] overflow-y-auto p-2">
        {isLoading ? (
          <RowSkeleton count={5} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : users.length === 0 ? (
          <EmptyState
            title={kind === "followers" ? "No followers yet" : "Not following anyone yet"}
            message={kind === "followers" ? "When people follow this account they’ll appear here." : undefined}
          />
        ) : (
          users.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-raised">
              <Link to={`/${entry.username}`} onClick={onClose}>
                <Avatar user={entry} size={42} link={false} showOnline />
              </Link>
              <Link to={`/${entry.username}`} onClick={onClose} className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{entry.username}</p>
                <p className="truncate text-xs text-muted">{entry.displayName}</p>
              </Link>
              {canRemove && kind === "followers" && user?.username === username && (
                <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => removeFollower(entry.id)}>
                  Remove
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { get } from "../lib/api.ts";
import type { UserCard } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";
import { EmptyState, ErrorState, RowSkeleton } from "./States.tsx";

/** Lists the people behind a count — likes by default, reposts when asked. */
export function LikesDialog({
  open,
  onClose,
  postId,
  kind = "likes",
}: {
  open: boolean;
  onClose: () => void;
  postId: string;
  kind?: "likes" | "reposts";
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [kind, postId],
    queryFn: () => get<{ users: UserCard[] }>(`/posts/${postId}/${kind}`),
    enabled: open,
  });

  return (
    <Modal open={open} onClose={onClose} title={kind === "likes" ? "Likes" : "Reposts"} size="sm">
      <div className="min-h-[12rem] overflow-y-auto p-2">
        {isLoading ? (
          <RowSkeleton count={5} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : data?.users.length === 0 ? (
          <EmptyState
            title={kind === "likes" ? "No likes yet" : "No reposts yet"}
            message={kind === "likes" ? "Be the first one." : undefined}
          />
        ) : (
          data?.users.map((user) => (
            <Link
              key={user.id}
              to={`/${user.username}`}
              onClick={onClose}
              className="flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-raised"
            >
              <Avatar user={user} size={40} link={false} showOnline />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{user.username}</p>
                <p className="truncate text-xs text-muted">{user.displayName}</p>
              </div>
            </Link>
          ))
        )}
      </div>
    </Modal>
  );
}

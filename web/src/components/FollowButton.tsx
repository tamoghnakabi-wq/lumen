import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del, post } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import type { Profile, Relation } from "../lib/types.ts";
import { Spinner } from "./States.tsx";

type Props = {
  userId: string;
  relation: Relation;
  isPrivate: boolean;
  size?: "sm" | "md";
  full?: boolean;
  className?: string;
  onChanged?: (user: Profile) => void;
};

export function FollowButton({
  userId,
  relation,
  isPrivate,
  size = "md",
  full = false,
  className = "",
  onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(relation);
  const queryClient = useQueryClient();
  const toast = useToast();

  if (local.isSelf) return null;

  const state = local.isRequested ? "requested" : local.isFollowing ? "following" : "none";

  async function toggle() {
    setBusy(true);
    // Optimistic flip keeps the button responsive; the response is authoritative.
    const previous = local;
    setLocal({
      ...local,
      isFollowing: state === "none" && !isPrivate,
      isRequested: state === "none" && isPrivate,
    });
    try {
      const data =
        state === "none"
          ? await post<{ user: Profile }>(`/users/${userId}/follow`)
          : await del<{ user: Profile }>(`/users/${userId}/follow`);
      setLocal(data.user.relation);
      onChanged?.(data.user);
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      void queryClient.invalidateQueries({ queryKey: ["suggestions"] });
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
      void queryClient.invalidateQueries({ queryKey: ["profile", data.user.username] });
    } catch (err) {
      setLocal(previous);
      toast(err instanceof Error ? err.message : "Could not update follow.", "error");
    } finally {
      setBusy(false);
    }
  }

  const label = state === "requested" ? "Requested" : state === "following" ? "Following" : "Follow";
  const classes =
    state === "none" ? "btn-primary" : state === "requested" ? "btn-outline" : "btn-ghost";

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`btn ${classes} ${size === "sm" ? "px-3.5 py-1.5 text-[13px]" : ""} ${
        full ? "w-full justify-center" : ""
      } ${className}`}
      aria-label={state === "following" ? "Unfollow" : state === "requested" ? "Cancel request" : "Follow"}
    >
      {busy ? <Spinner size={14} /> : label}
    </button>
  );
}

import { Link } from "react-router-dom";
import type { UserCard } from "../lib/types.ts";
import { hueOf, initialsOf } from "../lib/text.tsx";

type Props = {
  user: Pick<UserCard, "username" | "displayName" | "avatar"> & { isOnline?: boolean };
  size?: number;
  ring?: "none" | "unseen" | "seen";
  showOnline?: boolean;
  link?: boolean;
  className?: string;
  onClick?: () => void;
};

export function Avatar({
  user,
  size = 40,
  ring = "none",
  showOnline = false,
  link = true,
  className = "",
  onClick,
}: Props) {
  const hue = hueOf(user.username);
  const inner = (
    <span
      className={`relative block shrink-0 ${className}`}
      style={{ width: size, height: size }}
      onClick={onClick}
    >
      {ring !== "none" && (
        <span
          className={`absolute inset-0 rounded-full ${ring === "unseen" ? "story-ring" : "bg-line"}`}
          style={{ padding: Math.max(2, size * 0.055) }}
        >
          <span className="block h-full w-full rounded-full bg-bg" />
        </span>
      )}
      <span
        className="absolute overflow-hidden rounded-full bg-raised"
        style={
          ring !== "none"
            ? { inset: Math.max(4, size * 0.11) }
            : { inset: 0 }
        }
      >
        {user.avatar ? (
          <img
            src={user.avatar}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center font-semibold text-white"
            style={{
              fontSize: size * 0.38,
              background: `linear-gradient(140deg, hsl(${hue} 62% 52%), hsl(${(hue + 48) % 360} 68% 44%))`,
            }}
          >
            {initialsOf(user.displayName || user.username)}
          </span>
        )}
      </span>
      {showOnline && user.isOnline && (
        <span
          className="absolute rounded-full border-2 border-bg bg-online"
          style={{ width: size * 0.28, height: size * 0.28, right: 0, bottom: 0 }}
          aria-label="Online"
        />
      )}
    </span>
  );

  if (!link) return inner;
  return (
    <Link to={`/${user.username}`} aria-label={user.username} className="shrink-0">
      {inner}
    </Link>
  );
}

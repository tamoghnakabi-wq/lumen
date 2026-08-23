import { Link } from "react-router-dom";

const TOKEN = /(#[\p{L}\p{N}_]{1,50}|@[a-z0-9._]{2,24}|https?:\/\/[^\s]+)/giu;

/**
 * Renders a caption or comment with hashtags, @mentions and links made clickable.
 * Everything is rendered as text nodes — no HTML from user input is ever injected.
 */
export function RichText({ text, className = "" }: { text: string; className?: string }) {
  const parts = text.split(TOKEN);
  return (
    <span className={className} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {parts.map((part, i) => {
        if (!part) return null;
        if (part.startsWith("#")) {
          return (
            <Link
              key={i}
              to={`/tags/${part.slice(1).toLowerCase()}`}
              className="text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </Link>
          );
        }
        if (part.startsWith("@")) {
          return (
            <Link
              key={i}
              to={`/${part.slice(1).toLowerCase()}`}
              className="text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </Link>
          );
        }
        if (/^https?:\/\//i.test(part)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {part.replace(/^https?:\/\//, "")}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

export function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** Stable per-user hue so avatar fallbacks are colourful but consistent. */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function externalHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

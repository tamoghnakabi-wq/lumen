import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api.ts";
import type { MentionSuggestion } from "../lib/types.ts";
import { Avatar } from "./Avatar.tsx";

/** The @token the caret currently sits inside, if any. */
function activeMention(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const match = /(?:^|[\s(])@([a-z0-9._]{0,24})$/i.exec(before);
  if (!match) return null;
  return { query: match[1], start: caret - match[1].length - 1 };
}

/**
 * Shared @mention autocomplete for the composers and the comment box.
 *
 * Keeps the underlying element a plain textarea/input — a contenteditable
 * rich-text field would mean re-implementing selection, undo and mobile IME
 * behaviour for very little gain.
 */
function useMentions(
  value: string,
  onChange: (next: string) => void,
  ref: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
) {
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  // The list opens upward by default, but a field near the top of a scrolling
  // modal has nowhere to put it, so measure and flip when it would be clipped.
  const [below, setBelow] = useState(false);

  const suggestions = useQuery({
    queryKey: ["mentions", token?.query ?? ""],
    queryFn: () => get<{ users: MentionSuggestion[] }>(`/explore/mentions?q=${encodeURIComponent(token!.query)}`),
    enabled: !!token && token.query.length > 0,
    staleTime: 30_000,
  });

  const users = token && token.query.length > 0 ? (suggestions.data?.users ?? []) : [];

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = activeMention(el.value, el.selectionStart ?? el.value.length);
    setToken(next);
    setHighlight(0);
    if (next) setBelow(el.getBoundingClientRect().top < 260);
  }, [ref]);

  const pick = useCallback(
    (username: string) => {
      const el = ref.current;
      if (!el || !token) return;
      const caret = el.selectionStart ?? value.length;
      const next = `${value.slice(0, token.start)}@${username} ${value.slice(caret)}`;
      onChange(next);
      setToken(null);
      // Put the caret after the inserted name on the next frame, once React has
      // written the new value back into the element.
      requestAnimationFrame(() => {
        const position = token.start + username.length + 2;
        el.focus();
        el.setSelectionRange(position, position);
      });
    },
    [onChange, ref, token, value],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (users.length === 0) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((h) => (h + 1) % users.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((h) => (h - 1 + users.length) % users.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(users[highlight].username);
        return true;
      }
      if (event.key === "Escape") {
        setToken(null);
        return true;
      }
      return false;
    },
    [highlight, pick, users],
  );

  return { users, highlight, setHighlight, sync, pick, onKeyDown, below };
}

function SuggestionList({
  users,
  highlight,
  onHover,
  onPick,
  below,
}: {
  users: MentionSuggestion[];
  highlight: number;
  onHover: (i: number) => void;
  onPick: (username: string) => void;
  below: boolean;
}) {
  return (
    <div
      className={`absolute inset-x-0 z-50 overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/20 ${
        below ? "top-full mt-1" : "bottom-full mb-1"
      }`}
    >
      {users.map((user, i) => (
        <button
          key={user.id}
          type="button"
          onMouseEnter={() => onHover(i)}
          // mousedown fires before the field's blur, so the pick still lands.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(user.username);
          }}
          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition ${
            i === highlight ? "bg-raised" : ""
          }`}
        >
          <Avatar user={user} size={28} link={false} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{user.username}</span>
            <span className="block truncate text-xs text-muted">{user.displayName}</span>
          </span>
          {user.connected && <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">connected</span>}
        </button>
      ))}
    </div>
  );
}

type SharedProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
};

export function MentionTextarea({ rows = 4, ...props }: SharedProps & { rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { users, highlight, setHighlight, sync, pick, onKeyDown, below } = useMentions(props.value, props.onChange, ref);

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);

  return (
    <div className="relative">
      {users.length > 0 && (
        <SuggestionList users={users} highlight={highlight} onHover={setHighlight} onPick={pick} below={below} />
      )}
      <textarea
        ref={ref}
        rows={rows}
        value={props.value}
        aria-label={props["aria-label"]}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        onChange={(e) => {
          props.onChange(e.target.value);
          sync();
        }}
        onKeyUp={sync}
        onClick={sync}
        onKeyDown={(e) => onKeyDown(e)}
        className={props.className ?? "field resize-none"}
      />
    </div>
  );
}

export function MentionInput({
  onSubmit,
  ...props
}: SharedProps & { onSubmit?: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const { users, highlight, setHighlight, sync, pick, onKeyDown, below } = useMentions(props.value, props.onChange, ref);

  return (
    <div className="relative flex-1">
      {users.length > 0 && (
        <SuggestionList users={users} highlight={highlight} onHover={setHighlight} onPick={pick} below={below} />
      )}
      <input
        ref={ref}
        value={props.value}
        aria-label={props["aria-label"]}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        autoFocus={props.autoFocus}
        onChange={(e) => {
          props.onChange(e.target.value);
          sync();
        }}
        onKeyUp={sync}
        onClick={sync}
        onKeyDown={(e) => {
          // The suggestion list claims Enter while it is open.
          if (onKeyDown(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.();
          }
        }}
        className={props.className ?? "min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"}
      />
    </div>
  );
}

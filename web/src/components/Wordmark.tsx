import { useId } from "react";

/**
 * The Lumen mark: an aperture ring with a warm-to-violet gradient.
 *
 * The gradient id is generated per instance. A fixed one collided whenever the
 * mark appeared more than once — the rail and the mobile header both render it —
 * and every copy then pointed at the first definition, so unmounting that one
 * would leave the rest unpainted.
 */
export function Wordmark({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const gradientId = useId();
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="shrink-0">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--warm)" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="12" fill="none" stroke={`url(#${gradientId})`} strokeWidth="2.6" />
        <circle cx="16" cy="16" r="4.4" fill={`url(#${gradientId})`} />
      </svg>
      {!compact && <span className="wordmark text-[21px]">lumen</span>}
    </span>
  );
}

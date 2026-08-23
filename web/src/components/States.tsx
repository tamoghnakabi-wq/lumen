import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { ApiError } from "../lib/api.ts";

export function Spinner({ size = 18, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} aria-hidden />;
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center text-muted">
      <Spinner size={22} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="animate-[fade_0.3s_ease-out] flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-line text-muted">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {message && <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Something went wrong.";
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <h3 className="text-base font-semibold tracking-tight">That didn’t load</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{message}</p>
      {onRetry && (
        <button className="btn btn-ghost mt-5" onClick={onRetry}>
          <RefreshCw size={15} /> Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function PostSkeleton() {
  return (
    <article className="card overflow-hidden">
      <div className="flex items-center gap-3 p-3.5">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      </div>
      <Skeleton className="aspect-[4/5] w-full rounded-none" />
      <div className="space-y-2 p-3.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </article>
  );
}

export function GridSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-0.5 sm:gap-1">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="aspect-square rounded-none sm:rounded-md" />
      ))}
    </div>
  );
}

export function RowSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 w-36" />
          </div>
        </div>
      ))}
    </div>
  );
}

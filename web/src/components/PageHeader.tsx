import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

/** Sticky page title bar. On mobile it doubles as the back affordance. */
export function PageHeader({
  title,
  back = false,
  backAlways = false,
  action,
  sticky = true,
  className = "",
}: {
  title: ReactNode;
  back?: boolean;
  /** Keep the back control at every width, for pages the nav cannot return from. */
  backAlways?: boolean;
  action?: ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <header
      className={`${
        sticky ? "sticky top-0 z-30" : ""
      } flex items-center gap-2 border-b border-line bg-bg/90 px-3 py-2.5 backdrop-blur-md sm:border-0 sm:bg-transparent sm:px-0 sm:py-5 sm:backdrop-blur-none ${className}`}
    >
      {back && (
        <button
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
          className={`press -ml-1 rounded-full p-1.5 text-fg ${backAlways ? "" : "sm:hidden"}`}
          aria-label="Go back"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight sm:text-xl">{title}</h1>
      {action}
    </header>
  );
}

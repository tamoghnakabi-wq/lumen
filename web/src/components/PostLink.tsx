import { Link, useLocation, type LinkProps } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * A link to a post that opens it over whatever you were looking at.
 *
 * The post still has its own URL — sharing, refreshing and the back button all
 * behave normally — but navigating from inside the app records where you came
 * from, and App renders the page underneath with the post layered on top. That
 * is what gives it a backdrop to click and a close button; a plain route
 * transition has neither, and leaves the browser's back button as the only exit.
 */
export function PostLink({
  postId,
  children,
  ...rest
}: { postId: string; children: ReactNode } & Omit<LinkProps, "to" | "state">) {
  const location = useLocation();
  return (
    <Link to={`/p/${postId}`} state={{ background: location }} {...rest}>
      {children}
    </Link>
  );
}

/** The same for imperative navigation. */
export function usePostNavState() {
  const location = useLocation();
  return { background: location };
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Who is asking, for the handful of decisions that depend on it deep inside
 * shared shaping code rather than in a route.
 *
 * Presence is the case that needs it: `userCard` is called from twenty-odd
 * places, and threading a viewer through all of them to answer one boolean
 * would be far more error-prone than reading it here — a call site quietly
 * missed would leak the very thing the setting exists to hide.
 */
type ViewerContext = {
  id: string;
  /** Whether this viewer shares their own activity, which is what earns them the ability to see others'. */
  sharesActivity: boolean;
};

const storage = new AsyncLocalStorage<ViewerContext>();

export function withViewer(req: Request, _res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) return next();
  storage.run({ id: user.id, sharesActivity: user.show_activity !== 0 }, () => next());
}

export function currentViewer(): ViewerContext | undefined {
  return storage.getStore();
}

/**
 * Outside a request — a socket emit, a background job — there is no viewer, and
 * the safe answer is the subject's own setting alone.
 */
export function viewerSharesActivity(): boolean {
  return currentViewer()?.sharesActivity ?? true;
}

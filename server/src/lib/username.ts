import { z } from "zod";

/**
 * Names that must never belong to a person, because the router would not be able
 * to tell them apart from a page. `/settings` has to mean settings, not whoever
 * registered that handle first. Reels was added late — anything routed at the top
 * level belongs on this list.
 */
export const RESERVED = new Set([
  "api", "media", "explore", "settings", "messages", "notifications", "auth", "login", "signup",
  "logout", "admin", "about", "help", "home", "create", "saved", "direct", "stories", "search",
  "reset", "forgot", "p", "u", "post", "user", "tag", "tags", "lumen", "support", "privacy", "terms",
  "reels", "collections", "comments", "conversations", "calls", "feed", "report", "reports",
]);

/** One definition of a valid handle, shared by signup, availability and renaming. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters.")
  .max(24, "Username must be 24 characters or fewer.")
  .regex(/^[a-z0-9._]+$/, "Use only letters, numbers, dots and underscores.")
  .refine((v) => !v.startsWith(".") && !v.endsWith("."), "Username cannot start or end with a dot.")
  .refine((v) => !v.includes(".."), "Username cannot contain consecutive dots.")
  .refine((v) => !RESERVED.has(v), "That username is reserved.");

/** How long you must wait between changes, so handles cannot be churned or squatted. */
export const USERNAME_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

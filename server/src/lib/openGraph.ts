import { get } from "../db.ts";

/**
 * Open Graph tags for shared links.
 *
 * This runs for signed-out crawlers, so it may only ever describe content that
 * is public: a private account's post gets the generic card, never its caption
 * or image. Everything interpolated is escaped — a caption ends up inside an
 * HTML attribute.
 */
export type Preview = { title: string; description: string; image: string | null; url: string };

const DEFAULT: Omit<Preview, "url"> = {
  title: "Lumen",
  description: "A quieter place for the pictures you actually care about.",
  image: null,
};

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, max = 180): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function previewForPath(pathname: string, origin: string): Preview {
  const url = `${origin}${pathname}`;

  const postMatch = /^\/p\/([a-z0-9]{6,40})$/i.exec(pathname);
  if (postMatch) {
    const row = get<{
      caption: string;
      username: string;
      display_name: string;
      is_private: number;
      media_id: string | null;
    }>(
      `SELECT p.caption, u.username, u.display_name, u.is_private,
              (SELECT m.id FROM post_media pm JOIN media m ON m.id = pm.media_id
                WHERE pm.post_id = p.id ORDER BY pm.position LIMIT 1) AS media_id
       FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
      postMatch[1],
    );
    if (!row || row.is_private) return { ...DEFAULT, url };
    const who = row.display_name || row.username;
    return {
      title: `${who} (@${row.username}) on Lumen`,
      description: row.caption ? clip(row.caption) : `A photo shared by @${row.username}.`,
      image: row.media_id ? `${origin}/media/${row.media_id}/feed.webp` : null,
      url,
    };
  }

  const userMatch = /^\/([a-z0-9._]{3,24})$/i.exec(pathname);
  if (userMatch) {
    const row = get<{ username: string; display_name: string; bio: string; is_private: number; avatar_id: string | null }>(
      "SELECT username, display_name, bio, is_private, avatar_id FROM users WHERE username = ?",
      userMatch[1].toLowerCase(),
    );
    if (!row) return { ...DEFAULT, url };
    const who = row.display_name || row.username;
    return {
      title: `${who} (@${row.username}) on Lumen`,
      // A private account still gets a profile card — that much is visible in
      // the app too — but never its bio.
      description: row.is_private ? "This account is private." : row.bio ? clip(row.bio) : `Photos by @${row.username}.`,
      image: row.avatar_id && !row.is_private ? `${origin}/media/${row.avatar_id}/thumb.webp` : null,
      url,
    };
  }

  return { ...DEFAULT, url };
}

/** Injects the tags into the built index.html just before </head>. */
export function injectPreview(html: string, preview: Preview): string {
  const tags = [
    `<meta property="og:type" content="${preview.image ? "article" : "website"}">`,
    `<meta property="og:site_name" content="Lumen">`,
    `<meta property="og:title" content="${escapeAttr(preview.title)}">`,
    `<meta property="og:description" content="${escapeAttr(preview.description)}">`,
    `<meta property="og:url" content="${escapeAttr(preview.url)}">`,
    preview.image ? `<meta property="og:image" content="${escapeAttr(preview.image)}">` : "",
    `<meta name="twitter:card" content="${preview.image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeAttr(preview.title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(preview.description)}">`,
    preview.image ? `<meta name="twitter:image" content="${escapeAttr(preview.image)}">` : "",
    `<meta name="description" content="${escapeAttr(preview.description)}">`,
  ]
    .filter(Boolean)
    .join("\n    ");

  return html.replace("</head>", `    ${tags}\n  </head>`);
}

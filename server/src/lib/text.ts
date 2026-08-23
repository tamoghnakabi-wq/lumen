const HASHTAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_]{1,50})/gu;
const MENTION_RE = /(?:^|[\s(])@([a-z0-9._]{2,24})/gi;

export function extractHashtags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HASHTAG_RE)) out.add(m[1].toLowerCase());
  return [...out].slice(0, 30);
}

export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1].toLowerCase().replace(/\.+$/, ""));
  return [...out].slice(0, 20);
}

/** Collapses runs of blank lines and trims, so captions cannot be padded into giant blocks. */
export function tidy(text: string, maxLines = 30): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .slice(0, maxLines)
    .join("\n")
    .trim();
}

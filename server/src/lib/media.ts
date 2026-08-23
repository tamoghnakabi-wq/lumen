import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import multer from "multer";
import { config, uploadsDir } from "../config.ts";
import { all, get, run } from "../db.ts";
import { newMediaId } from "./ids.ts";
import { badRequest } from "./http.ts";
import type { MediaRow } from "./shape.ts";
import { enqueueTranscode, extractPoster, probeVideo, videoSupported } from "./video.ts";

// A video reuses the three image variants for its poster frame, so grids,
// link previews and blur placeholders work on video posts with no special
// casing anywhere; "video" is the playable file itself.
export const VARIANTS = ["thumb", "feed", "full", "video"] as const;
export type Variant = (typeof VARIANTS)[number];

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/heic", "image/heif"]);
const ACCEPTED_VIDEO = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-m4v",
  "video/mpeg",
  "video/3gpp",
]);

export function isVideoUpload(mimetype: string): boolean {
  return ACCEPTED_VIDEO.has(mimetype);
}

/** Files are buffered in memory, re-encoded by sharp, then written to disk — originals are never stored. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxPostImages,
    // Without these a multipart body could carry unbounded text fields and
    // exhaust memory long before any image is decoded.
    fields: 12,
    fieldSize: 8 * 1024,
    fieldNameSize: 100,
    parts: config.maxPostImages + 12,
    headerPairs: 100,
  },
  fileFilter(_req, file, cb) {
    if (!ACCEPTED.has(file.mimetype)) {
      cb(badRequest("Only JPEG, PNG, WebP, AVIF, GIF or HEIC images are supported."));
      return;
    }
    cb(null, true);
  },
});

/**
 * Decoding is the expensive step: a 300 KB PNG can expand to hundreds of
 * megabytes in memory. Cap how many run at once so a burst of uploads queues
 * instead of taking the process down, and keep libvips from spawning a thread
 * pool per request on top of that.
 */
sharp.concurrency(Math.max(1, Math.min(4, config.maxConcurrentUploads)));
sharp.cache({ files: 0, memory: 64 });

let active = 0;
const waiting: (() => void)[] = [];

async function withUploadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.maxConcurrentUploads) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function dirFor(id: string) {
  return path.join(uploadsDir, id.slice(0, 2), id);
}

export function fileFor(id: string, variant: Variant) {
  return path.join(dirFor(id), variant === "video" ? "video.mp4" : `${variant}.webp`);
}

export function mediaDir(id: string) {
  return dirFor(id);
}

/**
 * Re-encodes an upload into three WebP variants plus a tiny inline preview,
 * and records the metadata row. Returns the stored media row.
 */
export async function storeImage(input: Buffer | string, ownerId: string | null): Promise<MediaRow> {
  return withUploadSlot(() => processImage(input, ownerId));
}

/** `input` is either the bytes or a path on disk; sharp reads both. */
async function processImage(input: Buffer | string, ownerId: string | null): Promise<MediaRow> {
  // Read the header only. limitInputPixels makes sharp refuse a decompression
  // bomb here, before any pixel buffer is allocated.
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: config.maxImagePixels }).metadata();
  } catch {
    throw badRequest("That file could not be read as an image.");
  }
  if (!meta.width || !meta.height) throw badRequest("That file could not be read as an image.");
  if (meta.width > 12000 || meta.height > 12000) throw badRequest("That image is too large (max 12000px per side).");
  if (meta.width * meta.height > config.maxImagePixels) {
    throw badRequest(
      `That image is too detailed (max ${Math.round(config.maxImagePixels / 1_000_000)} megapixels).`,
    );
  }
  // An animated source is flattened to its first frame; pages * height is the
  // real decode cost, so check it too.
  if ((meta.pages ?? 1) > 1 && meta.width * meta.height * (meta.pages ?? 1) > config.maxImagePixels * 4) {
    throw badRequest("That animation is too large to process.");
  }

  const id = newMediaId();
  const dir = dirFor(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });

  // .rotate() applies EXIF orientation; sharp drops all other metadata by default.
  const base = sharp(input, { failOn: "none", limitInputPixels: config.maxImagePixels }).rotate();

  let feedBuf: Buffer;
  let fullBuf: Buffer;
  let thumbBuf: Buffer;
  let previewBuf: Buffer;
  let feedMeta: Metadata;
  try {
    feedBuf = await base
      .clone()
      .resize({ width: 1080, height: 1350, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    feedMeta = await sharp(feedBuf).metadata();

    fullBuf = await base
      .clone()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer();

    thumbBuf = await base
      .clone()
      .resize({ width: 400, height: 400, fit: "cover", position: "attention" })
      .webp({ quality: 78 })
      .toBuffer();

    previewBuf = await base.clone().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();

    await Promise.all([
      fs.writeFile(fileFor(id, "feed"), feedBuf),
      fs.writeFile(fileFor(id, "full"), fullBuf),
      fs.writeFile(fileFor(id, "thumb"), thumbBuf),
    ]);
  } catch (err) {
    // A truncated or hostile file can fail partway through; leave nothing behind.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (err && typeof err === "object" && "status" in err) throw err;
    throw badRequest("That image could not be processed.");
  }

  const row: MediaRow = {
    id,
    owner_id: ownerId,
    kind: "image",
    status: "ready",
    duration_ms: 0,
    has_audio: 0,
    width: feedMeta.width ?? meta.width,
    height: feedMeta.height ?? meta.height,
    bytes: feedBuf.length + fullBuf.length + thumbBuf.length,
    preview: `data:image/webp;base64,${previewBuf.toString("base64")}`,
    created_at: Date.now(),
  };
  run(
    "INSERT INTO media (id, owner_id, width, height, bytes, preview, created_at) VALUES (?,?,?,?,?,?,?)",
    row.id,
    row.owner_id,
    row.width,
    row.height,
    row.bytes,
    row.preview,
    row.created_at,
  );
  return row;
}

export function getMedia(id: string): MediaRow | undefined {
  return get<MediaRow>("SELECT * FROM media WHERE id = ?", id);
}

/** Removes the DB row and the files on disk. Safe to call for ids that no longer exist. */
export async function deleteMedia(id: string) {
  run("DELETE FROM media WHERE id = ?", id);
  await fs.rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
}

/**
 * Deletes images nothing points at any more — the residue of a cascaded delete
 * or an interrupted upload. Only touches media older than an hour so an
 * in-flight upload is never swept out from under a request.
 */
export async function sweepOrphanMedia() {
  const orphans = all<{ id: string }>(
    `SELECT m.id FROM media m
      WHERE m.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM stories s    WHERE s.media_id  = m.id)
        AND NOT EXISTS (SELECT 1 FROM messages msg WHERE msg.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM users u      WHERE u.avatar_id  = m.id)`,
    Date.now() - 60 * 60 * 1000,
  );
  for (const orphan of orphans) await deleteMedia(orphan.id);
  return orphans.length;
}


/* ------------------------------------------------------------------ video */

const tmpDir = path.join(os.tmpdir(), "lumen-uploads");

/**
 * Post uploads land on disk rather than in memory: a 150 MB video held as a
 * Buffer per concurrent request is exactly the kind of thing that takes the
 * process down. sharp and ffmpeg both read straight from a path.
 */
export const uploadPostMedia = multer({
  storage: multer.diskStorage({
    async destination(_req, _file, cb) {
      await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 }).catch(() => {});
      cb(null, tmpDir);
    },
    filename(_req, _file, cb) {
      cb(null, `${newMediaId()}.upload`);
    },
  }),
  limits: {
    // One ceiling for both kinds; images are checked against their own, smaller
    // limit once the size is known.
    fileSize: Math.max(config.maxUploadBytes, config.video.maxBytes),
    files: config.maxPostImages,
    fields: 12,
    fieldSize: 8 * 1024,
    fieldNameSize: 100,
    parts: config.maxPostImages + 12,
    headerPairs: 100,
  },
  fileFilter(_req, file, cb) {
    if (ACCEPTED.has(file.mimetype) || ACCEPTED_VIDEO.has(file.mimetype)) return cb(null, true);
    cb(badRequest("Upload a photo (JPEG, PNG, WebP, HEIC) or a video (MP4, MOV, WebM)."));
  },
});

/** Removes a multer temp file; safe to call twice. */
export async function discardUpload(file?: { path?: string }) {
  if (file?.path) await fs.rm(file.path, { force: true }).catch(() => {});
}

/**
 * Validates a video, writes its poster immediately and queues the transcode.
 *
 * The row is returned in `processing`: the post can be created and shown right
 * away with a real poster frame, and playback unlocks when the encode lands.
 */
export async function storeVideo(sourcePath: string, ownerId: string | null): Promise<MediaRow> {
  if (!(await videoSupported())) {
    throw badRequest("Video uploads are not available on this server.");
  }

  const probe = await probeVideo(sourcePath);
  if (probe.durationMs > 0 && probe.durationMs > config.video.maxDurationMs) {
    throw badRequest(
      `That video is ${Math.round(probe.durationMs / 1000)}s — the limit is ${Math.round(config.video.maxDurationMs / 1000)}s.`,
    );
  }
  if (probe.width < 32 || probe.height < 32) throw badRequest("That video is too small to post.");
  if (probe.width > 8192 || probe.height > 8192) throw badRequest("That video's resolution is too large.");

  const id = newMediaId();
  const dir = dirFor(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });

  try {
    // Grab a frame a little way in: the very first frame is often black.
    const at = probe.durationMs > 1500 ? Math.min(1000, probe.durationMs / 4) : 0;
    const poster = await extractPoster(sourcePath, at);

    // The poster goes through the ordinary image pipeline, which is why a video
    // needs no special handling in grids, previews or link cards.
    const base = sharp(poster, { failOn: "none" }).rotate();
    const [feedBuf, fullBuf, thumbBuf, previewBuf] = await Promise.all([
      base.clone().resize({ width: 1080, height: 1350, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
      base.clone().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer(),
      base.clone().resize({ width: 400, height: 400, fit: "cover", position: "attention" }).webp({ quality: 78 }).toBuffer(),
      base.clone().resize({ width: 16 }).webp({ quality: 40 }).toBuffer(),
    ]);
    await Promise.all([
      fs.writeFile(fileFor(id, "feed"), feedBuf),
      fs.writeFile(fileFor(id, "full"), fullBuf),
      fs.writeFile(fileFor(id, "thumb"), thumbBuf),
    ]);

    // Dimensions come from the poster so they match what will be displayed
    // after the transcode's aspect-preserving scale.
    const posterMeta = await sharp(feedBuf).metadata();
    const row: MediaRow = {
      id,
      owner_id: ownerId,
      kind: "video",
      status: "processing",
      width: posterMeta.width ?? probe.width,
      height: posterMeta.height ?? probe.height,
      bytes: 0,
      duration_ms: Math.min(probe.durationMs, config.video.maxDurationMs),
      has_audio: probe.hasAudio ? 1 : 0,
      preview: `data:image/webp;base64,${previewBuf.toString("base64")}`,
      created_at: Date.now(),
    };
    run(
      `INSERT INTO media (id, owner_id, kind, status, width, height, bytes, duration_ms, has_audio, preview, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.owner_id,
      row.kind,
      row.status,
      row.width,
      row.height,
      row.bytes,
      row.duration_ms,
      row.has_audio,
      row.preview,
      row.created_at,
    );

    // Hand the source to the queue, which owns deleting it when it is done.
    enqueueTranscode({
      mediaId: id,
      ownerId,
      input: sourcePath,
      output: fileFor(id, "video"),
      probe,
    });

    return row;
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

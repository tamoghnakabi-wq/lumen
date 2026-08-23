import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../config.ts";
import { get, run } from "../db.ts";
import { badRequest } from "./http.ts";
import { log } from "./log.ts";
import { emitToUser } from "./bus.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Video processing.
 *
 * Every upload is re-encoded to one predictable shape — H.264 + AAC in MP4 with
 * the moov atom at the front — for the same reason images are re-encoded to
 * WebP: the browser gets something it can definitely play, exotic containers
 * and codecs never reach a viewer, and the output size is bounded by us rather
 * than by whatever the uploader had.
 *
 * Transcoding is slow, so it happens after the request returns. The poster
 * frame is extracted synchronously (a fraction of a second) so the post is
 * never a blank rectangle while its video is still being processed.
 */

/** Prefer a system ffmpeg, fall back to the bundled binary. */
function resolveFfmpeg(): string | null {
  try {
    return require("ffmpeg-static") as string;
  } catch {
    return "ffmpeg";
  }
}

const FFMPEG = resolveFfmpeg();
let ffmpegChecked = false;
let ffmpegWorks = false;

export async function videoSupported(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegWorks;
  ffmpegChecked = true;
  try {
    if (!FFMPEG) return (ffmpegWorks = false);
    await execFileAsync(FFMPEG, ["-version"], { timeout: 10_000 });
    ffmpegWorks = true;
  } catch {
    ffmpegWorks = false;
  }
  return ffmpegWorks;
}

export type Probe = { durationMs: number; width: number; height: number; hasAudio: boolean };

/**
 * Reads duration, dimensions and whether there is an audio track.
 *
 * ffmpeg reports this on stderr when asked to decode nothing, which avoids a
 * second 300 MB dependency just for ffprobe. Exit code is ignored on purpose:
 * "at least one output file must be specified" is the expected failure.
 */
export async function probeVideo(file: string): Promise<Probe> {
  const output = await new Promise<string>((resolve) => {
    const child = spawn(FFMPEG!, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", () => resolve(stderr));
    child.on("error", () => resolve(""));
    setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
  });

  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
  const video = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video:.*?,\s*(\d{2,5})x(\d{2,5})/s.exec(output);
  const hasAudio = /Stream #\d+:\d+.*?: Audio:/.test(output);

  if (!video) throw badRequest("That file does not contain a video track we can read.");

  const durationMs = duration
    ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
    : 0;

  return {
    durationMs,
    width: Number(video[1]),
    height: Number(video[2]),
    hasAudio,
  };
}

/** Writes a single frame as a JPEG buffer, used as the poster image. */
export async function extractPoster(file: string, atMs: number): Promise<Buffer> {
  const seconds = Math.max(0, atMs / 1000).toFixed(2);
  const { stdout } = await execFileAsync(
    FFMPEG!,
    [
      "-hide_banner",
      "-loglevel", "error",
      // -ss before -i seeks by keyframe, which is near-instant.
      "-ss", seconds,
      "-i", file,
      "-frames:v", "1",
      "-f", "image2",
      "-vcodec", "mjpeg",
      "-q:v", "3",
      "pipe:1",
    ],
    { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
  );
  if (!stdout || stdout.length === 0) throw badRequest("Could not read a frame from that video.");
  return stdout as unknown as Buffer;
}

/**
 * Transcodes to a web-safe MP4, bounded in resolution, bitrate and duration.
 * scale keeps the aspect ratio and forces even dimensions, which H.264 requires.
 */
async function transcode(input: string, output: string, probe: Probe): Promise<void> {
  const maxEdge = config.video.maxEdge;
  const portrait = probe.height >= probe.width;
  const scale = portrait
    ? `scale='min(${maxEdge},iw)':-2`
    : `scale=-2:'min(${maxEdge},ih)'`;

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", input,
    // Hard cap: a file that lies about its duration cannot produce a long output.
    "-t", String(config.video.maxDurationMs / 1000),
    "-vf", `${scale},format=yuv420p`,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-crf", String(config.video.crf),
    "-maxrate", `${config.video.maxBitrateKbps}k`,
    "-bufsize", `${config.video.maxBitrateKbps * 2}k`,
    "-r", String(config.video.maxFps),
    "-movflags", "+faststart",
    "-map_metadata", "-1",
  ];
  if (probe.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  } else {
    args.push("-an");
  }
  args.push("-y", output);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG!, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString().slice(0, 2000)));
    const killer = setTimeout(() => child.kill("SIGKILL"), config.video.transcodeTimeoutMs);
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/* --------------------------------------------------------------- the queue */

type Job = { mediaId: string; ownerId: string | null; input: string; output: string; probe: Probe };

const queue: Job[] = [];
let running = 0;

/**
 * Transcodes run outside the request. Concurrency is capped because ffmpeg will
 * happily consume every core, and this process also has to keep serving.
 */
function pump() {
  while (running < config.video.concurrency && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    void runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function runJob(job: Job) {
  const startedAt = Date.now();
  try {
    await transcode(job.input, job.output, job.probe);
    const stat = await fs.stat(job.output);
    run(
      "UPDATE media SET status = 'ready', bytes = ? WHERE id = ?",
      stat.size,
      job.mediaId,
    );
    log.info("video ready", { media: job.mediaId, ms: Date.now() - startedAt, bytes: stat.size });
    if (job.ownerId) emitToUser(job.ownerId, "media:ready", { mediaId: job.mediaId });
  } catch (err) {
    run("UPDATE media SET status = 'failed' WHERE id = ?", job.mediaId);
    await fs.rm(job.output, { force: true }).catch(() => {});
    log.error("video transcode failed", {
      media: job.mediaId,
      message: err instanceof Error ? err.message : String(err),
    });
    if (job.ownerId) emitToUser(job.ownerId, "media:failed", { mediaId: job.mediaId });
  } finally {
    // The upload's temporary copy is never needed again.
    await fs.rm(job.input, { force: true }).catch(() => {});
  }
}

export function enqueueTranscode(job: Job) {
  queue.push(job);
  pump();
}

export function transcodeQueueDepth() {
  return { queued: queue.length, running };
}

/**
 * Anything left in `processing` after a restart can never finish — the queue
 * lived in memory. Mark it failed rather than leaving posts spinning forever.
 */
export function failInterruptedTranscodes(): number {
  const stuck = run("UPDATE media SET status = 'failed' WHERE kind = 'video' AND status = 'processing'");
  return Number(stuck.changes ?? 0);
}

export function videoFileFor(dir: string) {
  return path.join(dir, "video.mp4");
}

export function mediaStatus(mediaId: string): string | undefined {
  return get<{ status: string }>("SELECT status FROM media WHERE id = ?", mediaId)?.status;
}

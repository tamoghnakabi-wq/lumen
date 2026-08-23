/**
 * Video and Reels suite.
 *
 * Uploads real encoded video (generated with ffmpeg at run time), waits for the
 * server's transcode, and checks playback, range requests, authorization,
 * limits, failure handling and cleanup on disk.
 *
 *   node scripts/video-test.js [baseUrl]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPLOADS = path.join(root, "data", "uploads");

let passed = 0;
const failures = [];
let section = "";

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${section} — ${name}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ""}`);
  }
}
function heading(title) {
  section = title;
  console.log(`\n${title}`);
}

function client() {
  const jar = new Map();
  return {
    async fetch(pathname, options = {}) {
      const headers = new Headers(options.headers ?? {});
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.set("cookie", cookie);
      if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        options.body = JSON.stringify(options.json);
      }
      const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const type = res.headers.get("content-type") ?? "";
      return {
        status: res.status,
        body: type.includes("application/json") ? await res.json() : await res.text(),
        headers: res.headers,
      };
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-video-test-"));

/** Renders a real clip so the server has genuine encoded video to work with. */
async function makeVideo(name, { seconds = 3, width = 720, height = 1280, audio = true } = {}) {
  const file = path.join(tmp, name);
  const args = ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=24:duration=${seconds}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  await execFileAsync("ffmpeg", args, { timeout: 120_000 });
  return fs.readFileSync(file);
}

function png(width = 64, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 3) % 256;
      raw[o++] = (y * 3) % 256;
      raw[o++] = 150;
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function form(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) fd.append(key, new Blob([v.file], { type: v.type }), v.name);
    } else if (value && value.file) {
      fd.append(key, new Blob([value.file], { type: value.type }), value.name);
    } else fd.append(key, value);
  }
  return fd;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a post until its video leaves the processing state. */
async function waitForProcessing(session, postId, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await session.fetch(`/api/posts/${postId}`);
    const media = r.body.post?.media?.[0];
    if (media && media.status !== "processing") return media;
    await wait(700);
  }
  return null;
}

function mediaDirFor(id) {
  return path.join(UPLOADS, id.slice(0, 2), id);
}

const stamp = Math.random().toString(36).slice(2, 7);
const pw = "VideoSuite!2026";
const people = {
  creator: { username: `vid_a_${stamp}`, email: `vid_a_${stamp}@test.dev`, password: pw },
  viewer: { username: `vid_b_${stamp}`, email: `vid_b_${stamp}@test.dev`, password: pw },
  hermit: { username: `vid_c_${stamp}`, email: `vid_c_${stamp}@test.dev`, password: pw },
};

async function main() {
  console.log(`\nLumen video suite → ${BASE}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`\nCannot reach ${BASE}.\n`);
    process.exit(1);
  }

  const creator = client();
  const viewer = client();
  const hermit = client();
  const anon = client();
  const ids = {};
  for (const [key, session] of [["creator", creator], ["viewer", viewer], ["hermit", hermit]]) {
    const r = await session.fetch("/api/auth/signup", { method: "POST", json: people[key] });
    if (r.status !== 201) {
      console.error(`\nCould not create ${key} (${r.status}). Start the server with DISABLE_RATE_LIMITS=1.\n`);
      process.exit(1);
    }
    ids[key] = r.body.user.id;
  }

  /* ------------------------------------------------------------- upload */
  heading("Uploading a video");

  const clip = await makeVideo("clip.mp4", { seconds: 3 });
  let r = await creator.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: clip, type: "video/mp4", name: "clip.mp4" }, caption: "a reel #video" }),
  });
  check("a video post is accepted", r.status === 201, r.body);
  const post = r.body.post;
  const media = post?.media?.[0];
  check("the media is recorded as video", media?.kind === "video", media);
  check("it starts out processing", media?.status === "processing", media?.status);
  check("its duration is read from the file", media?.durationMs >= 2500 && media?.durationMs <= 3500, media?.durationMs);
  check("an audio track is detected", media?.hasAudio === true, media?.hasAudio);
  check("portrait dimensions survive", media?.height > media?.width, { w: media?.width, h: media?.height });

  // The poster must exist immediately, or the post is a blank box while encoding.
  r = await creator.fetch(media.thumb);
  check("a poster frame is available before the transcode finishes", r.status === 200, { status: r.status });

  const ready = await waitForProcessing(creator, post.id);
  check("the transcode completes", ready?.status === "ready", ready?.status);

  r = await creator.fetch(media.video);
  check("the encoded video is served", r.status === 200, { status: r.status });
  check("...as video/mp4", (r.headers.get("content-type") ?? "").includes("video/mp4"), r.headers.get("content-type"));
  check("...with range support for seeking", r.headers.get("accept-ranges") === "bytes", r.headers.get("accept-ranges"));

  const ranged = await creator.fetch(media.video, { headers: { Range: "bytes=0-999" } });
  check("a range request returns 206", ranged.status === 206, { status: ranged.status });
  check("...with a Content-Range header", !!ranged.headers.get("content-range"), ranged.headers.get("content-range"));

  const dir = mediaDirFor(media.id);
  check("poster and video both exist on disk", fs.existsSync(path.join(dir, "video.mp4")) && fs.existsSync(path.join(dir, "thumb.webp")));

  /* -------------------------------------------------------------- reels */
  heading("Reels feed");

  r = await viewer.fetch("/api/reels");
  check("reels are listed", r.status === 200 && Array.isArray(r.body.reels), r.body);
  check("the new video appears", r.body.reels.some((x) => x.id === post.id), r.body.reels?.map((x) => x.id));
  check("every reel is a ready video", r.body.reels.every((x) => x.media[0]?.kind === "video" && x.media[0]?.status === "ready"));

  // A photo post must never surface as a reel.
  const photoPost = (
    await creator.fetch("/api/posts", { method: "POST", body: form({ images: { file: png(), type: "image/png", name: "p.png" }, caption: "a photo" }) })
  ).body.post;
  r = await viewer.fetch("/api/reels");
  check("photo posts are excluded from reels", !r.body.reels.some((x) => x.id === photoPost.id));

  r = await viewer.fetch(`/api/reels?seed=${post.id}`);
  check("a seeded reel is returned first", r.body.reels?.[0]?.id === post.id, r.body.reels?.[0]?.id);

  /* -------------------------------------------------------- limits */
  heading("Validation and limits");

  r = await creator.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.from("this is not a video"), type: "video/mp4", name: "fake.mp4" } }),
  });
  check("a non-video disguised as mp4 is rejected", r.status === 400, { status: r.status, error: r.body?.error });

  const long = await makeVideo("long.mp4", { seconds: 95, width: 320, height: 240, audio: false });
  r = await creator.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: long, type: "video/mp4", name: "long.mp4" }, caption: "too long" }),
  });
  check("a video past the duration limit is rejected", r.status === 400, { status: r.status, error: r.body?.error });
  check("...with a message naming the limit", /90s|limit/i.test(r.body?.error ?? ""), r.body?.error);

  const second = await makeVideo("second.mp4", { seconds: 2, audio: false });
  r = await creator.fetch("/api/posts", {
    method: "POST",
    body: form({
      images: [
        { file: clip, type: "video/mp4", name: "a.mp4" },
        { file: second, type: "video/mp4", name: "b.mp4" },
      ],
    }),
  });
  check("two videos in one post are rejected", r.status === 400, { status: r.status });

  r = await creator.fetch("/api/posts", {
    method: "POST",
    body: form({
      images: [
        { file: clip, type: "video/mp4", name: "a.mp4" },
        { file: png(), type: "image/png", name: "b.png" },
      ],
    }),
  });
  check("mixing a video and a photo is rejected", r.status === 400, { status: r.status });

  r = await creator.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.from("<html>nope</html>"), type: "video/webm", name: "evil.webm" } }),
  });
  check("HTML disguised as webm is rejected", r.status === 400, { status: r.status });

  const beforeDirs = fs.existsSync(UPLOADS)
    ? fs.readdirSync(UPLOADS).reduce((n, shard) => n + fs.readdirSync(path.join(UPLOADS, shard)).length, 0)
    : 0;
  await creator.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.from("garbage"), type: "video/mp4", name: "bad.mp4" } }),
  });
  const afterDirs = fs.existsSync(UPLOADS)
    ? fs.readdirSync(UPLOADS).reduce((n, shard) => n + fs.readdirSync(path.join(UPLOADS, shard)).length, 0)
    : 0;
  check("a rejected video leaves nothing on disk", afterDirs === beforeDirs, { beforeDirs, afterDirs });

  /* -------------------------------------------------- authorization */
  heading("Video obeys the same privacy rules as photos");

  await hermit.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });
  const hermitClip = await makeVideo("private.mp4", { seconds: 2, audio: false });
  const privatePost = (
    await hermit.fetch("/api/posts", {
      method: "POST",
      body: form({ images: { file: hermitClip, type: "video/mp4", name: "private.mp4" }, caption: "private reel" }),
    })
  ).body.post;
  const privateMedia = await waitForProcessing(hermit, privatePost.id);
  check("the private video processes", privateMedia?.status === "ready", privateMedia?.status);

  r = await anon.fetch(privateMedia.video);
  check("anonymous cannot fetch a private account's video", r.status === 404, { status: r.status });
  r = await viewer.fetch(privateMedia.video);
  check("a stranger cannot fetch it either", r.status === 404, { status: r.status });
  r = await anon.fetch(privateMedia.thumb);
  check("...nor its poster frame", r.status === 404, { status: r.status });

  r = await viewer.fetch("/api/reels");
  check("private videos stay out of the reels feed", !r.body.reels.some((x) => x.id === privatePost.id));

  // Blocking must cut off a video that was previously reachable.
  await creator.fetch(`/api/users/${ids.viewer}/block`, { method: "POST" });
  r = await viewer.fetch(ready.video);
  check("blocking revokes access to an already-known video URL", r.status === 404, { status: r.status });
  r = await viewer.fetch("/api/reels");
  check("...and removes it from their reels", !r.body.reels.some((x) => x.id === post.id));
  await creator.fetch(`/api/users/${ids.viewer}/block`, { method: "DELETE" });

  /* ------------------------------------------------------------ deletion */
  heading("Deletion removes the video from disk");

  const doomed = (
    await creator.fetch("/api/posts", {
      method: "POST",
      body: form({ images: { file: second, type: "video/mp4", name: "doomed.mp4" }, caption: "temporary" }),
    })
  ).body.post;
  const doomedMedia = await waitForProcessing(creator, doomed.id);
  const doomedDir = mediaDirFor(doomedMedia.id);
  check("the doomed video is on disk", fs.existsSync(path.join(doomedDir, "video.mp4")));

  await creator.fetch(`/api/posts/${doomed.id}`, { method: "DELETE" });
  check("deleting the post removes the whole media directory", !fs.existsSync(doomedDir), doomedDir);
  r = await creator.fetch(doomedMedia.video);
  check("...and the video URL stops resolving", r.status === 404, { status: r.status });

  /* -------------------------------------------------- everything else */
  heading("Video posts behave like posts");

  r = await viewer.fetch(`/api/posts/${post.id}/like`, { method: "POST" });
  check("a reel can be liked", r.body.post?.counts?.likes === 1, r.body.post?.counts);
  r = await viewer.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "great clip" } });
  check("a reel can be commented on", r.status === 201, r.body);
  r = await viewer.fetch(`/api/posts/${post.id}/repost`, { method: "POST" });
  check("a reel can be reposted", r.body.post?.counts?.reposts === 1, r.body.post?.counts);

  r = await viewer.fetch(`/api/users/${people.creator.username}/posts`);
  const inGrid = r.body.posts?.find((p) => p.id === post.id);
  check("the reel shows on the author's profile grid", !!inGrid, r.body.posts?.length);
  check("...with a poster the grid can render", !!inGrid?.media?.[0]?.thumb, inGrid?.media?.[0]);

  r = await anon.fetch(`/p/${post.id}`);
  check("the link preview page still renders for a video post", r.status === 200 && String(r.body).includes("og:image"));

  /* -------------------------------------------------------------- cleanup */
  heading("Cleanup");
  let removed = 0;
  for (const [session, person] of [[creator, people.creator], [viewer, people.viewer], [hermit, people.hermit]]) {
    const res = await session.fetch("/api/me", { method: "DELETE", json: { password: person.password } });
    if (res.status === 200) removed++;
  }
  check(`test accounts removed (${removed}/3)`, removed === 3, { removed });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log("Failed:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nVideo suite crashed:", err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});

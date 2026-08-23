import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import { assertProductionConfig, config } from "./config.ts";
import { checkpoint, closeDatabase } from "./db.ts";
import { attachUser, pruneSessions } from "./lib/auth.ts";
import { withViewer } from "./lib/viewerContext.ts";
import { HttpError, notFound, rateLimit, clientKey } from "./lib/http.ts";
import { log, errorId } from "./lib/log.ts";
import { VARIANTS, fileFor, sweepOrphanMedia, type Variant } from "./lib/media.ts";
import { failInterruptedTranscodes, videoSupported } from "./lib/video.ts";
import { decideMediaAccess } from "./lib/mediaAccess.ts";
import { injectPreview, previewForPath } from "./lib/openGraph.ts";
import { inlineScriptHashes, sameOriginOnly, securityHeaders } from "./lib/security.ts";
import { createRealtime } from "./realtime.ts";
import { authRouter } from "./routes/auth.ts";
import { callsRouter } from "./routes/calls.ts";
import { collectionsRouter } from "./routes/collections.ts";
import { exploreRouter } from "./routes/explore.ts";
import { feedRouter } from "./routes/feed.ts";
import { conversationsRouter, messagesRouter } from "./routes/messages.ts";
import { notificationsRouter, reportsRouter } from "./routes/notifications.ts";
import { commentsRouter, postsRouter } from "./routes/posts.ts";
import { reelsRouter } from "./routes/reels.ts";
import { purgeExpiredStories, storiesRouter } from "./routes/stories.ts";
import { meRouter, usersRouter } from "./routes/users.ts";

for (const problem of assertProductionConfig()) log.warn(`config: ${problem}`);
if (!config.rateLimitsEnabled) log.warn("rate limiting is DISABLED (development only)");

const app = express();

// Only the loopback hop (cloudflared runs on this host) may set X-Forwarded-*.
// Trusting every proxy would let any client spoof its IP and slip rate limits.
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
app.set("etag", "strong");

const indexHtmlPath = path.join(config.webDist, "index.html");
app.use(securityHeaders(inlineScriptHashes(indexHtmlPath)));

/* ------------------------------------------------------------- logging */

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "debug";
    // Paths can carry usernames but never secrets; query strings are dropped.
    // The client address is recorded only for failures — enough to investigate
    // abuse, without keeping an address log of everyone who reads a page.
    log[level]("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
      ip: res.statusCode >= 400 ? req.ip : undefined,
      user: req.user?.username,
    });
  });
  next();
});

/* --------------------------------------------------------- global guard */

// A ceiling that no legitimate client comes near, so one host cannot saturate
// the single-threaded server even with otherwise-allowed requests.
app.use((req, _res, next) => {
  try {
    rateLimit(`global:${clientKey(req)}`, 600, 60_000);
    next();
  } catch (err) {
    next(err);
  }
});

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use(attachUser);
// Everything downstream can ask who is looking, without being handed a viewer.
app.use(withViewer);
app.use(sameOriginOnly);

/* ------------------------------------------------------------- media */

app.get("/media/:id/:file", (req, res, next) => {
  const { id, file } = req.params;
  // thumb.webp | feed.webp | full.webp | video.mp4
  const variant = file.replace(/\.(webp|mp4)$/, "") as Variant;
  const extension = variant === "video" ? ".mp4" : ".webp";
  if (!/^[a-z0-9]{8,40}$/.test(id) || !VARIANTS.includes(variant) || !file.endsWith(extension)) {
    return next(notFound());
  }

  // Unguessable ids are not access control on their own: private posts, stories
  // and DM attachments are authorized on every request.
  const decision = decideMediaAccess(id, req.user?.id ?? null);
  if (!decision.allow) {
    return next(decision.reason === "forbidden" ? notFound("Image not found.") : notFound("Image not found."));
  }

  res.setHeader(
    "Cache-Control",
    decision.cache === "immutable"
      ? "public, max-age=31536000, immutable"
      : decision.cache === "public"
        ? "public, max-age=3600"
        : "private, max-age=600, must-revalidate",
  );
  // The same URL answers differently depending on who is asking.
  if (decision.cache !== "immutable") res.setHeader("Vary", "Cookie");
  // sendFile answers Range requests with 206 on its own, which is what lets a
  // <video> element seek without downloading the whole file first.
  res.sendFile(fileFor(id, variant), (err) => {
    if (err) next(notFound(variant === "video" ? "Video not found." : "Image not found."));
  });
});

/* --------------------------------------------------------------- api */

app.use("/api/auth", authRouter);
app.use("/api/feed", feedRouter);
app.use("/api/posts", postsRouter);
app.use("/api/comments", commentsRouter);
app.use("/api/users", usersRouter);
app.use("/api/me", meRouter);
app.use("/api/stories", storiesRouter);
app.use("/api/explore", exploreRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/collections", collectionsRouter);
app.use("/api/calls", callsRouter);
app.use("/api/reels", reelsRouter);
app.get("/api/health", (_req, res) => res.json({ ok: true, time: Date.now() }));
app.use("/api", (_req, _res, next) => next(notFound("Unknown endpoint.")));

/* ------------------------------------------------- static single page app */

const hasBuild = fs.existsSync(indexHtmlPath);
if (hasBuild) {
  app.use(
    express.static(config.webDist, {
      index: false,
      setHeaders(res, filePath) {
        // Hashed asset filenames can be cached forever; index.html must not be.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  // Shared links get Open Graph tags so a pasted post or profile URL previews
  // properly. Only public content is described; everything else falls back to
  // the generic card.
  let shell = fs.readFileSync(indexHtmlPath, "utf8");
  let shellMtime = fs.statSync(indexHtmlPath).mtimeMs;

  // Held in memory rather than read per request, but a rebuild replaces the file
  // underneath a running server — so notice when it changes instead of serving a
  // shell that points at asset hashes which no longer exist.
  function currentShell(): string {
    try {
      const mtime = fs.statSync(indexHtmlPath).mtimeMs;
      if (mtime !== shellMtime) {
        shell = fs.readFileSync(indexHtmlPath, "utf8");
        shellMtime = mtime;
      }
    } catch {
      /* mid-write during a deploy: keep the copy we already have */
    }
    return shell;
  }

  app.get("*", (req, res, next) => {
    // A hashed asset that express.static could not find belongs to a build that
    // no longer exists — a page held open across a deploy asking for its old
    // chunk. Answering with the HTML shell makes the browser reject it on MIME
    // grounds and render nothing; a real 404 lets the client reload instead.
    if (req.path.startsWith("/assets/")) return next();

    res.setHeader("Cache-Control", "no-cache");
    res.type("html");
    if (/^\/(p\/[a-z0-9]+|[a-z0-9._]{3,24})$/i.test(req.path)) {
      const origin = config.publicOrigin || `${req.protocol}://${req.get("host")}`;
      return res.send(injectPreview(currentShell(), previewForPath(req.path, origin)));
    }
    res.send(currentShell());
  });
} else {
  app.get("*", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(
        `<pre style="font:14px ui-monospace,monospace;padding:32px;line-height:1.6">Lumen API is running on port ${config.port}.

The web app has not been built yet.
  Development:  npm run dev        (Vite on :5190, proxying to this server)
  Production:   npm run serve      (builds web/dist, then serves it from here)
</pre>`,
      );
  });
}

/* ----------------------------------------------------------- errors */

app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    if (err.status === 429) {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 60;
      res.setHeader("Retry-After", String(retry));
    }
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error:
        `That file is too large. Photos must be under ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB ` +
        `and videos under ${Math.round(config.video.maxBytes / 1024 / 1024)} MB.`,
      code: "file_too_large",
    });
  }
  if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE" || err?.code === "LIMIT_PART_COUNT") {
    return res.status(400).json({ error: `You can attach up to ${config.maxPostImages} images.`, code: "too_many_files" });
  }
  if (err?.code === "LIMIT_FIELD_VALUE" || err?.code === "LIMIT_FIELD_COUNT" || err?.code === "LIMIT_FIELD_KEY") {
    return res.status(400).json({ error: "That form had too much data attached.", code: "bad_request" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "That request was too large.", code: "payload_too_large" });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "That request body was not valid JSON.", code: "bad_request" });
  }

  // Unexpected: log the detail, hand the user only a correlation id.
  const id = errorId();
  log.error("unhandled error", {
    id,
    method: req.method,
    path: req.path,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: "Something went wrong on our end.", code: "server_error", ref: id });
});

/* ------------------------------------------------------------- boot */

const server = http.createServer(app);
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 20_000;

const realtime = createRealtime(server);

async function maintenance() {
  try {
    const stories = await purgeExpiredStories();
    const media = await sweepOrphanMedia();
    const sessions = pruneSessions();
    checkpoint();
    if (stories || media || sessions) {
      log.info("maintenance", { expiredStories: stories, orphanImages: media, staleSessions: sessions });
    }
  } catch (err) {
    log.error("maintenance failed", { message: err instanceof Error ? err.message : String(err) });
  }
}
// A transcode queue only exists in memory, so anything mid-flight when the
// process stopped can never complete.
const interrupted = failInterruptedTranscodes();
if (interrupted > 0) log.warn("marked interrupted video transcodes as failed", { count: interrupted });
void videoSupported().then((ok) => {
  if (!ok) log.warn("ffmpeg is unavailable — video uploads are disabled");
});

void maintenance();
const maintenanceTimer = setInterval(() => void maintenance(), 60 * 60 * 1000);
maintenanceTimer.unref();

/* --------------------------------------------------- crash + shutdown */

// A stray rejection is usually one broken request, not a broken process: log it
// and keep serving the other connections rather than dropping everyone.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// An uncaught exception is different: the process may be in an undefined state,
// so carrying on risks serving corrupt data. Log it, close down cleanly, and
// exit non-zero for the supervisor to restart. (An earlier version kept running
// here, which once left a process alive that was not listening at all.)
process.on("uncaughtException", (err) => {
  log.error("uncaught exception — exiting", { message: err.message, stack: err.stack });
  try {
    closeDatabase();
  } catch {
    /* nothing more to do */
  }
  process.exit(1);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log.error(`port ${config.port} is already in use`, { hint: "stop the other server or set PORT" });
  } else {
    log.error("server error", { message: err.message, code: err.code });
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  clearInterval(maintenanceTimer);
  // Stop accepting connections, let in-flight requests finish, then checkpoint
  // the WAL so the database file on disk is complete for a backup or restart.
  realtime.close();
  server.close(() => {
    closeDatabase();
    log.info("stopped cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    log.warn("forced exit after timeout");
    closeDatabase();
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(config.port, config.host, () => {
  log.info("lumen ready", { port: config.port, env: config.env, data: config.dataDir, ui: hasBuild });
  if (!config.isProd) {
    console.log(`\n  Lumen server ready`);
    console.log(`  → http://localhost:${config.port}${hasBuild ? "" : "  (API only — run the Vite dev server for the UI)"}`);
    console.log(`  → data: ${config.dataDir}\n`);
  }
});

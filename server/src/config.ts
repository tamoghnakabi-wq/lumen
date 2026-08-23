import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
export const projectRoot = path.resolve(serverRoot, "..");

const isProd = process.env.NODE_ENV === "production";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number (got "${raw}")`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * How much of X-Forwarded-For to believe. Default "loopback" matches the
 * intended deployment (cloudflared runs on this host and connects over the
 * loopback interface), and it is what stops a client from spoofing its own IP
 * to escape rate limiting. Override only if a different proxy sits in front.
 */
function trustProxy(): boolean | string | number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return "loopback";
  if (raw === "true") return true;
  if (raw === "false") return false;
  const hops = Number(raw);
  return Number.isFinite(hops) ? hops : raw;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  isProd,
  port: int("PORT", 4310),
  /**
   * In production the only ingress is meant to be cloudflared running on this
   * host, so bind to loopback: that is what makes X-Forwarded-For trustworthy.
   * Exposing the port directly requires setting HOST and reviewing TRUST_PROXY.
   */
  host: process.env.HOST ?? (isProd ? "127.0.0.1" : "0.0.0.0"),
  dataDir: process.env.DATA_DIR ?? path.join(projectRoot, "data"),
  webDist: path.join(projectRoot, "web", "dist"),
  trustProxy: trustProxy(),

  /** Cookies are Secure whenever the request arrived over HTTPS; forced on in production. */
  forceSecureCookies: bool("FORCE_SECURE_COOKIES", isProd),

  sessionTtlMs: int("SESSION_TTL_DAYS", 30) * 24 * 60 * 60 * 1000,
  /** A session that goes unused for this long is dropped even if it has not expired. */
  sessionIdleMs: int("SESSION_IDLE_DAYS", 14) * 24 * 60 * 60 * 1000,
  resetTtlMs: int("RESET_TTL_MINUTES", 30) * 60 * 1000,
  storyTtlMs: 24 * 60 * 60 * 1000,

  maxUploadBytes: int("MAX_UPLOAD_MB", 12) * 1024 * 1024,
  maxPostImages: int("MAX_POST_IMAGES", 6),
  /** Refuse images above this many megapixels before decoding: decompression bombs. */
  maxImagePixels: int("MAX_IMAGE_MEGAPIXELS", 40) * 1_000_000,
  /** Simultaneous sharp pipelines. Beyond this, uploads queue instead of exhausting RAM. */
  maxConcurrentUploads: int("MAX_CONCURRENT_UPLOADS", 4),

  /**
   * Short-form video. The limits are deliberately Reel-shaped: long enough for
   * a real clip, short enough that transcoding stays quick and storage stays
   * predictable on a single machine.
   */
  video: {
    maxBytes: int("MAX_VIDEO_MB", 150) * 1024 * 1024,
    maxDurationMs: int("MAX_VIDEO_SECONDS", 90) * 1000,
    maxEdge: int("VIDEO_MAX_EDGE", 1280),
    maxFps: int("VIDEO_MAX_FPS", 30),
    maxBitrateKbps: int("VIDEO_MAX_BITRATE_KBPS", 2500),
    crf: int("VIDEO_CRF", 26),
    concurrency: int("VIDEO_CONCURRENCY", 1),
    transcodeTimeoutMs: int("VIDEO_TRANSCODE_TIMEOUT_SECONDS", 300) * 1000,
  },

  /** Optional: used for reset links when the request host cannot be trusted. */
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "",

  smtp: {
    url: process.env.SMTP_URL ?? "",
    from: process.env.MAIL_FROM ?? "Lumen <no-reply@lumen.local>",
  },

  /**
   * Audio calls are peer-to-peer, so the only server-side need is ICE.
   * STUN is enough for most networks and costs nothing to use. A TURN relay is
   * required only when both peers sit behind symmetric NAT; it is optional
   * here precisely so the app needs no extra infrastructure to work.
   */
  webrtc: {
    stunUrls: (process.env.STUN_URLS ?? "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    turnUrl: process.env.TURN_URL ?? "",
    turnUsername: process.env.TURN_USERNAME ?? "",
    turnCredential: process.env.TURN_CREDENTIAL ?? "",
  },

  /**
   * Rate limiting can be switched off for functional test runs, which would
   * otherwise trip the signup and upload ceilings. Ignored in production, where
   * the limits are the point.
   */
  rateLimitsEnabled: !(bool("DISABLE_RATE_LIMITS", false) && !isProd),

  logLevel: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  /** Print reset links to the console/log file when no mail transport is configured. */
  showResetLink: bool("LUMEN_SHOW_RESET_LINK", false),
};

export const uploadsDir = path.join(config.dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o750 });

/** Fail fast on a configuration that would be unsafe once real users arrive. */
export function assertProductionConfig() {
  const problems: string[] = [];
  if (!config.isProd) return problems;

  if (config.trustProxy === true) {
    problems.push(
      "TRUST_PROXY=true trusts any X-Forwarded-For header, which lets clients spoof their IP and bypass rate limits. Use 'loopback' or a hop count.",
    );
  }
  // 'loopback' means "believe X-Forwarded-For from a loopback peer". That is
  // only safe while the sole loopback peer is the tunnel; if the port is also
  // reachable directly, any client can set the header itself.
  const loopbackBound = config.host === "127.0.0.1" || config.host === "::1" || config.host === "localhost";
  if (config.trustProxy === "loopback" && !loopbackBound) {
    problems.push(
      `HOST=${config.host} exposes the port beyond loopback while TRUST_PROXY=loopback still believes X-Forwarded-For, so a direct client could spoof its IP. Bind to 127.0.0.1 and let cloudflared be the only ingress, or set TRUST_PROXY to match your real proxy.`,
    );
  }
  if (!config.forceSecureCookies) {
    problems.push("FORCE_SECURE_COOKIES is off in production; session cookies could be sent over plain HTTP.");
  }
  if (!config.smtp.url) {
    problems.push(
      "SMTP_URL is not set, so password reset emails cannot be delivered. Reset links will only be written to the server log.",
    );
  }
  return problems;
}

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Mic, MicOff, Phone, PhoneOff, TriangleAlert, Video, VideoOff } from "lucide-react";
import { useCall } from "../lib/call.tsx";
import { useToast } from "../lib/toast.tsx";
import { Avatar } from "./Avatar.tsx";

function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The whole call surface: an incoming banner, and a full-screen panel once a
 * call is live. Mounted app-wide so a call can arrive on any page.
 *
 * A video call reuses the same panel with the pictures layered underneath the
 * avatar treatment, so the two kinds share every control and state.
 */
export function CallOverlay() {
  const call = useCall();
  const toast = useToast();

  // Failures and end reasons are one-off notices, not screens.
  useEffect(() => {
    if (call.error) {
      toast(call.error, "error");
      call.dismissError();
    }
  }, [call.error, call, toast]);

  const ringing = call.phase === "incoming";
  const live = call.phase === "outgoing" || call.phase === "connecting" || call.phase === "active";

  return createPortal(
    <>
      <AnimatePresence>{ringing && <IncomingCall key="incoming" />}</AnimatePresence>
      <AnimatePresence>{live && <ActiveCall key="active" />}</AnimatePresence>
    </>,
    document.body,
  );
}

function IncomingCall() {
  const { peer, accept, decline, kind } = useCall();
  const video = kind === "video";

  return (
    <motion.div
      // Rendered at full opacity immediately rather than faded in: a call is
      // time-critical, and its visibility must not depend on an animation
      // frame ever running (throttled tabs, reduced-motion, low power).
      initial={false}
      animate={{ opacity: 1, y: 0, pointerEvents: "auto" }}
      // Stop intercepting clicks the instant it starts leaving: a fading
      // full-screen layer that still captures pointer events blocks the page.
      exit={{ opacity: 0, y: -16, pointerEvents: "none" }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      role="dialog"
      aria-label={`Incoming call from ${peer?.username ?? "someone"}`}
      className="fixed inset-x-0 top-0 z-[220] p-3 sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem] sm:p-0"
    >
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-2xl shadow-black/30">
        <span className="relative shrink-0">
          <Avatar user={peer ?? { username: "?", displayName: "?", avatar: null }} size={48} link={false} />
          <motion.span
            className="absolute inset-0 rounded-full ring-2 ring-online"
            animate={{ opacity: [0.9, 0.15, 0.9], scale: [1, 1.18, 1] }}
            transition={{ duration: 1.6, repeat: Infinity }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{peer?.username ?? "Unknown"}</p>
          <p className="text-xs text-muted">Incoming {video ? "video" : "audio"} call…</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={decline}
            aria-label="Decline call"
            className="press flex h-10 w-10 items-center justify-center rounded-full bg-danger text-white"
          >
            <PhoneOff size={17} />
          </button>
          <button
            onClick={() => void accept()}
            aria-label={video ? "Accept video call" : "Accept call"}
            className="press flex h-10 w-10 items-center justify-center rounded-full bg-online text-white"
          >
            {video ? <Video size={17} /> : <Phone size={17} />}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function ActiveCall() {
  const {
    peer, phase, kind, muted, cameraOff, remoteVideo, elapsedMs, reconnecting,
    toggleMute, toggleCamera, attachVideo, hangUp,
  } = useCall();
  const video = kind === "video";
  // Hand the elements to the call layer as they mount, and take them back on
  // unmount so it never writes to a detached node.
  const remoteRef = (el: HTMLVideoElement | null) => attachVideo("remote", el);
  const localRef = (el: HTMLVideoElement | null) => attachVideo("local", el);

  const status =
    phase === "outgoing"
      ? "Calling…"
      : phase === "connecting"
        ? "Connecting…"
        : reconnecting
          ? "Reconnecting…"
          : duration(elapsedMs);

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, pointerEvents: "auto" }}
      exit={{ opacity: 0, pointerEvents: "none" }}
      role="dialog"
      aria-label={video ? "Video call" : "Audio call"}
      className="fixed inset-0 z-[210] flex flex-col items-center justify-between bg-[#0b0b10] px-6 py-14 text-white"
    >
      {/* The peer's picture fills the screen once frames are actually arriving;
          until then the avatar treatment below stands in for it. */}
      {video && (
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            remoteVideo ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {/* A quiet wash of colour so the screen is not a flat black rectangle. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 30% 20%, rgba(124,92,255,0.35), transparent 60%)," +
            "radial-gradient(55% 45% at 75% 30%, rgba(255,122,89,0.22), transparent 62%)",
        }}
      />

      <div
        className={`relative flex flex-1 flex-col items-center justify-center gap-5 transition-opacity duration-500 ${
          video && remoteVideo ? "opacity-0" : "opacity-100"
        }`}
      >
        <span className="relative">
          <Avatar
            user={peer ?? { username: "?", displayName: "?", avatar: null }}
            size={120}
            link={false}
            // The wrapper needs the radius too, or the ring draws as a square.
            className="rounded-full ring-4 ring-white/10"
          />
          {(phase === "outgoing" || phase === "connecting" || reconnecting) && (
            <motion.span
              className="absolute inset-0 rounded-full ring-2 ring-white/40"
              animate={{ opacity: [0.6, 0, 0.6], scale: [1, 1.25, 1] }}
              transition={{ duration: 1.8, repeat: Infinity }}
            />
          )}
        </span>

        <div className="text-center">
          <h2 className="text-2xl font-semibold tracking-tight">{peer?.displayName || peer?.username}</h2>
          <p className="mt-1 text-sm text-white/60">@{peer?.username}</p>
          <p className="mt-4 font-mono text-lg tabular-nums text-white/80">{status}</p>
          {reconnecting && (
            <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-warm">
              <TriangleAlert size={13} /> the connection is unstable
            </p>
          )}
        </div>
      </div>

      {/* Your own camera, mirrored the way every video app shows it. */}
      {video && (
        <div
          className={`absolute right-4 top-4 z-10 w-28 overflow-hidden rounded-2xl border border-white/15 bg-black/60 shadow-xl sm:w-40 ${
            cameraOff ? "hidden" : ""
          }`}
        >
          <video ref={localRef} autoPlay playsInline muted className="aspect-[3/4] w-full -scale-x-100 object-cover" />
        </div>
      )}

      {/* Keeps the name and controls readable over a bright frame. */}
      {video && remoteVideo && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/70 to-transparent" />
      )}

      {video && remoteVideo && (
        <div className="relative order-first w-full text-center">
          <p className="text-sm font-medium text-white/90 drop-shadow">{peer?.displayName || peer?.username}</p>
          <p className="font-mono text-sm tabular-nums text-white/70 drop-shadow">{status}</p>
        </div>
      )}

      <div className="relative flex items-center gap-5">
        {video && (
          <button
            onClick={toggleCamera}
            aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
            aria-pressed={cameraOff}
            className={`press flex h-14 w-14 items-center justify-center rounded-full transition ${
              cameraOff ? "bg-white text-black" : "bg-white/15 text-white hover:bg-white/25"
            }`}
          >
            {cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
          </button>
        )}
        <button
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
          className={`press flex h-14 w-14 items-center justify-center rounded-full transition ${
            muted ? "bg-white text-black" : "bg-white/15 text-white hover:bg-white/25"
          }`}
        >
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button
          onClick={hangUp}
          aria-label="End call"
          className="press flex h-16 w-16 items-center justify-center rounded-full bg-danger text-white shadow-lg shadow-black/40"
        >
          <PhoneOff size={24} />
        </button>
      </div>
    </motion.div>
  );
}

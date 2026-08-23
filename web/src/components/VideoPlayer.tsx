import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, TriangleAlert, Volume2, VolumeX } from "lucide-react";
import type { Media } from "../lib/types.ts";

/** Sound is off across the whole app until the viewer turns it on, then it stays on. */
let soundOn = false;
const soundListeners = new Set<(on: boolean) => void>();

function setSound(on: boolean) {
  soundOn = on;
  for (const listener of soundListeners) listener(on);
}

function useSoundPreference() {
  const [on, setOn] = useState(soundOn);
  useEffect(() => {
    soundListeners.add(setOn);
    return () => {
      soundListeners.delete(setOn);
    };
  }, []);
  return [on, setSound] as const;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

type Props = {
  media: Media;
  /** Reels drive playback themselves; feed posts play when scrolled into view. */
  active?: boolean;
  autoPlayInView?: boolean;
  loop?: boolean;
  className?: string;
  objectFit?: "cover" | "contain";
  /** Reels supply their own controls in the overlay. */
  showControls?: boolean;
  /** Buffer this one ahead of time — the reel about to come into view. */
  bufferAhead?: boolean;
  onTogglePlay?: (playing: boolean) => void;
};

/**
 * Plays a post's video.
 *
 * Autoplay is only permitted while muted, so playback starts silent and the
 * viewer opts into sound — that choice is then remembered app-wide, which is
 * what makes scrolling a video feed feel continuous rather than repeatedly
 * asking. Videos pause the moment they leave the viewport so a long feed is
 * never decoding several streams at once.
 */
export function VideoPlayer({
  media,
  active,
  autoPlayInView = true,
  loop = true,
  className = "",
  objectFit = "cover",
  showControls = true,
  bufferAhead = false,
  onTogglePlay,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [sound, setSoundPreference] = useSoundPreference();
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [inView, setInView] = useState(false);

  const shouldPlay = active !== undefined ? active : autoPlayInView && inView;

  // Only decode what is on screen.
  useEffect(() => {
    if (active !== undefined) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio > 0.6),
      { threshold: [0, 0.6, 1] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (shouldPlay) {
      node.play().then(
        () => setPlaying(true),
        () => {
          // Autoplay can still be refused; falling back to muted almost always works.
          node.muted = true;
          node.play().then(() => setPlaying(true), () => setPlaying(false));
        },
      );
    } else {
      node.pause();
      setPlaying(false);
    }
  }, [shouldPlay]);

  // Mute state is global, so a video mounting mid-scroll matches the rest.
  useEffect(() => {
    const node = ref.current;
    if (node) node.muted = !sound || !media.hasAudio;
  }, [sound, media.hasAudio]);

  const toggleSound = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setSoundPreference(!sound);
    },
    [sound, setSoundPreference],
  );

  const togglePlay = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    if (node.paused) {
      void node.play().then(() => setPlaying(true)).catch(() => {});
      onTogglePlay?.(true);
    } else {
      node.pause();
      setPlaying(false);
      onTogglePlay?.(false);
    }
  }, [onTogglePlay]);

  if (media.status === "processing") {
    return (
      <div className={`relative bg-raised ${className}`} style={{ aspectRatio: media.width / media.height }}>
        <img src={media.url} alt="" className="h-full w-full object-cover opacity-60" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 text-white">
          <Loader2 size={26} className="animate-spin" />
          <p className="text-sm font-medium">Processing video…</p>
          <p className="text-xs text-white/70">It will play here as soon as it is ready.</p>
        </div>
      </div>
    );
  }

  if (media.status === "failed" || failed) {
    return (
      <div className={`relative bg-raised ${className}`} style={{ aspectRatio: media.width / media.height }}>
        <img src={media.url} alt="" className="h-full w-full object-cover opacity-40" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 px-6 text-center text-white">
          <TriangleAlert size={22} />
          <p className="text-sm font-medium">This video could not be processed</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group relative bg-black ${className}`}
      style={active === undefined ? { aspectRatio: media.width / media.height } : undefined}
    >
      <video
        ref={ref}
        src={media.video ?? undefined}
        poster={media.url}
        loop={loop}
        muted={!sound || !media.hasAudio}
        playsInline
        preload={shouldPlay || bufferAhead ? "auto" : "metadata"}
        className={`h-full w-full ${objectFit === "cover" ? "object-cover" : "object-contain"}`}
        onClick={showControls ? togglePlay : undefined}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => {
          setWaiting(false);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onError={() => setFailed(true)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (el.duration) setProgress(el.currentTime / el.duration);
        }}
      />

      {waiting && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-white/80" />
        </div>
      )}

      {showControls && (
        <>
          {!playing && !waiting && (
            <button
              onClick={togglePlay}
              aria-label="Play video"
              className="absolute inset-0 flex items-center justify-center"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur">
                <Play size={24} className="ml-0.5 fill-white" />
              </span>
            </button>
          )}

          <div className="pointer-events-none absolute right-2.5 top-2.5 flex items-center gap-1.5">
            {media.durationMs > 0 && (
              <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                {formatDuration(media.durationMs)}
              </span>
            )}
          </div>

          {media.hasAudio && (
            <button
              onClick={toggleSound}
              aria-label={sound ? "Mute video" : "Unmute video"}
              className="press absolute bottom-2.5 right-2.5 rounded-full bg-black/55 p-2 text-white backdrop-blur transition hover:bg-black/75"
            >
              {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
          )}

          {playing && (
            <button
              onClick={togglePlay}
              aria-label="Pause video"
              className="press absolute bottom-2.5 left-2.5 rounded-full bg-black/40 p-2 text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
            >
              <Pause size={15} />
            </button>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
            <div className="h-full bg-white/80" style={{ width: `${progress * 100}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

export { useSoundPreference, formatDuration };

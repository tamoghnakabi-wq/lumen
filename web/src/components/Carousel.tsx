import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Media } from "../lib/types.ts";
import { Img } from "./Img.tsx";
import { VideoPlayer } from "./VideoPlayer.tsx";

/**
 * The shape the frame takes for a set of media: the tallest ratio present, so
 * no slide is cropped as you page through, clamped at both ends.
 *
 * Exported because a layout that wants to size a column to the media has to
 * agree with the carousel exactly — a disagreement of a few percent is what
 * leaves a band of dead space beside the picture.
 */
export function frameRatio(media: Media[], minRatio = 0.8): number {
  if (media.length === 0) return 1;
  const ratio = Math.min(...media.map((m) => (m.width && m.height ? m.width / m.height : 1)), 1.91);
  return Math.max(ratio, minRatio);
}

/**
 * Horizontal media pager. Scroll-snap does the work, so touch swiping is native
 * and smooth; arrows and dots are layered on for pointer devices.
 */
export function Carousel({
  media,
  onDoubleClick,
  eager = false,
  className = "",
  minRatio = 0.8,
  maxHeight = "66dvh",
}: {
  media: Media[];
  onDoubleClick?: () => void;
  eager?: boolean;
  className?: string;
  /**
   * Tallest shape the frame may take, as width ÷ height. A feed defaults to 4:5
   * — a 9:16 clip left at its own ratio is over 1000px tall in a 608px column,
   * so a single post fills more than the window and you cannot see who posted it
   * without scrolling. Photos crop to fit; video is letterboxed rather than cut.
   */
  minRatio?: number;
  /** Second guard: leaves room for the header, the like row and the story
   *  rail above the first post, so a whole card is visible on landing. */
  maxHeight?: string;
}) {
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const safeRatio = frameRatio(media, minRatio);

  function scrollTo(next: number) {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.max(0, Math.min(next, media.length - 1));
    track.scrollTo({ left: clamped * track.clientWidth, behavior: "smooth" });
    setIndex(clamped);
  }

  function onScroll() {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.round(track.scrollLeft / track.clientWidth);
    if (next !== index) setIndex(next);
  }

  if (media.length === 0) return null;

  return (
    <div className={`group relative bg-raised ${className}`} onDoubleClick={onDoubleClick}>
      <div
        ref={trackRef}
        onScroll={onScroll}
        // `w-full` is load-bearing. With an aspect-ratio and an auto width, a
        // max-height that bites makes the browser shrink the *width* to keep the
        // ratio — so a tall post ended up narrower than its card, with a band of
        // background down one side. Pinning the width makes the cap trim the
        // frame instead, and object-cover takes care of the rest.
        className="hide-scroll flex w-full snap-x snap-mandatory overflow-x-auto"
        style={{ aspectRatio: String(safeRatio), maxHeight }}
      >
        {media.map((m, i) => (
          <div key={m.id} className="w-full flex-none snap-center">
            {m.kind === "video" ? (
              // A video post is a single item, so it owns the whole frame and
              // keeps its own aspect rather than being letterboxed to the carousel's.
              <VideoPlayer media={m} className="h-full w-full" objectFit="contain" />
            ) : (
              <Img media={m} alt="" eager={eager && i === 0} cover ratio={safeRatio} className="h-full w-full" />
            )}
          </div>
        ))}
      </div>

      {media.length > 1 && (
        <>
          {index > 0 && (
            <button
              onClick={() => scrollTo(index - 1)}
              aria-label="Previous image"
              className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/45 p-1.5 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 hover:bg-black/65 md:block"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          {index < media.length - 1 && (
            <button
              onClick={() => scrollTo(index + 1)}
              aria-label="Next image"
              className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/45 p-1.5 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 hover:bg-black/65 md:block"
            >
              <ChevronRight size={18} />
            </button>
          )}
          <div className="absolute right-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
            {index + 1}/{media.length}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-2.5 flex justify-center gap-1.5">
            {media.map((m, i) => (
              <span
                key={m.id}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === index ? "w-4 bg-white" : "w-1.5 bg-white/50"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

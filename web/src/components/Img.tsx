import { useState } from "react";
import type { Media } from "../lib/types.ts";

type Props = {
  media: Media;
  variant?: "thumb" | "url" | "full";
  alt?: string;
  className?: string;
  /** Constrain the aspect box; defaults to the media's own ratio. */
  ratio?: number;
  cover?: boolean;
  eager?: boolean;
};

/**
 * Progressive image: the 16px inline preview is painted immediately as a
 * blurred backdrop, and the real file fades in on top once decoded. The box
 * reserves its aspect ratio, so nothing on the page shifts while loading.
 */
export function Img({
  media,
  variant = "url",
  alt = "",
  className = "",
  ratio,
  cover = false,
  eager = false,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const src = variant === "thumb" ? media.thumb : variant === "full" ? media.full : media.url;
  const aspect = ratio ?? (media.width && media.height ? media.width / media.height : 1);

  return (
    <div
      className={`relative overflow-hidden bg-raised ${className}`}
      style={{ aspectRatio: String(aspect) }}
    >
      {media.preview && (
        <img
          src={media.preview}
          alt=""
          aria-hidden
          className={`absolute inset-0 h-full w-full scale-110 object-cover blur-xl transition-opacity duration-500 ${
            loaded ? "opacity-0" : "opacity-100"
          }`}
          draggable={false}
        />
      )}
      <img
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        draggable={false}
        className={`relative h-full w-full transition-opacity duration-500 ${cover ? "object-cover" : "object-contain"} ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}

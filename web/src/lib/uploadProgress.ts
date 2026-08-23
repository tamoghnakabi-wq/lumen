import { ApiError } from "./api.ts";

/**
 * fetch() cannot report upload progress, and image posts are big enough that a
 * progress bar matters on a phone connection — so uploads go through XHR.
 */
export function uploadWithProgress<T>(
  path: string,
  body: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.withCredentials = true;

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });

    xhr.addEventListener("load", () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON response */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(parsed as T);
      } else {
        reject(
          new ApiError(
            xhr.status,
            parsed?.error ?? "Upload failed. Please try again.",
            parsed?.code ?? "upload_failed",
          ),
        );
      }
    });

    xhr.addEventListener("error", () => reject(new ApiError(0, "Upload failed — check your connection.", "offline")));
    xhr.addEventListener("abort", () => reject(new ApiError(0, "Upload cancelled.", "aborted")));

    xhr.send(body);
  });
}

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 90;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/heic", "image/heif"];
export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-m4v", "video/mpeg", "video/3gpp"];

export function isVideoFile(file: File): boolean {
  return ACCEPTED_VIDEO_TYPES.includes(file.type) || /\.(mp4|mov|webm|mkv|m4v|3gp)$/i.test(file.name);
}

/** Client-side guard so obvious mistakes never reach the network. */
export function validateImage(file: File): string | null {
  const typeOk = ACCEPTED_TYPES.includes(file.type) || /\.(jpe?g|png|webp|avif|gif|heic|heif)$/i.test(file.name);
  if (!typeOk) return `“${file.name}” is not an image we can use. Try JPEG, PNG, WebP or HEIC.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `“${file.name}” is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 12 MB.`;
  }
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}

export function validateVideo(file: File): string | null {
  if (!isVideoFile(file)) return `“${file.name}” is not a video we can use. Try MP4, MOV or WebM.`;
  if (file.size > MAX_VIDEO_BYTES) {
    return `“${file.name}” is ${(file.size / 1024 / 1024).toFixed(0)} MB — the limit is ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`;
  }
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}

/**
 * Reads a local video's duration before uploading, so a clip that is too long
 * is rejected instantly instead of after a long upload the server will refuse.
 */
export function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    const done = (seconds: number) => {
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : 0);
    video.onerror = () => done(0);
    // Never block the composer on a container the browser cannot parse.
    setTimeout(() => done(0), 5000);
    video.src = url;
  });
}

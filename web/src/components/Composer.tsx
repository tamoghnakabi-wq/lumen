import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, ImagePlus, MapPin, X } from "lucide-react";
import { prependPost } from "../lib/postCache.ts";
import { useToast } from "../lib/toast.tsx";
import {
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_SECONDS,
  isVideoFile,
  readVideoDuration,
  uploadWithProgress,
  validateImage,
  validateVideo,
} from "../lib/uploadProgress.ts";
import type { Post, Story } from "../lib/types.ts";
import { MentionTextarea } from "./MentionInput.tsx";
import { Modal } from "./Modal.tsx";
import { QuotedPost } from "./QuotedPost.tsx";
import { Spinner } from "./States.tsx";

const MAX_IMAGES = 6;

type Picked = { file: File; url: string; key: string; isVideo: boolean; durationSec?: number };

function usePickedImages(max: number, allowVideo = false) {
  const [images, setImages] = useState<Picked[]>([]);
  const toast = useToast();

  const add = useCallback(
    async (files: FileList | File[]) => {
      const incoming = Array.from(files);
      const accepted: Picked[] = [];
      for (const file of incoming) {
        if (isVideoFile(file)) {
          if (!allowVideo) {
            toast("Videos can only be posted on their own.", "error");
            continue;
          }
          const error = validateVideo(file);
          if (error) {
            toast(error, "error");
            continue;
          }
          // Duration is checked here so a long clip is refused before the upload.
          const durationSec = await readVideoDuration(file);
          if (durationSec > MAX_VIDEO_SECONDS + 0.5) {
            toast(`That video is ${Math.round(durationSec)}s — the limit is ${MAX_VIDEO_SECONDS}s.`, "error");
            continue;
          }
          accepted.push({
            file,
            url: URL.createObjectURL(file),
            key: `${file.name}-${file.size}-${Math.random()}`,
            isVideo: true,
            durationSec,
          });
          continue;
        }
        const error = validateImage(file);
        if (error) {
          toast(error, "error");
          continue;
        }
        accepted.push({
          file,
          url: URL.createObjectURL(file),
          key: `${file.name}-${file.size}-${Math.random()}`,
          isVideo: false,
        });
      }
      setImages((current) => {
        // One video per post, and never mixed with photos.
        const nextVideo = accepted.find((a) => a.isVideo);
        if (nextVideo) {
          if (current.length > 0) {
            toast("A post can hold photos or one video, not both.", "error");
            return current;
          }
          return [nextVideo];
        }
        if (current.some((c) => c.isVideo)) {
          toast("A post can hold photos or one video, not both.", "error");
          return current;
        }
        const room = max - current.length;
        if (accepted.length > room) toast(`You can attach up to ${max} images.`, "error");
        return [...current, ...accepted.slice(0, Math.max(0, room))];
      });
    },
    [allowVideo, max, toast],
  );

  const remove = useCallback((key: string) => {
    setImages((current) => {
      const hit = current.find((i) => i.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return current.filter((i) => i.key !== key);
    });
  }, []);

  const move = useCallback((key: string, direction: -1 | 1) => {
    setImages((current) => {
      const index = current.findIndex((i) => i.key === key);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.url);
      return [];
    });
  }, []);

  return { images, add, remove, move, clear };
}

function DropZone({
  onFiles,
  multiple,
  hint,
  accept = "image/*",
  label = "Drag photos here",
}: {
  onFiles: (files: FileList | File[]) => void;
  multiple: boolean;
  hint: string;
  accept?: string;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${
        over ? "border-accent bg-accent-soft" : "border-line hover:border-accent/60 hover:bg-raised"
      }`}
    >
      <ImagePlus size={34} className="text-muted" />
      <p className="mt-3 text-sm font-medium">{label}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
      <span className="btn btn-ghost mt-4">Choose from device</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function PostComposer({
  open,
  onClose,
  quoted = null,
}: {
  open: boolean;
  onClose: () => void;
  quoted?: Post | null;
}) {
  const { images, add, remove, move, clear } = usePickedImages(MAX_IMAGES, !quoted);
  const [caption, setCaption] = useState("");
  const [location, setLocation] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (!open) {
      clear();
      setCaption("");
      setLocation("");
      setProgress(null);
    }
  }, [open, clear]);

  async function submit() {
    // A quote borrows the original's images, so it is the one post that can be
    // published without any of its own.
    if (images.length === 0 && !quoted) return;
    if (quoted && images.length === 0 && !caption.trim()) return;
    setProgress(0);
    const body = new FormData();
    for (const image of images) body.append("images", image.file, image.file.name);
    body.append("caption", caption);
    body.append("location", location);
    if (quoted) body.append("quotedPostId", quoted.id);
    try {
      const data = await uploadWithProgress<{ post: Post }>("/posts", body, setProgress);
      prependPost(queryClient, data.post);
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      toast("Posted", "success");
      onClose();
      navigate(`/p/${data.post.id}`);
    } catch (err) {
      setProgress(null);
      toast(err instanceof Error ? err.message : "Could not create post.", "error");
    }
  }

  const busy = progress !== null;

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={quoted ? "Quote post" : "New post"} size="lg">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {quoted ? (
          <div className="space-y-3">
            <MentionTextarea
              value={caption}
              onChange={setCaption}
              rows={4}
              maxLength={2200}
              placeholder="Add your thoughts…"
              autoFocus
            />
            <QuotedPost post={quoted} />
            {images.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {images.map((image) => (
                  <div key={image.key} className="relative aspect-square overflow-hidden rounded-xl bg-raised">
                    <img src={image.url} alt="" className="h-full w-full object-cover" />
                    <button
                      onClick={() => remove(image.key)}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
                      aria-label="Remove image"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted transition hover:text-fg">
              <ImagePlus size={16} /> Add your own image
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void add(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        ) : images.length === 0 ? (
          <DropZone
            onFiles={add}
            multiple
            accept="image/*,video/*"
            label="Drag photos or a video here"
            hint={`Up to ${MAX_IMAGES} photos (${MAX_UPLOAD_BYTES / 1024 / 1024} MB each), or one video up to ${MAX_VIDEO_SECONDS}s`}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <div>
              <div className="grid grid-cols-3 gap-2">
                <AnimatePresence initial={false}>
                  {images.map((image, index) => (
                    <motion.div
                      key={image.key}
                      layout
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      className="group relative aspect-square overflow-hidden rounded-xl bg-raised"
                    >
                      {image.isVideo ? (
                        <>
                          <video src={image.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                          <span className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            {image.durationSec ? `${Math.round(image.durationSec)}s` : "video"}
                          </span>
                        </>
                      ) : (
                        <img src={image.url} alt="" className="h-full w-full object-cover" />
                      )}
                      <button
                        onClick={() => remove(image.key)}
                        className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label="Remove image"
                      >
                        <X size={13} />
                      </button>
                      <div
                        className={`absolute inset-x-1 bottom-1 justify-between opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 ${
                          image.isVideo ? "hidden" : "flex"
                        }`}
                      >
                        <button
                          onClick={() => move(image.key, -1)}
                          disabled={index === 0}
                          className="rounded-full bg-black/60 p-1 text-white disabled:opacity-30"
                          aria-label="Move earlier"
                        >
                          <ArrowLeft size={12} />
                        </button>
                        <span className="rounded-full bg-black/60 px-1.5 text-[10px] font-medium leading-5 text-white">
                          {index + 1}
                        </span>
                        <button
                          onClick={() => move(image.key, 1)}
                          disabled={index === images.length - 1}
                          className="rounded-full bg-black/60 p-1 text-white disabled:opacity-30"
                          aria-label="Move later"
                        >
                          <ArrowRight size={12} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {images.length < MAX_IMAGES && !images.some((i) => i.isVideo) && (
                  <label className="flex aspect-square cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-line text-muted transition hover:border-accent/60 hover:bg-raised">
                    <ImagePlus size={20} />
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files?.length) add(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <MentionTextarea
                value={caption}
                onChange={setCaption}
                rows={6}
                maxLength={2200}
                placeholder="Write a caption… use #hashtags and @mentions"
              />
              <div className="relative">
                <MapPin size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value.slice(0, 80))}
                  placeholder="Add a location"
                  className="field pl-9"
                />
              </div>
              <p className="text-right text-xs text-faint">{caption.length}/2200</p>
            </div>
          </div>
        )}

        {busy && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
              <motion.div
                className="h-full rounded-full bg-accent"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ ease: "easeOut", duration: 0.25 }}
              />
            </div>
            <p className="mt-1.5 text-center text-xs text-muted">
              {progress! < 100 ? `Uploading ${progress}%` : "Processing images…"}
            </p>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <p className="text-xs text-muted">
          {quoted
            ? "Your comment plus the post you are quoting"
            : images.length > 0
              ? `${images.length} of ${MAX_IMAGES} images`
              : "Photos only, for now"}
        </p>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || (quoted ? images.length === 0 && !caption.trim() : images.length === 0)}
          >
            {busy ? <Spinner size={15} /> : quoted ? "Post quote" : "Share post"}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

export function StoryComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { images, add, clear } = usePickedImages(1);
  const [caption, setCaption] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    if (!open) {
      clear();
      setCaption("");
      setProgress(null);
    }
  }, [open, clear]);

  async function submit() {
    if (images.length === 0) return;
    setProgress(0);
    const body = new FormData();
    body.append("image", images[0].file, images[0].file.name);
    body.append("caption", caption);
    try {
      await uploadWithProgress<{ story: Story }>("/stories", body, setProgress);
      void queryClient.invalidateQueries({ queryKey: ["stories"] });
      toast("Story added — it disappears in 24 hours", "success");
      onClose();
    } catch (err) {
      setProgress(null);
      toast(err instanceof Error ? err.message : "Could not add story.", "error");
    }
  }

  const busy = progress !== null;

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Add to your story" size="sm">
      <div className="space-y-3 overflow-y-auto p-5">
        {images.length === 0 ? (
          <DropZone onFiles={add} multiple={false} hint="One image · visible for 24 hours" />
        ) : (
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[16rem] overflow-hidden rounded-2xl bg-raised">
            <img src={images[0].url} alt="" className="h-full w-full object-cover" />
            <button
              onClick={clear}
              className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white"
              aria-label="Remove image"
            >
              <X size={14} />
            </button>
            {caption && (
              <p className="absolute inset-x-3 bottom-3 rounded-lg bg-black/55 px-2.5 py-1.5 text-center text-sm text-white backdrop-blur">
                {caption}
              </p>
            )}
          </div>
        )}
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value.slice(0, 200))}
          placeholder="Say something (optional)"
          className="field"
        />
        {busy && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
            <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${progress}%` }} />
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn btn-ghost flex-1 justify-center" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary flex-1 justify-center" onClick={submit} disabled={images.length === 0 || busy}>
            {busy ? <Spinner size={15} /> : "Add to story"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

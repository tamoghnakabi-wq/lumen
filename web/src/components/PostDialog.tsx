import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { X } from "lucide-react";

/**
 * Full-screen layer holding an opened post.
 *
 * Dismissal is deliberately over-provided — backdrop, close button, Escape —
 * because this is the one screen people reach by tapping a picture and then have
 * to get out of again.
 */
export function PostDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog opened on top of this one (share, report, delete) gets it first.
      if (document.querySelectorAll('[role="dialog"]').length > 1) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      document.body.style.paddingRight = "";
    };
  }, [onClose]);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-[140] overflow-y-auto overscroll-contain bg-black/70 backdrop-blur-[2px]"
      // Anything that reaches this element is a click in the empty space around
      // the post, because the card below stops its own. Using mousedown rather
      // than click means a text selection that ends out here does not dismiss.
      onMouseDown={onClose}
    >
      <button
        onClick={onClose}
        aria-label="Close post"
        className="press fixed right-3 top-3 z-10 rounded-full bg-black/50 p-2 text-white backdrop-blur transition hover:bg-black/70 sm:right-5 sm:top-5"
      >
        <X size={20} />
      </button>

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Post"
        initial={{ opacity: 0, scale: 0.985, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="flex min-h-full items-start justify-center sm:items-center sm:px-6 sm:py-8"
      >
        {/* Bounded to the post's own width so the space either side of it is
            genuinely backdrop; a full-width wrapper would swallow those clicks
            and leave a band where clicking outside did nothing. */}
        <div className="w-full max-w-[70rem]" onMouseDown={(e) => e.stopPropagation()}>
          {children}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

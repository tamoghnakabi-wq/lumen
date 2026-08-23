import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import type { Post } from "../lib/types.ts";
import { useIsDesktop } from "../hooks/useMediaQuery.ts";
import { CommentComposer, CommentList } from "./Comments.tsx";
import { Modal } from "./Modal.tsx";

function Thread({ post }: { post: Post }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <CommentList postId={post.id} postAuthorId={post.author.id} />
      </div>
      <div className="border-t border-line px-4">
        <CommentComposer postId={post.id} />
      </div>
    </>
  );
}

/**
 * Comments for a reel.
 *
 * On a wide screen the thread is a column beside the video, not a sheet on top
 * of it — reading comments while the clip keeps playing is the whole point, and
 * a centred dialog covered the face of it. The Reels page reserves the width, so
 * the reel shifts across rather than being hidden. A phone has no room for two
 * columns, so there it stays a bottom sheet.
 */
export function CommentsDialog({
  open,
  onClose,
  post,
}: {
  open: boolean;
  onClose: () => void;
  post: Post;
}) {
  const isDesktop = useIsDesktop();

  if (!isDesktop) {
    return (
      <Modal open={open} onClose={onClose} title={`Comments · ${post.counts.comments}`} size="md">
        <div className="flex max-h-[70dvh] min-h-[16rem] flex-col">
          <Thread post={post} />
        </div>
      </Modal>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          role="dialog"
          aria-label={`Comments on ${post.author.username}'s reel`}
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 420, damping: 38 }}
          className="fixed inset-y-0 right-0 z-[120] flex w-[var(--reel-comments-w)] flex-col border-l border-line bg-surface shadow-2xl shadow-black/25"
        >
          <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-base font-semibold tracking-tight">
              Comments · {post.counts.comments}
            </h2>
            <button
              onClick={onClose}
              className="press rounded-full p-1.5 text-muted hover:bg-raised hover:text-fg"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </header>
          <Thread post={post} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

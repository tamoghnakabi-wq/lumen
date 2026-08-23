import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  /** Full-bleed modals (media viewers) skip the card chrome. */
  bare?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  /** On mobile, slide up from the bottom like a sheet instead of scaling in. */
  sheetOnMobile?: boolean;
};

const WIDTHS = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl", xl: "max-w-5xl" };

export function Modal({ open, onClose, children, title, bare = false, size = "md", sheetOnMobile = true }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Lock scroll without the layout jump that removing the scrollbar causes.
    const previous = document.body.style.overflow;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      document.body.style.paddingRight = "";
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[150] flex items-end justify-center sm:items-center sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={sheetOnMobile ? { opacity: 0, y: 24, scale: 0.99 } : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={sheetOnMobile ? { opacity: 0, y: 16, scale: 0.99 } : { opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            className={`relative flex max-h-[92dvh] w-full flex-col ${WIDTHS[size]} ${
              bare
                ? ""
                : "rounded-t-2xl border border-line bg-surface shadow-2xl shadow-black/25 sm:rounded-2xl"
            }`}
          >
            {title && !bare && (
              <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
                <h2 className="text-base font-semibold tracking-tight">{title}</h2>
                <button onClick={onClose} className="press rounded-full p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label="Close">
                  <X size={18} />
                </button>
              </header>
            )}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Confirmation dialog used for destructive actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  danger = true,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <div className="p-6 text-center">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{message}</p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"} w-full justify-center`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
          <button className="btn btn-ghost w-full justify-center" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

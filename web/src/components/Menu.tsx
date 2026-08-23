import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  hidden?: boolean;
};

/** Small dropdown used for post/comment/message overflow actions. */
export function Menu({
  trigger,
  items,
  align = "right",
  side = "bottom",
  label = "More options",
  triggerClassName = "press rounded-full p-1.5 text-muted transition hover:bg-raised hover:text-fg",
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  /** Open upwards when the trigger sits at the bottom of a clipped container. */
  side?: "top" | "bottom";
  label?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className={triggerClassName}
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: side === "top" ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: side === "top" ? 2 : -2 }}
            transition={{ duration: 0.14 }}
            className={`absolute z-50 min-w-[11rem] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-xl shadow-black/20 ${
              align === "right" ? "right-0" : "left-0"
            } ${side === "top" ? "bottom-full mb-1" : "top-full mt-1"}`}
          >
            {visible.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-raised ${
                  item.danger ? "text-danger" : "text-fg"
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

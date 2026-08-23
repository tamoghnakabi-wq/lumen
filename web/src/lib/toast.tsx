import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

type Kind = "success" | "error" | "info";
type Toast = { id: number; message: string; kind: Kind };

const ToastContext = createContext<{
  toast: (message: string, kind?: Kind) => void;
}>({ toast: () => {} });

const ICONS = { success: CheckCircle2, error: TriangleAlert, info: Info };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: Kind = "info") => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, message, kind }]);
      setTimeout(() => dismiss(id), kind === "error" ? 5200 : 3400);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[200] flex flex-col items-center gap-2 p-4 pb-[calc(4.75rem+env(safe-area-inset-bottom))] sm:items-start sm:pb-6 sm:pl-6 md:pb-6">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = ICONS[t.kind];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-lg shadow-black/10"
                role="status"
              >
                <Icon
                  size={17}
                  className={
                    t.kind === "error" ? "mt-0.5 text-danger" : t.kind === "success" ? "mt-0.5 text-online" : "mt-0.5 text-muted"
                  }
                />
                <p className="text-sm leading-snug">{t.message}</p>
                <button
                  onClick={() => dismiss(t.id)}
                  className="ml-1 rounded p-0.5 text-faint transition hover:text-fg"
                  aria-label="Dismiss"
                >
                  <X size={14} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => useContext(ToastContext).toast;

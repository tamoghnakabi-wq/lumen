import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Mode = "light" | "dark" | "system";

const KEY = "lumen:theme";
const ThemeContext = createContext<{ mode: Mode; setMode: (m: Mode) => void; isDark: boolean }>({
  mode: "system",
  setMode: () => {},
  isDark: true,
});

function resolve(mode: Mode): boolean {
  if (mode === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches;
  return mode === "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem(KEY) as Mode) ?? "system");
  const [isDark, setIsDark] = useState(() => resolve((localStorage.getItem(KEY) as Mode) ?? "system"));

  const apply = useCallback((next: Mode) => {
    const dark = resolve(next);
    document.documentElement.classList.toggle("dark", dark);
    setIsDark(dark);
  }, []);

  const setMode = useCallback(
    (next: Mode) => {
      localStorage.setItem(KEY, next);
      setModeState(next);
      apply(next);
    },
    [apply],
  );

  useEffect(() => {
    apply(mode);
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, apply]);

  return <ThemeContext.Provider value={{ mode, setMode, isDark }}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => useContext(ThemeContext);

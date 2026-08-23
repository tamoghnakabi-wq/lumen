import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { PostComposer, StoryComposer } from "../components/Composer.tsx";
import type { Post } from "./types.ts";

type UIState = {
  openPostComposer: () => void;
  openStoryComposer: () => void;
  openQuoteComposer: (post: Post) => void;
};

const UIContext = createContext<UIState>({
  openPostComposer: () => {},
  openStoryComposer: () => {},
  openQuoteComposer: () => {},
});

/** Holds the global composers so any screen can open them. */
export function UIProvider({ children }: { children: ReactNode }) {
  const [postOpen, setPostOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  // A quote repost is the post composer with an attached original.
  const [quoted, setQuoted] = useState<Post | null>(null);

  const value = useMemo(
    () => ({
      openPostComposer: () => {
        setQuoted(null);
        setPostOpen(true);
      },
      openStoryComposer: () => setStoryOpen(true),
      openQuoteComposer: (post: Post) => {
        setQuoted(post);
        setPostOpen(true);
      },
    }),
    [],
  );

  return (
    <UIContext.Provider value={value}>
      {children}
      <PostComposer
        open={postOpen}
        quoted={quoted}
        onClose={() => {
          setPostOpen(false);
          setQuoted(null);
        }}
      />
      <StoryComposer open={storyOpen} onClose={() => setStoryOpen(false)} />
    </UIContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useComposer = () => useContext(UIContext);

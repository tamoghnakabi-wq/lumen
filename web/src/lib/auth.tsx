import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { get, post, setUnauthorizedHandler } from "./api.ts";
import { closeSocket, getSocket } from "./socket.ts";
import type { Profile } from "./types.ts";

export type TwoFactorChallenge = { challenge: string; recoveryAvailable: boolean };

type LoginResponse =
  | { twoFactorRequired: true; challenge: string; recoveryAvailable: boolean; user?: undefined }
  | { twoFactorRequired?: false; user: Profile; challenge?: undefined; recoveryAvailable?: undefined };

type AuthState = {
  user: Profile | null;
  loading: boolean;
  /** Resolves to a challenge when the account has a second factor, or null once signed in. */
  signIn: (identifier: string, password: string) => Promise<TwoFactorChallenge | null>;
  completeTwoFactor: (challenge: string, code: string) => Promise<void>;
  signUp: (input: { username: string; email: string; password: string; displayName?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: Profile) => void;
};

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const data = await get<{ user: Profile | null }>("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A session can end while the tab is open: it expires, another device signs
  // everything out, or the password changes. Any 401 drops the cached user, and
  // the router then sends the person to the sign-in screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      closeSocket();
      queryClient.clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  // The socket authenticates with the same session cookie, so it can only be
  // opened once we know a session exists.
  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    // The server closes sockets whose session has been revoked.
    const onExpired = () => {
      setUser(null);
      closeSocket();
      queryClient.clear();
    };
    // After a drop (server restart, tunnel bounce, phone waking up) the client
    // has missed every event in between, so refetch rather than trust the cache.
    const onReconnect = () => {
      void queryClient.invalidateQueries();
      void refresh();
    };
    // A video finishing its transcode changes what every feed should render.
    const onMediaReady = () => {
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
      void queryClient.invalidateQueries({ queryKey: ["reels"] });
      void queryClient.invalidateQueries({ queryKey: ["profile-posts"] });
      void queryClient.invalidateQueries({ queryKey: ["post"] });
    };
    socket.on("media:ready", onMediaReady);
    socket.on("media:failed", onMediaReady);
    socket.on("session:expired", onExpired);
    socket.io.on("reconnect", onReconnect);

    return () => {
      socket.off("media:ready", onMediaReady);
      socket.off("media:failed", onMediaReady);
      socket.off("session:expired", onExpired);
      socket.io.off("reconnect", onReconnect);
      closeSocket();
    };
  }, [user?.id, queryClient, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const data = await post<LoginResponse>("/auth/login", { identifier, password });
      // A second factor means no session yet: the caller collects a code and
      // finishes with completeTwoFactor. Nothing is stored until then.
      if (data.twoFactorRequired) {
        return { challenge: data.challenge, recoveryAvailable: data.recoveryAvailable };
      }
      queryClient.clear();
      setUser(data.user);
      return null;
    },
    [queryClient],
  );

  const completeTwoFactor = useCallback(
    async (challenge: string, code: string) => {
      const data = await post<{ user: Profile }>("/auth/2fa/verify", { challenge, code });
      queryClient.clear();
      setUser(data.user);
    },
    [queryClient],
  );

  const signUp = useCallback(
    async (input: { username: string; email: string; password: string; displayName?: string }) => {
      const data = await post<{ user: Profile }>("/auth/signup", input);
      queryClient.clear();
      setUser(data.user);
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await post("/auth/logout");
    } finally {
      closeSocket();
      setUser(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo(
    () => ({ user, loading, signIn, completeTwoFactor, signUp, signOut, refresh, setUser }),
    [user, loading, signIn, completeTwoFactor, signUp, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

/** Convenience for components that only render behind the auth gate. */
// eslint-disable-next-line react-refresh/only-export-components
export function useMe(): Profile {
  const { user } = useContext(AuthContext);
  if (!user) throw new Error("useMe called outside an authenticated route");
  return user;
}

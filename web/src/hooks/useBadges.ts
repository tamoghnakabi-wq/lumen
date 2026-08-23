import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "../lib/api.ts";
import { getSocket } from "../lib/socket.ts";
import { useAuth } from "../lib/auth.tsx";

/**
 * Unread counters for the nav. Seeded by a fetch, then kept live over the
 * socket — polling is only a slow safety net for a dropped connection.
 */
export function useBadges() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const notifications = useQuery({
    queryKey: ["unread", "notifications"],
    queryFn: () => get<{ unread: number }>("/notifications/unread-count"),
    enabled: !!user,
    refetchInterval: 120_000,
  });

  const messages = useQuery({
    queryKey: ["unread", "messages"],
    queryFn: () => get<{ unread: number }>("/conversations/unread-count"),
    enabled: !!user,
    refetchInterval: 120_000,
  });

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();

    const onNotification = (payload: { unread: number }) => {
      queryClient.setQueryData(["unread", "notifications"], { unread: payload.unread });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    };
    const onCount = (payload: { unread: number }) => {
      queryClient.setQueryData(["unread", "notifications"], { unread: payload.unread });
    };
    const onMessage = () => {
      void queryClient.invalidateQueries({ queryKey: ["unread", "messages"] });
    };

    socket.on("notification:new", onNotification);
    socket.on("notification:count", onCount);
    socket.on("message:new", onMessage);
    return () => {
      socket.off("notification:new", onNotification);
      socket.off("notification:count", onCount);
      socket.off("message:new", onMessage);
    };
  }, [user, queryClient]);

  return {
    notifications: notifications.data?.unread ?? 0,
    messages: messages.data?.unread ?? 0,
  };
}

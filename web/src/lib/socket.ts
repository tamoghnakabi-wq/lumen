import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * One shared connection for the whole app. Same-origin, so it follows the page
 * through localhost, LAN or tunnel hostnames with no configuration.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/socket.io",
      withCredentials: true,
      transports: ["websocket", "polling"],
      reconnectionDelay: 700,
      reconnectionDelayMax: 6000,
    });
  }
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}

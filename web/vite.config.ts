import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.LUMEN_API ?? "http://localhost:4310";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5190,
    strictPort: true,
    // A quick tunnel's hostname is random, so it can never be allow-listed ahead of time.
    allowedHosts: true,
    // changeOrigin must stay false: it would rewrite the Host header to the API's
    // own address, and the server's same-origin CSRF check compares Origin
    // against Host. Keeping the browser's Host makes dev look single-origin to
    // the server, exactly as production does.
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/media": { target: API, changeOrigin: false },
      "/socket.io": { target: API, ws: true, changeOrigin: false },
    },
  },
  preview: { port: 5190, allowedHosts: true },
  build: { chunkSizeWarningLimit: 900 },
});

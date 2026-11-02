import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const API = process.env.VITE_API_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev, so the httpOnly session cookie works without CORS tricks.
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/socket.io": { target: API, ws: true, changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
  },
});

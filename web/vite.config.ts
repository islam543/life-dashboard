import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Run from the repo root as `vite web` / `vite build web`; this folder is the Vite root.
// The dev server binds 127.0.0.1 only and proxies /api to the local API server.
const API_ORIGIN = "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: API_ORIGIN, changeOrigin: false },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

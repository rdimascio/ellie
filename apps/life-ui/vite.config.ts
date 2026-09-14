import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port: 4180, strictPort: true },
  preview: { host: "127.0.0.1", port: 4180, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, manifest: true },
});

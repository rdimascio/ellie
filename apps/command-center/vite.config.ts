import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port: 4173, strictPort: true, hmr: false },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: {
      input: {
        demo: resolve(import.meta.dirname, "index.html"),
        pairing: resolve(import.meta.dirname, "pair/index.html"),
      },
    },
  },
});

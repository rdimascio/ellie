import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scannerLicense = readFileSync(require.resolve("jsqr/LICENSE"), "utf8");

export default defineConfig({
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port: 4173, strictPort: true, hmr: false },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: {
      output: {
        postBanner: (chunk) =>
          chunk.moduleIds.some((id) => id.includes("/jsqr/"))
            ? `/*! jsQR 1.4.0 — https://github.com/cozmo/jsQR\n${scannerLicense}\n*/`
            : "",
      },
      input: {
        demo: resolve(import.meta.dirname, "index.html"),
        pairing: resolve(import.meta.dirname, "pair/index.html"),
      },
    },
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: `${root}src/renderer`,
  base: "./",
  build: {
    outDir: `${root}dist/renderer`,
    emptyOutDir: true,
    // The renderer is a local, file:// document. Keep it a small static bundle:
    // no inline module-preload shim, no inlined assets, no source maps.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    target: "chrome130",
    rollupOptions: {
      input: `${root}src/renderer/index.html`,
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  esbuild: {
    jsx: "automatic",
    legalComments: "none",
  },
  server: {
    host: "127.0.0.1",
  },
});

import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    ssr: path.resolve(__dirname, "src/bin.ts"),
    outDir: path.resolve(__dirname, "dist/bin"),
    target: "node20",
    rollupOptions: {
      output: {
        entryFileNames: "symphony.js",
        banner: "#!/usr/bin/env node\n",
        format: "esm",
      },
    },
    emptyOutDir: true,
  },
  // `bin.test.ts` rebuilds `dist/bin/symphony.js` (vite `emptyOutDir`) while
  // sibling test files execute that same binary. Run CLI test files sequentially
  // so the rebuild cannot delete the artifact mid-execution.
  test: {
    fileParallelism: false,
  },
  plugins: [
    {
      name: "make-executable",
      closeBundle() {
        const binPath = path.resolve(__dirname, "dist/bin/symphony.js");
        try {
          fs.chmodSync(binPath, 0o755);
        } catch {
          // ignore
        }
      },
    },
  ],
});

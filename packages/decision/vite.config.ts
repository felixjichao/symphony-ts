import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    ssr: path.resolve(__dirname, "src/cleanup-polluted-tasks.ts"),
    outDir: path.resolve(__dirname, "../../scripts"),
    target: "node20",
    rollupOptions: {
      output: {
        entryFileNames: "cleanup-polluted-tasks.mjs",
        banner: "#!/usr/bin/env node\n",
        format: "esm",
      },
    },
    emptyOutDir: false,
  },
});

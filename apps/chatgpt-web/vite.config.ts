import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRIVER_VERSION = "0.1.6";

const USERSCRIPT_BANNER = `// ==UserScript==
// @name         Symphony Decision Driver (ChatGPT Web)
// @namespace    https://github.com/felixjichao/symphony-ts
// @version      ${DRIVER_VERSION}
// @description  Tampermonkey driver for Symphony Decision execution via ChatGPT Web
// @author       Symphony Contributors
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==
`;

export default defineConfig({
  define: { __SYMPHONY_DRIVER_VERSION__: JSON.stringify(DRIVER_VERSION) },
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/userscript-entry.ts"),
      name: "SymphonyDecisionDriver",
      formats: ["iife"],
      fileName: () => "symphony-decision-driver.user.js",
    },
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  test: {
    environment: "node",
  },
  plugins: [{
    name: "userscript-header",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || !output.isEntry) continue;
        // Generate from the output chunk, not a post-build file that another hook
        // can prepend again. Keep repeated invocation idempotent as well.
        const code = output.code.replace(/^(?:\/\/ ==UserScript==\r?\n[\s\S]*?\/\/ ==\/UserScript==\s*)+/, "");
        output.code = `${USERSCRIPT_BANNER}\n${code}`;
      }
    },
  }],
});

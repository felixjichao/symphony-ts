import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERSCRIPT_BANNER = `// ==UserScript==
// @name         Symphony Decision Driver (ChatGPT Web)
// @namespace    https://github.com/felixjichao/symphony-ts
// @version      0.1.0
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
  plugins: [
    {
      name: "prepend-userscript-header",
      closeBundle() {
        const outPath = path.resolve(__dirname, "dist/symphony-decision-driver.user.js");
        if (fs.existsSync(outPath)) {
          const content = fs.readFileSync(outPath, "utf-8");
          fs.writeFileSync(outPath, `${USERSCRIPT_BANNER}\n${content}`, "utf-8");
        }
      },
    },
  ],
});

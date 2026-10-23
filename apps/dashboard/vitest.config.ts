import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] }, resolve: { alias: {
  "@symphony/operations": new URL("../../packages/operations/src/index.ts", import.meta.url).pathname,
  "@symphony/observability": new URL("../../packages/observability/src/index.ts", import.meta.url).pathname,
  "@symphony/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname,
} } });

/**
 * 结构边界测试（M5.2 / #51 验收 08、SPEC §7.3 / §10.4）。
 *
 * orchestrator 只能消费稳定 AgentEvent 契约：不得接触 Codex `ChildProcess`、
 * 不得解析 raw Codex JSON、不得按 Codex wire method literal 分支、不得 import
 * agent 私有 transport / protocol 实现。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(SRC_DIR, name));
}

describe("orchestrator 边界 — 验收 08", () => {
  it("不 import child_process / agent 私有 transport", () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source, path.basename(file)).not.toMatch(/from\s+["']node:child_process["']/);
      expect(source, path.basename(file)).not.toMatch(/@symphony\/agent\/src/);
      expect(source, path.basename(file)).not.toMatch(/from\s+["'][^"']*\/transport["']/);
      expect(source, path.basename(file)).not.toMatch(/from\s+["'][^"']*\/process-launcher["']/);
    }
  });

  it("不含 Codex wire method literal 依赖", () => {
    const wireLiterals = [
      "thread/start",
      "turn/start",
      "turn/completed",
      "thread/tokenUsage/updated",
      "account/rateLimits/updated",
      '"initialize"',
      '"initialized"',
    ];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const literal of wireLiterals) {
        expect(source.includes(literal), `${path.basename(file)} contains ${literal}`).toBe(false);
      }
    }
  });
});

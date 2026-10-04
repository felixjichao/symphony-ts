// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 骨架阶段允许 `_` 前缀的占位参数（M1+ 实现后自然消除）。
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // 仓库脚本（doc gate 等）：Node 环境的 ESM 脚本，只声明用到的全局。
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // dogfood 目标仓库模板：会被复制到隔离测试仓库的 Node ESM 脚本。
    files: ["examples/github-delivery-dogfood/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // 包内测试 fixture subprocess（不进 tsc，由 eslint 守住基本卫生）：Node ESM。
    files: ["packages/*/test-fixtures/**/*.mjs", "apps/*/test-fixtures/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
      },
    },
  },
);
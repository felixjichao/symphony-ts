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
    // 包内测试 fixture subprocess（不进 tsc，由 eslint 守住基本卫生）：Node ESM。
    files: ["packages/*/test-fixtures/**/*.mjs"],
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
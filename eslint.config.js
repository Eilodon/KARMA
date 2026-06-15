// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import n from "eslint-plugin-n";

export default tseslint.config(
  eslint.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked,

  security.configs.recommended,

  {
    plugins: { n },
    rules: {
      "n/no-unsupported-features/node-builtins": ["error", { version: ">=20.3.0" }],
    },
  },

  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async safety — critical for plugin runner, task store, redis client
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "@typescript-eslint/await-thenable": "error",

      // Type hygiene
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],

      // Interface implementations routinely have async signatures without await
      "@typescript-eslint/require-await": "off",

      // Security hardening
      "no-eval": "error",
      "no-implied-eval": "error",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-possible-timing-attacks": "error",

      // Legitimate patterns for this project type — turn off false positives
      "n/no-process-exit": "off",                           // server runtime cần process.exit
      "security/detect-object-injection": "off",            // dynamic plugin system, không phải injection
      "security/detect-non-literal-require": "off",         // plugin loader dynamic imports

      // Console discipline — telemetry đã có OTel + file logger
      "no-console": ["warn", { allow: ["error", "warn"] }],
    },
  },

  // stdout/stderr logger là console adapter hợp lệ
  {
    files: ["src/telemetry/stdout_logger.ts", "src/telemetry/stderr_logger.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // CLI entry scripts print to console by design
  {
    files: ["src/scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // File operations dùng biến làm path là hợp lệ — paths đến từ config nội bộ, không phải user input
  {
    files: [
      "src/telemetry/file_logger.ts",
      "src/storage/local_fs.ts",
      "src/core/plugin_loader.ts",
      "src/scripts/**/*.ts",
    ],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },

  // Files dùng `any` vì lý do kiến trúc hợp lệ:
  // - SDK internals chưa được type đầy đủ (MCP alpha)
  // - Worker IPC protocol (opaque message boundary)
  // - JSON schema validation (schema type là any by design)
  // - Express request internals
  {
    files: [
      "src/core/plugin_worker.ts",
      "src/mcp/adapter/schema_guard.ts",
      "src/mcp/adapter/execution_pipeline.ts",
      "src/mcp/adapter/mcp_protocol_adapter.ts",
      "src/core/plugin_loader.ts",
      "src/core/runtime.ts",
      "src/storage/encryption.ts",
      "src/index.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },

  // Relax một số rule trong test files
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/require-await": "off",
      "security/detect-non-literal-fs-filename": "off",
      "no-console": "off",
    },
  },

  {
    ignores: ["dist/**", "node_modules/**"],
  },
);

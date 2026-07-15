const js             = require("@eslint/js");
const globals        = require("globals");
const prettierConfig = require("eslint-config-prettier");
const boundaries     = require("eslint-plugin-boundaries");

/**
 * Architectural boundary rules (Phase 1 foundation).
 * Activates meaningfully once Phase 2 populates src/core/**.
 * Rule: core must never import modules (or express/server routes).
 */
module.exports = [
  js.configs.recommended,

  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        { type: "core", pattern: "src/core/**" },
        { type: "modules", pattern: "src/modules/**" },
        { type: "shared", pattern: "src/shared/**" },
        { type: "infra", pattern: "src/infrastructure/**" },
        { type: "config", pattern: "src/config/**" },
        { type: "app", pattern: "src/{application,server,domain,services,middleware}/**" },
      ],
      "boundaries/include": ["src/**/*.js"],
    },
    rules: {
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors:      "none",
      }],

      "no-debugger":          "error",
      "no-eval":              "error",
      "no-process-exit":      "warn",
      "no-empty":             ["warn", { allowEmptyCatch: true }],

      "no-console":           "off",
      "preserve-caught-error": "off",

      "boundaries/element-types": ["error", {
        default: "allow",
        rules: [
          {
            from: "core",
            disallow: ["modules", "app"],
            message: "core/ must not import modules/ or application/server/routes layers",
          },
          // shared may import core/infra/config/modules (middleware needs entitlement etc.)
          // but should not import legacy application/server route layers directly.
          {
            from: "shared",
            disallow: ["app"],
            message: "shared/ must not import application/server/domain legacy layers — use modules/ or core/",
          },
        ],
      }],

      ...prettierConfig.rules,
    },
  },

  {
    ignores: ["node_modules/**", "quantara.db*", "scripts/**", "test/**", "data/**"],
  },
];

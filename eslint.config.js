const js             = require("@eslint/js");
const globals        = require("globals");
const prettierConfig = require("eslint-config-prettier");

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
    rules: {
      // Variables — warn saja agar tidak blocker
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors:      "none",   // catch (e) {} tidak wajib pakai e
      }],

      // Best practices
      "no-debugger":          "error",
      "no-eval":              "error",
      "no-process-exit":      "warn",
      "no-empty":             ["warn", { allowEmptyCatch: true }],  // allow: } catch { /* ok */ }

      // Matikan rule yang terlalu strict untuk codebase ini
      "no-console":           "off",  // bot pakai console.log untuk trade log
      "preserve-caught-error": "off", // pola: throw new Error(e.message) sudah cukup

      // Prettier formatting — matikan rule yang bentrok
      ...prettierConfig.rules,
    },
  },

  {
    ignores: ["node_modules/**", "quantara.db*", "scripts/**"],
  },
];

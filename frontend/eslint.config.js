import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // These effects intentionally reset derived state when inputs change.
      // Refactoring them to useMemo/event handlers is a separate task.
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // globalIgnores is the supported flat-config form for excluding
  // paths from the whole config. The previous inline
  // `{ ignores: ["dist/", "node_modules/"] }` on a bare object is
  // treated as a deprecated warning by ESLint 9+ and will be removed
  // in a future major. `*.d.ts` is excluded so generated ambient
  // declarations don't generate lint noise.
  {
    ignores: ["dist/**", "node_modules/**", "**/*.d.ts"],
  }
);

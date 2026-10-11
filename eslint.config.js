// Minimal flat config so `npm run lint` runs on the TypeScript sources.
// It parses every file and enables a few rules that cannot misfire on
// TypeScript; widening the rule set is tracked in NOTES.md.
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
    },
  },
];

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "venv/**",
      "dist/**"     // the output of obfuscate.bat, generated code
    ]
  },
  js.configs.recommended,
  {
    files: ["src/timelens/webclient/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser
    },
    rules: {
      "eqeqeq": "error",
      "prefer-const": "error",
      "no-var": "error"
    }
  }
];

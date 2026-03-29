module.exports = {
  root: true,

  env: {
    node: true,
    es2022: true,
  },

  parser: "@typescript-eslint/parser",

  parserOptions: {
    project: ["./tsconfig.json", "./scripts/tsconfig.json"],
    tsconfigRootDir: __dirname,
    sourceType: "module",
  },

  plugins: ["@typescript-eslint", "import"],

  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:import/recommended",
    "plugin:import/typescript",
  ],

  ignorePatterns: [
    "lib/**/*",
    "generated/**/*",
    "node_modules",
    ".eslintrc.js",
  ],

  rules: {
    /* ---------- Style ---------- */
    quotes: ["error", "double"],
    indent: ["error", 2],
    "max-len": ["warn", { code: 120 }],

    /* ---------- TypeScript ---------- */
    "@typescript-eslint/no-explicit-any": "off", // allow flexibility
    "@typescript-eslint/no-non-null-assertion": "off",

    /* ---------- Imports ---------- */
    "import/no-unresolved": "off",

    /* ---------- General ---------- */
    "no-unused-vars": "warn",
    "@typescript-eslint/no-unused-vars": ["warn"],
  },
};

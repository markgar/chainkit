import js from "@eslint/js";

// chainkit is plain Node ESM (.mjs) with no build step and no TypeScript, so this
// config is deliberately small.
//
// IT MUST STAY IN AGREEMENT WITH THE HOST'S. A repo that vendors chainkit lints it
// with ITS OWN eslint config, not this one -- so a rule that is on here and off
// there (or the reverse) means chainkit passes its own gate and fails the host's,
// which is a defect the vendoring test cannot see. If you change a rule here,
// change it in the vendoring host too, or accept that the two gates now disagree.
export default [
  {
    ignores: [
      "**/node_modules/**",
      // Fixture reference solutions and acceptance suites are model-facing
      // artifacts copied verbatim into a run, not repo source; run output is
      // generated.
      "fixtures/**",
      "results/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // Node's globals are listed inline rather than pulled from the `globals`
      // package -- one dependency fewer, for a list that changes about once a
      // decade.
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly",
        performance: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

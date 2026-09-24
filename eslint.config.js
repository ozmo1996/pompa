// Minimalna konfiguracja: wykrywa nieużywane i niezdefiniowane zmienne.
const browser = Object.fromEntries(
  "window document navigator location localStorage matchMedia isSecureContext crypto Notification devicePixelRatio requestAnimationFrame getComputedStyle OffscreenCanvas Image confirm console setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone globalThis TextEncoder URL Request caches clients self importScripts firebase fetch process"
    .split(" ")
    .map((g) => [g, "readonly"]),
);
export default [
  { ignores: ["node_modules/"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: browser },
    rules: { "no-unused-vars": ["error", { caughtErrors: "none" }], "no-undef": "error" },
  },
  {
    files: ["raspberry/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...browser, require: "readonly", module: "readonly", Buffer: "readonly" },
    },
  },
];

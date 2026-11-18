import { registerHooks } from "node:module";

const replacements = new Map([
  ["@ailoha/cli/runtime", new URL("./ailoha-sdk-double.mjs", import.meta.url).href],
  ["@github/copilot-sdk/extension", new URL("./copilot-sdk-double.mjs", import.meta.url).href],
  ["vscode", new URL("./vscode-double.cjs", import.meta.url).href],
]);
registerHooks({
  resolve(specifier, context, next) {
    const url = replacements.get(specifier);
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
});

/**
 * Load-test the extension against the installed pi runtime (jiti), the same
 * loader pi uses for filesystem extensions. Exercises the default export
 * with a stub ExtensionAPI and reports what got registered.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Resolve jiti from the linked pi package (extensions run inside pi's module
// root, so this mirrors the real resolution environment).
const require2 = createRequire(
  resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
);
const jitiPath = require2.resolve("jiti");
const { createJiti } = await import(
  jitiPath.startsWith("/") ? `file://${jitiPath}` : jitiPath,
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(resolve(root, "index.ts"), { default: true });

console.log("default export:", typeof mod);
if (typeof mod !== "function") process.exit(1);

const registered = { transformers: 0, tools: [], commands: [], handlers: [] };
const stub = {
  registerMarkdownTransformer: () => registered.transformers++,
  registerTool: (t) => registered.tools.push(t?.name),
  registerCommand: (n) => registered.commands.push(n),
  on: (e) => registered.handlers.push(e),
  appendEntry: () => {},
};
mod(stub);
console.log(
  "transformers:", registered.transformers,
  "| tools:", registered.tools.join(","),
  "| commands:", registered.commands.join(","),
  "| handlers:", registered.handlers.join(","),
);
if (registered.transformers !== 1 || registered.tools.length !== 7 || registered.commands[0] !== "fold") {
  console.error("registration shape unexpected");
  process.exit(1);
}
console.log("OK");

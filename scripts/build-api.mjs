import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "apps/api/dist/server.cjs");

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "apps/api/src/server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  // better-sqlite3 carries a native binary and is staged beside the bundled
  // server. Everything else is bundled so the helper has a small, auditable
  // runtime surface.
  external: ["better-sqlite3"],
  banner: {
    js: "const { pathToFileURL: __consistencyPathToFileURL } = require('node:url'); const __consistencyImportMetaUrl = __consistencyPathToFileURL(__filename).href;"
  },
  define: {
    "import.meta.url": "__consistencyImportMetaUrl"
  }
});

console.log(`Bundled API for Node 22: ${outfile}`);

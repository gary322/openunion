import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, "..");

const src = path.resolve(pkgRoot, "..", "..", "skills", "proofwork-universal-worker", "scripts", "proofwork_worker.mjs");
const dst = path.resolve(pkgRoot, "assets", "proofwork_worker.mjs");

const check = process.argv.includes("--check");

const srcBytes = await readFile(src);
let dstBytes = null;
try {
  dstBytes = await readFile(dst);
} catch {
  dstBytes = null;
}

const same = dstBytes && sha256Hex(srcBytes) === sha256Hex(dstBytes);
if (same) {
  process.stdout.write("ok\n");
  process.exit(0);
}

if (check) {
  process.stderr.write(`assets/proofwork_worker.mjs is stale or missing. Run: node scripts/sync_assets.mjs\n`);
  process.exit(1);
}

await mkdir(path.dirname(dst), { recursive: true });
await writeFile(dst, srcBytes);
process.stdout.write(`synced ${path.relative(pkgRoot, dst)}\n`);


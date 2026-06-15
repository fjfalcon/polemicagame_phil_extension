#!/usr/bin/env node
// Собирает dist/<target> из общего JS-бандла (.dist-js), статики и манифеста base+overlay.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const target = process.argv[2];
if (!["chrome", "firefox"].includes(target)) {
  console.error("Usage: node scripts/assemble.mjs <chrome|firefox>");
  process.exit(1);
}

const outDir = path.join(root, "dist", target);
const jsDir = path.join(root, ".dist-js");
const manifestDir = path.join(root, "src", "manifest");
const staticDir = path.join(root, "src", "static");

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
// Глубокий мердж: объекты сливаются, остальное (включая массивы) перезаписывается overlay-ем.
function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  // 1. Манифест
  const base = JSON.parse(await fs.readFile(path.join(manifestDir, "manifest.base.json"), "utf8"));
  const overlay = JSON.parse(
    await fs.readFile(path.join(manifestDir, `manifest.${target}.json`), "utf8"),
  );
  const manifest = deepMerge(base, overlay);
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // 2. JS-бандлы
  for (const f of await fs.readdir(jsDir)) {
    if (f.endsWith(".js")) await fs.copyFile(path.join(jsDir, f), path.join(outDir, f));
  }

  // 3. Статика (popup.html, css, иконки, _locales)
  if (await exists(staticDir)) await copyDir(staticDir, outDir);

  console.log(`✓ assembled dist/${target}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Link the locally installed pi runtime into this project's node_modules so
 * the extension typechecks and imports against the exact pi version that is
 * installed on this machine (the same runtime that loads the extension).
 *
 * Creates:
 *   node_modules/@earendil-works/pi-coding-agent -> <pi>/libexec/lib/node_modules/@earendil-works/pi-coding-agent
 *   node_modules/@earendil-works/pi-tui          -> <pi>/.../pi-coding-agent/node_modules/@earendil-works/pi-tui
 *
 * Re-run after every pi upgrade (also wired up as the npm `postinstall` and
 * `link:pi` scripts; pass --required to fail hard when pi is not found).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve the pi installation root from the `pi` launcher on PATH. */
function piRoot() {
  for (const finder of [
    () => process.env.PI_BIN,
    () => execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
  ]) {
    try {
      const bin = finder();
      if (!bin) continue;
      // /opt/homebrew/bin/pi -> ../Cellar/pi-coding-agent/<ver>/bin/pi
      const real = execFileSync("realpath", [bin], { encoding: "utf8" }).trim();
      return dirname(dirname(real)); // .../pi-coding-agent/<ver>
    } catch {
      // try next strategy
    }
  }
  return undefined;
}

const root = piRoot();
if (!root) {
  const message = "link-pi: could not locate the pi installation (is `pi` on PATH?)";
  if (process.argv.includes("--required")) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} — skipping (dev typecheck will not work until linked)`);
  process.exit(0);
}

const agentPkg = resolve(root, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const tuiPkg = resolve(agentPkg, "node_modules/@earendil-works/pi-tui");

const links = [
  ["@earendil-works/pi-coding-agent", agentPkg],
  ["@earendil-works/pi-tui", tuiPkg],
];

for (const [name, target] of links) {
  const linkPath = resolve(projectRoot, "node_modules", name);
  try {
    const existing = readlinkSync(linkPath);
    if (existing === target) {
      console.log(`link-pi: ${name} already -> ${target}`);
      continue;
    }
    rmSync(linkPath, { force: true, recursive: true });
  } catch {
    // no existing link (or a real directory — leave real dirs alone unless
    // they are dangling symlinks, handled by rmSync above)
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  console.log(`link-pi: linked ${name} -> ${target}`);
}

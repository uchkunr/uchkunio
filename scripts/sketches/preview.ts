// Renders sketches to PNG so they can be checked without a browser, for example by an agent
// that can read images. Animated sketches render their still frame.
//
//   pnpm sketches:preview            all sketches
//   pnpm sketches:preview outbox     only names starting with "outbox"
//
// PNGs land in <os tmpdir>/sketches-preview/<post>-<name>.png.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const root = new URL("../../public/sketches/", import.meta.url);
const out = join(tmpdir(), "sketches-preview");
mkdirSync(out, { recursive: true });

const only = process.argv[2];
for (const post of readdirSync(root)) {
  for (const file of readdirSync(new URL(`${post}/`, root))) {
    const name = `${post}/${file.replace(/\.svg$/, "")}`;
    if (only && !name.startsWith(only)) continue;
    const target = join(out, `${post}-${file.replace(/\.svg$/, ".png")}`);
    await sharp(readFileSync(new URL(`${post}/${file}`, root)), { density: 110 })
      .flatten({ background: "#ffffff" })
      .png()
      .toFile(target);
    console.log(target);
  }
}

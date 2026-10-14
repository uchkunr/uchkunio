// Generates every favicon from src/assets/logo.svg: an SVG favicon that follows the
// system theme, PNGs on a white tile for browsers and home screens, and favicon.ico.
//   pnpm favicons
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "public");
const logo = fs.readFileSync(path.join(root, "src/assets/logo.svg"), "utf8");
const [, w, h] = logo.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!.map(Number);
const d = logo.match(/ d="([^"]+)"/)![1];

/** The mark centred on a square tile, `scale` of the tile wide. */
function tile(size: number, scale: number, bg: string, fg: string, radius = 0): string {
  const width = size * scale;
  const k = width / w;
  const x = (size - width) / 2;
  const y = (size - h * k) / 2;
  const back = bg === "none" ? "" : `<rect width="${size}" height="${size}" rx="${radius}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${back}<path transform="translate(${x} ${y}) scale(${k})" fill="${fg}" fill-rule="evenodd" d="${d}"/></svg>`;
}

const png = (svg: string) => sharp(Buffer.from(svg)).png().toBuffer();

/** Packs PNG images into an ICO container (PNG entries are valid since Vista). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// SVG favicon: the mark alone, dark on light and light on dark.
const svgIcon = tile(64, 0.92, "none", "#111111").replace(
  "<path",
  `<style>@media (prefers-color-scheme: dark){path{fill:#ededed}}</style><path`,
);
fs.writeFileSync(path.join(out, "favicon.svg"), svgIcon + "\n");

const files: Record<string, string> = {
  "favicon-16x16.png": tile(16, 0.92, "#ffffff", "#111111", 3),
  "favicon-32x32.png": tile(32, 0.86, "#ffffff", "#111111", 6),
  "apple-touch-icon.png": tile(180, 0.72, "#ffffff", "#111111"),
  "android-chrome-192x192.png": tile(192, 0.68, "#ffffff", "#111111"),
  "android-chrome-512x512.png": tile(512, 0.68, "#ffffff", "#111111"),
};
for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), await png(svg));
}
fs.writeFileSync(
  path.join(out, "favicon.ico"),
  ico([
    { size: 16, data: await png(files["favicon-16x16.png"]) },
    { size: 32, data: await png(files["favicon-32x32.png"]) },
  ]),
);
console.log("favicons written to public/");

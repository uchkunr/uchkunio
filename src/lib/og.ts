import satori, { type SatoriOptions } from "satori";
import sharp from "sharp";
import fs from "node:fs";

// Open Graph cards, rendered at build time. Every card shares this size, font and palette
// (the site's dark theme), so a shared link looks like the site it leads to.
export const WIDTH = 1200;
export const HEIGHT = 630;
export const FAMILY = "Jost";
export const COLORS = { bg: "#0a0a0a", fg: "#ededed", fg2: "#9a9a9a", line: "#222222" } as const;

type Font = SatoriOptions["fonts"][number];
type Weight = 400 | 600;

// Satori needs TTF/OTF. Google Fonts serves TTF to clients without a modern
// user agent, which is what fetch() sends. Each weight is fetched once.
const fontCache = new Map<Weight, Promise<ArrayBuffer | undefined>>();

function googleFont(weight: Weight): Promise<ArrayBuffer | undefined> {
  let font = fontCache.get(weight);
  if (!font) {
    font = (async () => {
      try {
        const query = `family=${FAMILY}:wght@${weight}`;
        const css = await fetch(`https://fonts.googleapis.com/css2?${query}`).then((r) => r.text());
        const url = css.match(/src: url\((.+?)\)/)?.[1];
        return url ? await fetch(url).then((r) => r.arrayBuffer()) : undefined;
      } catch {
        return undefined;
      }
    })();
    fontCache.set(weight, font);
  }
  return font;
}

function systemFont(): ArrayBuffer {
  for (const path of [
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ]) {
    if (fs.existsSync(path)) {
      const buf = fs.readFileSync(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  }
  throw new Error("No font available for OG image generation");
}

async function fonts(): Promise<Font[]> {
  return Promise.all(
    ([400, 600] as const).map(async (weight) => ({
      name: FAMILY,
      data: (await googleFont(weight)) ?? systemFont(),
      weight,
      style: "normal" as const,
    })),
  );
}

/** Fetches an image as a data URI for Satori, or undefined if it can't be had. */
export async function dataUri(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const type = res.headers.get("content-type") ?? "image/png";
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Renders Satori markup to a PNG response. */
export async function renderCard(markup: Parameters<typeof satori>[0]): Promise<Response> {
  const svg = await satori(markup, { width: WIDTH, height: HEIGHT, fonts: await fonts() });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

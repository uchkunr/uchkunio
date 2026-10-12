export const prerender = true;
import type { APIContext } from "astro";
import satori, { type SatoriOptions } from "satori";
import { html } from "satori-html";
import sharp from "sharp";
import fs from "node:fs";
import { formatDate } from "@/lib/date";
import { getCollection } from "astro:content";
import { localeOf, readingTime, type Post } from "@/lib/posts";

// One image per post and language: /og/<slug>.png, /og/en/<slug>.png, /og/ru/<slug>.png.
export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}

// Satori needs TTF/OTF. Google Fonts serves TTF to clients without a modern
// user agent, which is what fetch() sends. Outfit has no Cyrillic, so Russian
// cards are set in Open Sans, like Russian pages. Each family is fetched once.
type Font = SatoriOptions["fonts"][number];
const fontCache = new Map<string, Promise<ArrayBuffer | undefined>>();

function googleFont(family: string): Promise<ArrayBuffer | undefined> {
  let font = fontCache.get(family);
  if (!font) {
    font = (async () => {
      try {
        const query = `family=${family.replaceAll(" ", "+")}:wght@600`;
        const css = await fetch(`https://fonts.googleapis.com/css2?${query}`).then((r) => r.text());
        const url = css.match(/src: url\((.+?)\)/)?.[1];
        return url ? await fetch(url).then((r) => r.arrayBuffer()) : undefined;
      } catch {
        return undefined;
      }
    })();
    fontCache.set(family, font);
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

async function getFont(family: string): Promise<Font> {
  return { name: family, data: (await googleFont(family)) ?? systemFont(), weight: 600, style: "normal" };
}

export async function GET({ props }: APIContext) {
  const { post } = props as { post: Post };
  const family = localeOf(post) === "ru" ? "Open Sans" : "Outfit";
  const meta = `${formatDate(post.data.date, "long")}  ·  ${readingTime(post.body ?? "")}`;

  const markup = html`
    <div
      style="display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;width:1200px;height:630px;padding:72px 80px;background:#0a0a0a;color:#ededed;font-family:'${family}'"
    >
      <div style="display:flex;justify-content:space-between;font-size:22px;color:#9a9a9a">
        <span>Uchkun Rakhimov</span>
        <span>uchkun.io</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:28px">
        <div style="font-size:60px;font-weight:600;line-height:1.1;letter-spacing:-0.025em;max-width:1000px">
          ${post.data.title}
        </div>
        <div style="font-size:22px;color:#9a9a9a">${meta}</div>
      </div>
    </div>
  `;

  const svg = await satori(markup, {
    width: 1200,
    height: 630,
    fonts: [await getFont(family)],
  });

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

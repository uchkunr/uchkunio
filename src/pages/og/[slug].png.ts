export const prerender = true;
import type { APIContext } from "astro";
import satori from "satori";
import { html } from "satori-html";
import sharp from "sharp";
import fs from "node:fs";
import { formatDate } from "@/lib/date";
import { getPosts, readingTime, type Post } from "@/lib/posts";

export async function getStaticPaths() {
  const posts = await getPosts();
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}

// Satori needs TTF/OTF. Google Fonts serves TTF to clients without a modern
// user agent, which is what fetch() sends. Cached across all OG images.
let cachedFont: ArrayBuffer | undefined;

async function getFont(): Promise<ArrayBuffer> {
  if (cachedFont) return cachedFont;

  try {
    const css = await fetch("https://fonts.googleapis.com/css2?family=Outfit:wght@600").then((r) => r.text());
    const url = css.match(/src: url\((.+?)\)/)?.[1];
    if (url) return (cachedFont = await fetch(url).then((r) => r.arrayBuffer()));
  } catch {}

  for (const path of [
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ]) {
    if (fs.existsSync(path)) {
      const buf = fs.readFileSync(path);
      return (cachedFont = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
  }

  throw new Error("No font available for OG image generation");
}

export async function GET({ props }: APIContext) {
  const { post } = props as { post: Post };
  const fontData = await getFont();
  const meta = `${formatDate(post.data.date, "long")}  ·  ${readingTime(post.body ?? "")}`;

  const markup = html`
    <div
      style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;padding:72px 80px;background:#0a0a0a;color:#ededed;font-family:Outfit"
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
    fonts: [{ name: "Outfit", data: fontData, weight: 600, style: "normal" }],
  });

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

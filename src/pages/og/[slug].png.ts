export const prerender = true;
import type { APIContext } from "astro";
import { getCollection } from "astro:content";
import satori from "satori";
import { html } from "satori-html";
import sharp from "sharp";
import fs from "node:fs";

export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}

// Cache font across all OG image builds
let cachedFont: ArrayBuffer | undefined;

async function getFont(): Promise<ArrayBuffer> {
  if (cachedFont) return cachedFont;

  // Try Google Fonts first
  try {
    const css = await fetch(
      "https://fonts.googleapis.com/css2?family=Outfit:wght@600&display=swap"
    ).then((r) => r.text());
    const match = css.match(/src: url\((.+?)\)/);
    if (match) {
      cachedFont = await fetch(match[1]).then((r) => r.arrayBuffer());
      return cachedFont;
    }
  } catch {}

  // Fallback: use system Arial (available on Windows, macOS, Linux)
  const systemFonts = [
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ];

  for (const fontPath of systemFonts) {
    try {
      if (fs.existsSync(fontPath)) {
        const buf = fs.readFileSync(fontPath);
        cachedFont = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return cachedFont;
      }
    } catch {}
  }

  throw new Error("No font available for OG image generation");
}

export async function GET({ props }: APIContext) {
  const { post } = props as { post: any };
  const fontData = await getFont();

  const markup = html`
    <div
      style="display:flex;flex-direction:column;justify-content:flex-end;width:1200px;height:630px;padding:60px;background:linear-gradient(135deg,#2b2824 0%,#1a1917 50%,#2b2824 100%);color:white;font-family:Outfit"
    >
      <div style="display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;align-items:center;gap:8px;font-size:18px;color:#a1a1aa">
          uchkun.io
        </div>
        <div style="font-size:48px;font-weight:600;line-height:1.2;max-width:900px">
          ${post.data.title}
        </div>
        <div style="font-size:20px;color:#a1a1aa;max-width:800px;line-height:1.5">
          ${post.data.excerpt}
        </div>
        <div style="display:flex;gap:12px;margin-top:8px">
          ${post.data.tags
            .map(
              (tag: string) =>
                `<div style="padding:4px 12px;border-radius:6px;background:rgba(255,255,255,0.1);font-size:14px;color:#d4d4d8">#${tag}</div>`
            )
            .join("")}
        </div>
      </div>
    </div>
  `;

  const svg = await satori(markup, {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: "Outfit",
        data: fontData,
        weight: 600,
        style: "normal" as const,
      },
    ],
  });

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

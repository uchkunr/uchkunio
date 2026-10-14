export const prerender = true;
import type { APIContext } from "astro";
import { html } from "satori-html";
import { formatDate } from "@/lib/date";
import { getCollection } from "astro:content";
import { readingTime, type Post } from "@/lib/posts";
import { COLORS, FAMILY, HEIGHT, WIDTH, renderCard } from "@/lib/og";

// One image per post and language: /og/<slug>.png, /og/en/<slug>.png, /og/ru/<slug>.png.
export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}

export async function GET({ props }: APIContext) {
  const { post } = props as { post: Post };
  const meta = `${formatDate(post.data.date, "long")}  ·  ${readingTime(post.body ?? "")}`;

  return renderCard(html`
    <div
      style="display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;padding:72px 80px;background:${COLORS.bg};color:${COLORS.fg};font-family:'${FAMILY}'"
    >
      <div style="display:flex;justify-content:space-between;font-size:22px;font-weight:600;color:${COLORS.fg2}">
        <span>Uchkun Rakhimov</span>
        <span>uchkun.io</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:28px">
        <div style="font-size:60px;font-weight:600;line-height:1.1;letter-spacing:-0.025em;max-width:1000px">
          ${post.data.title}
        </div>
        <div style="font-size:22px;font-weight:600;color:${COLORS.fg2}">${meta}</div>
      </div>
    </div>
  `);
}

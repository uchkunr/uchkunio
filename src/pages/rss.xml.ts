export const prerender = true;
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { SITE } from "@/config/site";
import { getPosts, postUrl } from "@/lib/posts";

export async function GET(context: APIContext) {
  const posts = await getPosts();

  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site ?? SITE.url,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: new Date(post.data.date),
      description: post.data.excerpt,
      link: `${postUrl(post)}/`,
    })),
  });
}

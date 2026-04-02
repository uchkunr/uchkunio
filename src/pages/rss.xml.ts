export const prerender = true;
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "@/config/site";

export async function GET(context: APIContext) {
  const posts = await getCollection("blog");
  const sortedPosts = posts.sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );

  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site ?? SITE.url,
    items: sortedPosts.map((post) => ({
      title: post.data.title,
      pubDate: new Date(post.data.date),
      description: post.data.excerpt,
      link: `/blog/${post.id}/`,
    })),
  });
}

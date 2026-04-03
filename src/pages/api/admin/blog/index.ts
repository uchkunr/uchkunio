import type { APIRoute } from "astro";
import { saveFile } from "@/lib/github";
import { stringifyBlogFile, titleToSlug } from "@/lib/frontmatter";

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { title, date, excerpt, tags, content } = body;

    if (!title) return new Response(JSON.stringify({ error: "title required" }), { status: 400 });

    const slug = titleToSlug(title);
    const path = `src/content/blog/${slug}.md`;
    const fileContent = stringifyBlogFile({ title, date, excerpt, tags: tags ?? [] }, content ?? "");

    await saveFile(path, fileContent, undefined, `feat(blog): add "${title}"`);
    return new Response(JSON.stringify({ slug }), { status: 201 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

import type { APIRoute } from "astro";
import { getFile, saveFile, deleteFile } from "@/lib/github";
import { stringifyBlogFile } from "@/lib/frontmatter";

const getPath = (slug: string) => `src/content/blog/${slug}.md`;

function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9-]/g, "");
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const slug = sanitizeSlug(params.slug ?? "");
    if (!slug) return new Response(JSON.stringify({ error: "Invalid slug" }), { status: 400 });
    const path = getPath(slug);
    const body = await request.json();
    const { title, date, excerpt, tags, content } = body;

    const existing = await getFile(path).catch(() => null);
    const fileContent = stringifyBlogFile(
      { title, date, excerpt, tags: tags ?? [] },
      content ?? ""
    );

    await saveFile(path, fileContent, existing?.sha, `feat(blog): update "${title}"`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const slug = sanitizeSlug(params.slug ?? "");
    if (!slug) return new Response(JSON.stringify({ error: "Invalid slug" }), { status: 400 });
    const path = getPath(slug);
    const file = await getFile(path);
    await deleteFile(path, file.sha, `chore(blog): delete "${slug}"`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

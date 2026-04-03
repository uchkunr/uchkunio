import type { APIRoute } from "astro";
import { getFile, saveFile } from "@/lib/github";

const PATH = "src/content/experience.json";

export const GET: APIRoute = async () => {
  try {
    const file = await getFile(PATH);
    return new Response(JSON.stringify({ content: file.content, sha: file.sha }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const PUT: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { content, sha } = body;
    await saveFile(PATH, JSON.stringify(JSON.parse(content), null, 2), sha, "chore: update experience");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

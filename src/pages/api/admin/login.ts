import type { APIRoute } from "astro";
import { createAuthCookie } from "@/lib/auth";
import { isBlocked, recordFailure, clearRecord } from "@/lib/ratelimit";

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) {
    let dummy = 0;
    for (let i = 0; i < bb.length; i++) dummy |= bb[i] ^ (bb[i] + 1);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function getIP(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export const POST: APIRoute = async ({ request }) => {
  const ip = getIP(request);

  // Check if IP is blocked
  if (await isBlocked(ip)) {
    await new Promise((r) => setTimeout(r, 500));
    return new Response(null, {
      status: 303,
      headers: { Location: "/admin/login?error=blocked" },
    });
  }

  const form = await request.formData().catch(() => null);
  const password = form?.get("password")?.toString() ?? "";
  const expected = import.meta.env.ADMIN_PASSWORD ?? "";

  const ok = expected.length > 0 && timingSafeEqual(password, expected);

  if (!ok) {
    await new Promise((r) => setTimeout(r, 500));
    const { blocked, attemptsLeft } = await recordFailure(ip);

    const query = blocked ? "?error=blocked" : `?error=1&left=${attemptsLeft}`;
    return new Response(null, {
      status: 303,
      headers: { Location: `/admin/login${query}` },
    });
  }

  // Success — clear any previous failure records
  await clearRecord(ip);

  const cookie = await createAuthCookie();
  return new Response(null, {
    status: 303,
    headers: { "Set-Cookie": cookie, Location: "/admin" },
  });
};

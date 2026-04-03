import { defineMiddleware } from "astro:middleware";
import { verifyAuth } from "@/lib/auth";

const PUBLIC = new Set(["/admin/login", "/api/admin/login"]);

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  const isProtected =
    pathname.startsWith("/admin") || pathname.startsWith("/api/admin");

  if (!isProtected) return next();
  if (PUBLIC.has(pathname)) return next();

  const cookieHeader = context.request.headers.get("cookie") ?? "";
  const ok = await verifyAuth(cookieHeader);

  if (!ok) {
    // API routes → 401, page routes → redirect
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return context.redirect("/admin/login");
  }

  return next();
});

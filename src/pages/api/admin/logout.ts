import type { APIRoute } from "astro";
import { clearAuthCookie } from "@/lib/auth";

export const POST: APIRoute = () => {
  return new Response(null, {
    status: 303,
    headers: { "Set-Cookie": clearAuthCookie(), Location: "/admin/login" },
  });
};

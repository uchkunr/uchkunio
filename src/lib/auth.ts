export const COOKIE_NAME = "admin_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

async function deriveToken(): Promise<Uint8Array> {
  const secret = import.meta.env.ADMIN_SECRET;
  if (!secret) throw new Error("ADMIN_SECRET is not set");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("admin_session_v1"));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function createAuthCookie(): Promise<string> {
  const token = await deriveToken();
  const encoded = btoa(String.fromCharCode(...token));
  const secure = import.meta.env.PROD ? "; Secure" : "";
  return `${COOKIE_NAME}=${encoded}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}

export async function verifyAuth(cookieHeader: string): Promise<boolean> {
  try {
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [k, ...v] = c.trim().split("=");
        return [k.trim(), v.join("=")];
      })
    );
    const raw = cookies[COOKIE_NAME];
    if (!raw) return false;

    const provided = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const expected = await deriveToken();
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

export function clearAuthCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

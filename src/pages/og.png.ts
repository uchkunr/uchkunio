export const prerender = true;
import { html } from "satori-html";
import { SITE } from "@/config/site";
import { COLORS, FAMILY, HEIGHT, WIDTH, logoDataUri, renderCard } from "@/lib/og";

// The card for every page that isn't a post: the home page, the blog index, tags.
// Same frame as the post cards, with the person in place of a post title.
const STACK = ["TypeScript", "Node.js", "PostgreSQL", "Distributed systems"];

export async function GET() {
  const logo = await logoDataUri(56, COLORS.fg);
  const lead = `<img src="${logo.src}" width="${logo.width}" height="${logo.height}" />`;

  // A plain string, not html``: that escapes interpolations, and the logo is markup.
  // Every value here is the site's own.
  return renderCard(html(`
    <div
      style="display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;padding:72px 80px;background:${COLORS.bg};color:${COLORS.fg};font-family:'${FAMILY}'"
    >
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:22px;font-weight:600;color:${COLORS.fg2}">
        ${lead}
        <span>uchkun.io</span>
      </div>
      <div style="display:flex;flex-direction:column">
        <div style="font-size:84px;font-weight:600;line-height:1;letter-spacing:-0.03em">${SITE.name}</div>
        <div style="margin-top:20px;font-size:36px;font-weight:400;color:${COLORS.fg2}">
          Backend engineer. Writing on systems, databases and Node.js.
        </div>
        <div style="display:flex;margin-top:44px;padding-top:28px;border-top:1px solid ${COLORS.line};font-size:22px;font-weight:600;color:${COLORS.fg2}">
          ${STACK.join("  ·  ")}
        </div>
      </div>
    </div>
  `));
}

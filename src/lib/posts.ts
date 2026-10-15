import { getCollection, type CollectionEntry } from "astro:content";
import { getRelativeLocaleUrl } from "astro:i18n";

export type Post = CollectionEntry<"blog">;

/**
 * Posts are written in Uzbek; translations sit next to them in en/ and ru/ under the same
 * filename, so their ids are "en/<slug>" and "ru/<slug>". Lists, tags and RSS show the
 * Uzbek originals only; a post page links to its translations.
 */
// Same order and codes as i18n.locales in astro.config.mjs.
export const LOCALES = ["uz", "en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "uz";

export const LOCALE_NAMES: Record<Locale, string> = { uz: "O'zbekcha", en: "English", ru: "Русский" };
export const OG_LOCALES: Record<Locale, string> = { uz: "uz_UZ", en: "en_US", ru: "ru_RU" };

export function localeOf(post: Post): Locale {
  const prefix = post.id.split("/")[0];
  return prefix === "en" || prefix === "ru" ? prefix : DEFAULT_LOCALE;
}

export function slugOf(post: Post): string {
  return localeOf(post) === DEFAULT_LOCALE ? post.id : post.id.slice(post.id.indexOf("/") + 1);
}

/** /blog/<slug> for Uzbek, /en/blog/<slug> and /ru/blog/<slug> for translations. */
export function postUrl(post: Post): string {
  return getRelativeLocaleUrl(localeOf(post), `blog/${slugOf(post)}`);
}

/** Posts in one language, newest first. Dates are ISO strings, so they sort lexically. */
export async function getPosts(locale: Locale = DEFAULT_LOCALE): Promise<Post[]> {
  const posts = await getCollection("blog", (post) => localeOf(post) === locale);
  return posts.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

/** getStaticPaths for a post page in one language, with its newer and older neighbours. */
export async function postPaths(locale: Locale) {
  const posts = await getPosts(locale);
  return posts.map((post, i) => ({
    params: { slug: slugOf(post) },
    props: { post, newer: posts[i - 1] ?? null, older: posts[i + 1] ?? null },
  }));
}

/** Every language a post exists in, in LOCALES order. */
export async function getTranslations(post: Post): Promise<Post[]> {
  const slug = slugOf(post);
  const posts = await getCollection("blog", (other) => slugOf(other) === slug);
  return posts.sort((a, b) => LOCALES.indexOf(localeOf(a)) - LOCALES.indexOf(localeOf(b)));
}

export function readingTime(body: string): string {
  const words = body.trim().split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 230));
  return `${minutes} min read`;
}

/** Posts grouped by year, newest year first, order within a year preserved. */
export function groupByYear(posts: Post[]): [string, Post[]][] {
  const groups = new Map<string, Post[]>();
  for (const post of posts) {
    const year = post.data.date.slice(0, 4);
    groups.set(year, [...(groups.get(year) ?? []), post]);
  }
  return [...groups];
}

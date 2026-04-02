export const prerender = false;

import { makeHandler } from "@keystatic/astro/api";
// @ts-ignore
import keystaticonfig from "../../../../keystatic.config";

export const all = makeHandler({
  config: keystaticonfig,
  clientId: process.env.KEYSTATIC_GITHUB_CLIENT_ID,
  clientSecret: process.env.KEYSTATIC_GITHUB_CLIENT_SECRET,
  secret: process.env.KEYSTATIC_SECRET,
});

export const ALL = all;

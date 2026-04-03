export interface BlogFrontmatter {
  title: string;
  date: string;
  excerpt: string;
  tags: string[];
}

export function parseBlogFile(raw: string): { frontmatter: BlogFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: { title: "", date: "", excerpt: "", tags: [] }, body: raw };

  const fm: BlogFrontmatter = { title: "", date: "", excerpt: "", tags: [] };
  const lines = match[1].split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const scalar = line.match(/^(\w+):\s+"?([^"]*)"?\s*$/);
    if (scalar) {
      const [, key, val] = scalar;
      if (key === "title") fm.title = val;
      else if (key === "date") fm.date = val;
      else if (key === "excerpt") fm.excerpt = val;
      i++;
      continue;
    }
    const arrayKey = line.match(/^(\w+):\s*$/);
    if (arrayKey) {
      const key = arrayKey[1];
      i++;
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s+-\s+/)) {
        items.push(lines[i].replace(/^\s+-\s+/, "").trim());
        i++;
      }
      if (key === "tags") fm.tags = items;
      continue;
    }
    i++;
  }

  return { frontmatter: fm, body: match[2] };
}

export function stringifyBlogFile(fm: BlogFrontmatter, body: string): string {
  const tags = fm.tags.map((t) => `  - ${t}`).join("\n");
  return `---\ntitle: "${fm.title}"\ndate: "${fm.date}"\nexcerpt: "${fm.excerpt}"\ntags:\n${tags}\n---\n${body}`;
}

export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

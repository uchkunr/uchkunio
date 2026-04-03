import { useState } from "react";

interface Props {
  slug?: string;
  initial?: {
    title: string;
    date: string;
    excerpt: string;
    tags: string[];
    body: string;
  };
}

export default function BlogEditor({ slug, initial }: Props) {
  const isNew = !slug;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(initial?.date ?? new Date().toISOString().slice(0, 10));
  const [excerpt, setExcerpt] = useState(initial?.excerpt ?? "");
  const [tags, setTags] = useState(initial?.tags?.join(", ") ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  async function save() {
    setStatus("saving");
    setError("");

    const payload = {
      title,
      date,
      excerpt,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      content: body,
    };

    try {
      const res = isNew
        ? await fetch("/api/admin/blog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/admin/blog/${slug}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed");
      }

      if (isNew) {
        const { slug: newSlug } = await res.json();
        window.location.href = `/admin/blog/${newSlug}`;
        return;
      }

      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  async function remove() {
    if (!slug || !confirm(`Delete "${title}"?`)) return;
    setStatus("saving");
    try {
      const res = await fetch(`/api/admin/blog/${slug}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      window.location.href = "/admin/blog";
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  const inputClass =
    "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring transition-shadow";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <label className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Title</label>
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Post title" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Date</label>
          <input className={inputClass} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Tags</label>
          <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="api, backend, node" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <label className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Excerpt</label>
          <textarea
            className={`${inputClass} resize-none`}
            rows={2}
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            placeholder="Short description"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Content (Markdown)</label>
        <textarea
          className={`${inputClass} font-mono text-sm resize-none`}
          rows={24}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="# Heading&#10;&#10;Write your post..."
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-3">
        {!isNew && (
          <button
            onClick={remove}
            disabled={status === "saving"}
            className="rounded-lg border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            Delete
          </button>
        )}
        <div className="flex items-center gap-3 ml-auto">
          {status === "saved" && <span className="text-sm text-muted-foreground">Saved ✓</span>}
          <button
            onClick={save}
            disabled={status === "saving" || !title}
            className="rounded-lg bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {status === "saving" ? "Saving…" : isNew ? "Publish" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useCallback } from "react";
import { marked } from "marked";

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

marked.setOptions({ breaks: true });

type Tab = "write" | "preview";

const TOOLBAR = [
  { label: "H2", insert: (s: string) => `## ${s || "Heading"}` },
  { label: "H3", insert: (s: string) => `### ${s || "Heading"}` },
  { label: "B", insert: (s: string) => `**${s || "bold"}**`, style: "font-bold" },
  { label: "I", insert: (s: string) => `*${s || "italic"}*`, style: "italic" },
  { label: "`", insert: (s: string) => `\`${s || "code"}\``, style: "font-mono" },
  { label: "```", insert: (s: string) => `\`\`\`\n${s || "code"}\n\`\`\`` },
  { label: "Link", insert: (s: string) => `[${s || "text"}](url)` },
  { label: "---", insert: () => `\n---\n` },
  { label: "• List", insert: (s: string) => `- ${s || "item"}` },
];

function insertAtCursor(
  textarea: HTMLTextAreaElement,
  fn: (selected: string) => string,
  setter: (v: string) => void
) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);
  const replacement = fn(selected);
  const next = value.slice(0, start) + replacement + value.slice(end);
  setter(next);
  setTimeout(() => {
    const pos = start + replacement.length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
  }, 0);
}

export default function BlogEditor({ slug, initial }: Props) {
  const isNew = !slug;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(initial?.date ?? new Date().toISOString().slice(0, 10));
  const [excerpt, setExcerpt] = useState(initial?.excerpt ?? "");
  const [tags, setTags] = useState(initial?.tags?.join(", ") ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tab, setTab] = useState<Tab>("write");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  const previewHtml = useCallback(() => marked.parse(body) as string, [body]);

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
      setTimeout(() => setStatus("idle"), 2500);
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
    "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring transition-shadow placeholder:text-muted-foreground/60";

  return (
    <div className="space-y-5">
      {/* Metadata */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Title</label>
          <input
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Post title"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Date</label>
            <input
              className={inputClass}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Tags</label>
            <input
              className={inputClass}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="api, backend"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Excerpt</label>
          <textarea
            className={`${inputClass} resize-none`}
            rows={2}
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            placeholder="Short description shown in post list"
          />
        </div>
      </div>

      {/* Content editor */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* Tab bar + toolbar */}
        <div className="flex items-center justify-between border-b border-border px-2 py-1.5 gap-2 flex-wrap">
          {/* Tabs */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTab("write")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === "write"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              Write
            </button>
            <button
              onClick={() => setTab("preview")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === "preview"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              Preview
            </button>
          </div>

          {/* Toolbar (only in write mode) */}
          {tab === "write" && (
            <div className="flex items-center gap-0.5 flex-wrap">
              {TOOLBAR.map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  title={btn.label}
                  onClick={() => {
                    const ta = document.getElementById("body-editor") as HTMLTextAreaElement;
                    if (ta) insertAtCursor(ta, btn.insert, setBody);
                  }}
                  className={`px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${btn.style ?? ""}`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Write tab */}
        {tab === "write" && (
          <textarea
            id="body-editor"
            className="w-full bg-background px-4 py-3 text-sm font-mono outline-none resize-none leading-relaxed placeholder:text-muted-foreground/50"
            style={{ minHeight: "60vh" }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"# Heading\n\nWrite your post in Markdown..."}
            spellCheck={false}
          />
        )}

        {/* Preview tab */}
        {tab === "preview" && (
          <div
            className="prose max-w-none px-4 py-4"
            style={{ minHeight: "60vh" }}
            dangerouslySetInnerHTML={{ __html: previewHtml() }}
          />
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-3 py-1">
        {!isNew ? (
          <button
            onClick={remove}
            disabled={status === "saving"}
            className="rounded-lg border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            Delete post
          </button>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-3">
          {status === "saved" && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Saved
            </span>
          )}
          <button
            onClick={save}
            disabled={status === "saving" || !title}
            className="rounded-lg bg-primary text-primary-foreground px-5 py-2 text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {status === "saving" ? "Saving…" : isNew ? "Publish" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";

export default function ExperienceEditor() {
  const [content, setContent] = useState("");
  const [sha, setSha] = useState("");
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/experience")
      .then((r) => r.json())
      .then((data) => {
        setContent(JSON.stringify(JSON.parse(data.content), null, 2));
        setSha(data.sha);
        setStatus("idle");
      })
      .catch((e) => {
        setError(e.message);
        setStatus("error");
      });
  }, []);

  async function save() {
    setStatus("saving");
    setError("");
    try {
      JSON.parse(content); // validate
      const res = await fetch("/api/admin/experience", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, sha }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed");
      }
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  if (status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <textarea
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ring transition-shadow resize-none"
        rows={32}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        {status === "saved" && <span className="text-sm text-muted-foreground">Saved ✓</span>}
        <button
          onClick={save}
          disabled={status === "saving"}
          className="rounded-lg bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

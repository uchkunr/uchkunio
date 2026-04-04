import { useState, useEffect } from "react";

interface Role {
  title: string;
  project: string;
  period: string;
  highlights: string[];
}

interface Job {
  company: string;
  website: string;
  location: string;
  roles: Role[];
}

interface Data {
  jobs: Job[];
}

const inputClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring transition-shadow placeholder:text-muted-foreground/60";

function newRole(): Role {
  return { title: "", project: "", period: "", highlights: [""] };
}

function newJob(): Job {
  return { company: "", website: "", location: "", roles: [newRole()] };
}

function RoleEditor({
  role,
  onChange,
  onDelete,
  canDelete,
}: {
  role: Role;
  onChange: (r: Role) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  function setField<K extends keyof Role>(k: K, v: Role[K]) {
    onChange({ ...role, [k]: v });
  }

  function setHighlight(i: number, v: string) {
    const h = [...role.highlights];
    h[i] = v;
    onChange({ ...role, highlights: h });
  }

  function addHighlight() {
    onChange({ ...role, highlights: [...role.highlights, ""] });
  }

  function removeHighlight(i: number) {
    onChange({ ...role, highlights: role.highlights.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Role</p>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-destructive hover:underline"
          >
            Remove role
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Title</label>
          <input
            className={inputClass}
            value={role.title}
            onChange={(e) => setField("title", e.target.value)}
            placeholder="Backend Developer"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Project <span className="text-muted-foreground/50">(optional)</span></label>
          <input
            className={inputClass}
            value={role.project}
            onChange={(e) => setField("project", e.target.value)}
            placeholder="PillPlan"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs text-muted-foreground">Period</label>
          <input
            className={inputClass}
            value={role.period}
            onChange={(e) => setField("period", e.target.value)}
            placeholder="Jan 2024 – Mar 2025"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Highlights</label>
        {role.highlights.map((h, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-2.5 text-muted-foreground/50 text-xs select-none">•</span>
            <textarea
              className={`${inputClass} resize-none flex-1`}
              rows={2}
              value={h}
              onChange={(e) => setHighlight(i, e.target.value)}
              placeholder="What you did..."
            />
            {role.highlights.length > 1 && (
              <button
                type="button"
                onClick={() => removeHighlight(i)}
                className="mt-2 p-1 text-muted-foreground hover:text-destructive transition-colors"
                aria-label="Remove"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addHighlight}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add highlight
        </button>
      </div>
    </div>
  );
}

function JobEditor({
  job,
  index,
  onChange,
  onDelete,
  canDelete,
}: {
  job: Job;
  index: number;
  onChange: (j: Job) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const [open, setOpen] = useState(index === 0);

  function setField<K extends keyof Job>(k: K, v: Job[K]) {
    onChange({ ...job, [k]: v });
  }

  function updateRole(i: number, r: Role) {
    const roles = [...job.roles];
    roles[i] = r;
    onChange({ ...job, roles });
  }

  function addRole() {
    onChange({ ...job, roles: [...job.roles, newRole()] });
  }

  function removeRole(i: number) {
    onChange({ ...job, roles: job.roles.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-accent/40 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold truncate">
            {job.company || <span className="text-muted-foreground font-normal italic">New company</span>}
          </span>
          {job.roles.length > 0 && job.roles[0].title && (
            <span className="text-xs text-muted-foreground hidden sm:block truncate">
              {job.roles[0].title}{job.roles.length > 1 ? ` +${job.roles.length - 1}` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {canDelete && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onDelete(); } }}
              className="text-xs text-destructive hover:underline"
            >
              Delete
            </span>
          )}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            className={`text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Body */}
      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-border">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Company</label>
              <input
                className={inputClass}
                value={job.company}
                onChange={(e) => setField("company", e.target.value)}
                placeholder="Company name"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Website <span className="text-muted-foreground/50">(optional)</span></label>
              <input
                className={inputClass}
                value={job.website}
                onChange={(e) => setField("website", e.target.value)}
                placeholder="company.com"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs text-muted-foreground">Location</label>
              <input
                className={inputClass}
                value={job.location}
                onChange={(e) => setField("location", e.target.value)}
                placeholder="Tashkent, Uzbekistan"
              />
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Roles</p>
            {job.roles.map((role, i) => (
              <RoleEditor
                key={i}
                role={role}
                onChange={(r) => updateRole(i, r)}
                onDelete={() => removeRole(i)}
                canDelete={job.roles.length > 1}
              />
            ))}
            <button
              type="button"
              onClick={addRole}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 border border-dashed border-border rounded-lg px-3 py-2 w-full justify-center hover:bg-accent/40"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add role
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExperienceEditor() {
  const [data, setData] = useState<Data | null>(null);
  const [sha, setSha] = useState("");
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/admin/experience")
      .then((r) => r.json())
      .then((res) => {
        setData(JSON.parse(res.content));
        setSha(res.sha);
        setStatus("idle");
      })
      .catch((e) => {
        setError(e.message);
        setStatus("error");
      });
  }, []);

  function updateJob(i: number, j: Job) {
    if (!data) return;
    const jobs = [...data.jobs];
    jobs[i] = j;
    setData({ ...data, jobs });
  }

  function addJob() {
    if (!data) return;
    setData({ ...data, jobs: [...data.jobs, newJob()] });
  }

  function removeJob(i: number) {
    if (!data) return;
    setData({ ...data, jobs: data.jobs.filter((_, idx) => idx !== i) });
  }

  async function save() {
    if (!data) return;
    setStatus("saving");
    setError("");
    try {
      const res = await fetch("/api/admin/experience", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: JSON.stringify(data, null, 2), sha }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Failed");
      }
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        Loading…
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {data.jobs.map((job, i) => (
        <JobEditor
          key={i}
          job={job}
          index={i}
          onChange={(j) => updateJob(i, j)}
          onDelete={() => removeJob(i)}
          canDelete={data.jobs.length > 1}
        />
      ))}

      <button
        type="button"
        onClick={addJob}
        className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-3.5 text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add company
      </button>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        {status === "saved" && (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Saved
          </span>
        )}
        <button
          onClick={save}
          disabled={status === "saving"}
          className="rounded-lg bg-primary text-primary-foreground px-5 py-2 text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

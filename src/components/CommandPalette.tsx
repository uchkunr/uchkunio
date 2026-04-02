import { useEffect, useState, useRef } from "react";
import {
  TbHome,
  TbCode,
  TbNotebook,
  TbFileText,
  TbSunMoon,
  TbSearch,
} from "react-icons/tb";

interface CommandItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
  keywords?: string;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands: CommandItem[] = [
    {
      id: "home",
      label: "Go to Home",
      icon: <TbHome size={18} />,
      action: () => (window.location.href = "/"),
      keywords: "home about",
    },
    {
      id: "projects",
      label: "Go to Projects",
      icon: <TbCode size={18} />,
      action: () => (window.location.href = "/projects"),
      keywords: "projects work portfolio",
    },
    {
      id: "blog",
      label: "Go to Blog",
      icon: <TbNotebook size={18} />,
      action: () => (window.location.href = "/blog"),
      keywords: "blog posts articles",
    },
    {
      id: "resume",
      label: "Open Resume",
      icon: <TbFileText size={18} />,
      action: () =>
        window.open(
          "https://docs.google.com/document/d/1_-cqOu5iZBPYh48o1oi8C1HFe1D3VlqWnNS3tPHWJQ/edit?usp=sharing",
          "_blank"
        ),
      keywords: "resume cv",
    },
    {
      id: "theme",
      label: "Toggle Theme",
      icon: <TbSunMoon size={18} />,
      action: () => {
        const current = localStorage.getItem("theme") || "light";
        const next = current === "dark" ? "light" : "dark";
        localStorage.setItem("theme", next);
        document.documentElement.classList.toggle("dark", next === "dark");
      },
      keywords: "theme dark light mode toggle",
    },
  ];

  const filtered = commands.filter((cmd) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      cmd.label.toLowerCase().includes(q) ||
      (cmd.keywords?.toLowerCase().includes(q) ?? false)
    );
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);

    const handleClick = () => setOpen(true);
    const trigger = document.getElementById("cmd-k-trigger");
    const triggerMobile = document.getElementById("cmd-k-trigger-mobile");
    trigger?.addEventListener("click", handleClick);
    triggerMobile?.addEventListener("click", handleClick);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      trigger?.removeEventListener("click", handleClick);
      triggerMobile?.removeEventListener("click", handleClick);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && filtered[selected]) {
      filtered[selected].action();
      setOpen(false);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      <div className="relative mx-auto mt-[15vh] sm:mt-[20vh] max-w-lg px-3 sm:px-4">
        <div className="overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border px-4">
            <TbSearch size={18} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command or search..."
              className="flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden sm:inline-flex h-5 items-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              ESC
            </kbd>
          </div>

          <div ref={listRef} className="max-h-[300px] overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No results found.
              </p>
            ) : (
              filtered.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onClick={() => {
                    cmd.action();
                    setOpen(false);
                  }}
                  onMouseEnter={() => setSelected(i)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors cursor-pointer ${
                    i === selected
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  {cmd.icon}
                  {cmd.label}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

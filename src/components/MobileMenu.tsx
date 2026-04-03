import { useState, useEffect } from "react";
import {
  TbHome,
  TbCode,
  TbNotebook,
  TbFileText,
  TbMenu2,
  TbX,
  TbBrandGithub,
  TbBrandX,
  TbBrandLinkedin,
  TbMail,
  TbCircle,
} from "react-icons/tb";

const menuItems = [
  { label: "Home", href: "/", icon: <TbHome size={20} /> },
  { label: "X/O", href: "/xo", icon: <TbCircle size={20} /> },
  { label: "Projects", href: "/projects", icon: <TbCode size={20} /> },
  { label: "Blog", href: "/blog", icon: <TbNotebook size={20} /> },
  {
    label: "Resume",
    href: "https://docs.google.com/document/d/1_-cqOu5iZBPYh48o1oi8C1HFe1D3VlqWnNS3tPHWJQ/edit?usp=sharing",
    icon: <TbFileText size={20} />,
    external: true,
  },
];

const socialItems = [
  { label: "GitHub", href: "https://github.com/uchkunrakhimow", icon: <TbBrandGithub size={20} /> },
  { label: "Twitter", href: "https://twitter.com/uchkunrakhimov", icon: <TbBrandX size={20} /> },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/uchkunio", icon: <TbBrandLinkedin size={20} /> },
  { label: "Email", href: "mailto:uchkunrakhimov@gmail.com", icon: <TbMail size={20} /> },
];

export default function MobileMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (
        target.closest("[data-mobile-menu]") ||
        target.closest("[data-theme-toggle]") ||
        target.closest("#cmd-k-trigger-mobile")
      ) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    const timer = setTimeout(() => {
      document.addEventListener("click", onClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <>
      <button
        data-mobile-menu
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close menu" : "Open menu"}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
      >
        {open ? <TbX size={18} /> : <TbMenu2 size={18} />}
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] pt-14">
          <div
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div data-mobile-menu className="relative bg-background border-b border-border shadow-lg animate-in slide-in-from-top-2 duration-200">
            <nav className="mx-auto max-w-3xl px-4 py-4">
              <div className="space-y-1">
                {menuItems.map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    target={item.external ? "_blank" : undefined}
                    rel={item.external ? "noopener noreferrer" : undefined}
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                      !item.external && pathname === item.href
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    {item.icon}
                    {item.label}
                    {item.external && (
                      <span className="ml-auto text-[10px] text-muted-foreground/60">↗</span>
                    )}
                  </a>
                ))}
              </div>
              <div className="my-3 h-px bg-border" />
              <div className="flex items-center gap-2 px-3">
                {socialItems.map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-accent/50"
                    aria-label={item.label}
                  >
                    {item.icon}
                  </a>
                ))}
              </div>
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

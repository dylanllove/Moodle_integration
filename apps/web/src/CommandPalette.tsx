import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SearchHit } from "./api.js";

/**
 * One box for the whole app.
 *
 * The data is spread over eleven pages, each with its own filter: a slide deck
 * lives under Course files, the sentence inside it lives in the search index,
 * and knowing which page to look on is the student's problem. ⌘K searches names
 * *and* content in one place and goes straight there.
 */
const PAGES: { label: string; hint: string; to: string }[] = [
  { label: "Dashboard", hint: "today at a glance", to: "/" },
  { label: "Calendar", hint: "month, week and agenda", to: "/calendar" },
  { label: "Workload", hint: "the semester's shape", to: "/workload" },
  { label: "Courses", hint: "enrolments & cheat sheets", to: "/courses" },
  { label: "Course files", hint: "slides & readings by week", to: "/materials" },
  { label: "Lectures", hint: "recordings & transcripts", to: "/lectures" },
  { label: "Notes", hint: "your notes", to: "/notes" },
  { label: "Flashcards", hint: "review what's due", to: "/flashcards" },
  { label: "Grades", hint: "what do I need on the final?", to: "/grades" },
  { label: "Assignment help", hint: "outline, draft, feedback", to: "/assistant" },
  { label: "Settings", hint: "connections & digest", to: "/settings" },
];

const GROUP_LABEL: Record<SearchHit["group"] | "page", string> = {
  page: "Go to",
  course: "Courses",
  assignment: "Assignments",
  deadline: "Deadlines",
  class: "Classes",
  lecture: "Lectures",
  material: "Course files",
  note: "Notes",
  deck: "Flashcards",
  content: "Found in your material",
};

/** Rendering order — named things first, prose last. */
const GROUP_ORDER: (SearchHit["group"] | "page")[] = [
  "course",
  "assignment",
  "deadline",
  "class",
  "lecture",
  "material",
  "note",
  "deck",
  "content",
  "page",
];

interface Row {
  key: string;
  group: SearchHit["group"] | "page";
  title: string;
  subtitle: string | null;
  badge: string | null;
  snippet: string | null;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reopening should feel like a fresh box, not where you left off.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  // Debounced so a fast typist makes one request, not eight.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .search(q, controller.signal)
        .then((r) => setHits(r.hits))
        .catch(() => {
          /* aborted or offline — keep the last result rather than flashing empty */
        })
        .finally(() => setSearching(false));
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  const go = useCallback(
    (hit: SearchHit) => {
      onClose();
      if (hit.to) navigate(hit.to);
      else if (hit.href) window.open(hit.href, "_blank", "noreferrer");
    },
    [navigate, onClose],
  );

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const pages = PAGES.filter((p) => !q || p.label.toLowerCase().includes(q) || p.hint.includes(q));

    const all: Row[] = [
      ...hits.map((h) => ({
        key: h.id,
        group: h.group,
        title: h.title,
        subtitle: h.subtitle,
        badge: h.badge,
        snippet: h.snippet,
        run: () => go(h),
      })),
      ...pages.map((p) => ({
        key: `page:${p.to}`,
        group: "page" as const,
        title: p.label,
        subtitle: p.hint,
        badge: null,
        snippet: null,
        run: () => {
          onClose();
          navigate(p.to);
        },
      })),
    ];

    // Ask the tutor — the honest last resort when nothing matched, and often
    // the right answer for a question rather than a keyword.
    if (q.length >= 2) {
      all.push({
        key: "ask",
        group: "page",
        title: `Ask the study assistant: “${query.trim()}”`,
        subtitle: "answers from your own lectures, slides and deadlines",
        badge: null,
        snippet: null,
        run: () => {
          onClose();
          window.dispatchEvent(new CustomEvent("uni:ask", { detail: query.trim() }));
        },
      });
    }

    return all.sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    );
  }, [hits, query, go, navigate, onClose]);

  // Anything that changes the list invalidates where the highlight was.
  useEffect(() => setActive(0), [rows.length, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
        e.preventDefault();
        setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
      } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
        e.preventDefault();
        setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        rows[active]?.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, active, onClose]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  let lastGroup: string | null = null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/25 p-6 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="reveal w-full max-w-2xl overflow-hidden rounded-card border border-hair bg-surface shadow-lift"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
      >
        <div className="flex items-center gap-3 border-b border-hair px-5 py-3.5">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search courses, files, lectures, deadlines — or anything said in them"
            aria-label="Search everything"
            /* The dialog itself is the focus indicator here — a ring around the
               only field in an auto-focused modal is noise. */
            className="flex-1 border-0 bg-transparent p-0 text-[15px] text-ink outline-none placeholder:text-ink-muted/70 focus-visible:outline-none"
          />
          {searching && (
            <span className="h-3.5 w-3.5 animate-spin rounded-pill border-2 border-hair border-t-accent-deep" />
          )}
          <kbd className="rounded-[6px] bg-chip px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="pane max-h-[52vh] py-2">
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-muted">
              {query.trim().length < 2 ? "Start typing…" : "Nothing matches that."}
            </p>
          ) : (
            rows.map((row, i) => {
              const header = row.group !== lastGroup ? GROUP_LABEL[row.group] : null;
              lastGroup = row.group;
              return (
                <div key={row.key}>
                  {header && (
                    <div className="mt-2 px-5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted/70 first:mt-0">
                      {header}
                    </div>
                  )}
                  <button
                    data-index={i}
                    onMouseMove={() => setActive(i)}
                    onClick={row.run}
                    className={`flex w-full items-center gap-3 px-5 py-2.5 text-left ${
                      i === active ? "bg-accent-tint/60" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{row.title}</div>
                      {row.subtitle && (
                        <div className="mt-0.5 truncate text-xs text-ink-muted">{row.subtitle}</div>
                      )}
                      {row.snippet && (
                        <div className="mt-1 line-clamp-2 text-xs leading-snug text-ink-muted">
                          {row.snippet}
                        </div>
                      )}
                    </div>
                    {row.badge && (
                      <span className="shrink-0 rounded-pill bg-chip px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                        {row.badge}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-hair px-5 py-2 text-[11px] text-ink-muted">
          <span>
            <Key>↑</Key> <Key>↓</Key> to move
          </span>
          <span>
            <Key>↵</Key> to open
          </span>
          <span className="ml-auto">Searches inside your slides and transcripts too</span>
        </div>
      </div>
    </div>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-[5px] bg-chip px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
      {children}
    </kbd>
  );
}

function SearchIcon() {
  return (
    <svg
      className="h-4.5 w-4.5 shrink-0 text-ink-muted"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

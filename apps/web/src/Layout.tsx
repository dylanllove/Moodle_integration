import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type SyncProgress } from "./api.js";
import { ChatWidget } from "./ChatWidget.js";
import { CommandPalette } from "./CommandPalette.js";

function relTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "12m" until the next scheduled sync, or null if it's due/unknown. */
function untilNext(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  return mins > 0 ? `${mins}m` : null;
}

/**
 * Grouped nav. Eleven destinations is too many to read as one list, but they fall
 * naturally into what you're doing: planning the week, studying the material,
 * tracking where you stand.
 */
const groups: { label: string | null; items: NavItem[] }[] = [
  {
    label: "Plan",
    items: [
      { to: "/", label: "Dashboard", icon: HomeIcon, end: true },
      { to: "/calendar", label: "Calendar", icon: CalendarIcon },
      { to: "/workload", label: "Workload", icon: ChartIcon },
    ],
  },
  {
    label: "Study",
    items: [
      { to: "/courses", label: "Courses", icon: BookIcon },
      { to: "/materials", label: "Course files", icon: FolderIcon },
      { to: "/lectures", label: "Lectures", icon: MicIcon },
      { to: "/notes", label: "Notes", icon: NoteIcon },
      { to: "/flashcards", label: "Flashcards", icon: CardsIcon, badge: "due" },
    ],
  },
  {
    label: "Track",
    items: [
      { to: "/grades", label: "Grades", icon: TargetIcon },
      { to: "/assistant", label: "Assignment help", icon: PenIcon },
    ],
  },
  { label: null, items: [{ to: "/settings", label: "Settings", icon: GearIcon }] },
];

interface NavItem {
  to: string;
  label: string;
  icon: (p: IconProps) => ReactNode;
  end?: boolean;
  /** "due" renders the count of flashcards waiting, when there are any. */
  badge?: "due";
}

export function Layout() {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [showPhases, setShowPhases] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [cardsDue, setCardsDue] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const refreshSidebar = useCallback(() => {
    api.settings().then((s) => setLastSynced(s.last_synced ?? null)).catch(() => {});
    // A quiet nudge in the nav is the whole retention mechanism for flashcards.
    api
      .decks()
      .then((d) => setCardsDue(d.decks.reduce((n, deck) => n + deck.due, 0)))
      .catch(() => {});
  }, []);

  useEffect(refreshSidebar, [pathname, refreshSidebar]);

  // ⌘K / Ctrl-K from anywhere. Ignored while typing so it can't eat a keystroke
  // meant for a note or a draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First run on a fresh clone: nothing is configured, so send them to setup
  // rather than an empty dashboard. Only redirects once, and never away from a
  // page they navigated to themselves.
  useEffect(() => {
    let cancelled = false;
    api
      .setupStatus()
      .then((s) => {
        if (cancelled) return;
        const unconfigured = !s.moodle.connected || !s.openai;
        setNeedsSetup(unconfigured);
        if (unconfigured && !s.moodle.url && !s.openai && pathname === "/") navigate("/setup");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Intentionally mount-only: a redirect that re-fires on every navigation
    // would trap you on /setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Follow a sync that's already under way — including the one the server kicks
   * off at launch, which used to happen entirely behind the student's back.
   * Polling stops the moment it finishes, so an idle app is silent.
   */
  const poll = useRef<number | null>(null);
  const watch = useCallback(() => {
    if (poll.current != null) return;
    poll.current = window.setInterval(async () => {
      try {
        const state = await api.syncProgress();
        setProgress(state);
        if (!state.running) {
          window.clearInterval(poll.current!);
          poll.current = null;
          refreshSidebar();
          // Whoever's on screen refetches itself rather than being reloaded.
          window.dispatchEvent(new CustomEvent("uni:synced"));
        }
      } catch {
        window.clearInterval(poll.current!);
        poll.current = null;
      }
    }, 900);
  }, [refreshSidebar]);

  /**
   * Syncs now start on their own — at launch, on a timer, and on waking from
   * sleep. A heartbeat is what lets the sidebar notice one it didn't press the
   * button for; without it, background work is invisible until you navigate.
   */
  useEffect(() => {
    const check = () =>
      api
        .syncProgress()
        .then((state) => {
          setProgress(state);
          if (state.running) watch();
        })
        .catch(() => {});
    void check();
    const heartbeat = window.setInterval(() => {
      if (poll.current == null) void check();
    }, 45_000);
    return () => {
      window.clearInterval(heartbeat);
      if (poll.current != null) window.clearInterval(poll.current);
    };
  }, [watch]);

  async function sync() {
    setShowPhases(true);
    try {
      const r = await api.syncRun();
      setProgress(r.state);
      watch();
    } catch {
      setProgress((p) => (p ? { ...p, error: "Couldn't start the sync." } : p));
    }
  }

  const syncing = progress?.running ?? false;
  const runningPhase = progress?.phases.find((p) => p.status === "running");
  const failed = progress?.phases.filter((p) => p.status === "error") ?? [];

  return (
    <div className="min-h-screen text-ink">
      <div className="flex">
        <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-hair bg-surface px-4 py-6">
          {/* Wordmark — the one place the bronze half of the palette fills a
              shape, so the warm counterweight has a fixed anchor. */}
          <div className="mb-9 flex items-center gap-2.5 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-second-deep font-display text-lg font-black text-white">
              U
            </div>
            <div className="leading-tight">
              <div className="font-display text-[15px] font-bold tracking-tight text-ink">
                Uni Study
              </div>
              <div className="text-xs text-ink-muted">quietly under control</div>
            </div>
          </div>

          {/* The one box. Discoverable as a button, fast as a shortcut. */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="mb-5 flex items-center gap-2.5 rounded-pill border border-hair bg-page px-3 py-2 text-left text-[13px] text-ink-muted transition duration-200 hover:bg-chip hover:text-ink"
          >
            <svg
              className="h-4 w-4 shrink-0"
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
            <span className="flex-1">Search everything</span>
            <kbd className="rounded-[5px] bg-chip px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
          </button>

          {/* Scrolls rather than pushing the sync controls off a short screen. */}
          <nav className="pane -mr-2 flex min-h-0 flex-col gap-0.5 pr-2">
            {/* Only present until the essentials are connected. */}
            {needsSetup && (
              <NavItemLink item={{ to: "/setup", label: "Finish setup", icon: SparkIcon, end: true }} />
            )}
            {groups.map((group, i) => (
              <div key={group.label ?? `group-${i}`} className={group.label ? "mt-4 first:mt-0" : "mt-4"}>
                {group.label && (
                  <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted/70">
                    {group.label}
                  </div>
                )}
                {group.items.map((item) => (
                  <NavItemLink key={item.to} item={item} cardsDue={cardsDue} />
                ))}
              </div>
            ))}
          </nav>

          <div className="mt-auto shrink-0 border-t border-hair pt-5">
            {showPhases && progress && (
              <>
                <SyncPhases progress={progress} />
                <p className="mb-3 px-1 text-[11px] leading-snug text-ink-muted">
                  {progress.auto?.enabled
                    ? `Runs itself every ${progress.auto.minutes} minutes${
                        untilNext(progress.auto.nextAt) ? ` · next in ${untilNext(progress.auto.nextAt)}` : ""
                      }.`
                    : "Automatic syncing is off — change it in Settings."}
                </p>
              </>
            )}
            <button
              onClick={sync}
              disabled={syncing}
              className="flex w-full items-center justify-center gap-2 rounded-pill bg-accent px-3 py-2.5 text-sm font-medium text-ink transition duration-200 hover:brightness-[0.94] disabled:opacity-50"
            >
              <svg
                className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {syncing ? "Syncing…" : "Sync everything"}
            </button>
            {/* One line of truth: what it's doing, or what it last did. */}
            <button
              onClick={() => setShowPhases((s) => !s)}
              className="mt-2.5 w-full text-center text-[13px] text-ink-muted transition duration-200 hover:text-ink"
            >
              {syncing
                ? (runningPhase?.label ?? "Starting…")
                : failed.length > 0
                  ? `${failed.length} step${failed.length === 1 ? " needs" : "s need"} attention`
                  : relTime(lastSynced)
                    ? `Synced ${relTime(lastSynced)}`
                    : "Not synced yet"}
            </button>
          </div>
        </aside>

        <main className="min-h-screen flex-1">
          <div className="mx-auto max-w-[1200px] px-10 py-14">
            <Outlet />
          </div>
        </main>
      </div>
      <ChatWidget />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/**
 * What the sync is actually doing. A full run pulls a semester of slide decks
 * and can transcribe an hour of lecture audio — a spinner with no detail leaves
 * you unable to tell "working" from "stuck", and hides the one step that failed.
 */
function SyncPhases({ progress }: { progress: SyncProgress }) {
  const MARK: Record<string, string> = {
    pending: "·",
    running: "→",
    done: "✓",
    skipped: "–",
    error: "!",
  };
  const TONE: Record<string, string> = {
    pending: "text-ink-muted/50",
    running: "text-accent-deep font-medium",
    done: "text-ink-muted",
    skipped: "text-ink-muted/60",
    error: "text-rose-700",
  };
  return (
    <div className="pane mb-3 max-h-56 space-y-1 rounded-field bg-chip/60 px-3 py-2.5">
      {progress.phases.map((p) => (
        <div key={p.key} className={`text-[11px] leading-snug ${TONE[p.status]}`}>
          <span className="mr-1.5 inline-block w-2 font-mono">{MARK[p.status]}</span>
          {p.label}
          {p.detail && <span className="block pl-[14px] text-ink-muted/70">{p.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function NavItemLink({ item, cardsDue = 0 }: { item: NavItem; cardsDue?: number }) {
  const badge = item.badge === "due" && cardsDue > 0 ? cardsDue : null;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-pill px-3 py-2 text-sm transition duration-200 ${
          isActive
            ? "bg-accent-tint font-semibold text-accent-deep"
            : "font-medium text-ink-muted hover:bg-chip hover:text-ink"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <item.icon active={isActive} />
          <span className="flex-1">{item.label}</span>
          {badge != null && (
            <span className="rounded-pill bg-second-tint px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-second-deep">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// --- minimal stroke icons ---
type IconProps = { active?: boolean };
const cls = (active?: boolean) => `h-[18px] w-[18px] ${active ? "text-accent-deep" : "text-ink-muted"}`;
const S = (p: { children: ReactNode; active?: boolean }) => (
  <svg className={cls(p.active)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {p.children}
  </svg>
);
function SparkIcon({ active }: IconProps) { return <S active={active}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="3.2" /></S>; }
function HomeIcon({ active }: IconProps) { return <S active={active}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></S>; }
function CalendarIcon({ active }: IconProps) { return <S active={active}><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></S>; }
function BookIcon({ active }: IconProps) { return <S active={active}><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" /><path d="M8 3v18" /></S>; }
function MicIcon({ active }: IconProps) { return <S active={active}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></S>; }
function NoteIcon({ active }: IconProps) { return <S active={active}><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></S>; }
function PenIcon({ active }: IconProps) { return <S active={active}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>; }
function ChartIcon({ active }: IconProps) { return <S active={active}><path d="M4 20V10M10 20V5M16 20v-7M22 20H2" /></S>; }
function FolderIcon({ active }: IconProps) { return <S active={active}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" /></S>; }
function CardsIcon({ active }: IconProps) { return <S active={active}><rect x="3" y="7" width="14" height="12" rx="2" /><path d="M7 4h11a2 2 0 0 1 2 2v10" /></S>; }
function TargetIcon({ active }: IconProps) { return <S active={active}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.6" fill="currentColor" /></S>; }
function GearIcon({ active }: IconProps) { return <S active={active}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></S>; }

import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api.js";
import { ChatWidget } from "./ChatWidget.js";

function relTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const nav = [
  { to: "/", label: "Dashboard", icon: HomeIcon, end: true },
  { to: "/calendar", label: "Calendar", icon: CalendarIcon },
  { to: "/courses", label: "Courses", icon: BookIcon },
  { to: "/lectures", label: "Lectures", icon: MicIcon },
  { to: "/notes", label: "Notes", icon: NoteIcon },
  { to: "/assistant", label: "Assignment help", icon: PenIcon },
  { to: "/settings", label: "Settings", icon: GearIcon },
];

export function Layout() {
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    api.settings().then((s) => setLastSynced(s.last_synced ?? null)).catch(() => {});
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

  async function sync() {
    setSyncing(true);
    setStatus(null);
    try {
      const r = await api.sync();
      setStatus(r.ok ? "Up to date" : "Sync failed");
      if (r.ok) setTimeout(() => location.reload(), 500);
    } catch {
      setStatus("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="min-h-screen text-ink">
      <div className="flex">
        <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-hair bg-surface px-4 py-6">
          {/* Wordmark — the only place the deep terracotta fills a shape. */}
          <div className="mb-9 flex items-center gap-2.5 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent-deep font-display text-lg font-black text-white">
              U
            </div>
            <div className="leading-tight">
              <div className="font-display text-[15px] font-bold tracking-tight text-ink">
                Uni Study
              </div>
              <div className="text-xs text-ink-muted">quietly under control</div>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5">
            {/* Only present until the essentials are connected. */}
            {(needsSetup ? [{ to: "/setup", label: "Finish setup", icon: SparkIcon, end: true }, ...nav] : nav).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
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
                    <n.icon active={isActive} />
                    {n.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto border-t border-hair pt-5">
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
              {syncing ? "Syncing…" : "Sync Moodle"}
            </button>
            <p className="mt-2.5 text-center text-[13px] text-ink-muted">
              {status ?? (relTime(lastSynced) ? `Synced ${relTime(lastSynced)}` : "Not synced yet")}
            </p>
          </div>
        </aside>

        <main className="min-h-screen flex-1">
          <div className="mx-auto max-w-[1200px] px-10 py-14">
            <Outlet />
          </div>
        </main>
      </div>
      <ChatWidget />
    </div>
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
function GearIcon({ active }: IconProps) { return <S active={active}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></S>; }

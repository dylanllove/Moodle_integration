import { NavLink, Outlet } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { api } from "./api.js";
import { ChatWidget } from "./ChatWidget.js";

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
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex">
        <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-5">
          <div className="mb-8 flex items-center gap-2.5 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white">
              U
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-slate-900">Uni Study</div>
              <div className="text-xs text-slate-400">study manager</div>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
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

          <div className="mt-auto border-t border-slate-100 pt-4">
            <button
              onClick={sync}
              disabled={syncing}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
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
            {status && <p className="mt-2 text-center text-xs text-slate-400">{status}</p>}
          </div>
        </aside>

        <main className="min-h-screen flex-1">
          <div className="mx-auto max-w-6xl px-10 py-10">
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
const cls = (active?: boolean) => `h-[18px] w-[18px] ${active ? "text-indigo-600" : "text-slate-400"}`;
const S = (p: { children: ReactNode; active?: boolean }) => (
  <svg className={cls(p.active)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {p.children}
  </svg>
);
function HomeIcon({ active }: IconProps) { return <S active={active}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></S>; }
function CalendarIcon({ active }: IconProps) { return <S active={active}><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></S>; }
function BookIcon({ active }: IconProps) { return <S active={active}><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" /><path d="M8 3v18" /></S>; }
function MicIcon({ active }: IconProps) { return <S active={active}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></S>; }
function NoteIcon({ active }: IconProps) { return <S active={active}><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></S>; }
function PenIcon({ active }: IconProps) { return <S active={active}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>; }
function GearIcon({ active }: IconProps) { return <S active={active}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></S>; }

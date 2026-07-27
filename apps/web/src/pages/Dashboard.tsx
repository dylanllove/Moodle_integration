import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CalEvent, type Course } from "../api.js";
import { Card, PageHeader, Button, Badge, EmptyState, Loading, dueMeta } from "../ui.js";
import { courseColor } from "../colors.js";

export function Dashboard() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [reminderDays, setReminderDays] = useState(3);
  const [gcal, setGcal] = useState({ configured: false, connected: false });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const now = new Date();
    const to = new Date(now.getTime() + 60 * 864e5);
    Promise.all([
      api.events(now.toISOString(), to.toISOString()),
      api.courses(),
      api.reminderDays(),
      api.gcalStatus().catch(() => ({ configured: false, connected: false })),
    ])
      .then(([e, c, r, g]) => {
        setEvents(e);
        setCourses(c);
        setReminderDays(r.days);
        setGcal(g);
      })
      .finally(() => setLoading(false));
  }, []);

  const courseCode = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "General";
  const isToday = (iso: string) => {
    const d = new Date(iso);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  };

  const todaySchedule = events
    .filter((e) => e.kind === "class" && isToday(e.start_at))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const deadlines = events
    .filter((e) => ["deadline", "exam", "open"].includes(e.kind))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const soon = deadlines.filter(
    (e) => e.kind !== "open" && new Date(e.start_at).getTime() - Date.now() <= reminderDays * 864e5 && new Date(e.start_at) >= new Date(Date.now() - 864e5),
  );

  return (
    <div>
      <PageHeader
        title={greeting()}
        subtitle={new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
      />

      {loading && <Loading label="Loading your dashboard…" />}
      <div className={loading ? "hidden" : ""}>

      {/* First-run guidance when nothing's synced yet */}
      {!loading && courses.length === 0 && <GettingStarted />}

      {/* Today's timetable */}
      <Card className="mb-6 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">📆 Today's schedule</h2>
          <Link to="/calendar" className="text-xs text-indigo-600 hover:underline">Full calendar →</Link>
        </div>
        {todaySchedule.length === 0 ? (
          <p className="text-sm text-slate-400">
            No classes scheduled today. Add your timetable in Settings to see it here.
          </p>
        ) : (
          <div className="space-y-2">
            {todaySchedule.map((e) => (
              <div key={e.id} className="flex items-center gap-4 rounded-xl bg-slate-50 px-4 py-2.5">
                <div className="w-24 shrink-0 text-sm font-medium tabular-nums text-slate-900">
                  {new Date(e.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {e.end_at && (
                    <span className="text-slate-400">
                      {" – "}
                      {new Date(e.end_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                </div>
                <span className="h-8 w-1 rounded-full" style={{ background: courseColor(e.course_id) }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{e.title}</div>
                  <div className="text-xs text-slate-500">
                    {courseCode(e.course_id)}
                    {e.location ? ` · ${e.location}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Quick actions */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card hover className="p-5">
          <div className="mb-1 text-sm font-semibold text-slate-900">📦 Study pack</div>
          <p className="mb-4 text-xs leading-relaxed text-slate-500">
            All courses + a CLAUDE.md tutor guide, zipped for any LLM.
          </p>
          <a href="/api/export/all" download>
            <Button variant="primary" className="w-full">Download study pack</Button>
          </a>
        </Card>
        <Card className="p-5">
          <div className="mb-1 text-sm font-semibold text-slate-900">🔔 Remind me</div>
          <p className="mb-4 text-xs text-slate-500">Flag deadlines this far ahead.</p>
          <div className="flex gap-1.5">
            {[1, 3, 7, 14].map((d) => (
              <button
                key={d}
                onClick={async () => { setReminderDays(d); await api.setReminderDays(d); }}
                className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${
                  reminderDays === d ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-1 text-sm font-semibold text-slate-900">📆 Google Calendar</div>
          {gcal.connected ? (
            <><p className="mb-4 text-xs text-emerald-600">Connected — syncing.</p><Badge tone="green">Syncing</Badge></>
          ) : (
            <><p className="mb-4 text-xs text-slate-500">Push deadlines to your calendar.</p><Link to="/settings"><Button className="w-full">Set up</Button></Link></>
          )}
        </Card>
      </div>

      {soon.length > 0 && (
        <Card className="mb-6 border-amber-200 bg-amber-50 p-4">
          <span className="text-sm font-medium text-amber-800">
            ⚠️ {soon.length} due within {reminderDays} day{reminderDays > 1 ? "s" : ""}
          </span>
        </Card>
      )}

      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Upcoming deadlines</h2>
      {deadlines.length === 0 ? (
        <EmptyState icon="✅">Nothing upcoming. Hit Sync Moodle to refresh.</EmptyState>
      ) : (
        <div className="space-y-2">
          {deadlines.map((e) => {
            const meta = dueMeta(e.start_at);
            const isOpen = e.kind === "open";
            return (
              <Card key={e.id} hover className="flex items-center gap-4 p-4">
                <span className="h-9 w-1.5 rounded-full" style={{ background: courseColor(e.course_id) }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{e.title}</div>
                  <div className="text-xs text-slate-400">{courseCode(e.course_id)}{isOpen && " · opens"}</div>
                </div>
                <div className="text-right text-xs text-slate-400">
                  {new Date(e.start_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                </div>
                {isOpen ? <Badge tone="indigo">opens</Badge> : <Badge tone={meta.tone}>{meta.label}</Badge>}
              </Card>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function GettingStarted() {
  const steps = [
    { t: "Add your keys", d: "Put MOODLE_URL, MOODLE_TOKEN and OPENAI_API_KEY in your .env file, then restart.", tag: ".env" },
    { t: "Sync Moodle", d: "Hit “Sync Moodle” (bottom-left) to pull your courses, assignments and deadlines.", tag: "sidebar" },
    { t: "Connect Echo360", d: "Settings → Echo360 → Connect to auto-transcribe your lecture recordings.", tag: "Settings" },
    { t: "Add your timetable", d: "Settings → Class timetable → paste your iCal link (or drop the .ics in the project folder).", tag: "Settings" },
  ];
  return (
    <Card className="mb-6 border-indigo-100 bg-indigo-50/50 p-6">
      <h2 className="mb-1 text-base font-semibold text-slate-900">👋 Welcome — let's get you set up</h2>
      <p className="mb-4 text-sm text-slate-600">A few one-time steps and your dashboard fills itself in.</p>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">{i + 1}</span>
            <div>
              <div className="text-sm font-medium text-slate-900">
                {s.t} <span className="ml-1 rounded bg-white px-1.5 py-0.5 text-[11px] font-normal text-slate-500 ring-1 ring-slate-200">{s.tag}</span>
              </div>
              <div className="text-sm text-slate-600">{s.d}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4">
        <Link to="/settings"><Button variant="primary">Open Settings</Button></Link>
      </div>
    </Card>
  );
}

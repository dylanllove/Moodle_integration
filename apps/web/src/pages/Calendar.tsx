import { useEffect, useMemo, useState } from "react";
import { api, type CalEvent, type Course } from "../api.js";
import { courseColor } from "../colors.js";
import { Card, PageHeader, Button, Badge, EmptyState, dueMeta } from "../ui.js";

type View = "month" | "agenda";

// Event-type styling so what matters (deadlines, exams) pops at a glance.
const TYPE: Record<string, { label: string; color: string; tone: "red" | "amber" | "green" | "indigo" | "neutral" }> = {
  deadline: { label: "Deadline", color: "#e11d48", tone: "red" },
  exam: { label: "Exam", color: "#7c3aed", tone: "indigo" },
  open: { label: "Opens", color: "#64748b", tone: "neutral" },
  class: { label: "Class", color: "#2563eb", tone: "indigo" },
  other: { label: "Event", color: "#64748b", tone: "neutral" },
};
const typeOf = (k: string) => TYPE[k] ?? TYPE.other;

export function Calendar() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>(dayKey(new Date()));

  useEffect(() => {
    Promise.all([api.events(), api.courses()]).then(([e, c]) => {
      setEvents(e);
      setCourses(c);
    });
  }, []);

  const courseCode = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "General";
  const shown = useMemo(
    () => events.filter((e) => !(e.course_id && hidden.has(e.course_id))),
    [events, hidden],
  );

  function toggleCourse(id: string) {
    setHidden((h) => {
      const n = new Set(h);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Deadlines, opening dates, classes & exams"
        actions={
          <div className="flex rounded-xl border border-slate-300 bg-white p-0.5">
            {(["month", "agenda"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition ${
                  view === v ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        }
      />

      {/* Course filters + type legend */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {courses.map((c) => {
            const off = hidden.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggleCourse(c.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  off ? "border-slate-200 bg-white text-slate-400" : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: off ? "#cbd5e1" : courseColor(c.id) }} />
                {c.code}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-slate-500">
          {["deadline", "exam", "class", "open"].map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: typeOf(k).color }} />
              {typeOf(k).label}
            </span>
          ))}
        </div>
      </div>

      {events.length === 0 ? (
        <EmptyState icon="📅">No events yet — Sync Moodle.</EmptyState>
      ) : view === "month" ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
          <MonthGrid events={shown} cursor={cursor} setCursor={setCursor} selected={selected} onSelect={setSelected} />
          <DayPanel dateKey={selected} events={shown} courseCode={courseCode} />
        </div>
      ) : (
        <Agenda events={shown} courseCode={courseCode} />
      )}

      <p className="mt-6 text-xs text-slate-400">
        Apple Calendar can subscribe to{" "}
        <code className="rounded bg-slate-100 px-1.5 py-0.5">{location.origin}/api/calendar.ics</code>
      </p>
    </div>
  );
}

function MonthGrid({
  events,
  cursor,
  setCursor,
  selected,
  onSelect,
}: {
  events: CalEvent[];
  cursor: Date;
  setCursor: (d: Date) => void;
  selected: string;
  onSelect: (k: string) => void;
}) {
  const cells = useMemo(() => monthCells(cursor), [cursor]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) (m.get(dayKey(new Date(e.start_at))) ?? m.set(dayKey(new Date(e.start_at)), []).get(dayKey(new Date(e.start_at)))!).push(e);
    return m;
  }, [events]);
  const today = dayKey(new Date());

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-3">
        <Button size="sm" variant="ghost" onClick={() => setCursor(addMonths(cursor, -1))}>←</Button>
        <div className="w-40 text-center text-sm font-semibold text-slate-900">
          {cursor.toLocaleString([], { month: "long", year: "numeric" })}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setCursor(addMonths(cursor, 1))}>→</Button>
        <button className="ml-1 text-xs text-slate-400 hover:text-slate-600" onClick={() => setCursor(startOfMonth(new Date()))}>Today</button>
      </div>
      <div className="grid grid-cols-7 bg-slate-100" style={{ gap: 1 }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="bg-white py-2 text-center text-xs font-semibold text-slate-400">{d}</div>
        ))}
        {cells.map((d) => {
          const key = dayKey(d);
          const inMonth = d.getMonth() === cursor.getMonth();
          const items = (byDay.get(key) ?? []).sort((a, b) => a.start_at.localeCompare(b.start_at));
          const isToday = key === today;
          const isSel = key === selected;
          return (
            <button
              key={d.toISOString()}
              onClick={() => onSelect(key)}
              className={`min-h-[96px] cursor-pointer bg-white p-1.5 text-left transition hover:bg-slate-50 ${inMonth ? "" : "bg-slate-50/60"} ${isSel ? "ring-2 ring-inset ring-indigo-400" : ""}`}
            >
              <div className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${isToday ? "bg-indigo-600 font-semibold text-white" : inMonth ? "text-slate-500" : "text-slate-300"}`}>
                {d.getDate()}
              </div>
              <div className="space-y-1">
                {items.slice(0, 3).map((e) => (
                  <div key={e.id} title={e.title} className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px]" style={{ background: typeOf(e.kind).color + "1a", color: typeOf(e.kind).color }}>
                    <span className="truncate">{e.title.replace(/^(Due|Opens): /, "")}</span>
                  </div>
                ))}
                {items.length > 3 && <div className="pl-1 text-[11px] text-slate-400">+{items.length - 3} more</div>}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function DayPanel({
  dateKey,
  events,
  courseCode,
}: {
  dateKey: string;
  events: CalEvent[];
  courseCode: (id: string | null) => string;
}) {
  const items = events
    .filter((e) => dayKey(new Date(e.start_at)) === dateKey)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const [y, m, d] = dateKey.split("-").map(Number);
  const label = new Date(y!, m!, d!).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  return (
    <Card className="p-5">
      <div className="mb-3 text-sm font-semibold text-slate-900">{label}</div>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing scheduled.</p>
      ) : (
        <div className="space-y-3">
          {items.map((e) => {
            const t = typeOf(e.kind);
            return (
              <div key={e.id} className="flex gap-3">
                <span className="mt-1 h-full w-1 shrink-0 rounded-full" style={{ background: t.color }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900">{e.title.replace(/^(Due|Opens): /, "")}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge tone={t.tone}>{t.label}</Badge>
                    <span>{courseCode(e.course_id)}</span>
                    <span>·</span>
                    <span>{new Date(e.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  {e.url && (
                    <a href={e.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-indigo-600 hover:underline">
                      Open in Moodle ↗
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Agenda({ events, courseCode }: { events: CalEvent[]; courseCode: (id: string | null) => string }) {
  const upcoming = events
    .filter((e) => new Date(e.start_at) >= new Date(Date.now() - 864e5))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const groups: Record<string, CalEvent[]> = {};
  for (const e of upcoming) {
    const day = new Date(e.start_at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    (groups[day] ??= []).push(e);
  }
  return (
    <div className="space-y-6">
      {Object.entries(groups).map(([day, items]) => (
        <div key={day}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{day}</div>
          <div className="space-y-2">
            {items.map((e) => {
              const t = typeOf(e.kind);
              const meta = dueMeta(e.start_at);
              return (
                <Card key={e.id} className="flex items-center gap-3 p-3.5">
                  <span className="h-8 w-1 rounded-full" style={{ background: t.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">{e.title.replace(/^(Due|Opens): /, "")}</div>
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <Badge tone={t.tone}>{t.label}</Badge>
                      {courseCode(e.course_id)}
                    </div>
                  </div>
                  {e.kind === "deadline" && <Badge tone={meta.tone}>{meta.label}</Badge>}
                  <span className="text-xs text-slate-400">
                    {new Date(e.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function dayKey(d: Date) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function monthCells(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

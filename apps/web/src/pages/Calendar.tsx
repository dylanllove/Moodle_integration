import { useEffect, useMemo, useState } from "react";
import { api, type CalEvent, type Course } from "../api.js";
import { courseColor } from "../colors.js";
import {
  Card,
  PageHeader,
  Badge,
  Tabs,
  IconButton,
  SectionTitle,
  EmptyState,
  Loading,
  dueMeta,
} from "../ui.js";

type View = "month" | "agenda";

// Event-type styling. Muted on purpose — these sit beside the apricot accent
// all day, and each hue is kept clear of the terracotta used for accent text.
const TYPE: Record<string, { label: string; color: string; tone: "red" | "amber" | "green" | "accent" | "neutral" }> = {
  deadline: { label: "Deadline", color: "#c0392b", tone: "red" },
  exam: { label: "Exam", color: "#6b4a7a", tone: "accent" },
  open: { label: "Opens", color: "#8a8a80", tone: "neutral" },
  class: { label: "Class", color: "#4a7c6f", tone: "neutral" },
  other: { label: "Event", color: "#8a8a80", tone: "neutral" },
};
const typeOf = (k: string) => TYPE[k] ?? TYPE.other;

const VIEWS = [
  { key: "month" as const, label: "Month" },
  { key: "agenda" as const, label: "Agenda" },
];

export function Calendar() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>(dayKey(new Date()));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.events(), api.courses()])
      .then(([e, c]) => {
        setEvents(e);
        setCourses(c);
      })
      .finally(() => setLoading(false));
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
        actions={<Tabs tabs={VIEWS} value={view} onChange={setView} />}
      />

      {/* Course filters. No colour legend — every event is labelled where it
          matters (day panel, agenda), so a legend is decoration. */}
      {courses.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {courses.map((c) => {
            const off = hidden.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggleCourse(c.id)}
                aria-pressed={!off}
                className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-medium transition duration-200 ${
                  off ? "bg-chip/60 text-ink-muted/70 hover:bg-chip" : "bg-accent-tint text-accent-deep"
                }`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-pill transition duration-200"
                  style={{ background: off ? "#c4c4bb" : courseColor(c.id) }}
                />
                {c.code}
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <Loading />
      ) : events.length === 0 ? (
        <EmptyState icon="📅">No events yet — Sync Moodle.</EmptyState>
      ) : view === "month" ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
          <MonthGrid events={shown} cursor={cursor} setCursor={setCursor} selected={selected} onSelect={setSelected} />
          <DayPanel dateKey={selected} events={shown} courseCode={courseCode} />
        </div>
      ) : (
        <Agenda events={shown} courseCode={courseCode} />
      )}
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
    for (const e of events) {
      const k = dayKey(new Date(e.start_at));
      const list = m.get(k) ?? [];
      list.push(e);
      m.set(k, list);
    }
    return m;
  }, [events]);
  const today = dayKey(new Date());

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-1 border-b border-hair px-4 py-3">
        <IconButton label="Previous month" onClick={() => setCursor(addMonths(cursor, -1))}>
          <Chevron dir="left" />
        </IconButton>
        <div className="w-44 text-center font-display text-[15px] font-bold tracking-tight text-ink">
          {cursor.toLocaleString([], { month: "long", year: "numeric" })}
        </div>
        <IconButton label="Next month" onClick={() => setCursor(addMonths(cursor, 1))}>
          <Chevron dir="right" />
        </IconButton>
        <button
          className="ml-2 rounded-pill px-2.5 py-1 text-xs font-medium text-ink-muted transition duration-200 hover:bg-chip hover:text-ink"
          onClick={() => setCursor(startOfMonth(new Date()))}
        >
          Today
        </button>
      </div>

      <div className="grid grid-cols-7 border-b border-hair">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div
            key={d}
            className="py-2.5 text-center text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Hairline borders on the cells themselves — no gap-trick background. */}
      <div className="grid grid-cols-7">
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
              className={`min-h-[98px] border-b border-r border-hair p-1.5 text-left align-top transition duration-200 ${
                isSel ? "bg-accent-tint/60" : inMonth ? "hover:bg-chip/50" : "bg-chip/25"
              }`}
            >
              <div
                className={`mb-1 flex h-6 w-6 items-center justify-center rounded-pill text-xs tabular-nums transition duration-200 ${
                  isToday
                    ? "bg-pill font-semibold text-white"
                    : inMonth
                      ? "text-ink-muted"
                      : "text-ink-muted/40"
                }`}
              >
                {d.getDate()}
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((e) => {
                  const t = typeOf(e.kind);
                  return (
                    <div
                      key={e.id}
                      title={e.title}
                      className="flex items-center gap-1.5 truncate rounded-[5px] px-1.5 py-0.5 text-[11px] leading-tight"
                      style={{ background: t.color + "14", color: t.color }}
                    >
                      <span className="truncate">{e.title.replace(/^(Due|Opens): /, "")}</span>
                    </div>
                  );
                })}
                {items.length > 3 && (
                  <div className="pl-1.5 text-[11px] text-ink-muted">+{items.length - 3} more</div>
                )}
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
    <Card className="h-fit p-5">
      <SectionTitle className="mb-4">{label}</SectionTitle>
      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing scheduled.</p>
      ) : (
        <div className="space-y-4">
          {items.map((e) => {
            const t = typeOf(e.kind);
            return (
              <div key={e.id} className="flex gap-3">
                <span
                  className="mt-0.5 w-1 shrink-0 rounded-pill"
                  style={{ background: t.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug text-ink">
                    {e.title.replace(/^(Due|Opens): /, "")}
                  </div>
                  <div className="mt-1 text-xs text-ink-muted">
                    {t.label} · {courseCode(e.course_id)} ·{" "}
                    {new Date(e.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  {e.url && (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-xs font-medium text-accent-deep transition duration-200 hover:underline"
                    >
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
    <div className="space-y-7">
      {Object.entries(groups).map(([day, items]) => (
        <div key={day}>
          <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {day}
          </div>
          <div className="space-y-2">
            {items.map((e) => {
              const t = typeOf(e.kind);
              const meta = dueMeta(e.start_at);
              return (
                <Card key={e.id} hover className="flex items-center gap-3.5 p-4">
                  <span className="h-8 w-1 shrink-0 rounded-pill" style={{ background: t.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">
                      {e.title.replace(/^(Due|Opens): /, "")}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {t.label} · {courseCode(e.course_id)}
                    </div>
                  </div>
                  {e.kind === "deadline" && <Badge tone={meta.tone}>{meta.label}</Badge>}
                  <span className="shrink-0 text-xs tabular-nums text-ink-muted">
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

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 6 6 6-6 6"} />
    </svg>
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

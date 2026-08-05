import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type CalEvent, type Commitment, type Course } from "../api.js";
import { courseColor } from "../colors.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  Input,
  Select,
  Tabs,
  IconButton,
  SectionTitle,
  Details,
  EmptyState,
  Loading,
  dueMeta,
} from "../ui.js";

type View = "month" | "week" | "agenda";

// Event-type styling. Muted on purpose — these sit beside the sky accent all
// day, and each hue is kept clear of the accent colours used for interaction.
const TYPE: Record<string, { label: string; color: string; tone: "red" | "amber" | "green" | "accent" | "neutral" }> = {
  deadline: { label: "Deadline", color: "#c0392b", tone: "red" },
  exam: { label: "Exam", color: "#6b4a7a", tone: "accent" },
  open: { label: "Opens", color: "#8a8a80", tone: "neutral" },
  class: { label: "Class", color: "#4a7c6f", tone: "neutral" },
  personal: { label: "Personal", color: "#8f5a16", tone: "neutral" },
  other: { label: "Event", color: "#8a8a80", tone: "neutral" },
};
const typeOf = (k: string) => TYPE[k] ?? TYPE.other;

const VIEWS = [
  { key: "month" as const, label: "Month" },
  { key: "week" as const, label: "Week" },
  { key: "agenda" as const, label: "Agenda" },
];

export function Calendar() {
  // ?focus=YYYY-MM-DD lands on the day a search hit falls on, rather than on
  // today with the student left to find it.
  const [params] = useSearchParams();
  const focus = params.get("focus");
  const focusDate = focus && !Number.isNaN(Date.parse(focus)) ? new Date(`${focus}T12:00:00`) : null;
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => startOfMonth(focusDate ?? new Date()));
  const [weekCursor, setWeekCursor] = useState(() => mondayOf(focusDate ?? new Date()));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showPersonal, setShowPersonal] = useState(true);
  const [selected, setSelected] = useState<string>(dayKey(focusDate ?? new Date()));
  const [loading, setLoading] = useState(true);

  async function load() {
    const [e, c] = await Promise.all([api.events(), api.courses()]);
    setEvents(e);
    setCourses(c);
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const courseCode = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "General";
  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          !(e.course_id && hidden.has(e.course_id)) && (showPersonal || e.kind !== "personal"),
      ),
    [events, hidden, showPersonal],
  );

  function toggleCourse(id: string) {
    setHidden((h) => {
      const n = new Set(h);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  const hasPersonal = events.some((e) => e.kind === "personal");

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Deadlines, classes, exams — and the rest of your life alongside them"
        actions={<Tabs tabs={VIEWS} value={view} onChange={setView} />}
      />

      {/* Course filters. No colour legend — every event is labelled where it
          matters (day panel, agenda, week grid), so a legend is decoration. */}
      {(courses.length > 1 || hasPersonal) && (
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
          {hasPersonal && (
            <button
              onClick={() => setShowPersonal((v) => !v)}
              aria-pressed={showPersonal}
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-medium transition duration-200 ${
                showPersonal ? "bg-second-tint text-second-deep" : "bg-chip/60 text-ink-muted/70 hover:bg-chip"
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-pill"
                style={{ background: showPersonal ? TYPE.personal!.color : "#c4c4bb" }}
              />
              Life
            </button>
          )}
        </div>
      )}

      {loading ? (
        <Loading />
      ) : events.length === 0 ? (
        <EmptyState icon="📅">No events yet — Sync Moodle, or import your timetable.</EmptyState>
      ) : view === "month" ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
          <MonthGrid events={shown} cursor={cursor} setCursor={setCursor} selected={selected} onSelect={setSelected} />
          <DayPanel dateKey={selected} events={shown} courseCode={courseCode} />
        </div>
      ) : view === "week" ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
          <WeekGrid events={shown} weekStart={weekCursor} setWeekStart={setWeekCursor} courseCode={courseCode} />
          <LifePanel onChange={load} />
        </div>
      ) : (
        <Agenda events={shown} courseCode={courseCode} />
      )}
    </div>
  );
}

/* --- Week view ------------------------------------------------------------ */

const DAY_START = 7; // 07:00
const DAY_END = 23; // 23:00
const PX_PER_HOUR = 44;

/**
 * A real week grid, because "which week is going to hurt" is a question you
 * answer by looking at a week — and it's the only view where classes, shifts
 * and deadlines sit in the same visual field.
 */
function WeekGrid({
  events,
  weekStart,
  setWeekStart,
  courseCode,
}: {
  events: CalEvent[];
  weekStart: Date;
  setWeekStart: (d: Date) => void;
  courseCode: (id: string | null) => string;
}) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = addDays(weekStart, 7);
  const inWeek = events.filter((e) => {
    const d = new Date(e.start_at);
    return d >= weekStart && d < weekEnd;
  });
  // Deadlines are moments, not blocks — they belong in a strip, not the grid.
  const timed = inWeek.filter((e) => e.kind === "class" || e.kind === "personal");
  const moments = inWeek.filter((e) => e.kind !== "class" && e.kind !== "personal");
  const todayKey = dayKey(new Date());
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-1 border-b border-hair px-4 py-3">
        <IconButton label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))}>
          <Chevron dir="left" />
        </IconButton>
        <div className="w-56 text-center font-display text-[15px] font-bold tracking-tight text-ink">
          {weekStart.toLocaleDateString([], { day: "numeric", month: "short" })} –{" "}
          {addDays(weekStart, 6).toLocaleDateString([], { day: "numeric", month: "short" })}
        </div>
        <IconButton label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))}>
          <Chevron dir="right" />
        </IconButton>
        <button
          className="ml-2 rounded-pill px-2.5 py-1 text-xs font-medium text-ink-muted transition duration-200 hover:bg-chip hover:text-ink"
          onClick={() => setWeekStart(mondayOf(new Date()))}
        >
          This week
        </button>
      </div>

      {/* Day headers */}
      <div className="grid border-b border-hair" style={{ gridTemplateColumns: "3rem repeat(7, 1fr)" }}>
        <div />
        {days.map((d) => {
          const isToday = dayKey(d) === todayKey;
          return (
            <div key={d.toISOString()} className="border-l border-hair py-2 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                {d.toLocaleDateString([], { weekday: "short" })}
              </div>
              <div
                className={`mx-auto mt-1 flex h-6 w-6 items-center justify-center rounded-pill text-xs tabular-nums ${
                  isToday ? "bg-pill font-semibold text-white" : "text-ink"
                }`}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Deadline strip */}
      {moments.length > 0 && (
        <div
          className="grid border-b border-hair bg-chip/30"
          style={{ gridTemplateColumns: "3rem repeat(7, 1fr)" }}
        >
          <div className="py-1.5 pr-1.5 text-right text-[9px] uppercase tracking-wide text-ink-muted">
            due
          </div>
          {days.map((d) => {
            const items = moments.filter((e) => dayKey(new Date(e.start_at)) === dayKey(d));
            return (
              <div key={d.toISOString()} className="min-h-[26px] space-y-0.5 border-l border-hair p-1">
                {items.map((e) => {
                  const t = typeOf(e.kind);
                  return (
                    <div
                      key={e.id}
                      title={`${e.title} · ${courseCode(e.course_id)}`}
                      className="truncate rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium leading-tight"
                      style={{ background: t.color + "1f", color: t.color }}
                    >
                      {e.title.replace(/^(Due|Opens): /, "")}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Time grid */}
      <div className="pane max-h-[620px]">
        <div className="relative grid" style={{ gridTemplateColumns: "3rem repeat(7, 1fr)" }}>
          {/* Hour gutter */}
          <div>
            {hours.map((h) => (
              <div
                key={h}
                className="relative border-b border-hair/70 pr-1.5 text-right"
                style={{ height: PX_PER_HOUR }}
              >
                <span className="absolute right-1.5 -top-1.5 text-[10px] tabular-nums text-ink-muted">
                  {String(h).padStart(2, "0")}
                </span>
              </div>
            ))}
          </div>

          {days.map((d) => (
            <div key={d.toISOString()} className="relative border-l border-hair">
              {hours.map((h) => (
                <div key={h} className="border-b border-hair/70" style={{ height: PX_PER_HOUR }} />
              ))}
              {timed
                .filter((e) => dayKey(new Date(e.start_at)) === dayKey(d))
                .map((e) => {
                  const start = new Date(e.start_at);
                  const end = e.end_at ? new Date(e.end_at) : new Date(start.getTime() + 3.6e6);
                  const top = (hoursOf(start) - DAY_START) * PX_PER_HOUR;
                  const height = Math.max(
                    18,
                    ((end.getTime() - start.getTime()) / 3.6e6) * PX_PER_HOUR - 2,
                  );
                  const isPersonal = e.kind === "personal";
                  const color = isPersonal ? TYPE.personal!.color : courseColor(e.course_id);
                  return (
                    <div
                      key={e.id}
                      title={`${e.title}${e.location ? ` · ${e.location}` : ""} · ${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                      className="absolute inset-x-0.5 overflow-hidden rounded-[5px] px-1.5 py-1"
                      style={{
                        top: Math.max(0, top),
                        height,
                        background: color + (isPersonal ? "1c" : "20"),
                        borderLeft: `2px solid ${color}`,
                      }}
                    >
                      <div className="truncate text-[10px] font-semibold leading-tight text-ink">
                        {e.title}
                      </div>
                      {height > 34 && (
                        <div className="truncate text-[9px] leading-tight text-ink-muted">
                          {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          {e.location ? ` · ${e.location}` : isPersonal ? "" : ` · ${courseCode(e.course_id)}`}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/* --- Life outside class --------------------------------------------------- */

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const KINDS = [
  { key: "work", label: "Work" },
  { key: "sport", label: "Sport" },
  { key: "social", label: "Social" },
  { key: "care", label: "Care" },
  { key: "travel", label: "Travel" },
  { key: "other", label: "Other" },
];

/**
 * The bit that makes the week honest. A timetable that ignores a 20-hour-a-week
 * job isn't a plan, and the workload heatmap is only useful if it counts these.
 */
function LifePanel({ onChange }: { onChange: () => Promise<void> }) {
  const [items, setItems] = useState<Commitment[]>([]);
  const [adding, setAdding] = useState(false);

  async function load() {
    setItems(await api.commitments());
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <Card className="h-fit p-5">
      <SectionTitle className="mb-1.5">Life outside class</SectionTitle>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        Shifts, training, family — anything that eats a real block of your week. It shows on the grid
        and counts towards your workload.
      </p>

      {items.length > 0 && (
        <div className="mb-4 divide-y divide-hair">
          {items.map((c) => (
            <div key={c.id} className="flex items-start gap-2 py-2.5">
              <span
                className="mt-1 h-6 w-1 shrink-0 rounded-pill"
                style={{ background: TYPE.personal!.color }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{c.title}</div>
                <div className="mt-0.5 text-xs text-ink-muted">{describe(c)}</div>
              </div>
              <button
                onClick={async () => {
                  await api.deleteCommitment(c.id);
                  await load();
                  await onChange();
                }}
                className="shrink-0 px-1 text-ink-muted transition duration-200 hover:text-rose-700"
                aria-label={`Remove ${c.title}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <AddCommitment
          onDone={async () => {
            setAdding(false);
            await load();
            await onChange();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          Add a commitment
        </Button>
      )}
    </Card>
  );
}

function AddCommitment({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("work");
  const [days, setDays] = useState<number[]>([]);
  const [time, setTime] = useState("17:00");
  const [hours, setHours] = useState("4");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.createCommitment({
        title,
        kind,
        weekdays: days.length ? days : null,
        start_time: time,
        hours: Number(hours) || 1,
      });
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-field bg-chip/60 p-3.5">
      <Input
        density="sm"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Café shift"
        aria-label="Commitment name"
      />
      <div className="flex gap-2">
        <Select density="sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <span className="mb-1.5 block text-[11px] font-medium text-ink-muted">Repeats on</span>
        <div className="flex gap-1">
          {WEEKDAY_LABELS.map((l, i) => {
            const on = days.includes(i);
            return (
              <button
                key={i}
                onClick={() => setDays((d) => (on ? d.filter((x) => x !== i) : [...d, i]))}
                aria-pressed={on}
                aria-label={`Day ${i}`}
                className={`h-7 w-7 rounded-pill text-[11px] font-medium transition duration-200 ${
                  on ? "bg-pill text-white" : "border border-hair bg-surface text-ink-muted hover:bg-chip"
                }`}
              >
                {l}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-medium text-ink-muted">Starts</span>
          <Input
            density="sm"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Start time"
          />
        </label>
        <label className="w-24">
          <span className="mb-1 block text-[11px] font-medium text-ink-muted">Hours</span>
          <Input
            density="sm"
            type="number"
            min={0.5}
            step={0.5}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            aria-label="Duration in hours"
          />
        </label>
      </div>
      {err && <p className="text-[13px] text-rose-700">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={save} disabled={busy || !title.trim() || !days.length}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <Details summary="Just a one-off?">
        One-off events can be added straight to whichever calendar you sync with — they'll flow back
        in through the feed. This panel is for the weekly pattern that shapes your semester.
      </Details>
    </div>
  );
}

function describe(c: Commitment): string {
  const kind = KINDS.find((k) => k.key === c.kind)?.label ?? "Other";
  if (c.start_at) {
    return `${kind} · ${new Date(c.start_at).toLocaleDateString([], { day: "numeric", month: "short" })}, ${c.hours}h`;
  }
  let daysList: number[] = [];
  try {
    daysList = c.weekdays ? JSON.parse(c.weekdays) : [];
  } catch {
    daysList = [];
  }
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayText = daysList.map((d) => names[d]).join(", ") || "—";
  return `${kind} · ${dayText} · ${c.start_time ?? ""} · ${c.hours}h`;
}

/* --- Month view ----------------------------------------------------------- */

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
                <span className="mt-0.5 w-1 shrink-0 rounded-pill" style={{ background: t.color }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug text-ink">
                    {e.title.replace(/^(Due|Opens): /, "")}
                  </div>
                  <div className="mt-1 text-xs text-ink-muted">
                    {t.label} · {e.kind === "personal" ? "you" : courseCode(e.course_id)} ·{" "}
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
      <p className="mt-5 border-t border-hair pt-4 text-[12px] leading-relaxed text-ink-muted">
        Subscribe any calendar app to <Chip>/api/calendar.ics</Chip> — set it up in Settings.
      </p>
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
                      {t.label} · {e.kind === "personal" ? "you" : courseCode(e.course_id)}
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
function addDays(d: Date, n: number) { const o = new Date(d); o.setDate(o.getDate() + n); return o; }
function mondayOf(d: Date) {
  const o = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  o.setDate(o.getDate() - ((o.getDay() + 6) % 7));
  return o;
}
function hoursOf(d: Date) { return d.getHours() + d.getMinutes() / 60; }
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

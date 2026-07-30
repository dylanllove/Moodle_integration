import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type WeekLoad, type Workload as WorkloadData } from "../api.js";
import { courseColor } from "../colors.js";
import { Card, PageHeader, Badge, Button, Segmented, SectionTitle, EmptyState, Loading, Notice } from "../ui.js";

/**
 * Sequential ramp for "hours of demand" — one hue (the sand/bronze family),
 * light→dark, so intensity reads as heat without borrowing the red that means
 * "something is wrong". Cells carry their number, so the pale steps never rely
 * on colour alone.
 */
const RAMP: Record<WeekLoad["verdict"], { fill: string; ink: string; label: string }> = {
  // Outside the ramp on purpose: this is an absence of data, not a low value.
  unknown: { fill: "transparent", ink: "text-ink-muted", label: "Not published yet" },
  quiet: { fill: "#fdf6ec", ink: "text-ink", label: "Quiet" },
  steady: { fill: "#f7dfb4", ink: "text-ink", label: "Steady" },
  busy: { fill: "#eec078", ink: "text-ink", label: "Busy" },
  heavy: { fill: "#d8913f", ink: "text-ink", label: "Heavy" },
  brutal: { fill: "#a4631c", ink: "text-white", label: "Brutal" },
};
const ORDER: WeekLoad["verdict"][] = ["quiet", "steady", "busy", "heavy", "brutal"];

/** Life outside class is one series among the courses, in a warm neutral. */
const LIFE_COLOR = "#8a8a80";

export function Workload() {
  const [data, setData] = useState<WorkloadData | null>(null);
  const [weeks, setWeeks] = useState(14);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .workload(weeks)
      .then((d) => {
        setData(d);
        setSelected((s) => s ?? d.weeks.find((w) => w.isCurrent)?.weekStart ?? d.weeks[0]?.weekStart ?? null);
      })
      .finally(() => setLoading(false));
  }, [weeks]);

  const selectedWeek = useMemo(
    () => data?.weeks.find((w) => w.weekStart === selected) ?? null,
    [data, selected],
  );
  const peak = useMemo(() => Math.max(1, ...(data?.weeks.map((w) => w.totalHours) ?? [1])), [data]);
  const courseOf = (id: string | null) =>
    data?.courses.find((c) => c.id === id)?.code ?? (id ? "Course" : "Life");

  return (
    <div>
      <PageHeader
        title="Workload"
        subtitle="Where the crunch weeks are, across every course and the rest of your life"
        actions={
          <div className="w-48">
            <Segmented
              options={[8, 14, 20]}
              value={weeks}
              onChange={setWeeks}
              format={(w) => `${w} weeks`}
            />
          </div>
        }
      />

      {loading && !data ? (
        <Loading label="Working out your semester…" />
      ) : !data || data.weeks.every((w) => w.totalHours === 0) ? (
        <EmptyState icon="📊">
          Nothing to weigh up yet. Sync Moodle for deadlines, import your timetable for classes, and{" "}
          <Link to="/calendar" className="font-medium text-accent-deep hover:underline">
            add your commitments
          </Link>{" "}
          so the picture includes life outside study.
        </EmptyState>
      ) : (
        <div className="space-y-5">
          {data.crunch.length > 0 && <Crunch weeks={data.crunch} onPick={setSelected} />}

          <Card className="p-6">
            <SectionTitle className="mb-1.5">Hours of demand per week</SectionTitle>
            <p className="mb-5 text-[13px] text-ink-muted">
              Estimated from what each deadline is worth, your timetabled hours and your own
              commitments. A typical week for you is <strong className="font-semibold text-ink">{data.baseline}h</strong> —
              weeks are called busy or heavy relative to that, not to some average student.
            </p>
            <HeatStrip weeks={data.weeks} selected={selected} onSelect={setSelected} />
            <Legend />
            {data.horizon && data.weeks.some((w) => w.verdict === "unknown") && (
              <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
                Your courses have only published deadlines up to{" "}
                {new Date(data.horizon).toLocaleDateString([], { day: "numeric", month: "long" })}.
                Later weeks are marked unknown rather than quiet — they'll fill in as staff add dates.
              </p>
            )}
          </Card>

          <Card className="p-6">
            <SectionTitle className="mb-1.5">What's making each week</SectionTitle>
            <p className="mb-5 text-[13px] text-ink-muted">
              Same weeks, split by where the hours come from.
            </p>
            <StackedWeeks
              weeks={data.weeks}
              peak={peak}
              courses={data.courses}
              selected={selected}
              onSelect={setSelected}
            />
            <CourseLegend courses={data.courses} />
          </Card>

          {selectedWeek && <WeekDetail week={selectedWeek} courseOf={courseOf} />}
        </div>
      )}
    </div>
  );
}

/** The one thing worth interrupting for: heavy weeks that haven't happened yet. */
function Crunch({ weeks, onPick }: { weeks: WeekLoad[]; onPick: (k: string) => void }) {
  const first = weeks[0]!;
  return (
    <Notice tone={weeks.some((w) => w.verdict === "brutal") ? "error" : "warn"}>
      <div className="font-medium">
        {weeks.length === 1
          ? `One heavy week ahead: ${first.weekLabel}.`
          : `${weeks.length} heavy weeks ahead — the first is ${first.weekLabel}.`}
      </div>
      <p className="mt-1.5">
        {first.drivers
          .slice(0, 3)
          .map((d) => d.title)
          .join(", ")}
        {first.drivers.length > 3 ? ` and ${first.drivers.length - 3} more` : ""} — about{" "}
        {first.totalHours}h of demand.{" "}
        <button className="font-medium underline" onClick={() => onPick(first.weekStart)}>
          See the week
        </button>
      </p>
    </Notice>
  );
}

function HeatStrip({
  weeks,
  selected,
  onSelect,
}: {
  weeks: WeekLoad[];
  selected: string | null;
  onSelect: (k: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      {/* 2px gaps let the surface separate adjacent cells. */}
      <div className="flex min-w-max gap-0.5">
        {weeks.map((w) => {
          const tone = RAMP[w.verdict];
          const isSel = w.weekStart === selected;
          const unknown = w.verdict === "unknown";
          return (
            <button
              key={w.weekStart}
              onClick={() => onSelect(w.weekStart)}
              title={
                unknown
                  ? `${w.weekLabel}: no deadlines published yet — ${w.classHours}h classes, ${w.personalHours}h personal so far`
                  : `${w.weekLabel}: ${w.totalHours}h — ${tone.label.toLowerCase()} (${w.deadlineHours}h assessment, ${w.classHours}h classes, ${w.personalHours}h personal)`
              }
              aria-pressed={isSel}
              className={`group relative w-[62px] shrink-0 rounded-[7px] px-1.5 py-2.5 text-center transition duration-200 ${
                isSel ? "ring-2 ring-accent-deep ring-offset-1" : "hover:brightness-[0.97]"
              } ${unknown ? "border border-dashed border-hair" : ""}`}
              style={{ background: tone.fill }}
            >
              <div className={`text-[15px] font-semibold tabular-nums leading-none ${tone.ink}`}>
                {unknown ? "·" : Math.round(w.totalHours)}
              </div>
              <div className={`mt-1 text-[10px] leading-tight ${tone.ink} opacity-70`}>
                {unknown ? "—" : "h"}
              </div>
              {w.isCurrent && (
                <span
                  className="absolute inset-x-2 -bottom-[3px] h-[3px] rounded-pill bg-pill"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 flex min-w-max gap-0.5">
        {weeks.map((w) => (
          <div key={w.weekStart} className="w-[62px] shrink-0 px-0.5 text-center">
            <div className={`text-[10px] leading-tight ${w.isCurrent ? "font-semibold text-ink" : "text-ink-muted"}`}>
              {w.teachingWeek ? `Wk ${w.teachingWeek}` : w.weekLabel.split(" – ")[0]}
            </div>
            <div className="text-[10px] leading-tight text-ink-muted/70">
              {w.weekLabel.split(" – ")[1]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair pt-4">
      {ORDER.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span
            className="h-3 w-3 rounded-[3px] ring-1 ring-inset ring-ink/10"
            style={{ background: RAMP[k].fill }}
            aria-hidden="true"
          />
          {RAMP[k].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
        <span
          className="h-3 w-3 rounded-[3px] border border-dashed border-hair"
          aria-hidden="true"
        />
        Not published yet
      </span>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
        <span className="h-[3px] w-4 rounded-pill bg-pill" aria-hidden="true" />
        This week
      </span>
    </div>
  );
}

/** Stacked composition: which course (or life) each week's hours belong to. */
function StackedWeeks({
  weeks,
  peak,
  courses,
  selected,
  onSelect,
}: {
  weeks: WeekLoad[];
  peak: number;
  courses: { id: string; code: string | null }[];
  selected: string | null;
  onSelect: (k: string) => void;
}) {
  const H = 132;
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max items-end gap-0.5" style={{ height: H }}>
        {weeks.map((w) => {
          const segments = [
            ...courses
              .filter((c) => (w.byCourse[c.id] ?? 0) > 0)
              .map((c) => ({
                key: c.id,
                label: c.code ?? "Course",
                hours: w.byCourse[c.id]!,
                color: courseColor(c.id),
              })),
            ...(w.personalHours > 0
              ? [{ key: "life", label: "Life", hours: w.personalHours, color: LIFE_COLOR }]
              : []),
          ];
          const unassigned = Math.max(
            0,
            w.totalHours - segments.reduce((s, x) => s + x.hours, 0),
          );
          if (unassigned > 0.5) {
            segments.push({ key: "other", label: "Unassigned", hours: unassigned, color: "#cfcbc2" });
          }
          const isSel = w.weekStart === selected;

          return (
            <button
              key={w.weekStart}
              onClick={() => onSelect(w.weekStart)}
              aria-pressed={isSel}
              title={`${w.weekLabel}: ${segments.map((s) => `${s.label} ${Math.round(s.hours)}h`).join(", ")}`}
              className={`flex w-[62px] shrink-0 flex-col justify-end gap-0.5 rounded-t-[4px] px-1 pb-0 transition duration-200 ${
                isSel ? "bg-accent-tint/60" : "hover:bg-chip/60"
              }`}
              style={{ height: H }}
            >
              {segments.map((s) => (
                <span
                  key={s.key}
                  className="block w-full rounded-[3px]"
                  style={{
                    background: s.color,
                    // Floor at 3px so a 1-hour segment is still visible.
                    height: Math.max(3, (s.hours / peak) * (H - 18)),
                  }}
                />
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CourseLegend({ courses }: { courses: { id: string; code: string | null }[] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair pt-4">
      {courses.map((c) => (
        <span key={c.id} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span
            className="h-3 w-3 rounded-[3px]"
            style={{ background: courseColor(c.id) }}
            aria-hidden="true"
          />
          {c.code ?? "Course"}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
        <span className="h-3 w-3 rounded-[3px]" style={{ background: LIFE_COLOR }} aria-hidden="true" />
        Life
      </span>
    </div>
  );
}

function WeekDetail({
  week,
  courseOf,
}: {
  week: WeekLoad;
  courseOf: (id: string | null) => string;
}) {
  const tone = RAMP[week.verdict];
  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-4"
        action={
          <span className="inline-flex items-center gap-2">
            <Badge tone={week.verdict === "brutal" || week.verdict === "heavy" ? "amber" : "neutral"}>
              {tone.label}
            </Badge>
            <span className="text-sm font-semibold tabular-nums text-ink">{week.totalHours}h</span>
          </span>
        }
      >
        {week.isCurrent ? "This week" : week.weekLabel}
        {week.teachingWeek ? ` · teaching week ${week.teachingWeek}` : ""}
      </SectionTitle>

      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Assessment" value={`${week.deadlineHours}h`} />
        <Stat label="Classes" value={`${week.classHours}h`} />
        <Stat label="Life" value={`${week.personalHours}h`} />
      </div>

      {week.drivers.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing due — just your usual classes and commitments.</p>
      ) : (
        <div className="divide-y divide-hair">
          {week.drivers.map((d, i) => (
            <div key={`${d.at}-${i}`} className="flex items-center gap-3 py-2.5">
              <span
                className="h-7 w-1 shrink-0 rounded-pill"
                style={{ background: d.course_id ? courseColor(d.course_id) : LIFE_COLOR }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{d.title}</div>
                <div className="mt-0.5 text-xs text-ink-muted">
                  {courseOf(d.course_id)} ·{" "}
                  {new Date(d.at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
                </div>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-ink-muted">~{d.hours}h</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-field bg-chip/70 px-3.5 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

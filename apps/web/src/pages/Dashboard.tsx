import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CalEvent, type Course, type Deck, type Lecture, type WeekLoad } from "../api.js";
import { useSyncedRefresh } from "../hooks.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  PanelFrame,
  Reveal,
  EmptyState,
  Loading,
  dueMeta,
} from "../ui.js";
import { courseColor } from "../colors.js";
import { TodayPlan } from "../TodayPlan.js";

/** How many deadlines the dashboard shows before deferring to the calendar. */
const DEADLINE_LIMIT = 5;
/** Must match the reviewer's own session size — see pages/Flashcards.tsx. */
const SESSION_SIZE = 60;

export function Dashboard() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [thisWeek, setThisWeek] = useState<WeekLoad | null>(null);
  const [crunch, setCrunch] = useState<WeekLoad | null>(null);
  const [cardsDue, setCardsDue] = useState(0);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const now = new Date();
    const to = new Date(now.getTime() + 60 * 864e5);
    Promise.all([
      api.events(now.toISOString(), to.toISOString()),
      api.courses(),
    ])
      .then(([e, c]) => {
        setEvents(e);
        setCourses(c);
      })
      .finally(() => setLoading(false));

    // Secondary, non-blocking: the week's shape and any cards waiting.
    api
      .workload(8)
      .then((w) => {
        setThisWeek(w.weeks.find((x) => x.isCurrent) ?? null);
        setCrunch(w.crunch.find((x) => !x.isCurrent) ?? null);
      })
      .catch(() => {});
    api
      .decks()
      .then((d) => {
        setDecks(d.decks);
        setCardsDue(d.decks.reduce((n, deck) => n + deck.due, 0));
      })
      .catch(() => {});
    api.lectures().then(setLectures).catch(() => {});
  }, []);

  useEffect(load, [load]);

  // The launch sync usually finishes after this page has drawn — fill in
  // rather than showing an empty dashboard until the student navigates away.
  useSyncedRefresh(load);

  const courseCode = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "General";
  const isToday = (iso: string) => {
    const d = new Date(iso);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  };

  const todaySchedule = events
    .filter((e) => e.kind === "class" && isToday(e.start_at))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));

  // Real deadlines only. "Opens" dates are calendar detail, not something to
  // act on today — they live on the Calendar page.
  const deadlines = events
    .filter((e) => e.kind === "deadline" || e.kind === "exam")
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const g = greeting();
  const dateLine = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const nextClass = todaySchedule.find((e) => new Date(e.start_at).getTime() >= Date.now());
  const shownDeadlines = deadlines.slice(0, DEADLINE_LIMIT);
  const hiddenCount = deadlines.length - shownDeadlines.length;

  return (
    <div>
      <PageHeader
        size="hero"
        title={
          <>
            {g.lead} <span className="swash">{g.accent}</span>
          </>
        }
        subtitle={
          <>
            {dateLine}.
            <br />
            {loading ? "Pulling your week together…" : dateOnlySummary(todaySchedule.length)}
          </>
        }
        actions={
          <a href="/api/export/all" download>
            <Button variant="primary">Download study pack</Button>
          </a>
        }
      />

      {loading && <Loading label="Loading your dashboard…" />}
      <div className={loading ? "hidden" : ""}>

      {/* First-run guidance when nothing's synced yet */}
      {!loading && courses.length === 0 && <GettingStarted />}

      {/* What to do today, before the numbers that explain why. */}
      {!loading && courses.length > 0 && <TodayPlan />}

      {/* The week at a glance — hours, what's due, what's waiting to be drilled. */}
      {!loading && courses.length > 0 && (
        <Reveal className="mb-8">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              to="/workload"
              label="This week"
              value={thisWeek ? `${Math.round(thisWeek.totalHours)}h` : "—"}
              detail={thisWeek ? VERDICT_TEXT[thisWeek.verdict] : "workload"}
            />
            <StatCard
              to="/calendar"
              label="Due in 7 days"
              value={String(
                deadlines.filter(
                  (e) => new Date(e.start_at).getTime() - Date.now() <= 7 * 864e5,
                ).length,
              )}
              detail="deadlines & exams"
            />
            <StatCard
              to={cardsDue > 0 ? "/flashcards?review=all" : "/flashcards"}
              label="Cards due"
              value={String(cardsDue)}
              // A backlog of hundreds is real, but the sitting it buys is not —
              // say what you're actually committing to by clicking.
              detail={
                cardsDue > SESSION_SIZE
                  ? `review ${SESSION_SIZE} now`
                  : cardsDue > 0
                    ? "start reviewing"
                    : "all clear"
              }
            />
          </div>
          {crunch && (
            <Card className="mt-3 bg-second-tint/50 p-4">
              <p className="text-sm text-ink">
                <strong className="font-semibold">Heads up:</strong> {crunch.weekLabel} looks{" "}
                {crunch.verdict} — {crunch.drivers.slice(0, 2).map((d) => d.title).join(" and ")}
                {crunch.drivers.length > 2 ? ` plus ${crunch.drivers.length - 2} more` : ""}.{" "}
                <Link to="/workload" className="font-medium text-accent-deep hover:underline">
                  See the semester →
                </Link>
              </p>
            </Card>
          )}
        </Reveal>
      )}

      {/* Today's timetable — framed as its own little surface */}
      <Reveal className="mb-8">
        <PanelFrame
          label="today · timetable"
          action={
            <Link to="/calendar" className="text-xs font-medium text-accent-deep hover:underline">
              Full calendar →
            </Link>
          }
        >
          {todaySchedule.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-muted">
              No classes scheduled today.
            </p>
          ) : (
            <div className="divide-y divide-hair">
              {todaySchedule.map((e) => {
                const isNext = nextClass?.id === e.id;
                return (
                  <div
                    key={e.id}
                    className={`flex items-center gap-4 px-5 py-3.5 ${isNext ? "bg-accent-tint/50" : ""}`}
                  >
                    <div className="w-24 shrink-0 text-sm font-medium tabular-nums text-ink">
                      {new Date(e.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {e.end_at && (
                        <span className="text-ink-muted">
                          {" – "}
                          {new Date(e.end_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                    <span className="h-8 w-1 rounded-pill" style={{ background: courseColor(e.course_id) }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{e.title}</div>
                      <div className="mt-0.5 text-xs text-ink-muted">
                        {courseCode(e.course_id)}
                        {e.location ? ` · ${e.location}` : ""}
                      </div>
                    </div>
                    {isNext && <Badge tone="accent">next up</Badge>}
                  </div>
                );
              })}
            </div>
          )}
        </PanelFrame>
      </Reveal>

      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Next deadlines
        </h2>
        {hiddenCount > 0 && (
          <Link to="/calendar" className="text-xs font-medium text-accent-deep hover:underline">
            {hiddenCount} more in calendar →
          </Link>
        )}
      </div>
      {shownDeadlines.length === 0 ? (
        <EmptyState icon="✅">Nothing due in the next 60 days.</EmptyState>
      ) : (
        <div className="space-y-2">
          {shownDeadlines.map((e) => {
            const meta = dueMeta(e.start_at);
            return (
              <Card key={e.id} hover className="flex items-center gap-4 p-4">
                <span className="h-9 w-1.5 shrink-0 rounded-pill" style={{ background: courseColor(e.course_id) }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{e.title}</div>
                  <div className="mt-0.5 text-xs text-ink-muted">
                    {courseCode(e.course_id)} ·{" "}
                    {new Date(e.start_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                  </div>
                </div>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </Card>
            );
          })}
        </div>
      )}

      <FreshMaterial lectures={lectures} decks={decks} courses={courses} />
      </div>
    </div>
  );
}

/** How far back counts as "new" material worth putting on the front page. */
const FRESH_DAYS = 10;
const FRESH_LIMIT = 4;

/**
 * What the app has made for you since you last looked.
 *
 * Transcripts, study notes and flashcard decks now appear on their own, for
 * every lecture and every slide deck — and none of it was visible from the
 * dashboard, so the most valuable thing the app does was also the thing you had
 * to go hunting for. Newest first, one click into the notes.
 */
function FreshMaterial({
  lectures,
  decks,
  courses,
}: {
  lectures: Lecture[];
  decks: Deck[];
  courses: Course[];
}) {
  const cutoff = Date.now() - FRESH_DAYS * 864e5;
  const fresh = lectures
    .filter((l) => l.has_text && l.transcript_at)
    .filter((l) => Date.parse(`${l.transcript_at}Z`) > cutoff)
    .sort((a, b) => (b.transcript_at ?? "").localeCompare(a.transcript_at ?? ""))
    .slice(0, FRESH_LIMIT);

  if (fresh.length === 0) return null;

  const codeOf = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "General";
  const deckFor = (lectureId: string) => decks.find((d) => d.lecture_id === lectureId) ?? null;

  return (
    <Reveal className="mt-8">
      <PanelFrame
        label="ready to study"
        action={
          <Link to="/lectures" className="text-xs font-medium text-accent-deep hover:underline">
            All lectures →
          </Link>
        }
      >
        <div className="divide-y divide-hair">
          {fresh.map((l) => {
            const deck = deckFor(l.id);
            return (
              <div key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span
                  className="h-8 w-1 shrink-0 rounded-pill"
                  style={{ background: courseColor(l.course_id) }}
                />
                <Link
                  to={`/lectures?lecture=${encodeURIComponent(l.id)}`}
                  className="min-w-0 flex-1 group"
                >
                  <div className="truncate text-sm font-medium text-ink group-hover:text-accent-deep">
                    {l.title}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-muted">
                    {codeOf(l.course_id)}
                    {l.has_notes ? " · study notes ready" : " · transcript ready"}
                  </div>
                </Link>
                {deck && deck.due > 0 && (
                  <Link to={`/flashcards?deck=${encodeURIComponent(deck.id)}`}>
                    <Badge tone="accent">{deck.due} cards due</Badge>
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      </PanelFrame>
    </Reveal>
  );
}

const VERDICT_TEXT: Record<WeekLoad["verdict"], string> = {
  unknown: "no deadlines published yet",
  quiet: "quiet — get ahead",
  steady: "steady going",
  busy: "busy",
  heavy: "heavy — start early",
  brutal: "brutal",
};

/** Three numbers that answer "how bad is it", each a door to the detail. */
function StatCard({
  to,
  label,
  value,
  detail,
}: {
  to: string;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Link to={to}>
      <Card hover className="p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
          {label}
        </div>
        <div className="mt-1.5 font-display text-[26px] font-bold leading-none tracking-tight text-ink">
          {value}
        </div>
        <div className="mt-1.5 text-[13px] text-ink-muted">{detail}</div>
      </Card>
    </Link>
  );
}

function greeting(): { lead: string; accent: string } {
  const h = new Date().getHours();
  const accent = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return { lead: "Good", accent };
}

/**
 * Just the shape of the day. What's *pressing* is the plan's job, immediately
 * below — saying it twice in two different phrasings reads as a bug.
 */
function dateOnlySummary(classes: number): string {
  if (classes === 0) return "No classes today.";
  return `${classes} class${classes > 1 ? "es" : ""} today.`;
}


/** Shown while there's nothing to show — points at the guided setup. */
function GettingStarted() {
  return (
    <Card className="mb-8 bg-accent-tint/40 p-6">
      <h2 className="mb-1 font-display text-xl font-bold tracking-tight text-ink">
        Nothing here yet
      </h2>
      <p className="mb-5 max-w-xl text-sm text-ink-muted">
        Connect your Moodle and this fills itself in — courses, deadlines, lecture transcripts. It
        takes about two minutes and it's mostly copy-and-paste.
      </p>
      <Link to="/setup"><Button variant="primary">Start setup</Button></Link>
    </Card>
  );
}

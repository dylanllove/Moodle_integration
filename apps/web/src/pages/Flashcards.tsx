import { useCallback, useEffect, useState } from "react";
import { api, type Course, type Deck, type Lecture, type ReviewCard } from "../api.js";
import { courseColor } from "../colors.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  Select,
  SectionTitle,
  Details,
  Notice,
  EmptyState,
  Loading,
} from "../ui.js";

export function Flashcards() {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<{ scope: string; label: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, c, l] = await Promise.all([api.decks(), api.courses(), api.lectures()]);
    setDecks(d.decks);
    setCourses(c);
    setLectures(l);
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const dueTotal = decks.reduce((s, d) => s + d.due, 0);
  const cardTotal = decks.reduce((s, d) => s + d.cards, 0);

  if (session) {
    return (
      <Review
        scope={session.scope}
        label={session.label}
        onDone={async () => {
          setSession(null);
          await load();
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Flashcards"
        subtitle="Made from your own lectures and slides, drilled on a spacing schedule"
        actions={
          dueTotal > 0 && (
            <Button
              variant="primary"
              onClick={() => setSession({ scope: "", label: `${dueTotal} cards due` })}
            >
              Review {dueTotal} due
            </Button>
          )
        }
      />

      {msg && <Notice className="mb-5">{msg}</Notice>}

      {loading ? (
        <Loading label="Shuffling…" />
      ) : (
        <div className="space-y-5">
          <Generate
            courses={courses}
            lectures={lectures}
            onMade={async (text) => {
              setMsg(text);
              await load();
            }}
          />

          {decks.length === 0 ? (
            <EmptyState icon="🃏">
              No decks yet. Lectures make their own deck as soon as they're transcribed — or generate
              one above from a course, a lecture or a slide deck.
            </EmptyState>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                  {decks.length} deck{decks.length === 1 ? "" : "s"} · {cardTotal} cards
                </h2>
                {dueTotal === 0 && (
                  <span className="text-[13px] text-ink-muted">
                    Nothing due right now — come back tomorrow.
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {decks.map((d) => (
                  <DeckRow
                    key={d.id}
                    deck={d}
                    courseCode={courses.find((c) => c.id === d.course_id)?.code ?? null}
                    onReview={() => setSession({ scope: `deck:${d.id}`, label: d.title })}
                    onChange={load}
                  />
                ))}
              </div>
            </>
          )}

          <QuizletHelp />
        </div>
      )}
    </div>
  );
}

function Generate({
  courses,
  lectures,
  onMade,
}: {
  courses: Course[];
  lectures: Lecture[];
  onMade: (msg: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<"course" | "lecture">("course");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);

  const options = kind === "course" ? courses : lectures.filter((l) => l.has_text);

  async function make() {
    if (!id) return;
    setBusy(true);
    try {
      const r = await api.generateDeck(kind, id);
      await onMade(`Made “${r.title}” — ${r.cards} cards.`);
      setId("");
    } catch (e) {
      await onMade(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <SectionTitle className="mb-1.5">Make a deck</SectionTitle>
      <p className="mb-4 text-[13px] text-ink-muted">
        One card per testable idea, written from your material — not from the internet.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Select
            density="sm"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as "course" | "lecture");
              setId("");
            }}
            aria-label="Deck source type"
          >
            <option value="course">Whole course</option>
            <option value="lecture">One lecture</option>
          </Select>
        </div>
        <div className="min-w-[220px] flex-1">
          <Select
            density="sm"
            value={id}
            onChange={(e) => setId(e.target.value)}
            aria-label="Source"
          >
            <option value="">
              {options.length ? "Choose…" : kind === "lecture" ? "No transcribed lectures yet" : "No courses yet"}
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {"code" in o ? (o.code ?? o.name) : o.title}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" onClick={make} disabled={busy || !id}>
          {busy ? "Writing cards…" : "Generate"}
        </Button>
      </div>
      <p className="mt-3 text-[13px] text-ink-muted">
        Course files make decks too — there's a <strong className="font-semibold">Flashcards</strong>{" "}
        button on each readable file under Course files.
      </p>
    </Card>
  );
}

function DeckRow({
  deck,
  courseCode,
  onReview,
  onChange,
}: {
  deck: Deck;
  courseCode: string | null;
  onReview: () => void;
  onChange: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  async function copyQuizlet() {
    try {
      const { text } = await api.quizletText(deck.id);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  }

  const progress = deck.cards > 0 ? Math.round((deck.mastered / deck.cards) * 100) : 0;

  return (
    <Card hover className="flex flex-wrap items-center gap-4 p-4">
      <span
        className="h-9 w-1.5 shrink-0 rounded-pill"
        style={{ background: courseColor(deck.course_id) }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{deck.title}</div>
        <div className="mt-0.5 text-xs text-ink-muted">
          {courseCode ? `${courseCode} · ` : ""}
          {deck.cards} cards
          {deck.mastered > 0 ? ` · ${progress}% learned` : ""}
          {deck.source !== "manual" ? ` · from ${deck.source}` : ""}
        </div>
      </div>
      {deck.due > 0 ? <Badge tone="amber">{deck.due} due</Badge> : <Badge tone="green">clear</Badge>}
      <span className="flex shrink-0 flex-wrap gap-1.5">
        <Button size="sm" variant={deck.due > 0 ? "primary" : "outline"} onClick={onReview}>
          Review
        </Button>
        <Button size="sm" variant="ghost" onClick={copyQuizlet}>
          {copied ? "Copied for Quizlet" : "Copy for Quizlet"}
        </Button>
        <a href={`/api/decks/${deck.id}/anki.csv`} download>
          <Button size="sm" variant="ghost">
            Anki CSV
          </Button>
        </a>
        <button
          onClick={async () => {
            await api.deleteDeck(deck.id);
            await onChange();
          }}
          className="px-1 text-ink-muted transition duration-200 hover:text-rose-700"
          aria-label={`Delete ${deck.title}`}
          title="Delete deck"
        >
          ×
        </button>
      </span>
    </Card>
  );
}

/**
 * The Quizlet story needs saying plainly: they withdrew the public write API, so
 * importing is the only route in, and pretending otherwise would just confuse.
 */
function QuizletHelp() {
  return (
    <Card className="p-6">
      <Details summary="Getting these into Quizlet or Anki">
        <p>
          <strong className="font-semibold text-ink">Quizlet:</strong> hit{" "}
          <em>Copy for Quizlet</em>, then in Quizlet go to{" "}
          <a
            href="https://quizlet.com/create-set"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-deep hover:underline"
          >
            Create a set → Import
          </a>{" "}
          and paste. Leave the separators on the defaults (<Chip>Tab</Chip> between term and
          definition, <Chip>New line</Chip> between cards) — that's the format it's copied in.
        </p>
        <p className="mt-2.5">
          Quizlet retired its public write API in 2021, so no app can create a set for you; import is
          the supported path. The reviewer here does spaced repetition anyway, which Quizlet's free
          tier doesn't.
        </p>
        <p className="mt-2.5">
          <strong className="font-semibold text-ink">Anki:</strong> download the CSV and use{" "}
          <em>File → Import</em> with the Basic note type — the two columns map to Front and Back.
        </p>
      </Details>
    </Card>
  );
}

/* --- Review session ------------------------------------------------------- */

function Review({
  scope,
  label,
  onDone,
}: {
  scope: string;
  label: string;
  onDone: () => Promise<void>;
}) {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tally, setTally] = useState({ got: 0, missed: 0 });

  useEffect(() => {
    const deckId = scope.startsWith("deck:") ? scope.slice(5) : undefined;
    api
      .reviewQueue({ deck_id: deckId, limit: 60 })
      .then((r) => setQueue(r.cards))
      .finally(() => setLoading(false));
  }, [scope]);

  const card = queue[index];

  const answer = useCallback(
    async (got: boolean) => {
      if (!card) return;
      setTally((t) => ({ got: t.got + (got ? 1 : 0), missed: t.missed + (got ? 0 : 1) }));
      setShown(false);
      setIndex((i) => i + 1);
      await api.review(card.id, got).catch(() => {});
    },
    [card],
  );

  // Keyboard-first: space flips, 1/2 grade. Drilling with a mouse is slow.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!card) return;
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault();
        if (!shown) setShown(true);
      } else if (shown && (e.key === "1" || e.key === "j")) {
        void answer(false);
      } else if (shown && (e.key === "2" || e.key === "k")) {
        void answer(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, shown, answer]);

  if (loading) return <Loading label="Dealing your cards…" />;

  if (!card) {
    const done = tally.got + tally.missed;
    return (
      <div className="mx-auto max-w-lg text-center">
        <PageHeader
          size="hero"
          title={done ? <>Session <span className="swash">done</span></> : "Nothing due"}
          subtitle={
            done
              ? `${tally.got} right, ${tally.missed} to come back to. The ones you missed return in a few minutes; the rest are scheduled further out.`
              : "Everything in this deck is scheduled for later. That's the system working."
          }
        />
        <Button variant="primary" onClick={onDone}>
          Back to decks
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {label}
          </div>
          <div className="mt-1 text-sm text-ink-muted">
            {index + 1} of {queue.length} · {card.deck_title}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onDone}>
          End session
        </Button>
      </div>

      {/* Progress: thin, recessive, no numbers repeated on it. */}
      <div className="mb-6 h-1 overflow-hidden rounded-pill bg-chip">
        <div
          className="h-full rounded-pill bg-accent transition-all duration-300"
          style={{ width: `${(index / Math.max(1, queue.length)) * 100}%` }}
        />
      </div>

      <Card className="p-8">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Question
        </div>
        <p className="mt-3 font-display text-[22px] font-bold leading-snug tracking-tight text-ink">
          {card.q}
        </p>

        {shown ? (
          <div className="mt-7 border-t border-hair pt-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
              Answer
            </div>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{card.a}</p>
            <div className="mt-7 flex gap-2">
              <Button className="flex-1" onClick={() => answer(false)}>
                Didn't know <span className="ml-1 text-ink-muted">(1)</span>
              </Button>
              <Button variant="primary" className="flex-1" onClick={() => answer(true)}>
                Got it <span className="ml-1 opacity-60">(2)</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <Button variant="primary" onClick={() => setShown(true)}>
              Show answer <span className="ml-1 opacity-60">(space)</span>
            </Button>
            <p className="mt-3 text-[13px] text-ink-muted">
              Try to answer out loud first — the effort is the point.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

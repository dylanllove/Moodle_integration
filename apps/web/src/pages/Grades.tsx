import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AssessmentGroup,
  type CourseGrades,
  type GradeBand,
  type ParsedOutlineItem,
  type ResolvedAssessment,
} from "../api.js";
import { courseColor } from "../colors.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Input,
  Select,
  Textarea,
  SectionTitle,
  Details,
  Notice,
  EmptyState,
  Loading,
} from "../ui.js";

export function Grades() {
  const [courses, setCourses] = useState<CourseGrades[]>([]);
  const [bands, setBands] = useState<GradeBand[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await api.grades();
    setCourses(r.courses);
    setBands(r.bands);
    setTargets(r.targets);
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  async function syncGradebook() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.gradesSync();
      setMsg(
        r.weighted > 0
          ? `Pulled ${r.items} items from ${r.courses} course${r.courses === 1 ? "" : "s"} — ${r.weighted} came with weightings.`
          : `Pulled ${r.items} items, but your gradebook doesn't publish weightings. Paste your course outline below and they'll be filled in for you.`,
      );
      await load();
    } catch (e) {
      setMsg(`Couldn't read the gradebook: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Grades"
        subtitle="What you've banked, and exactly what you need on what's left"
        actions={
          <Button variant="primary" onClick={syncGradebook} disabled={syncing}>
            {syncing ? "Reading gradebook…" : "Pull from Moodle"}
          </Button>
        }
      />

      {msg && (
        <Notice className="mb-5" tone={msg.startsWith("Couldn't") ? "warn" : "info"}>
          {msg}
        </Notice>
      )}

      {loading ? (
        <Loading label="Adding it all up…" />
      ) : courses.length === 0 ? (
        <EmptyState icon="🎯">No active courses yet — sync Moodle first.</EmptyState>
      ) : (
        <div className="space-y-6">
          {courses.map((c) => (
            <CourseCard
              key={c.course_id}
              course={c}
              bands={bands}
              target={targets[c.course_id] ?? ""}
              onChange={load}
            />
          ))}
          <BandsEditor bands={bands} onSaved={load} />
        </div>
      )}
    </div>
  );
}

function CourseCard({
  course,
  bands,
  target,
  onChange,
}: {
  course: CourseGrades;
  bands: GradeBand[];
  target: string;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const noWeights = course.weightTotal === 0;

  async function setTarget(letter: string) {
    setBusy(true);
    try {
      await api.setGradeTarget(course.course_id, letter || null);
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-hair px-6 py-4">
        <span
          className="h-8 w-1.5 shrink-0 rounded-pill"
          style={{ background: courseColor(course.course_id) }}
        />
        <div className="min-w-0 flex-1">
          <div className="font-display text-[17px] font-bold tracking-tight text-ink">
            {course.code ?? course.name}
          </div>
          <div className="truncate text-xs text-ink-muted">{course.name}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
            Aiming for
          </span>
          <div className="w-24">
            <Select
              density="sm"
              value={target}
              disabled={busy}
              onChange={(e) => setTarget(e.target.value)}
              aria-label={`Target grade for ${course.code ?? course.name}`}
            >
              <option value="">—</option>
              {bands.map((b) => (
                <option key={b.letter} value={b.letter}>
                  {b.letter}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      <div className="grid gap-6 px-6 py-5 lg:grid-cols-[1fr_19rem]">
        <div className="min-w-0">
          <WeightBar course={course} onChange={onChange} />
          {noWeights && <OutlineImporter course={course} onChange={onChange} defaultOpen />}
          <Schedule course={course} onChange={onChange} />
          {!noWeights && <OutlineImporter course={course} onChange={onChange} />}
        </div>

        <div className="space-y-4">
          <Standing course={course} />
          <TargetVerdict course={course} target={target} />
          <WhatIf course={course} bands={bands} />
          <NeededTable course={course} target={target} />
          <AssumeControl course={course} onChange={onChange} />
        </div>
      </div>
    </Card>
  );
}

/**
 * Live total. Weights not adding to 100 is the single most common reason the
 * numbers on this page look wrong, so it's stated at the top with the fix
 * attached rather than buried in a warning.
 */
function WeightBar({ course, onChange }: { course: CourseGrades; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const total = course.weightTotal;
  const off = total > 0 && Math.abs(total - 100) > 0.5;
  const pct = Math.min(100, (total / 100) * 100);

  async function normalise() {
    setBusy(true);
    try {
      await api.normaliseWeights(course.course_id);
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
          Weightings
        </span>
        <span className="flex items-center gap-2.5">
          <span
            className={`text-[13px] font-semibold tabular-nums ${
              off ? "text-amber-800" : total === 0 ? "text-ink-muted" : "text-ink"
            }`}
          >
            {total}% of 100
          </span>
          {off && (
            <button
              onClick={normalise}
              disabled={busy}
              className="text-[12px] font-medium text-accent-deep transition duration-200 hover:underline disabled:opacity-50"
            >
              {busy ? "Scaling…" : "Scale to 100"}
            </button>
          )}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-pill bg-chip">
        <div
          className="h-full rounded-pill transition-all duration-300"
          style={{ width: `${pct}%`, background: off ? "#d8913f" : "#7dd3fc" }}
        />
      </div>
      {off && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          {total < 100
            ? `${Math.round((100 - total) * 10) / 10}% unaccounted for — add the missing item, or scale what's here to 100.`
            : `${Math.round((total - 100) * 10) / 10}% over — check for a duplicate, or mark extra credit as bonus.`}
        </p>
      )}
      {course.bonusPoints > 0 && (
        <p className="mt-2 text-[12px] text-ink-muted">
          Plus {course.bonusPoints} bonus point{course.bonusPoints === 1 ? "" : "s"} on top.
        </p>
      )}
    </div>
  );
}

/* --- The schedule table --------------------------------------------------- */

function Schedule({ course, onChange }: { course: CourseGrades; onChange: () => Promise<void> }) {
  const [adding, setAdding] = useState<"item" | "group" | null>(null);

  // Grouped items are nested under their group; loose items keep their order.
  const loose = course.assessments.filter((a) => !a.group_id);
  // Numeric-aware, or "Lab 10" lands between "Lab 1" and "Lab 2".
  const membersOf = (gid: string) =>
    course.assessments
      .filter((a) => a.group_id === gid)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[580px] text-[13px]">
          <thead>
            <tr className="border-b border-hair text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
              <th className="pb-2 pr-3 font-semibold">Assessment</th>
              <th className="w-20 pb-2 pr-2 text-right font-semibold" title="Share of the overall course grade">
                Weight
              </th>
              <th className="w-24 pb-2 pr-2 font-semibold" title="Type it as it was marked, e.g. 89/100 or 90/120">
                Your mark
              </th>
              <th className="w-16 pb-2 pr-2 text-right font-semibold" title="Percent of that assessment you earned">
                Scored
              </th>
              <th className="w-14 pb-2 pr-2 text-center font-semibold" title="The item to solve for">
                Solve
              </th>
              <th className="w-8 pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-hair">
            {course.assessments.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-ink-muted">
                  Nothing here yet — paste your outline below, or add items by hand.
                </td>
              </tr>
            )}
            {course.groups.map((g) => (
              <GroupRows
                key={g.id}
                group={g}
                members={membersOf(g.id)}
                onChange={onChange}
              />
            ))}
            {loose.map((a) => (
              <AssessmentRow key={a.id} a={a} onChange={onChange} />
            ))}
          </tbody>
        </table>
      </div>

      {course.dropsProvisional && (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
          Which results get dropped isn't settled until everything's marked. Attempts you haven't sat
          are assumed to beat your worst, and the ones marked <em>spare</em> are just holding the
          slot count — it all sharpens as marks arrive.
        </p>
      )}

      {adding === "item" ? (
        <AddAssessment
          courseId={course.course_id}
          onDone={async () => {
            setAdding(null);
            await onChange();
          }}
          onCancel={() => setAdding(null)}
        />
      ) : adding === "group" ? (
        <AddGroup
          courseId={course.course_id}
          onDone={async () => {
            setAdding(null);
            await onChange();
          }}
          onCancel={() => setAdding(null)}
        />
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding("item")}>
            Add an assessment
          </Button>
          <Button size="sm" onClick={() => setAdding("group")}>
            Add a weighted group
          </Button>
        </div>
      )}
    </div>
  );
}

/** A group header row plus its members, collapsible to keep ten labs tidy. */
function GroupRows({
  group,
  members,
  onChange,
}: {
  group: AssessmentGroup;
  members: ResolvedAssessment[];
  onChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(members.length <= 4);
  const [busy, setBusy] = useState(false);

  async function patch(body: Parameters<typeof api.updateGroup>[1]) {
    setBusy(true);
    try {
      await api.updateGroup(group.id, body);
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  const marked = members.filter((m) => m.percent != null).length;

  return (
    <>
      <tr className={`bg-chip/40 ${busy ? "opacity-60" : ""}`}>
        <td className="py-2 pr-3">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 text-left font-medium text-ink"
            aria-expanded={open}
          >
            <span className={`text-[10px] text-ink-muted transition duration-200 ${open ? "rotate-90" : ""}`}>
              ▶
            </span>
            {group.name}
          </button>
          <div className="mt-0.5 pl-4 text-[11px] text-ink-muted">
            {group.items} item{group.items === 1 ? "" : "s"} · best {group.counting} count
            {group.perItemWeight > 0 ? ` · ${group.perItemWeight}% each` : ""} · {marked} marked
          </div>
        </td>
        <td className="py-2 pr-2">
          <Cell
            value={group.weight == null ? "" : String(group.weight)}
            placeholder="%"
            label={`Total weight for ${group.name}`}
            align="right"
            onCommit={(raw) => {
              const n = parseNumber(raw);
              if (n !== undefined) return patch({ weight: n });
            }}
          />
        </td>
        <td className="py-2 pr-2">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            drop
            <Cell
              value={String(group.drop_lowest)}
              label={`How many lowest results to drop from ${group.name}`}
              align="right"
              width="w-12"
              onCommit={(raw) => {
                const n = parseNumber(raw);
                if (n !== undefined) return patch({ drop_lowest: n ?? 0 });
              }}
            />
            worst
          </label>
        </td>
        <td className="py-2 pr-2 text-right text-[11px] tabular-nums text-ink-muted">
          {group.scored > 0 ? `${group.scored}/${group.items}` : "—"}
        </td>
        <td className="py-2 text-center">
          <button
            onClick={async () => {
              await api.addGroupItem(group.id);
              await onChange();
            }}
            className="text-[11px] font-medium text-accent-deep hover:underline"
            title="Add another item to this group"
          >
            + item
          </button>
        </td>
        <td className="py-2 text-right">
          <button
            onClick={async () => {
              await api.deleteGroup(group.id, true);
              await onChange();
            }}
            className="text-ink-muted transition duration-200 hover:text-rose-700"
            aria-label={`Delete the ${group.name} group`}
            title="Delete group and its items"
          >
            ×
          </button>
        </td>
      </tr>
      {open && members.map((m) => <AssessmentRow key={m.id} a={m} onChange={onChange} nested />)}
    </>
  );
}

function AssessmentRow({
  a,
  onChange,
  nested = false,
}: {
  a: ResolvedAssessment;
  onChange: () => Promise<void>;
  nested?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [extras, setExtras] = useState(false);

  async function patch(body: Parameters<typeof api.updateAssessment>[1]) {
    setSaving(true);
    try {
      await api.updateAssessment(a.id, body);
      await onChange();
    } finally {
      setSaving(false);
    }
  }

  /** One field, written the way marks are written: "89/100", "90/120", "72%". */
  async function commitMark(raw: string) {
    const mark = parseMark(raw, a.max_score ?? 100);
    if (!mark) return; // unparseable — Cell will snap back to the saved value
    await patch({ score: mark.score, max_score: mark.max });
  }

  return (
    <>
      <tr className={`${saving ? "opacity-60" : ""} ${a.dropped ? "opacity-50" : ""}`}>
        <td className={`py-2 pr-3 ${nested ? "pl-5" : ""}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`font-medium text-ink ${a.dropped && a.percent != null ? "line-through" : ""}`}>
              {a.title}
            </span>
            {a.is_bonus === 1 && <Badge tone="accent">bonus</Badge>}
            {/* An excluded item that isn't marked yet hasn't lost anything — its
                slot is just being held back so the group's weight adds up. */}
            {a.dropped && (
              <Badge>{a.percent == null ? "spare" : "dropped"}</Badge>
            )}
            {a.belowHurdle && <Badge tone="red">below {a.min_percent}%</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
            {a.due_at
              ? new Date(a.due_at).toLocaleDateString([], { day: "numeric", month: "short" })
              : "no date"}
            {a.group_id ? ` · ${a.effectiveWeight}% of grade` : ""}
            {a.min_percent != null && !a.belowHurdle ? ` · needs ${a.min_percent}%` : ""}
            <button
              onClick={() => setExtras((v) => !v)}
              className="text-accent-deep hover:underline"
              aria-expanded={extras}
            >
              {extras ? "less" : "more"}
            </button>
          </div>
        </td>
        <td className="py-2 pr-2">
          <Cell
            value={a.weight == null ? "" : String(a.weight)}
            placeholder={a.group_id ? "share" : "%"}
            label={`Weight for ${a.title}`}
            align="right"
            onCommit={(raw) => {
              const n = parseNumber(raw);
              if (n !== undefined) return patch({ weight: n });
            }}
          />
        </td>
        <td className="py-2 pr-2">
          <Cell
            value={formatMark(a.score, a.max_score)}
            placeholder="89/100"
            label={`Mark for ${a.title} — type 89/100, 90/120 or 72%`}
            onCommit={commitMark}
          />
        </td>
        <td className="py-2 pr-2 text-right">
          <span className={`text-[13px] font-semibold tabular-nums ${a.percent == null ? "text-ink-muted" : "text-ink"}`}>
            {a.percent == null ? "—" : `${a.percent}%`}
          </span>
        </td>
        <td className="py-2 pr-2 text-center">
          <input
            type="radio"
            name={`solve-${a.course_id}`}
            checked={a.is_final === 1}
            onChange={() => patch({ is_final: true })}
            aria-label={`Solve for ${a.title}`}
            title="Work out what I need on this one"
            className="h-4 w-4 accent-[#075985]"
          />
        </td>
        <td className="py-2 text-right">
          {a.source === "manual" && (
            <button
              onClick={async () => {
                await api.deleteAssessment(a.id);
                await onChange();
              }}
              className="text-ink-muted transition duration-200 hover:text-rose-700"
              aria-label={`Delete ${a.title}`}
              title="Delete"
            >
              ×
            </button>
          )}
        </td>
      </tr>
      {extras && (
        <tr className="bg-chip/30">
          <td colSpan={6} className={`px-0 py-2.5 ${nested ? "pl-5" : ""}`}>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-[11px] text-ink-muted">
                <span className="mb-1 block font-medium">Minimum required (hurdle)</span>
                <Cell
                  value={a.min_percent == null ? "" : String(a.min_percent)}
                  placeholder="none"
                  label={`Minimum percent required on ${a.title}`}
                  width="w-28"
                  onCommit={(raw) => {
                    const n = parseNumber(raw);
                    if (n !== undefined) return patch({ min_percent: n });
                  }}
                />
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={a.is_bonus === 1}
                  onChange={(e) => patch({ is_bonus: e.target.checked })}
                  className="h-4 w-4 accent-[#075985]"
                />
                Extra credit (adds on top of 100)
              </label>
              <label className="text-[11px] text-ink-muted">
                <span className="mb-1 block font-medium">Rename</span>
                <Cell
                  value={a.title}
                  label={`Rename ${a.title}`}
                  width="w-48"
                  onCommit={(raw) => (raw.trim() ? patch({ title: raw.trim() }) : undefined)}
                />
              </label>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* --- Bulk entry ----------------------------------------------------------- */

/**
 * Paste the assessment table out of a course outline. Typing weights cell by
 * cell is why this page sits empty, and every course hands the numbers over in a
 * table already — so read it, show what was understood, and let them fix it.
 */
function OutlineImporter({
  course,
  onChange,
  defaultOpen = false,
}: {
  course: CourseGrades;
  onChange: () => Promise<void>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedOutlineItem[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const total = useMemo(
    () => (parsed ?? []).filter((i) => !i.isBonus).reduce((s, i) => s + i.weight, 0),
    [parsed],
  );

  async function parse() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.parseOutline(text);
      setParsed(r.items);
      setSkipped(r.skipped);
      if (!r.items.length) {
        setMsg("Couldn't find any weightings in that. Each assessment needs to be on its own line with its percentage.");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(replace: boolean) {
    if (!parsed?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.importOutline(course.course_id, parsed, replace);
      setParsed(null);
      setText("");
      setOpen(false);
      setMsg(`Added ${r.created} assessment${r.created === 1 ? "" : "s"}${r.groups ? ` in ${r.groups} group${r.groups === 1 ? "" : "s"}` : ""}.`);
      await onChange();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-4">
        <button
          onClick={() => setOpen(true)}
          className="text-[13px] font-medium text-accent-deep transition duration-200 hover:underline"
        >
          Paste weightings from your course outline
        </button>
        {msg && <p className="mt-2 text-[13px] text-ink-muted">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-field border border-hair bg-chip/40 p-4">
      <SectionTitle className="mb-1.5">Paste your assessment schedule</SectionTitle>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">
        Copy the assessment table out of your course outline and paste it here — one item per line
        with its percentage. Bundles like <em>"Quizzes (best 8 of 10) 20%"</em> and hurdles like{" "}
        <em>"must achieve at least 40%"</em> are picked up too. Nothing is saved until you confirm.
      </p>
      <Textarea
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Assignment 1 — 15%\nQuizzes (best 8 of 10)  20%\nFinal exam: 50%"}
        aria-label="Assessment schedule text"
        className="font-mono text-[12px]"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={parse} disabled={busy || !text.trim()}>
          {busy ? "Reading…" : "Read it"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setParsed(null);
          }}
        >
          Cancel
        </Button>
      </div>

      {parsed && parsed.length > 0 && (
        <div className="mt-4 border-t border-hair pt-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
              Found {parsed.length}
            </span>
            <span
              className={`text-[12px] font-semibold tabular-nums ${
                Math.abs(total - 100) > 0.5 ? "text-amber-800" : "text-ink"
              }`}
            >
              adds to {Math.round(total * 10) / 10}%
            </span>
          </div>
          <div className="divide-y divide-hair">
            {parsed.map((item, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 py-1.5 text-[13px]">
                <span className="w-12 shrink-0 text-right font-semibold tabular-nums text-ink">
                  {item.weight}%
                </span>
                <input
                  value={item.title}
                  onChange={(e) =>
                    setParsed((p) =>
                      (p ?? []).map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                    )
                  }
                  className="min-w-0 flex-1 bg-transparent text-ink outline-none"
                  aria-label={`Name for item ${i + 1}`}
                />
                {item.group && (
                  <Badge>
                    {item.group.count} items
                    {item.group.dropLowest ? `, drop ${item.group.dropLowest}` : ""}
                  </Badge>
                )}
                {item.isFinal && <Badge tone="accent">solve for</Badge>}
                {item.isBonus && <Badge tone="accent">bonus</Badge>}
                {item.minPercent != null && <Badge tone="amber">hurdle {item.minPercent}%</Badge>}
                <button
                  onClick={() => setParsed((p) => (p ?? []).filter((_, j) => j !== i))}
                  className="px-1 text-ink-muted transition duration-200 hover:text-rose-700"
                  aria-label={`Remove ${item.title}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {skipped.length > 0 && (
            <Details summary={`${skipped.length} line${skipped.length === 1 ? "" : "s"} skipped`} className="mt-3">
              These looked like assessments but had no weighting I could read — add them by hand if
              they matter:
              <ul className="mt-1.5 space-y-0.5">
                {skipped.map((s, i) => (
                  <li key={i} className="font-mono text-[11px]">
                    {s}
                  </li>
                ))}
              </ul>
            </Details>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => save(true)} disabled={busy}>
              {busy ? "Saving…" : "Replace what's there"}
            </Button>
            <Button size="sm" onClick={() => save(false)} disabled={busy}>
              Add alongside
            </Button>
          </div>
          <p className="mt-2 text-[12px] text-ink-muted">
            Replacing keeps any marks you've already entered against items with the same name.
          </p>
        </div>
      )}

      {msg && <Notice className="mt-3">{msg}</Notice>}
    </div>
  );
}

/* --- Right-hand column ---------------------------------------------------- */

function Standing({ course }: { course: CourseGrades }) {
  return (
    <div className="rounded-field bg-chip/70 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
          Mark so far
        </span>
        {course.currentLetter && <Badge tone="accent">{course.currentLetter}</Badge>}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">
        {course.markSoFar == null ? "—" : `${course.markSoFar}%`}
      </div>
      <div className="mt-1 text-xs text-ink-muted">
        {course.gradedWeight > 0
          ? `across ${course.gradedWeight}% of the grade`
          : "nothing marked yet"}
      </div>
      <div className="mt-3 space-y-1 border-t border-hair pt-3 text-xs text-ink-muted">
        <Line label="Banked" value={`${course.earnedPoints} pts`} />
        <Line label="Still to earn" value={`${course.remainingWeight} pts`} />
        <Line label="Best possible" value={`${course.ceiling}%`} />
        {course.projected != null && (
          <Line
            label="On current form"
            value={`${course.projected}%${course.projectedLetter ? ` (${course.projectedLetter})` : ""}`}
          />
        )}
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span className="font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}

/** The headline answer, in words, for the grade the student said they want. */
function TargetVerdict({ course, target }: { course: CourseGrades; target: string }) {
  const band = course.bands.find((b) => b.letter === target);

  if (course.hurdlesMissed.length > 0) {
    const h = course.hurdlesMissed[0]!;
    return (
      <Notice tone="error">
        <strong>You're under a required minimum.</strong> {h.title} needs {h.required}% and you got{" "}
        {h.percent}%. Check what your course does about that — the grade maths below can't see it.
      </Notice>
    );
  }
  if (!band) {
    return (
      <Notice>
        Pick a target grade above and this will tell you exactly what it takes.
      </Notice>
    );
  }
  if (band.secured) {
    return (
      <Notice>
        <strong>{band.letter} is already safe</strong> — you'd get it even with zero on everything
        left.
      </Notice>
    );
  }
  if (band.impossible) {
    return (
      <Notice tone="error">
        <strong>{band.letter} is out of reach.</strong> Even full marks on what's left lands at{" "}
        {course.ceiling}%. Aim at the next band down and protect it.
      </Notice>
    );
  }
  if (band.neededOnFinal != null && course.final) {
    const hard = band.neededOnFinal > 85;
    return (
      <Notice tone={hard ? "warn" : "info"}>
        You need <strong>{band.neededOnFinal}%</strong> on {course.final.title} for a{" "}
        <strong>{band.letter}</strong>
        {course.final.weight ? ` (it's worth ${course.final.weight}%)` : ""}.
        {band.hurdleBinds
          ? ` The maths alone needs less, but this course requires ${course.final.minPercent}% on it regardless.`
          : hard
            ? " That's a big ask — plan accordingly."
            : ""}
      </Notice>
    );
  }
  if (band.neededAcrossRemaining != null) {
    return (
      <Notice>
        You need an average of <strong>{band.neededAcrossRemaining}%</strong> across everything left
        for a <strong>{band.letter}</strong>.
      </Notice>
    );
  }
  return null;
}

/**
 * The interactive bit. A table of thresholds answers "what do I need"; a slider
 * answers "so what happens if I get 62?", which is the question people actually
 * sit there asking.
 */
function WhatIf({ course, bands }: { course: CourseGrades; bands: GradeBand[] }) {
  const [score, setScore] = useState<number | null>(null);
  if (!course.final || course.final.weight <= 0) return null;

  const value = score ?? Math.round(course.markSoFar ?? 70);
  const fromOthers =
    course.assume == null ? 0 : (course.otherRemainingWeight * course.assume) / 100;
  const result =
    Math.round((course.earnedPoints + fromOthers + (course.final.weight * value) / 100) * 10) / 10;
  const letter = bands.find((b) => result >= b.min)?.letter ?? "—";
  const belowHurdle = course.final.minPercent != null && value < course.final.minPercent;

  return (
    <div className="rounded-field border border-hair p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
        What if
      </div>
      <p className="mt-1 text-[12px] leading-snug text-ink-muted">
        I get <strong className="font-semibold text-ink">{value}%</strong> on{" "}
        {truncate(course.final.title, 24)}
      </p>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => setScore(Number(e.target.value))}
        className="mt-2.5 w-full accent-[#075985]"
        aria-label={`Hypothetical score on ${course.final.title}`}
      />
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink-muted">I finish on</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold tabular-nums text-ink">{result}%</span>
          <Badge tone="accent">{letter}</Badge>
        </span>
      </div>
      {belowHurdle && (
        <p className="mt-2 text-[12px] leading-relaxed text-rose-700">
          Below the {course.final.minPercent}% this item requires, so the letter above may not stand.
        </p>
      )}
      {course.otherRemainingWeight > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          Assumes {course.assume ?? "—"}% on the other {course.otherRemainingWeight}% still
          outstanding.
        </p>
      )}
    </div>
  );
}

function NeededTable({ course, target }: { course: CourseGrades; target: string }) {
  const solving = course.final;
  const rows = course.bands.filter((b) => !b.impossible || b.letter === target);
  if (course.remainingWeight <= 0) {
    return (
      <div className="rounded-field border border-hair p-4 text-[13px] text-ink-muted">
        Everything's marked — final grade {course.earnedPoints}%
        {course.currentLetter ? ` (${course.currentLetter})` : ""}.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-field border border-hair">
      <div className="border-b border-hair bg-chip/60 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
        {solving ? `Needed on ${truncate(solving.title, 20)}` : "Needed on what's left"}
      </div>
      <table className="w-full text-[13px]">
        <tbody className="divide-y divide-hair">
          {rows.map((b) => {
            const value = solving ? b.neededOnFinal : b.neededAcrossRemaining;
            const isTarget = b.letter === target;
            return (
              <tr key={b.letter} className={isTarget ? "bg-accent-tint/50" : ""}>
                <td className="px-3.5 py-2 font-medium text-ink">{b.letter}</td>
                <td className="py-2 text-ink-muted">{b.min}%+</td>
                <td className="px-3.5 py-2 text-right">
                  {b.secured ? (
                    <span className="text-[12px] font-medium text-[#3f6b4a]">safe</span>
                  ) : b.impossible ? (
                    <span className="text-[12px] text-ink-muted">out of reach</span>
                  ) : value == null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span
                      className={`font-semibold tabular-nums ${
                        value > 100 ? "text-rose-700" : value > 85 ? "text-amber-800" : "text-ink"
                      }`}
                      title={b.hurdleBinds ? "Set by a required minimum, not the arithmetic" : undefined}
                    >
                      {value <= 0 ? "0" : value}%{b.hurdleBinds ? "*" : ""}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.some((b) => b.hurdleBinds) && (
        <p className="border-t border-hair px-3.5 py-2 text-[11px] leading-relaxed text-ink-muted">
          * set by the {course.final?.minPercent}% minimum this course requires, not the arithmetic.
        </p>
      )}
    </div>
  );
}

/**
 * "What do I need on the final" is nonsense if other unmarked coursework is
 * silently treated as a zero — so the assumption is visible and editable.
 */
function AssumeControl({ course, onChange }: { course: CourseGrades; onChange: () => Promise<void> }) {
  const [value, setValue] = useState(course.assume == null ? "" : String(course.assume));
  const [saving, setSaving] = useState(false);
  if (!course.final || course.otherRemainingWeight <= 0) return null;

  async function save() {
    setSaving(true);
    try {
      await api.setGradeAssume(course.course_id, value === "" ? null : Number(value));
      await onChange();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Details summary={`Assuming ${course.assume ?? "—"}% on the other ${course.otherRemainingWeight}%`}>
      There's still {course.otherRemainingWeight}% of the grade outstanding besides{" "}
      {truncate(course.final.title, 30)}. Every figure here assumes you score{" "}
      {course.assume ?? "your current average"} on it. Change that assumption:
      <div className="mt-3 flex gap-2">
        <Input
          density="sm"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="current average"
          aria-label="Assumed score on remaining coursework"
        />
        <Button size="sm" onClick={save} disabled={saving} className="shrink-0">
          {saving ? "Saving…" : "Apply"}
        </Button>
      </div>
    </Details>
  );
}

/* --- Adders --------------------------------------------------------------- */

function AddAssessment({
  courseId,
  onDone,
  onCancel,
}: {
  courseId: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [weight, setWeight] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.createAssessment({
        course_id: courseId,
        title,
        weight: weight === "" ? null : Number(weight),
      });
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-end gap-2 rounded-field bg-chip/60 p-3">
      <div className="min-w-[180px] flex-1">
        <Input
          density="sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Final exam"
          aria-label="Assessment name"
        />
      </div>
      <div className="w-24">
        <Input
          density="sm"
          inputMode="decimal"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          placeholder="weight %"
          aria-label="Weight percent"
        />
      </div>
      <Button size="sm" variant="primary" onClick={save} disabled={busy || !title.trim()}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** For "Labs: 20% total across 10, best 8 count". */
function AddGroup({
  courseId,
  onDone,
  onCancel,
}: {
  courseId: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [weight, setWeight] = useState("");
  const [count, setCount] = useState("10");
  const [drop, setDrop] = useState("0");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.createGroup({
        course_id: courseId,
        name,
        weight: weight === "" ? null : Number(weight),
        count: Number(count) || 0,
        drop_lowest: Number(drop) || 0,
      });
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-field bg-chip/60 p-3">
      <p className="mb-2.5 text-[12px] leading-relaxed text-ink-muted">
        One weight for a set of repeated items — labs, quizzes, tutorials. The weight is split between
        however many count, so you enter it once.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[140px] flex-1">
          <span className="mb-1 block text-[11px] font-medium text-ink-muted">Name</span>
          <Input
            density="sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Labs"
            aria-label="Group name"
          />
        </div>
        <div className="w-24">
          <span className="mb-1 block text-[11px] font-medium text-ink-muted">Total %</span>
          <Input
            density="sm"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="20"
            aria-label="Total weight for the group"
          />
        </div>
        <div className="w-20">
          <span className="mb-1 block text-[11px] font-medium text-ink-muted">How many</span>
          <Input
            density="sm"
            inputMode="decimal"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            aria-label="Number of items"
          />
        </div>
        <div className="w-20">
          <span className="mb-1 block text-[11px] font-medium text-ink-muted">Drop worst</span>
          <Input
            density="sm"
            inputMode="decimal"
            value={drop}
            onChange={(e) => setDrop(e.target.value)}
            aria-label="How many lowest results to drop"
          />
        </div>
        <Button size="sm" variant="primary" onClick={save} disabled={busy || !name.trim()}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Grade boundaries differ by institution, so they're editable rather than baked in. */
function BandsEditor({ bands, onSaved }: { bands: GradeBand[]; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<GradeBand[]>(() => bands.map((b) => ({ ...b })));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => setDraft(bands.map((b) => ({ ...b }))), [bands]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const clean = draft
        .map((b) => ({ letter: b.letter.trim(), min: Number(b.min) }))
        .filter((b) => b.letter && Number.isFinite(b.min));
      await api.setGradeBands(clean);
      setMsg("Saved — every calculation on this page now uses these.");
      await onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<GradeBand>) =>
    setDraft((d) => d.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <Card className="p-6">
      <Details summary="My university uses different grade boundaries">
        The defaults are the NZ standard scale. Set the minimum percentage for each letter — the
        calculator solves against whatever's here.
        <div className="mt-4 flex flex-wrap gap-2">
          {draft.map((b, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-pill bg-chip py-1 pl-2 pr-1">
              <input
                value={b.letter}
                onChange={(e) => update(i, { letter: e.target.value })}
                className="w-9 bg-transparent text-[12px] font-semibold text-ink outline-none"
                aria-label={`Grade letter ${i + 1}`}
              />
              <input
                inputMode="decimal"
                value={b.min}
                onChange={(e) => update(i, { min: Number(e.target.value) })}
                className="w-12 bg-transparent text-[12px] tabular-nums text-ink-muted outline-none"
                aria-label={`Minimum percent for ${b.letter}`}
              />
              <button
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="px-1 text-ink-muted transition duration-200 hover:text-rose-700"
                aria-label={`Remove ${b.letter}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDraft((d) => [...d, { letter: "", min: 0 }])}>
            Add a band
          </Button>
          <Button size="sm" variant="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save boundaries"}
          </Button>
        </div>
        {msg && <p className="mt-3 text-[13px] text-ink">{msg}</p>}
      </Details>
    </Card>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* --- Editable cells ------------------------------------------------------- */

/**
 * A numeric cell that behaves.
 *
 * Deliberately NOT `type="number"`: a focused number input changes its value
 * when you scroll the page, which silently corrupts marks and weightings (it's
 * how a "/100" became "/106"). It also blocks typing "89/100" outright.
 *
 * The draft re-syncs whenever the saved value changes, so a reload can't leave
 * a stale number sitting in the box waiting to be written back.
 */
function Cell({
  value,
  onCommit,
  placeholder,
  label,
  align = "left",
  width,
}: {
  value: string;
  onCommit: (raw: string) => void | Promise<void>;
  placeholder?: string;
  label: string;
  align?: "left" | "right";
  width?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <span className={width ? `block ${width}` : "block"}>
      <Input
        density="sm"
        inputMode="decimal"
        autoComplete="off"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        className={align === "right" ? "text-right tabular-nums" : "tabular-nums"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== value.trim()) void onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}

/** Parse a weight/percentage cell. Blank means "not set", never zero. */
function parseNumber(raw: string): number | null | undefined {
  const s = raw.trim().replace(/%$/, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined; // undefined = reject, keep old value
}

export interface Mark {
  score: number | null;
  max: number;
}

/**
 * Read a mark the way it's actually written on a paper: "89/100", "90/120",
 * "4/5", "72%", or a bare number against the existing denominator. Returns
 * undefined for anything unparseable so the old value survives.
 */
export function parseMark(raw: string, currentMax: number): Mark | undefined {
  const s = raw.trim();
  if (s === "" || s === "—" || s === "/") return { score: null, max: currentMax };

  const fraction = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const score = Number(fraction[1]);
    const max = Number(fraction[2]);
    if (Number.isFinite(score) && Number.isFinite(max) && max > 0) return { score, max };
    return undefined;
  }

  const percent = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (percent) return { score: Number(percent[1]), max: 100 };

  const bare = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return { score: Number(bare[1]), max: currentMax };

  return undefined;
}

/** How a saved mark is shown back: always "score/max", so it's unambiguous. */
export function formatMark(score: number | null, max: number | null): string {
  if (score == null) return "";
  return `${trimNum(score)}/${trimNum(max ?? 100)}`;
}

const trimNum = (n: number) => String(Math.round(n * 100) / 100);

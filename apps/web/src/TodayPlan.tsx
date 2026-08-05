import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ActionKind, type CourseReadiness, type PlanAction, type StudyPlan } from "./api.js";
import { Card } from "./ui.js";
import { useSyncedRefresh } from "./hooks.js";
import { courseColor } from "./colors.js";

/**
 * Today, with an opinion.
 *
 * The rest of the dashboard reports: hours, counts, lists. This is the only part
 * that says *do this first, and here's why* — which is the whole difference
 * between a dashboard you check and an assistant you follow. Every reason on
 * screen comes from a number in your own data, so it can be argued with.
 */
const KIND_ICON: Record<ActionKind, string> = {
  deadline: "⏳",
  "exam-prep": "📝",
  review: "🃏",
  "study-lecture": "🎧",
  "setup-gap": "🔧",
};

const VERDICT_TONE: Record<CourseReadiness["verdict"], string> = {
  "not started": "text-rose-700",
  behind: "text-rose-700",
  "getting there": "text-amber-800",
  "on top of it": "text-[#3f6b4a]",
  "nothing due": "text-ink-muted",
};

export function TodayPlan() {
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api.plan().then(setPlan).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useSyncedRefresh(load);

  async function toggle(action: PlanAction) {
    setBusy(action.key);
    try {
      setPlan(await api.planDone(action.key, !action.done));
    } catch {
      /* leave it as it was — a failed tick shouldn't look like a successful one */
    } finally {
      setBusy(null);
    }
  }

  if (!plan) return null;
  const outstanding = plan.actions.filter((a) => !a.done);
  const finished = plan.actions.filter((a) => a.done);

  return (
    <Card className="mb-8 overflow-hidden">
      <div className="border-b border-hair px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="font-display text-[19px] font-bold leading-snug tracking-tight text-ink">
            {plan.headline}
          </h2>
          <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">
            {outstanding.length > 0 && <>{formatMinutes(plan.minutes)} of study</>}
            {plan.committedHours > 0 && (
              <> · {plan.committedHours}h of class today</>
            )}
          </span>
        </div>
      </div>

      {outstanding.length === 0 && finished.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-muted">
          Nothing to suggest yet — sync a course and this fills in.
        </p>
      ) : (
        <div className="divide-y divide-hair">
          {[...outstanding, ...finished].map((action) => (
            <ActionRow
              key={action.key}
              action={action}
              busy={busy === action.key}
              onToggle={() => toggle(action)}
              onOpen={() => navigate(action.to)}
            />
          ))}
        </div>
      )}

      {plan.readiness.length > 0 && <Readiness rows={plan.readiness} />}
    </Card>
  );
}

function ActionRow({
  action,
  busy,
  onToggle,
  onOpen,
}: {
  action: PlanAction;
  busy: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className={`flex items-start gap-3 px-5 py-3.5 ${action.done ? "opacity-45" : ""}`}>
      {/* Ticking off is separate from going there — you often do the thing
          elsewhere (in Moodle, on paper) and just want it off the list. */}
      <button
        onClick={onToggle}
        disabled={busy}
        aria-label={action.done ? `Mark "${action.title}" not done` : `Mark "${action.title}" done`}
        aria-pressed={action.done}
        className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition duration-200 ${
          action.done
            ? "border-accent-deep bg-accent-deep text-white"
            : "border-hair bg-surface hover:border-accent-deep"
        }`}
      >
        {action.done && (
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3.5">
            <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <span className="mt-px shrink-0 text-sm" aria-hidden="true">
        {KIND_ICON[action.kind]}
      </span>

      <button onClick={onOpen} className="min-w-0 flex-1 text-left group">
        <div
          className={`text-sm font-medium text-ink group-hover:text-accent-deep ${
            action.done ? "line-through" : ""
          }`}
        >
          {action.title}
        </div>
        <div className="mt-0.5 text-xs leading-snug text-ink-muted">
          {action.courseCode && (
            <>
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-pill align-middle"
                style={{ background: courseColor(action.courseId) }}
              />
              {action.courseCode} ·{" "}
            </>
          )}
          {action.why}
        </div>
      </button>

      <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
        {action.minutes}m
      </span>
    </div>
  );
}

/**
 * Where each course actually stands. "Seen" and "retained" are different numbers
 * and conflating them is how you walk into a test feeling prepared — meeting a
 * card once is not knowing it.
 */
function Readiness({ rows }: { rows: CourseReadiness[] }) {
  return (
    <div className="border-t border-hair bg-chip/40 px-5 py-3.5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted/70">
        where you stand
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.courseId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span
              className="h-2 w-2 shrink-0 rounded-pill"
              style={{ background: courseColor(r.courseId) }}
            />
            <span className="w-32 shrink-0 truncate font-medium text-ink">{r.courseCode}</span>
            {/* Retention as a bar, because a proportion is easier seen than read. */}
            <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-pill bg-hair">
              <span
                className="block h-full rounded-pill bg-accent"
                style={{ width: `${Math.round(r.strong * 100)}%` }}
              />
            </span>
            <span className={`w-24 shrink-0 font-medium ${VERDICT_TONE[r.verdict]}`}>
              {r.verdict}
            </span>
            <span className="text-ink-muted">
              {r.cards === 0
                ? "no cards yet"
                : `${Math.round(r.strong * 100)}% retained of ${r.cards}`}
              {r.daysToNext != null && ` · next in ${r.daysToNext}d`}
              {!r.weightsKnown && " · no weightings yet"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

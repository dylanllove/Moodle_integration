import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Course } from "../api.js";
import { Card, PageHeader, Button, Badge, Chip, Details, Notice, EmptyState, Loading } from "../ui.js";
import { courseColor } from "../colors.js";

/**
 * Which courses this app is allowed to touch.
 *
 * A Moodle account isn't a list of courses — it's a list of enrolments, and most
 * of them aren't teaching anything: notice boards, cohort groups, the library's
 * induction, last year's papers. Downloading a semester of files and transcribing
 * hours of audio for those is wasted disk, wasted money and a diluted search
 * index, so this page is where you say what's worth it.
 *
 * Three separate questions, deliberately not collapsed into one switch:
 *   Am I taking this?      → active
 *   Do I want its files?   → course files
 *   Do I want its lectures transcribed? → lectures
 * A paper can matter for its deadlines while its recordings are of no interest.
 */
export function Courses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [removed, setRemoved] = useState<{ id: string; code: string | null; name: string }[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  const load = useCallback(async (all: boolean) => {
    const [list, gone] = await Promise.all([
      api.courses(all),
      api.excludedCourses().catch(() => []),
    ]);
    setCourses(list);
    setRemoved(gone);
    setLoading(false);
  }, []);

  useEffect(() => {
    load(showAll);
  }, [showAll, load]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: "info", text: ok });
      await load(showAll);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function makeCheatSheet(c: Course) {
    setBusy(c.id);
    setMsg(null);
    try {
      await api.cheatsheet(c.id);
      nav("/notes");
    } catch (e) {
      setMsg({ tone: "error", text: `Couldn't build a cheat sheet for ${c.code} — ${e}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Courses"
        subtitle={
          showAll
            ? "Every enrolment. Turn off what you don't want downloaded, and remove what isn't a course at all."
            : "Your active courses this semester"
        }
        actions={
          <>
            <Button onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Active only" : "Manage all"}
            </Button>
            <a href="/api/export/all" download>
              <Button variant="primary">Download study pack</Button>
            </a>
          </>
        }
      />

      {msg && (
        <Notice tone={msg.tone === "error" ? "error" : "info"} className="mb-5">
          {msg.text}
        </Notice>
      )}

      {loading ? (
        <Loading />
      ) : courses.length === 0 ? (
        <EmptyState icon="📚">No courses yet — hit Sync everything.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {courses.map((c) => (
            <CourseCard
              key={c.id}
              course={c}
              showAll={showAll}
              busy={busy === c.id}
              confirming={confirming === c.id}
              onConfirm={() => setConfirming(confirming === c.id ? null : c.id)}
              onCheatSheet={() => makeCheatSheet(c)}
              onToggleActive={() =>
                run(c.id, () => api.setCourseActive(c.id, !c.active))
              }
              onToggleSync={(what, on) =>
                run(c.id, () => api.setCourseSync(c.id, { [what]: on }))
              }
              onDelete={() =>
                run(
                  c.id,
                  async () => {
                    const r = await api.deleteCourse(c.id);
                    setConfirming(null);
                    return r;
                  },
                  `Removed ${c.code ?? c.name}. It won't come back on the next sync — undo it below.`,
                )
              }
            />
          ))}
        </div>
      )}

      {removed.length > 0 && (
        <Details summary={`${removed.length} removed enrolment${removed.length === 1 ? "" : "s"}`} className="mt-6">
          <div className="space-y-1.5 pt-1">
            {removed.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-ink-muted">{r.code ?? r.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === r.id}
                  onClick={() =>
                    run(r.id, () => api.restoreCourse(r.id), `${r.code ?? r.name} is back.`)
                  }
                >
                  Put back
                </Button>
              </div>
            ))}
          </div>
        </Details>
      )}
    </div>
  );
}

function CourseCard({
  course: c,
  showAll,
  busy,
  confirming,
  onConfirm,
  onCheatSheet,
  onToggleActive,
  onToggleSync,
  onDelete,
}: {
  course: Course;
  showAll: boolean;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCheatSheet: () => void;
  onToggleActive: () => void;
  onToggleSync: (what: "materials" | "lectures", on: boolean) => void;
  onDelete: () => void;
}) {
  const files = c.files ?? 0;
  const lectures = c.lectures ?? 0;
  const cards = c.cards ?? 0;
  const mb = Math.round((c.bytes ?? 0) / 1048576);
  const empty = files === 0 && lectures === 0 && cards === 0;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3.5">
        <span
          className="mt-1 h-10 w-1.5 shrink-0 rounded-pill"
          style={{ background: courseColor(c.id) }}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Chip>{c.code}</Chip>
            {c.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}
          </div>
          <div
            className="truncate font-display text-[17px] font-bold leading-snug tracking-tight text-ink"
            title={c.name}
          >
            {c.name}
          </div>

          {/* What it's costing — the reason to keep or drop it. */}
          <p className="mt-1.5 text-[12px] text-ink-muted">
            {empty ? (
              "Nothing downloaded"
            ) : (
              <>
                {files > 0 && `${files} file${files === 1 ? "" : "s"}${mb > 0 ? ` · ${mb}MB` : ""}`}
                {files > 0 && (lectures > 0 || cards > 0) && " · "}
                {lectures > 0 &&
                  `${lectures} lecture${lectures === 1 ? "" : "s"}${
                    (c.transcribed ?? 0) > 0 ? ` (${c.transcribed} transcribed)` : ""
                  }`}
                {lectures > 0 && cards > 0 && " · "}
                {cards > 0 && `${cards} cards`}
              </>
            )}
          </p>

          {showAll && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-hair pt-3">
              <Toggle
                on={c.sync_materials !== 0}
                disabled={busy}
                label="Course files"
                onChange={(on) => onToggleSync("materials", on)}
              />
              <Toggle
                on={c.sync_lectures !== 0}
                disabled={busy}
                label="Lectures & transcripts"
                onChange={(on) => onToggleSync("lectures", on)}
              />
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={onCheatSheet}>
              {busy ? "Working…" : "Cheat sheet"}
            </Button>
            <a href={`/api/export/course/${encodeURIComponent(c.id)}`} download>
              <Button size="sm">Download pack</Button>
            </a>
            {showAll && (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onToggleActive}>
                  {c.active ? "Set inactive" : "Set active"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onConfirm}>
                  {confirming ? "Cancel" : "Remove"}
                </Button>
              </>
            )}
            {c.url && (
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-ink-muted transition duration-200 hover:text-accent-deep"
              >
                Moodle ↗
              </a>
            )}
          </div>

          {/* Say what disappears before it disappears. */}
          {confirming && (
            <div className="mt-3 rounded-field border border-rose-200 bg-rose-50 p-3">
              <p className="text-[13px] leading-relaxed text-rose-900">
                Remove <strong className="font-semibold">{c.code ?? c.name}</strong>?{" "}
                {empty
                  ? "Nothing has been downloaded for it, so there's nothing to lose."
                  : `This deletes ${[
                      files > 0 && `${files} downloaded file${files === 1 ? "" : "s"}${mb > 0 ? ` (${mb}MB)` : ""}`,
                      lectures > 0 && `${lectures} lecture${lectures === 1 ? "" : "s"} and their transcripts`,
                      cards > 0 && `${cards} flashcards`,
                    ]
                      .filter(Boolean)
                      .join(", ")} from your disk.`}{" "}
                It won't be downloaded again, and you can put it back afterwards.
              </p>
              <div className="mt-2.5">
                <Button size="sm" variant="dark" disabled={busy} onClick={onDelete}>
                  {busy ? "Removing…" : "Remove it"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#075985]"
      />
      {label}
    </label>
  );
}

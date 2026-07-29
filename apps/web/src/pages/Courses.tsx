import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Course } from "../api.js";
import { Card, PageHeader, Button, Badge, Chip, Notice, EmptyState, Loading } from "../ui.js";
import { courseColor } from "../colors.js";

export function Courses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  async function load(all: boolean) {
    setCourses(await api.courses(all));
    setLoading(false);
  }
  useEffect(() => {
    load(showAll);
  }, [showAll]);

  async function toggle(c: Course) {
    await api.setCourseActive(c.id, !c.active);
    await load(showAll);
  }

  async function makeCheatSheet(c: Course) {
    setBusy(c.id);
    setErr(null);
    try {
      await api.cheatsheet(c.id);
      nav("/notes");
    } catch (e) {
      setErr(`Couldn't build a cheat sheet for ${c.code} — ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Courses"
        subtitle={showAll ? "All enrolments — toggle which are active" : "Your active courses this semester"}
        actions={
          <>
            <Button onClick={() => setShowAll((s) => !s)}>{showAll ? "Active only" : "Manage all"}</Button>
            <a href="/api/export/all" download>
              <Button variant="primary">Download study pack</Button>
            </a>
          </>
        }
      />

      {err && <Notice tone="error" className="mb-5">{err}</Notice>}

      {loading ? (
        <Loading />
      ) : courses.length === 0 ? (
        <EmptyState icon="📚">No courses yet — hit Sync Moodle.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {courses.map((c) => (
            <Card key={c.id} hover className="p-5">
              <div className="flex items-start gap-3.5">
                <span
                  className="mt-1 h-10 w-1.5 shrink-0 rounded-pill"
                  style={{ background: courseColor(c.id) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <Chip>{c.code}</Chip>
                    {c.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}
                  </div>
                  <div
                    className="truncate font-display text-[17px] font-bold leading-snug tracking-tight text-ink"
                    title={c.name}
                  >
                    {c.name}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" disabled={busy === c.id} onClick={() => makeCheatSheet(c)}>
                      {busy === c.id ? "Generating…" : "Cheat sheet"}
                    </Button>
                    <a href={`/api/export/course/${encodeURIComponent(c.id)}`} download>
                      <Button size="sm">Download pack</Button>
                    </a>
                    {showAll && (
                      <Button size="sm" variant="ghost" onClick={() => toggle(c)}>
                        {c.active ? "Set inactive" : "Set active"}
                      </Button>
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
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

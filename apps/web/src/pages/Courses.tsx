import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Course } from "../api.js";
import { Card, PageHeader, Button, Badge, EmptyState, Loading } from "../ui.js";
import { courseColor } from "../colors.js";

export function Courses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
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
    try {
      await api.cheatsheet(c.id);
      nav("/notes");
    } catch (e) {
      alert(`Cheat sheet failed: ${e}`);
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

      {loading ? (
        <Loading />
      ) : courses.length === 0 ? (
        <EmptyState icon="📚">No courses yet — hit Sync Moodle.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {courses.map((c) => (
            <Card key={c.id} hover className="p-5">
              <div className="flex items-start gap-3">
                <span className="mt-1 h-10 w-1.5 shrink-0 rounded-full" style={{ background: courseColor(c.id) }} />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-400">{c.code}</span>
                    {c.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}
                  </div>
                  <div className="truncate text-[15px] font-semibold text-slate-900" title={c.name}>
                    {c.name}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" disabled={busy === c.id} onClick={() => makeCheatSheet(c)}>
                      {busy === c.id ? "Generating…" : "✨ Cheat sheet"}
                    </Button>
                    <a href={`/api/export/course/${encodeURIComponent(c.id)}`} download>
                      <Button size="sm">Download .md</Button>
                    </a>
                    {showAll && (
                      <Button size="sm" variant="ghost" onClick={() => toggle(c)}>
                        {c.active ? "Set inactive" : "Set active"}
                      </Button>
                    )}
                    {c.url && (
                      <a href={c.url} target="_blank" rel="noreferrer" className="text-xs text-slate-400 hover:text-slate-600">
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

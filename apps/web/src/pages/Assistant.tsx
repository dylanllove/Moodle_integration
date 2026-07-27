import { useEffect, useState } from "react";
import { api, type Assignment } from "../api.js";
import { Markdown } from "../Markdown.js";
import { Card, PageHeader, Button, EmptyState, Loading, Spinner } from "../ui.js";

export function Assistant() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.assignments()
      .then((a) => {
        setAssignments(a);
        if (a[0]) setSelected(a[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const current = assignments.find((a) => a.id === selected) ?? null;

  return (
    <div>
      <PageHeader title="Assignment help" subtitle="Research & drafting — you stay the author" />

      <Card className="mb-6 border-indigo-100 bg-indigo-50/60 p-4">
        <p className="text-sm text-indigo-900">
          This assistant outlines, pulls from your own notes, drafts sections you rewrite, and critiques
          your work. It never submits for you — follow your institution's academic-integrity rules and cite sources.
        </p>
      </Card>

      {loading ? (
        <Loading />
      ) : assignments.length === 0 ? (
        <EmptyState icon="✍️">No assignments yet — Sync Moodle.</EmptyState>
      ) : (
        <>
          <select
            className="mb-6 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-700"
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
                {a.due_at ? ` — due ${new Date(a.due_at).toLocaleDateString()}` : ""}
              </option>
            ))}
          </select>
          {current && <Workspace assignment={current} />}
        </>
      )}
    </div>
  );
}

function Workspace({ assignment }: { assignment: Assignment }) {
  const [outline, setOutline] = useState<string | null>(null);
  const [section, setSection] = useState("");
  const [draftOut, setDraftOut] = useState<string | null>(null);
  const [myDraft, setMyDraft] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run<T>(label: string, fn: () => Promise<T>, set: (v: string) => void, pick: (r: T) => string) {
    setBusy(label);
    setErr(null);
    try {
      set(pick(await fn()));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {assignment.brief && (
        <Card className="p-5">
          <details open>
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">Brief</summary>
            <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{assignment.brief}</div>
          </details>
        </Card>
      )}
      {err && <Card className="border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{err}</Card>}

      <Panel title="1 · Outline" action={
        <Button size="sm" variant="primary" disabled={!!busy} onClick={() => run("o", () => api.outline(assignment.id), setOutline, (r) => r.markdown)}>
          {busy === "o" ? "Thinking…" : outline ? "Regenerate" : "Generate"}
        </Button>
      }>
        {busy === "o" ? <Spinner label="Building outline…" /> : outline ? <Markdown>{outline}</Markdown> : <Muted>Plan the structure, grounded in your notes.</Muted>}
      </Panel>

      <Panel title="2 · Draft a section" action={
        <div className="flex gap-2">
          <input className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm" placeholder="Section title" value={section} onChange={(e) => setSection(e.target.value)} />
          <Button size="sm" variant="primary" disabled={!!busy || !section.trim()} onClick={() => run("d", () => api.draft(assignment.id, section), setDraftOut, (r) => r.markdown)}>
            {busy === "d" ? "Drafting…" : "Draft"}
          </Button>
        </div>
      }>
        {busy === "d" ? <Spinner label="Drafting…" /> : draftOut ? (
          <>
            <Markdown>{draftOut}</Markdown>
            <button className="mt-3 text-sm text-indigo-600 hover:underline" onClick={() => setMyDraft((d) => (d ? d + "\n\n" : "") + draftOut)}>↓ Copy into my draft</button>
          </>
        ) : <Muted>A first draft with [CHECK] flags — for you to rewrite in your own words.</Muted>}
      </Panel>

      <Panel title="3 · My draft & feedback">
        <textarea
          className="min-h-[28vh] w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 outline-none"
          placeholder="Write your own draft here…"
          value={myDraft}
          onChange={(e) => setMyDraft(e.target.value)}
        />
        <div className="mt-3">
          <Button size="sm" variant="primary" disabled={!!busy || !myDraft.trim()} onClick={() => run("f", () => api.feedback(assignment.id, myDraft), setFeedback, (r) => r.markdown)}>
            {busy === "f" ? "Reviewing…" : "Get feedback"}
          </Button>
        </div>
        {feedback && <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4"><Markdown>{feedback}</Markdown></div>}
      </Panel>
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}
function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-400">{children}</p>;
}

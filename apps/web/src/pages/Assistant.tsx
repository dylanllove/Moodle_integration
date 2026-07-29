import { useEffect, useState } from "react";
import { api, type Assignment } from "../api.js";
import { Markdown } from "../Markdown.js";
import {
  Card,
  PageHeader,
  Button,
  Input,
  Select,
  Textarea,
  Notice,
  SectionTitle,
  Chip,
  EmptyState,
  Loading,
  Spinner,
} from "../ui.js";

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

      <Notice className="mb-6">
        This assistant outlines, pulls from your own notes, drafts sections you rewrite, and critiques
        your work. It never submits for you — follow your institution's academic-integrity rules and
        cite sources.
      </Notice>

      {loading ? (
        <Loading />
      ) : assignments.length === 0 ? (
        <EmptyState icon="✍️">No assignments yet — Sync Moodle.</EmptyState>
      ) : (
        <>
          <div className="mb-6 max-w-xl">
            <Select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              aria-label="Choose an assignment"
            >
              {assignments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                  {a.due_at ? ` — due ${new Date(a.due_at).toLocaleDateString()}` : ""}
                </option>
              ))}
            </Select>
          </div>
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
          <details className="group">
            <summary className="flex cursor-pointer items-center gap-2 font-display text-[15px] font-bold tracking-tight text-ink marker:content-none">
              <span className="text-ink-muted transition duration-200 group-open:rotate-90">
                <Caret />
              </span>
              Brief
            </summary>
            <div className="mt-3 whitespace-pre-wrap pl-5 text-sm leading-relaxed text-ink-soft">
              {assignment.brief}
            </div>
          </details>
        </Card>
      )}
      {err && <Notice tone="error">{err}</Notice>}

      <Step
        n={1}
        title="Outline"
        action={
          <Button size="sm" variant="primary" disabled={!!busy} onClick={() => run("o", () => api.outline(assignment.id), setOutline, (r) => r.markdown)}>
            {busy === "o" ? "Thinking…" : outline ? "Regenerate" : "Generate"}
          </Button>
        }
      >
        {busy === "o" ? (
          <Spinner label="Building outline…" />
        ) : outline ? (
          <Markdown>{outline}</Markdown>
        ) : (
          <Muted>Plan the structure, grounded in your notes.</Muted>
        )}
      </Step>

      <Step
        n={2}
        title="Draft a section"
        action={
          <div className="flex gap-2">
            <div className="w-44">
              <Input
                density="sm"
                placeholder="Section title"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                aria-label="Section title"
              />
            </div>
            <Button size="sm" variant="primary" disabled={!!busy || !section.trim()} onClick={() => run("d", () => api.draft(assignment.id, section), setDraftOut, (r) => r.markdown)}>
              {busy === "d" ? "Drafting…" : "Draft"}
            </Button>
          </div>
        }
      >
        {busy === "d" ? (
          <Spinner label="Drafting…" />
        ) : draftOut ? (
          <>
            <Markdown>{draftOut}</Markdown>
            <button
              className="mt-4 text-sm font-medium text-accent-deep transition duration-200 hover:underline"
              onClick={() => setMyDraft((d) => (d ? d + "\n\n" : "") + draftOut)}
            >
              Copy into my draft ↓
            </button>
          </>
        ) : (
          <Muted>A first draft with [CHECK] flags — for you to rewrite in your own words.</Muted>
        )}
      </Step>

      <Step n={3} title="My draft & feedback">
        <Textarea
          className="min-h-[28vh] bg-chip/50 text-ink-soft"
          placeholder="Write your own draft here…"
          value={myDraft}
          onChange={(e) => setMyDraft(e.target.value)}
          aria-label="My draft"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="primary" disabled={!!busy || !myDraft.trim()} onClick={() => run("f", () => api.feedback(assignment.id, myDraft), setFeedback, (r) => r.markdown)}>
            {busy === "f" ? "Reviewing…" : "Get feedback"}
          </Button>
          {myDraft.trim() && <Chip>{wordCount(myDraft)} words</Chip>}
        </div>
        {feedback && (
          <div className="mt-5 border-t border-hair pt-4">
            <Markdown>{feedback}</Markdown>
          </div>
        )}
      </Step>
    </div>
  );
}

/** A numbered stage of the workflow. The step number is the only ornament. */
function Step({
  n,
  title,
  action,
  children,
}: {
  n: number;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <SectionTitle
        className="mb-4"
        action={action}
      >
        <span className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-chip font-sans text-xs font-semibold text-ink-muted">
            {n}
          </span>
          {title}
        </span>
      </SectionTitle>
      {children}
    </Card>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-muted">{children}</p>;
}

function Caret() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

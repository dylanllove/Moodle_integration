import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Note } from "../api.js";
import { Markdown } from "../Markdown.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Textarea,
  SectionTitle,
  EmptyState,
  Loading,
} from "../ui.js";

export function Notes() {
  // ?note= opens one directly — search and answer citations link here.
  const [params] = useSearchParams();
  const wanted = params.get("note");
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string | null>(wanted);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const n = await api.notes();
    setNotes(n);
    setSelected((cur) => cur ?? n[0]?.id ?? null);
    setLoading(false);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (wanted) setSelected(wanted);
  }, [wanted]);

  async function newNote() {
    const n = await api.createNote({ title: "New note", body: "" });
    await refresh();
    setSelected(n.id);
  }

  return (
    <div>
      <PageHeader
        title="Notes"
        subtitle="Your notes & AI-generated cheat sheets"
        actions={<Button variant="primary" onClick={newNote}>New note</Button>}
      />
      {loading && <Loading label="Loading notes…" />}
      <div className={`grid grid-cols-1 gap-6 lg:grid-cols-[18rem_1fr] ${loading ? "hidden" : ""}`}>
        <div className="space-y-1">
          {notes.length === 0 ? (
            <EmptyState icon="📝">No notes yet. Generate a cheat sheet from Courses, or add one.</EmptyState>
          ) : (
            notes.map((n) => {
              const isCheat = /^cheat sheet/i.test(n.title);
              const active = selected === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setSelected(n.id)}
                  aria-current={active}
                  className={`w-full rounded-field px-3.5 py-3 text-left transition duration-200 ${
                    active ? "bg-accent-tint" : "hover:bg-chip"
                  }`}
                >
                  <div
                    className={`truncate text-sm ${
                      active ? "font-semibold text-accent-deep" : "font-medium text-ink"
                    }`}
                  >
                    {n.title || "Untitled"}
                  </div>
                  {isCheat && (
                    <div className="mt-1.5">
                      <Badge tone="accent">cheat sheet</Badge>
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div>{selected ? <Editor id={selected} onChange={refresh} /> : null}</div>
      </div>
    </div>
  );
}

function Editor({ id, onChange }: { id: string; onChange: () => void }) {
  const [note, setNote] = useState<Note | null>(null);
  const [edit, setEdit] = useState(false);
  const [cards, setCards] = useState<{ q: string; a: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.notes().then((all) => setNote(all.find((n) => n.id === id) ?? null));
    setCards(null);
    setEdit(false);
  }, [id]);

  async function save(patch: Partial<Note>) {
    if (!note) return;
    const up = { ...note, ...patch };
    setNote(up);
    await api.updateNote(id, { title: up.title, body: up.body });
    onChange();
  }
  async function makeCards() {
    setBusy(true);
    try {
      setCards((await api.flashcards({ note_id: id })).cards);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    await api.deleteNote(id);
    onChange();
  }

  if (!note) return null;
  return (
    <Card className="p-6">
      <div className="mb-5 flex items-center gap-2">
        {/* Title edits in place — no border until you're actually in it. */}
        <input
          className="min-w-0 flex-1 rounded-field border border-transparent bg-transparent px-2 py-1 font-display text-[22px] font-bold tracking-tight text-ink outline-none transition duration-200 hover:border-hair focus:border-accent-deep/40 focus:ring-2 focus:ring-accent-deep/15"
          value={note.title}
          onChange={(e) => setNote({ ...note, title: e.target.value })}
          onBlur={() => save({ title: note.title })}
          aria-label="Note title"
        />
        <Button size="sm" onClick={() => setEdit((v) => !v)}>{edit ? "Preview" : "Edit"}</Button>
        <Button size="sm" disabled={busy} onClick={makeCards}>{busy ? "Working…" : "Flashcards"}</Button>
        <Button size="sm" variant="ghost" onClick={remove}>Delete</Button>
      </div>

      {edit ? (
        <Textarea
          className="min-h-[55vh] bg-chip/50 font-mono text-[13px] text-ink-soft"
          value={note.body}
          onChange={(e) => setNote({ ...note, body: e.target.value })}
          onBlur={() => save({ body: note.body })}
          placeholder="Write in markdown…"
        />
      ) : (
        <div className="min-h-[40vh]">
          <Markdown>{note.body || "_Empty note._"}</Markdown>
        </div>
      )}

      {cards && (
        <div className="mt-7 border-t border-hair pt-5">
          <SectionTitle className="mb-3">Flashcards</SectionTitle>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {cards.map((c, i) => (
              <details
                key={i}
                className="group rounded-field bg-chip/60 p-3.5 text-sm transition duration-200 hover:bg-chip"
              >
                <summary className="flex cursor-pointer items-start gap-2 font-medium text-ink marker:content-none">
                  <span className="mt-1 text-ink-muted transition duration-200 group-open:rotate-90">
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
                  </span>
                  {c.q}
                </summary>
                <p className="mt-2 pl-5 text-ink-muted">{c.a}</p>
              </details>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

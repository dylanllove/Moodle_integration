import { useEffect, useState } from "react";
import { api, type Note } from "../api.js";
import { Markdown } from "../Markdown.js";
import { Card, PageHeader, Button, Badge, EmptyState, Loading } from "../ui.js";

export function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const n = await api.notes();
    setNotes(n);
    setSelected((cur) => cur ?? n[0]?.id ?? null);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []);

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
        actions={<Button variant="primary" onClick={newNote}>+ New note</Button>}
      />
      {loading && <Loading label="Loading notes…" />}
      <div className={`grid grid-cols-1 gap-6 lg:grid-cols-[18rem_1fr] ${loading ? "hidden" : ""}`}>
        <div className="space-y-1.5">
          {notes.length === 0 ? (
            <EmptyState icon="📝">No notes yet. Generate a cheat sheet from Courses, or add one.</EmptyState>
          ) : (
            notes.map((n) => {
              const isCheat = /^cheat sheet/i.test(n.title);
              return (
                <button
                  key={n.id}
                  onClick={() => setSelected(n.id)}
                  className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                    selected === n.id ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className="truncate text-sm font-medium text-slate-900">{n.title || "Untitled"}</div>
                  {isCheat && <div className="mt-1"><Badge tone="indigo">cheat sheet</Badge></div>}
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
      <div className="mb-4 flex items-center gap-2">
        <input
          className="flex-1 rounded-lg border border-transparent bg-transparent px-1 text-lg font-semibold text-slate-900 outline-none focus:border-slate-200"
          value={note.title}
          onChange={(e) => setNote({ ...note, title: e.target.value })}
          onBlur={() => save({ title: note.title })}
        />
        <Button size="sm" onClick={() => setEdit((v) => !v)}>{edit ? "Preview" : "Edit"}</Button>
        <Button size="sm" disabled={busy} onClick={makeCards}>{busy ? "…" : "Flashcards"}</Button>
        <Button size="sm" variant="ghost" onClick={remove}>Delete</Button>
      </div>

      {edit ? (
        <textarea
          className="min-h-[55vh] w-full rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm text-slate-700 outline-none"
          value={note.body}
          onChange={(e) => setNote({ ...note, body: e.target.value })}
          onBlur={() => save({ body: note.body })}
          placeholder="Write in markdown…"
        />
      ) : (
        <div className="min-h-[40vh] rounded-xl bg-white">
          <Markdown>{note.body || "_Empty note._"}</Markdown>
        </div>
      )}

      {cards && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Flashcards</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {cards.map((c, i) => (
              <details key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <summary className="cursor-pointer font-medium text-slate-800">{c.q}</summary>
                <p className="mt-2 text-slate-600">{c.a}</p>
              </details>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

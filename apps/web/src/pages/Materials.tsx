import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Course, type Material } from "../api.js";
import { useSyncedRefresh } from "../hooks.js";
import { courseColor } from "../colors.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  Input,
  Select,
  SectionTitle,
  Notice,
  EmptyState,
  Loading,
  Spinner,
} from "../ui.js";

const KIND_ICON: Record<string, string> = {
  slides: "🖼",
  reading: "📄",
  sheet: "📊",
  data: "🧮",
  other: "📎",
};

export function Materials() {
  // Search and the assistant link straight to a file, a course's shelf, or a
  // term — landing on an unfiltered list of 500 files would waste the trip.
  const [params, setParams] = useSearchParams();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [root, setRoot] = useState("");
  const [course, setCourse] = useState(params.get("course") ?? "");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reading, setReading] = useState<{ title: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([api.materials(), api.courses()]);
    setMaterials(m.materials);
    setRoot(m.root);
    setCourses(c);
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  useSyncedRefresh(load);

  // ?open=<id> — a deep link straight into the file's extracted text.
  const openId = params.get("open");
  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    api
      .materialText(openId)
      .then((r) => !cancelled && setReading(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openId]);

  /** Closing the reader drops ?open so a refresh doesn't reopen it. */
  function closeReader() {
    setReading(null);
    if (params.has("open")) {
      params.delete("open");
      setParams(params, { replace: true });
    }
  }

  async function sync() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.materialsSync(course || undefined);
      setMsg(
        r.downloaded > 0
          ? `Downloaded ${r.downloaded} new file${r.downloaded === 1 ? "" : "s"} (${r.found} found, ${r.skipped} already current${r.failed ? `, ${r.failed} failed` : ""}).`
          : r.found > 0
            ? `Everything's already downloaded — ${r.found} files across ${r.courses} course${r.courses === 1 ? "" : "s"}.`
            : "No downloadable files found. Some courses put readings behind external links, which can't be pulled.",
      );
      await load();
    } catch (e) {
      setMsg(`Sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSyncing(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return materials.filter(
      (m) =>
        (!course || m.course_id === course) &&
        (!q ||
          m.title.toLowerCase().includes(q) ||
          (m.section ?? "").toLowerCase().includes(q) ||
          (m.module ?? "").toLowerCase().includes(q)),
    );
  }, [materials, course, query]);

  // Grouped course → week, which is exactly how it's laid out on disk.
  const grouped = useMemo(() => {
    const byCourse = new Map<string, Map<number | null, Material[]>>();
    for (const m of filtered) {
      const cid = m.course_id ?? "none";
      const weeks = byCourse.get(cid) ?? new Map<number | null, Material[]>();
      const list = weeks.get(m.week) ?? [];
      list.push(m);
      weeks.set(m.week, list);
      byCourse.set(cid, weeks);
    }
    return byCourse;
  }, [filtered]);

  const codeOf = (id: string) => courses.find((c) => c.id === id)?.code ?? "Other";

  return (
    <div>
      <PageHeader
        title="Course files"
        subtitle="Every slide deck, reading and handout — downloaded and filed by course and week"
        actions={
          <>
            <Button onClick={() => api.materialsReveal(course || undefined).catch(() => {})}>
              Open folder
            </Button>
            <Button variant="primary" onClick={sync} disabled={syncing}>
              {syncing ? "Downloading…" : "Sync files"}
            </Button>
          </>
        }
      />

      {msg && <Notice className="mb-5">{msg}</Notice>}
      {syncing && (
        <Card className="mb-5 p-4">
          <Spinner label="Fetching from Moodle — slide decks are also being read for text, so this can take a minute." />
        </Card>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="w-52">
          <Select
            density="sm"
            value={course}
            onChange={(e) => setCourse(e.target.value)}
            aria-label="Filter by course"
          >
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code ?? c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-64">
          <Input
            density="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search filenames & topics…"
            aria-label="Search course files"
          />
        </div>
        {materials.length > 0 && (
          <span className="text-[13px] text-ink-muted">
            {filtered.length} of {materials.length} files
          </span>
        )}
      </div>

      {loading ? (
        <Loading label="Reading your library…" />
      ) : materials.length === 0 ? (
        <EmptyState icon="📚">
          Nothing downloaded yet. <strong className="font-semibold">Sync files</strong> pulls every
          slide deck and reading from your active courses into{" "}
          <Chip>{root || "data/materials"}</Chip>, sorted into week folders.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState icon="🔍">Nothing matches that.</EmptyState>
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(([cid, weeks]) => (
            <div key={cid}>
              <div className="mb-3 flex items-center gap-2.5">
                <span
                  className="h-5 w-1.5 rounded-pill"
                  style={{ background: courseColor(cid === "none" ? null : cid) }}
                />
                <h2 className="font-display text-[17px] font-bold tracking-tight text-ink">
                  {cid === "none" ? "Unlinked" : codeOf(cid)}
                </h2>
                {cid !== "none" && (
                  <a href={`/api/materials/course/${cid}/zip`} download className="ml-1">
                    <Button size="sm" variant="ghost">
                      Download all
                    </Button>
                  </a>
                )}
              </div>
              <div className="space-y-3">
                {[...weeks.entries()]
                  .sort((a, b) => (a[0] ?? 999) - (b[0] ?? 999))
                  .map(([week, items]) => (
                    <Card key={String(week)} className="overflow-hidden">
                      <div className="flex items-center justify-between gap-3 border-b border-hair bg-chip/50 px-4 py-2.5">
                        <span className="font-mono text-[11px] text-ink-muted">
                          {week ? `Week ${String(week).padStart(2, "0")}` : "Unsorted"}
                        </span>
                        <span className="text-[11px] text-ink-muted">{items.length} files</span>
                      </div>
                      <div className="divide-y divide-hair">
                        {items.map((m) => (
                          <FileRow key={m.id} m={m} onRead={setReading} />
                        ))}
                      </div>
                    </Card>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {reading && <TextPane title={reading.title} text={reading.text} onClose={closeReader} />}
    </div>
  );
}

function FileRow({
  m,
  onRead,
}: {
  m: Material;
  onRead: (r: { title: string; text: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState<string | null>(null);

  async function read() {
    setBusy(true);
    try {
      onRead(await api.materialText(m.id));
    } finally {
      setBusy(false);
    }
  }

  async function makeCards() {
    setMaking("…");
    try {
      const r = await api.generateDeck("material", m.id);
      setMaking(`${r.cards} cards`);
    } catch (e) {
      setMaking(e instanceof Error ? e.message.slice(0, 60) : "failed");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="w-5 shrink-0 text-center text-sm" aria-hidden="true">
        {KIND_ICON[m.kind] ?? "📎"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{m.title}</div>
        <div className="mt-0.5 truncate text-xs text-ink-muted">
          {m.module ?? m.section ?? "—"}
          {m.bytes ? ` · ${formatBytes(m.bytes)}` : ""}
        </div>
      </div>
      {(m.text_len ?? 0) > 200 && <Badge tone="green">text ready</Badge>}
      <span className="flex shrink-0 gap-1.5">
        <a href={`/api/materials/${m.id}/file`} target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost">
            Open
          </Button>
        </a>
        {(m.text_len ?? 0) > 200 && (
          <>
            <Button size="sm" variant="ghost" onClick={read} disabled={busy}>
              {busy ? "…" : "Read"}
            </Button>
            <Button size="sm" variant="ghost" onClick={makeCards} disabled={making !== null}>
              {making ?? "Flashcards"}
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

/** Extracted text, so a deck can be skimmed without opening PowerPoint. */
function TextPane({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  // Escape closes, and the backdrop closes — but a click anywhere on the panel
  // itself must not, or selecting text dismisses what you were reading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/25 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <Card className="flex max-h-[80vh] flex-col p-0">
          <div className="flex items-center justify-between gap-3 border-b border-hair px-5 py-3">
            <SectionTitle>{title}</SectionTitle>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
          <div className="pane whitespace-pre-wrap px-5 py-4 text-[13px] leading-relaxed text-ink-soft">
            {text || "No text could be extracted from this file."}
          </div>
        </Card>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
}

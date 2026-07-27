import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Lecture, type Transcript, type TranscriptSegment, type Course } from "../api.js";
import { Card, PageHeader, Button, Badge, EmptyState, Loading, Spinner } from "../ui.js";
import { courseColor } from "../colors.js";

export function Lectures() {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [l, c] = await Promise.all([api.lectures(), api.courses()]);
    setLectures(l);
    setCourses(c);
    setSelected((cur) => cur ?? l.find((x) => x.has_text)?.id ?? l[0]?.id ?? null);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  // Group lectures under their (active) course.
  const groups = useMemo(() => {
    const byCourse = new Map<string, { course: Course | null; items: Lecture[] }>();
    for (const l of lectures) {
      const key = l.course_id ?? "none";
      const course = courses.find((c) => c.id === l.course_id) ?? null;
      const g = byCourse.get(key) ?? { course, items: [] };
      g.items.push(l);
      byCourse.set(key, g);
    }
    return [...byCourse.values()].sort((a, b) => (a.course?.code ?? "").localeCompare(b.course?.code ?? ""));
  }, [lectures, courses]);

  const total = lectures.length;
  const done = lectures.filter((l) => l.has_text).length;

  return (
    <div>
      <PageHeader
        title="Lectures & Transcripts"
        subtitle={total ? `${done} of ${total} transcribed across ${groups.length} course${groups.length > 1 ? "s" : ""}` : "Your current courses' lectures"}
        actions={<UploadButton courses={courses} onDone={load} />}
      />
      {loading && <Loading label="Loading lectures…" />}
      <div className={`grid grid-cols-1 gap-6 lg:grid-cols-[22rem_1fr] ${loading ? "hidden" : ""}`}>
        <div className="space-y-5">
          {groups.length === 0 ? (
            <EmptyState icon="🎧">No lectures yet — connect Echo360 or upload a recording.</EmptyState>
          ) : (
            groups.map((g) => {
              const gid = g.course?.id ?? "none";
              const gdone = g.items.filter((l) => l.has_text).length;
              return (
                <div key={gid}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: courseColor(g.course?.id ?? null) }} />
                    <span className="text-sm font-semibold text-slate-900">{g.course?.code ?? "Other"}</span>
                    <span className="text-xs text-slate-400">{gdone}/{g.items.length} transcribed</span>
                  </div>
                  <div className="space-y-1.5">
                    {g.items.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => setSelected(l.id)}
                        className={`flex w-full items-center gap-2 rounded-xl border px-3.5 py-2.5 text-left transition ${
                          selected === l.id ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white hover:border-slate-300"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{l.title}</span>
                        <StatusDot l={l} />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div>
          {selected ? <LectureDetail id={selected} onChange={load} /> : <EmptyState icon="📄">Select a lecture.</EmptyState>}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ l }: { l: Lecture }) {
  if (l.has_text) return <Badge tone="green">transcript</Badge>;
  if (l.transcript_status === "no_recording") return <Badge tone="amber">no rec</Badge>;
  if (["pending", "downloading", "transcribing"].includes(l.transcript_status ?? "")) return <Badge tone="indigo">…</Badge>;
  return <span className="text-xs text-slate-300">—</span>;
}

function UploadButton({ courses, onDone }: { courses: Course[]; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [course, setCourse] = useState("");

  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("course_id", course || courses[0]?.id || "");
      fd.append("title", file.name.replace(/\.[^.]+$/, ""));
      fd.append("file", file);
      const res = await fetch("/api/lectures/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).error);
      onDone();
    } catch (e) {
      alert(`Upload failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <select className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700" value={course} onChange={(e) => setCourse(e.target.value)}>
        <option value="">Course…</option>
        {courses.map((c) => (
          <option key={c.id} value={c.id}>{c.code}</option>
        ))}
      </select>
      <input ref={fileRef} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? "Transcribing…" : "⬆ Upload recording"}
      </Button>
    </div>
  );
}

function LectureDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [showStamps, setShowStamps] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadOne() {
    const { lecture, transcript } = await api.lecture(id);
    setLecture(lecture);
    setTranscript(transcript);
    return transcript?.status;
  }
  useEffect(() => {
    setShowStamps(false);
    loadOne();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [id]);

  async function process() {
    await api.processLecture(id);
    await loadOne();
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await loadOne();
      if (s === "done" || s === "error" || s === "no_recording") {
        clearInterval(poll.current!);
        onChange();
      }
    }, 2500);
  }

  if (!lecture) return null;
  const status = transcript?.status;
  const busy = ["pending", "downloading", "transcribing"].includes(status ?? "");
  const noRecording = status === "no_recording";
  const segments: TranscriptSegment[] = transcript?.segments ? JSON.parse(transcript.segments) : [];
  const isSlides = lecture.provider === "slides";
  const paragraphs = (transcript?.text ?? "").split(/\n{2,}/).filter((p) => p.trim());

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{lecture.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={isSlides ? "indigo" : "neutral"}>{lecture.provider}</Badge>
            {status === "done" && <Badge tone="green">transcribed</Badge>}
            {noRecording && <Badge tone="amber">no recording yet</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {segments.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowStamps((s) => !s)}>
              {showStamps ? "Reading view" : "Timestamps"}
            </Button>
          )}
          {status === "done" && (
            <a href={`/api/export/lecture/${encodeURIComponent(id)}`} download>
              <Button size="sm">Download .md</Button>
            </a>
          )}
          <Button size="sm" variant="primary" disabled={busy} onClick={process}>
            {busy ? "Working…" : status === "done" ? "Re-process" : isSlides ? "Extract text" : "Transcribe"}
          </Button>
        </div>
      </div>

      {busy && <Spinner label={status === "transcribing" ? "Transcribing & cleaning…" : "Downloading…"} />}
      {status === "error" && <p className="text-sm text-rose-600">Error: {transcript?.error}</p>}

      {!busy && transcript?.text ? (
        showStamps && segments.length > 0 ? (
          <div className="max-h-[64vh] space-y-1.5 overflow-y-auto rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
            {segments.map((s, i) => (
              <p key={i}>
                <span className="mr-2 select-none font-mono text-xs text-slate-400">{fmt(s.start)}</span>
                {s.text}
              </p>
            ))}
          </div>
        ) : (
          <div className="max-h-[64vh] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-5 text-[15px] leading-7 text-slate-700">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )
      ) : noRecording ? (
        <p className="text-sm text-slate-500">
          This class hasn't been recorded/published yet. It'll transcribe automatically once the recording appears.
        </p>
      ) : (
        !busy && <p className="text-sm text-slate-400">Not processed yet — click {isSlides ? "Extract text" : "Transcribe"}.</p>
      )}
    </Card>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

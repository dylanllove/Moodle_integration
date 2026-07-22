import { useEffect, useRef, useState } from "react";
import { api, type Lecture, type Transcript, type TranscriptSegment, type Course } from "../api.js";
import { Card, PageHeader, Button, Badge, EmptyState, Spinner } from "../ui.js";

export function Lectures() {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  async function load() {
    const [l, c] = await Promise.all([api.lectures(), api.courses()]);
    setLectures(l);
    setCourses(c);
    if (!selected && l[0]) setSelected(l[0].id);
  }
  useEffect(() => {
    load();
  }, []);

  const courseCode = (id: string | null) => courses.find((c) => c.id === id)?.code ?? "";

  return (
    <div>
      <PageHeader
        title="Lectures"
        subtitle="Slide decks & recordings — turn any of them into a transcript"
        actions={<UploadButton courses={courses} onDone={load} />}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-1.5">
          {lectures.length === 0 ? (
            <EmptyState icon="🎧">No lectures yet — Sync Moodle or upload a recording.</EmptyState>
          ) : (
            lectures.map((l) => (
              <button
                key={l.id}
                onClick={() => setSelected(l.id)}
                className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                  selected === l.id
                    ? "border-indigo-200 bg-indigo-50"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="truncate text-sm font-medium text-slate-900">{l.title}</div>
                <div className="mt-1 flex items-center gap-2">
                  <Badge tone={l.provider === "slides" ? "indigo" : "neutral"}>{l.provider}</Badge>
                  <span className="text-xs text-slate-400">{courseCode(l.course_id)}</span>
                </div>
              </button>
            ))
          )}
        </div>
        <div>
          {selected ? (
            <LectureDetail id={selected} onChange={load} />
          ) : (
            <EmptyState icon="📄">Select a lecture to view or transcribe it.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
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
      <select
        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
        value={course}
        onChange={(e) => setCourse(e.target.value)}
      >
        <option value="">Course…</option>
        {courses.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code}
          </option>
        ))}
      </select>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? "Transcribing…" : "⬆ Upload recording"}
      </Button>
    </div>
  );
}

function LectureDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadOne() {
    const { lecture, transcript } = await api.lecture(id);
    setLecture(lecture);
    setTranscript(transcript);
    return transcript?.status;
  }
  useEffect(() => {
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
      if (s === "done" || s === "error") {
        clearInterval(poll.current!);
        onChange();
      }
    }, 2500);
  }

  if (!lecture) return null;
  const status = transcript?.status;
  const busy = status === "pending" || status === "downloading" || status === "transcribing";
  const noRecording = status === "no_recording";
  const segments: TranscriptSegment[] = transcript?.segments ? JSON.parse(transcript.segments) : [];
  const isSlides = lecture.provider === "slides";

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{lecture.title}</h2>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone={isSlides ? "indigo" : "neutral"}>{lecture.provider}</Badge>
            {status === "done" && <Badge tone="green">transcribed</Badge>}
            {noRecording && <Badge tone="amber">no recording yet</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
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

      {busy && <Spinner label={status === "transcribing" ? "Processing…" : "Downloading…"} />}
      {status === "error" && <p className="text-sm text-rose-600">Error: {transcript?.error}</p>}

      {!busy && segments.length > 0 ? (
        <div className="max-h-[62vh] space-y-1.5 overflow-y-auto rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
          {segments.map((s, i) => (
            <p key={i}>
              <span className="mr-2 select-none font-mono text-xs text-slate-400">{fmt(s.start)}</span>
              {s.text}
            </p>
          ))}
        </div>
      ) : !busy && transcript?.text ? (
        <div className="max-h-[62vh] overflow-y-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
          {transcript.text}
        </div>
      ) : noRecording ? (
        <p className="text-sm text-slate-500">
          This class hasn't been recorded/published yet. It'll transcribe automatically once the
          recording appears.
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

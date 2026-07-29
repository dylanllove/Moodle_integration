import { useEffect, useState } from "react";
import { api, type Course, type EchoSection } from "../api.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  Input,
  Select,
  Segmented,
  Details,
  SectionTitle,
} from "../ui.js";

export function Settings() {
  const [hasKey, setHasKey] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [gcal, setGcal] = useState({ configured: false, connected: false });
  const [reminder, setReminder] = useState(3);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [s, g, r] = await Promise.all([
      api.settings(),
      api.gcalStatus().catch(() => ({ configured: false, connected: false })),
      api.reminderDays().catch(() => ({ days: 3 })),
    ]);
    setHasKey(s.has_api_key === "true");
    setHasToken(s.has_moodle_token === "true");
    setGcal(g);
    setReminder(r.days);
  }
  useEffect(() => {
    load();
  }, []);

  async function connectGoogle() {
    const r = await api.gcalAuth();
    if (r.url) {
      window.open(r.url, "_blank", "width=520,height=680");
      setMsg("Approve access in the Google popup, then click “I've connected”.");
    } else setMsg(r.error ?? "Could not start Google sign-in.");
  }
  async function pushGoogle() {
    setBusy(true);
    try {
      const r = await api.gcalPush();
      setMsg(r.ok ? `Pushed ${r.pushed} events to Google Calendar.` : `Error: ${r.error}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Connections & preferences" />
      <div className="space-y-5">
        <Card className="p-6">
          <SectionTitle className="mb-5">Connections</SectionTitle>
          <div className="divide-y divide-hair">
            <Row ok={hasToken} label="Moodle" okText="connected via API token" badText="add MOODLE_URL + MOODLE_TOKEN to .env" />
            <Row ok={hasKey} label="OpenAI" okText="connected" badText="add OPENAI_API_KEY to .env" />
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-2.5 text-sm">
                <Dot ok={gcal.connected} />
                <span className="font-medium text-ink">Google Calendar</span>
                <span className={gcal.connected ? "text-accent-deep" : "text-ink-muted"}>
                  {gcal.connected ? "connected" : gcal.configured ? "not connected" : "sign-in unavailable — see note below"}
                </span>
              </span>
              <span className="flex gap-2">
                {gcal.configured && !gcal.connected && <Button size="sm" onClick={connectGoogle}>Sign in with Google</Button>}
                {gcal.connected && (
                  <>
                    <Button size="sm" onClick={pushGoogle} disabled={busy}>{busy ? "Pushing…" : "Push now"}</Button>
                    <Button size="sm" variant="ghost" onClick={async () => { await api.gcalDisconnect(); load(); }}>Disconnect</Button>
                  </>
                )}
              </span>
            </div>
          </div>
          {gcal.configured && !gcal.connected && (
            <div className="mt-4"><Button size="sm" variant="ghost" onClick={load}>I've connected — refresh</Button></div>
          )}
          {!gcal.configured && (
            <Details summary="Why is Google sign-in unavailable?" className="mt-4">
              A “Sign in with Google” button needs a Google OAuth client, which Google only issues per
              project. Add <Chip>GOOGLE_CLIENT_ID</Chip> + <Chip>GOOGLE_CLIENT_SECRET</Chip> to{" "}
              <Chip>.env</Chip> (2-min setup) to enable one-click sign-in.
            </Details>
          )}
          {msg && <p className="mt-4 text-sm text-ink-muted">{msg}</p>}

          <p className="mt-5 border-t border-hair pt-4 text-[13px] leading-relaxed text-ink-muted">
            Or subscribe any calendar app to <Chip>{location.origin}/api/calendar.ics</Chip>
          </p>
        </Card>

        <Echo360Card />

        <TimetableCard />

        <Card className="p-6">
          <SectionTitle className="mb-1.5">Deadline reminders</SectionTitle>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
            Days before a due date to flag it (and set the Google reminder).
          </p>
          <div className="max-w-md">
            <Segmented
              options={[1, 2, 3, 5, 7, 14]}
              value={reminder}
              onChange={async (d) => { setReminder(d); await api.setReminderDays(d); }}
              format={(d) => `${d}d`}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function TimetableCard() {
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => setUrl(s.timetable_url ?? ""));
  }, []);

  async function saveAndSync() {
    setBusy(true);
    setMsg(null);
    try {
      await api.saveSettings({ timetable_url: url });
      setSaved(true);
      const r = await api.sync();
      setMsg(r.ok ? `Imported ${r.counts?.classes ?? 0} class sessions.` : `Sync error: ${r.error}`);
    } catch (e) {
      setMsg(`Failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <SectionTitle className="mb-1.5">Class timetable</SectionTitle>
      <p className="mb-4 text-[13px] text-ink-muted">
        Paste your timetable's iCal subscribe URL.
      </p>
      <div className="flex max-w-2xl gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mytimetable.canterbury.ac.nz/…/timetable.ics"
          aria-label="Timetable iCal URL"
        />
        <Button variant="primary" onClick={saveAndSync} disabled={busy || !url.trim()} className="shrink-0">
          {busy ? "Importing…" : saved ? "Re-import" : "Import"}
        </Button>
      </div>
      <Details summary="Where do I find it?" className="mt-4">
        On UC's timetable site, look for Export / Subscribe / “Add to calendar”. Recurring classes and
        rooms then populate your calendar and today's schedule.
      </Details>
      {msg && <p className="mt-4 text-sm text-ink-muted">{msg}</p>}
    </Card>
  );
}

function Echo360Card() {
  const [connected, setConnected] = useState(false);
  const [sections, setSections] = useState<EchoSection[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const [s, c] = await Promise.all([api.echoStatus(), api.courses(true)]);
    setConnected(s.connected);
    setSections(s.sections);
    setCourses(c);
  }
  useEffect(() => {
    load();
  }, []);

  async function connect() {
    setBusy("connect");
    try {
      const r = await api.echoLogin();
      setMsg(
        r.ok
          ? "A browser window opened — log in to Echo360, then click “I've connected” to save your session (you can close the window after)."
          : `Couldn't open the login window: ${r.error}`,
      );
    } catch (e) {
      setMsg(`Couldn't open the login window: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy("verify");
    try {
      const r = await api.echoVerify();
      setConnected(r.connected);
      setMsg(
        r.connected
          ? "Connected — downloading & transcribing your lectures now (this runs in the background)."
          : r.error ?? "Not connected yet — log in in the window, then try again.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function assign(sectionId: string, courseId: string) {
    const next = sections.map((s) => (s.sectionId === sectionId ? { ...s, courseId: courseId || null } : s));
    setSections(next);
    await api.echoConfig({ sections: next });
  }
  async function addSection(raw: string) {
    const id = (raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? raw).trim();
    if (!id || sections.some((s) => s.sectionId === id)) return;
    const next = [...sections, { sectionId: id, courseId: null, label: id.slice(0, 8) }];
    setSections(next);
    await api.echoConfig({ sections: next });
  }
  async function sync() {
    setBusy("sync");
    setMsg("Pulling lectures — fetching captions or downloading & transcribing audio. This can take a while.");
    try {
      const r = await api.echoSync();
      const c = r.counts;
      setMsg(
        r.ok && c
          ? `Done — ${c.transcribed} transcribed · ${c.noRecording} not recorded yet · ${c.failed} failed (of ${c.lessons} classes)`
          : `Error: ${r.error}`,
      );
    } catch (e) {
      setMsg(`Sync failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-1.5"
        action={connected ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not connected</Badge>}
      >
        Echo360 lecture recordings
      </SectionTitle>
      <p className="mb-5 text-[13px] text-ink-muted">
        Log in <strong className="font-semibold text-ink">once</strong> — new recordings then
        auto-transcribe on every launch.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        <Button size="sm" onClick={connect} disabled={busy === "connect"}>
          {busy === "connect" ? "Opening…" : connected ? "Reconnect" : "Connect Echo360"}
        </Button>
        <Button size="sm" variant="primary" onClick={verify} disabled={busy === "verify"}>
          {busy === "verify" ? "Checking…" : "I've connected"}
        </Button>
        <Button size="sm" onClick={sync} disabled={busy === "sync"}>
          {busy === "sync" ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {/* Section mapping only matters once there's a live session. */}
      <div className={`max-w-xl ${connected ? "" : "hidden"}`}>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Sections → course
        </div>
        <div className="divide-y divide-hair">
          {sections.map((s) => (
            <div key={s.sectionId} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{s.label || s.sectionId}</span>
              <div className="w-40 shrink-0">
                <Select
                  density="sm"
                  value={s.courseId ?? ""}
                  onChange={(e) => assign(s.sectionId, e.target.value)}
                  aria-label={`Course for section ${s.label || s.sectionId}`}
                >
                  <option value="">Unassigned</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </Select>
              </div>
            </div>
          ))}
        </div>
        <AddSection onAdd={addSection} />
      </div>
      {msg && <p className="mt-4 text-sm text-ink-muted">{msg}</p>}
    </Card>
  );
}

function AddSection({ onAdd }: { onAdd: (raw: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex gap-2 pt-3">
      <Input
        density="sm"
        placeholder="Paste an Echo360 section URL or ID to add a course…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        aria-label="Echo360 section URL or ID"
      />
      <Button size="sm" onClick={() => { onAdd(v); setV(""); }} disabled={!v.trim()} className="shrink-0">
        Add
      </Button>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-pill ${ok ? "bg-accent-deep" : "bg-amber-400"}`}
      aria-hidden="true"
    />
  );
}
function Row({ ok, label, okText, badText }: { ok: boolean; label: string; okText: string; badText: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-3 text-sm">
      <Dot ok={ok} />
      <span className="font-medium text-ink">{label}</span>
      <span className={ok ? "text-accent-deep" : "text-ink-muted"}>{ok ? okText : badText}</span>
    </div>
  );
}

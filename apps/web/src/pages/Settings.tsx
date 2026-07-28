import { useEffect, useState } from "react";
import { api, type Course, type EchoSection } from "../api.js";
import { Card, PageHeader, Button, Badge } from "../ui.js";

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
      setMsg(r.ok ? `Pushed ${r.pushed} events to Google Calendar ✓` : `Error: ${r.error}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Connections & preferences" />
      <div className="space-y-5">
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">Connections</h2>
          <div className="space-y-3">
            <Row ok={hasToken} label="Moodle" okText="connected via API token" badText="add MOODLE_URL + MOODLE_TOKEN to .env" />
            <Row ok={hasKey} label="OpenAI" okText="connected" badText="add OPENAI_API_KEY to .env" />
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2.5 text-sm">
                <Dot ok={gcal.connected} />
                <span className="font-medium text-slate-800">Google Calendar</span>
                <span className={gcal.connected ? "text-emerald-600" : "text-amber-600"}>
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
            <div className="mt-3"><Button size="sm" variant="ghost" onClick={load}>I've connected — refresh</Button></div>
          )}
          {!gcal.configured && (
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
              A “Sign in with Google” button needs a Google OAuth client, which Google only issues per project.
              Add <code>GOOGLE_CLIENT_ID</code> + <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> (2-min setup) to
              enable one-click sign-in. Meanwhile, Apple Calendar can subscribe to the .ics feed on the Calendar page.
            </p>
          )}
          {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
        </Card>

        <Echo360Card />

        <TimetableCard />

        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">Deadline reminders</h2>
          <p className="mb-3 text-xs text-slate-500">Days before a due date to flag it (and set the Google reminder).</p>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 5, 7, 14].map((d) => (
              <button
                key={d}
                onClick={async () => { setReminder(d); await api.setReminderDays(d); }}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                  reminder === d ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {d} day{d > 1 ? "s" : ""}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">Study pack export</h2>
          <p className="mb-3 text-xs text-slate-500">
            Every active course as Markdown (transcripts, slide text, forum posts) plus a CLAUDE.md
            tutor guide — zipped for any LLM.
          </p>
          <a href="/api/export/all" download><Button variant="primary">Download study pack</Button></a>
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
      setMsg(r.ok ? `Imported ✓ ${r.counts?.classes ?? 0} class sessions` : `Sync error: ${r.error}`);
    } catch (e) {
      setMsg(`Failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">Class timetable</h2>
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        Paste your university timetable's <strong>iCal / “subscribe” URL</strong> (from UC’s timetable
        site — look for Export / Subscribe / “Add to calendar”). Recurring classes and rooms populate
        your calendar and the “Today’s schedule” panel.
      </p>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mytimetable.canterbury.ac.nz/…/timetable.ics"
        />
        <Button variant="primary" onClick={saveAndSync} disabled={busy || !url.trim()}>
          {busy ? "Importing…" : saved ? "Re-import" : "Import"}
        </Button>
      </div>
      {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
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
          ? "Connected ✓ — downloading & transcribing your lectures now (this runs in the background)."
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
          ? `Done ✓ ${c.transcribed} transcribed · ${c.noRecording} not recorded yet · ${c.failed} failed (of ${c.lessons} classes)`
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
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Echo360 lecture recordings</h2>
        {connected ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not connected</Badge>}
      </div>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        Connect and log in <strong>once</strong> — your session is saved, so new lecture recordings
        <strong> auto-download and transcribe every time the app launches</strong>, with no re-login.
        If Echo eventually signs you out, just reconnect.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
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

      <div className="space-y-2">
        <div className="text-xs font-medium text-slate-500">Sections → course</div>
        {sections.map((s) => (
          <div key={s.sectionId} className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate text-slate-700">{s.label || s.sectionId}</span>
            <select
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
              value={s.courseId ?? ""}
              onChange={(e) => assign(s.sectionId, e.target.value)}
            >
              <option value="">Unassigned</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>{c.code}</option>
              ))}
            </select>
          </div>
        ))}
        <AddSection onAdd={addSection} />
      </div>
      {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}
    </Card>
  );
}

function AddSection({ onAdd }: { onAdd: (raw: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex gap-2 pt-1">
      <input
        className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
        placeholder="Paste an Echo360 section URL or ID to add a course…"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <Button size="sm" onClick={() => { onAdd(v); setV(""); }} disabled={!v.trim()}>Add</Button>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`h-2.5 w-2.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-400"}`} />;
}
function Row({ ok, label, okText, badText }: { ok: boolean; label: string; okText: string; badText: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Dot ok={ok} />
      <span className="font-medium text-slate-800">{label}</span>
      <span className={ok ? "text-emerald-600" : "text-amber-600"}>{ok ? okText : badText}</span>
    </div>
  );
}

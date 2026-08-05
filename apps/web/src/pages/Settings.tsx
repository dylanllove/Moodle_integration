import { useEffect, useState } from "react";
import { api, type AutoSync, type Course, type DigestStatus, type EchoSection, type SyncStatus } from "../api.js";
import { NotionSettings } from "../NotionSettings.js";
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
  Notice,
  SectionTitle,
} from "../ui.js";

export function Settings() {
  const [hasKey, setHasKey] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [reminder, setReminder] = useState(3);
  const [automation, setAutomation] = useState({ materials: true, flashcards: true });

  async function load() {
    const [s, r] = await Promise.all([api.settings(), api.reminderDays().catch(() => ({ days: 3 }))]);
    setHasKey(s.has_api_key === "true");
    setHasToken(s.has_moodle_token === "true");
    setReminder(r.days);
    setAutomation({
      materials: s.auto_materials !== "false",
      flashcards: s.auto_flashcards !== "false",
    });
  }
  useEffect(() => {
    load();
  }, []);

  async function toggle(key: "auto_materials" | "auto_flashcards", on: boolean) {
    await api.saveSettings({ [key]: on ? "true" : "false" });
    setAutomation((a) => ({
      ...a,
      [key === "auto_materials" ? "materials" : "flashcards"]: on,
    }));
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Connections, sync destinations & preferences" />
      <div className="space-y-5">
        <Card className="p-6">
          <SectionTitle className="mb-5">Connections</SectionTitle>
          <div className="divide-y divide-hair">
            <Row
              ok={hasToken}
              label="Moodle"
              okText="connected via API token"
              badText="not connected — run through setup"
            />
            <Row ok={hasKey} label="OpenAI" okText="connected" badText="no key — run through setup" />
          </div>
        </Card>

        <SyncCard />
        <NotionSettings />
        <DigestCard />
        <Echo360Card />
        <TimetableCard />

        <Card className="p-6">
          <SectionTitle className="mb-1.5">Deadline reminders</SectionTitle>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
            Days before a due date to flag it — also used for the alarms in your synced calendars.
          </p>
          <div className="max-w-md">
            <Segmented
              options={[1, 2, 3, 5, 7, 14]}
              value={reminder}
              onChange={async (d) => {
                setReminder(d);
                await api.setReminderDays(d);
              }}
              format={(d) => `${d}d`}
            />
          </div>
        </Card>

        <Card className="p-6">
          <SectionTitle className="mb-1.5">What happens on its own</SectionTitle>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
            These run at launch and on every automatic sync. Turn them off if you'd rather do them
            by hand.
          </p>
          <div className="divide-y divide-hair">
            <Toggle
              on={automation.materials}
              label="Download new course files"
              detail="Slides and readings, filed by course and week."
              onChange={(v) => toggle("auto_materials", v)}
            />
            <Toggle
              on={automation.flashcards}
              label="Make flashcards from new lectures"
              detail="One deck per lecture, generated after it's transcribed."
              onChange={(v) => toggle("auto_flashcards", v)}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

/* --- Where deadlines go --------------------------------------------------- */

function SyncCard() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setStatus(await api.syncStatus().catch(() => null));
  }
  useEffect(() => {
    load();
  }, []);

  async function pushAll() {
    setBusy("push");
    setMsg(null);
    try {
      const r = await api.syncPush();
      const parts: string[] = [];
      if (r.google) {
        parts.push(
          r.google.ok
            ? `Google: ${r.google.pushed} events${r.google.removed ? `, ${r.google.removed} removed` : ""}`
            : `Google failed — ${r.google.error}`,
        );
      }
      if (r.notion) {
        parts.push(
          r.notion.ok
            ? `Notion: ${r.notion.created} added, ${r.notion.updated} updated${r.notion.archived ? `, ${r.notion.archived} archived` : ""}`
            : `Notion failed — ${r.notion.error}`,
        );
      }
      setMsg(parts.length ? parts.join(" · ") : "Nothing connected to push to yet.");
      await load();
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;
  const anyConnected = status.google.connected || status.notion.connected;

  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-1.5"
        action={
          anyConnected && (
            <Button size="sm" onClick={pushAll} disabled={busy === "push"}>
              {busy === "push" ? "Pushing…" : "Push now"}
            </Button>
          )
        }
      >
        Where your deadlines go
      </SectionTitle>
      <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
        {status.deadlines} deadline{status.deadlines === 1 ? "" : "s"} across your active courses.
        Connect either — they stay in step after every sync. Notion has its own section below.
      </p>

      <div className="space-y-4">
        <GoogleRow status={status} onChange={load} />
        <AppleRow status={status} onChange={load} />
      </div>

      {anyConnected && (
        <label className="mt-5 flex cursor-pointer items-center gap-2.5 border-t border-hair pt-4 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={status.autoPush}
            onChange={async (e) => {
              await api.syncOptions({ autoPush: e.target.checked });
              await load();
            }}
            className="h-4 w-4 accent-[#075985]"
          />
          Push automatically after every Moodle sync
        </label>
      )}

      <AutoSyncRow auto={status.auto} onChange={load} />

      {msg && <p className="mt-4 text-sm text-ink-muted">{msg}</p>}
    </Card>
  );
}

/**
 * How often the app refreshes itself. Worth a control rather than a constant:
 * on a metered connection or a tired battery, twenty minutes of browser launches
 * is a cost, and the right number depends on the week you're having.
 */
const INTERVALS = [10, 20, 30, 60, 120] as const;

function AutoSyncRow({ auto, onChange }: { auto: AutoSync; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const save = async (body: { autoSyncEnabled?: boolean; autoSyncMinutes?: number }) => {
    setBusy(true);
    try {
      await api.syncOptions(body);
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-hair pt-4">
      <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={auto.enabled}
          disabled={busy}
          onChange={(e) => save({ autoSyncEnabled: e.target.checked })}
          className="h-4 w-4 accent-[#075985]"
        />
        Keep everything up to date while the app is open
      </label>
      {auto.enabled && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-6.5">
          <span className="text-[13px] text-ink-muted">Every</span>
          <div className="w-36">
            <Select
              density="sm"
              value={String(auto.minutes)}
              disabled={busy}
              onChange={(e) => save({ autoSyncMinutes: Number(e.target.value) })}
              aria-label="How often to sync"
            >
              {INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}
                </option>
              ))}
            </Select>
          </div>
          <span className="text-[13px] text-ink-muted">
            Moodle, gradebook, course files, Echo360 and any outstanding transcripts. It also
            catches up straight after the machine wakes from sleep.
          </span>
        </div>
      )}
    </div>
  );
}

function Destination({
  name,
  connected,
  note,
  children,
}: {
  name: string;
  connected: boolean;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-field border border-hair p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Dot ok={connected} />
        <span className="text-sm font-medium text-ink">{name}</span>
        {connected ? <Badge tone="green">connected</Badge> : <Badge>not set up</Badge>}
        <span className="text-[13px] text-ink-muted">{note}</span>
      </div>
      {children}
    </div>
  );
}

function GoogleRow({ status, onChange }: { status: SyncStatus; onChange: () => Promise<void> }) {
  const [msg, setMsg] = useState<string | null>(null);
  const g = status.google;

  async function connect() {
    const r = await api.gcalAuth().catch((e) => ({ error: String(e) }) as { error: string });
    if ("url" in r && r.url) {
      window.open(r.url, "_blank", "width=520,height=680");
      setMsg("Approve access in the Google window, then hit Refresh.");
    } else setMsg(("error" in r && r.error) || "Couldn't start Google sign-in.");
  }

  return (
    <Destination
      name="Google Calendar"
      connected={g.connected}
      note={g.connected ? "writes to a dedicated “Uni Study” calendar" : "two-way OAuth, updates in place"}
    >
      {!g.configured ? (
        <Details summary="Needs a Google OAuth client first">
          Google only issues OAuth clients per project, so a one-click button isn't possible in an app
          you run yourself. Create one at{" "}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-deep hover:underline"
          >
            console.cloud.google.com/apis/credentials
          </a>{" "}
          (type: Web application), enable the Calendar API, add the redirect URI{" "}
          <Chip>http://127.0.0.1:8787/api/gcal/callback</Chip>, then put{" "}
          <Chip>GOOGLE_CLIENT_ID</Chip> and <Chip>GOOGLE_CLIENT_SECRET</Chip> in <Chip>.env</Chip>.
          Or just subscribe Google to the feed below — no setup at all.
        </Details>
      ) : g.connected ? (
        <div className="space-y-2.5">
          <div className="flex flex-wrap gap-3">
            <Check
              label="Also send classes"
              on={g.includeClasses}
              onChange={async (v) => {
                await api.gcalOptions({ includeClasses: v });
                await onChange();
              }}
            />
            <Check
              label="Also send personal commitments"
              on={g.includePersonal}
              onChange={async (v) => {
                await api.gcalOptions({ includePersonal: v });
                await onChange();
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api.gcalDisconnect();
                await onChange();
              }}
            >
              Disconnect
            </Button>
          </div>
          {g.lastPush && (
            <p className="text-[12px] text-ink-muted">
              Last pushed {new Date(g.lastPush).toLocaleString()}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={connect}>
            Sign in with Google
          </Button>
          <Button size="sm" variant="ghost" onClick={onChange}>
            Refresh
          </Button>
        </div>
      )}
      {msg && <p className="mt-2.5 text-[13px] text-ink-muted">{msg}</p>}
    </Destination>
  );
}

/**
 * Apple's honest story: there's no write API without handing over an Apple ID, so
 * subscription is the integration. It also keeps working when the app is closed.
 */
function AppleRow({ status, onChange }: { status: SyncStatus; onChange: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const a = status.apple;

  return (
    <Destination
      name="Apple Calendar (or any calendar app)"
      connected={a.subscribed}
      note="subscribe once, refreshes hourly on its own"
    >
      <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
        Apple has no API to write into your calendar without storing your Apple ID, so this is a
        subscription instead — which is better anyway: it keeps updating whether or not Uni Study is
        running, and carries reminders.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <a href={a.webcal}>
          <Button size="sm" variant="primary">
            Subscribe in Calendar
          </Button>
        </a>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(a.https);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Link copied" : "Copy feed URL"}
        </Button>
        {!a.subscribed && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.syncOptions({ appleSubscribed: true });
              await onChange();
            }}
          >
            Mark as done
          </Button>
        )}
      </div>
      <Details summary="Doing it manually, or want fewer event types" className="mt-3">
        In Apple Calendar: <strong className="text-ink">File → New Calendar Subscription</strong> and
        paste <Chip>{a.https}</Chip>. Set auto-refresh to every hour. Google Calendar has the same
        thing under <strong className="text-ink">Other calendars → From URL</strong>.
        <p className="mt-2">
          Add <Chip>?kinds=deadline,exam</Chip> to the URL for deadlines only — handy if your
          timetable is already in that calendar.
        </p>
      </Details>
    </Destination>
  );
}
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function DigestCard() {
  const [status, setStatus] = useState<DigestStatus | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function load() {
    const s = await api.digestStatus().catch(() => null);
    if (!s) return;
    setStatus(s);
    setHost(s.smtp.host);
    setPort(String(s.smtp.port));
    setUser(s.smtp.user);
    setTo(s.to || s.smtp.user);
  }
  useEffect(() => {
    load();
  }, []);

  async function saveSmtp() {
    setBusy("save");
    setMsg(null);
    try {
      await api.digestSettings({
        to,
        smtp: { host, port: Number(port), user, pass: pass || undefined, from: user },
      });
      setPass("");
      setMsg("Saved.");
      await load();
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await api.digestTest();
      setMsg(`Sent to ${r.to} — check your inbox.`);
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;

  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-1.5"
        action={status.enabled ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}
      >
        Weekly digest
      </SectionTitle>
      <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
        One email, {status.schedule.label}: what's due, how heavy the week looks, what's new, and
        anything at risk. Sent from your machine through your own mail account.
      </p>

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <label className="w-40">
          <span className="mb-1.5 block text-[11px] font-medium text-ink-muted">Send on</span>
          <Select
            density="sm"
            value={status.schedule.day}
            onChange={async (e) => {
              await api.digestSettings({ day: Number(e.target.value) });
              await load();
            }}
            aria-label="Digest day"
          >
            {DAY_NAMES.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </label>
        <label className="w-24">
          <span className="mb-1.5 block text-[11px] font-medium text-ink-muted">At</span>
          <Select
            density="sm"
            value={status.schedule.hour}
            onChange={async (e) => {
              await api.digestSettings({ hour: Number(e.target.value) });
              await load();
            }}
            aria-label="Digest hour"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </label>
        <label className="min-w-[200px] flex-1">
          <span className="mb-1.5 block text-[11px] font-medium text-ink-muted">Send to</span>
          <Input
            density="sm"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onBlur={() => to !== status.to && api.digestSettings({ to }).then(load).catch(() => {})}
            placeholder="you@example.com"
            aria-label="Digest recipient"
          />
        </label>
      </div>

      <Details summary={status.emailConfigured ? "Mail account (configured)" : "Set up your mail account"}>
        <p>
          The digest goes out through SMTP, using an account you already have. For Gmail that means an{" "}
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-deep hover:underline"
          >
            App Password
          </a>{" "}
          — Google blocks normal passwords for this. Host <Chip>smtp.gmail.com</Chip>, port{" "}
          <Chip>587</Chip>.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input
            density="sm"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.gmail.com"
            aria-label="SMTP host"
          />
          <Input
            density="sm"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="587"
            aria-label="SMTP port"
          />
          <Input
            density="sm"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="you@gmail.com"
            autoComplete="username"
            aria-label="SMTP username"
          />
          <Input
            density="sm"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder={status.smtp.hasPassword ? "•••••••• (saved)" : "app password"}
            autoComplete="new-password"
            aria-label="SMTP password"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={saveSmtp} disabled={busy === "save"}>
            {busy === "save" ? "Saving…" : "Save mail settings"}
          </Button>
          {status.emailConfigured && (
            <Button size="sm" onClick={sendTest} disabled={busy === "test"}>
              {busy === "test" ? "Sending…" : "Send me this week's digest"}
            </Button>
          )}
        </div>
      </Details>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-hair pt-4">
        <Button
          size="sm"
          variant={status.enabled ? "outline" : "primary"}
          disabled={busy === "toggle" || (!status.emailConfigured && !status.enabled)}
          onClick={async () => {
            setBusy("toggle");
            setMsg(null);
            try {
              await api.digestSettings({ enabled: !status.enabled });
              await load();
            } catch (e) {
              setMsg(String(e instanceof Error ? e.message : e));
            } finally {
              setBusy(null);
            }
          }}
        >
          {status.enabled ? "Turn digest off" : "Turn digest on"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const p = await api.digestPreview();
            setPreview(p.markdown);
          }}
        >
          Preview this week's
        </Button>
        {!status.emailConfigured && !status.enabled && (
          <span className="text-[13px] text-ink-muted">Add your mail account first.</span>
        )}
      </div>

      {status.last && (
        <p className="mt-3 text-[12px] text-ink-muted">
          Last digest {status.last.sent_at ? new Date(status.last.sent_at).toLocaleString() : "—"} ·{" "}
          {status.last.channel === "email" ? "emailed" : "saved locally"}
          {status.last.error && status.last.error !== "no-email" ? ` · ${status.last.error}` : ""}
        </p>
      )}
      {msg && <Notice className="mt-4">{msg}</Notice>}
      {preview && (
        <pre className="pane mt-4 max-h-80 whitespace-pre-wrap rounded-field bg-chip p-4 font-mono text-[12px] leading-relaxed text-ink-soft">
          {preview}
        </pre>
      )}
    </Card>
  );
}

/* --- Existing cards ------------------------------------------------------- */

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
      <p className="mb-4 text-[13px] text-ink-muted">Paste your timetable's iCal subscribe URL.</p>
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
        On your university's timetable site, look for Export / Subscribe / “Add to calendar”.
        Recurring classes and rooms then populate your calendar, today's schedule and the workload
        heatmap.
      </Details>
      {msg && <p className="mt-4 text-sm text-ink-muted">{msg}</p>}
    </Card>
  );
}

function Echo360Card() {
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<{ wobbly: boolean; lastWarm: string | null } | null>(null);
  const [sections, setSections] = useState<EchoSection[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const [s, c] = await Promise.all([api.echoStatus(), api.courses(true)]);
    setConnected(s.connected);
    setSession(s.session);
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
  async function discover() {
    setBusy("discover");
    setNotes([]);
    setMsg("Opening each course's Echo360 link on Moodle to find its recordings…");
    try {
      const r = await api.echoDiscover();
      if (!r.ok) {
        setMsg(`Couldn't look up your courses: ${r.error}`);
        return;
      }
      if (r.sections) setSections(r.sections);
      setNotes(r.notes ?? []);
      const n = r.found?.length ?? 0;
      setMsg(
        n
          ? `Matched ${n} section${n === 1 ? "" : "s"}${r.changed ? `, ${r.changed} updated` : " — all already correct"}. ` +
            `Use Sync now to pull them.`
          : "Couldn't match any sections automatically — see below.",
      );
    } catch (e) {
      setMsg(`Couldn't look up your courses: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    setMsg("Pulling lectures — fetching captions or downloading & transcribing audio. This can take a while.");
    try {
      const r = await api.echoSync();
      const c = r.counts;
      setMsg(
        r.ok && c
          ? `Done — ${c.lessons} class${c.lessons === 1 ? "" : "es"} found · ${c.transcribed} newly transcribed` +
            (c.stillWaiting ? ` · ${c.stillWaiting} not published yet` : "") +
            (c.deferred ? ` · ${c.deferred} queued for the next run` : "") +
            (c.failed ? ` · ${c.failed} failed` : "")
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
      <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
        Log in <strong className="font-semibold text-ink">once</strong>. Echo360's cookies carry no
        expiry date — they simply go stale if the session sits idle — so the app touches Echo360
        every ten minutes and saves the refreshed session. New recordings transcribe on their own,
        and each one gets study notes and a flashcard deck.
        {session?.lastWarm && (
          <> Session last confirmed {new Date(session.lastWarm).toLocaleString()}.</>
        )}
      </p>
      {session?.wobbly && connected && (
        <Notice tone="warn" className="mb-5">
          Echo360 turned down the saved session on the last try. It's being retried rather than
          thrown away — if this doesn't clear, use <strong className="font-semibold">Reconnect</strong>.
        </Notice>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        <Button size="sm" onClick={connect} disabled={busy === "connect"}>
          {busy === "connect" ? "Opening…" : connected ? "Reconnect" : "Connect Echo360"}
        </Button>
        <Button size="sm" variant="primary" onClick={verify} disabled={busy === "verify"}>
          {busy === "verify" ? "Checking…" : "I've connected"}
        </Button>
        <Button size="sm" onClick={discover} disabled={busy === "discover" || !connected}>
          {busy === "discover" ? "Looking…" : "Find my courses"}
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
        <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
          <strong className="font-semibold text-ink">Find my courses</strong> reads each course's
          Echo360 link on Moodle and fills this in for you — the course comes from the link itself,
          so it can't drift out of step with the label.
        </p>
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
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ))}
        </div>
        <AddSection onAdd={addSection} />
      </div>
      {msg && <p className="mt-4 text-sm text-ink-muted">{msg}</p>}
      {notes.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
          {notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="text-hair-strong">
                •
              </span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
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

function Check({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void | Promise<void>;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => void onChange(e.target.checked)}
        className="h-4 w-4 accent-[#075985]"
      />
      {label}
    </label>
  );
}

function Toggle({
  on,
  label,
  detail,
  onChange,
}: {
  on: boolean;
  label: string;
  detail: string;
  onChange: (v: boolean) => void | Promise<void>;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-3">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => void onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[#075985]"
      />
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-[13px] text-ink-muted">{detail}</span>
      </span>
    </label>
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

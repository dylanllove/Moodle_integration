import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type SetupStatus } from "../api.js";
import {
  Card,
  PageHeader,
  Button,
  Badge,
  Chip,
  Input,
  Tabs,
  Notice,
  Details,
  Loading,
} from "../ui.js";

/**
 * Guided setup, in three passes.
 *
 * Two things are genuinely required (Moodle + an OpenAI key); everything else
 * makes the app better but works fine unset. Grouping them that way stops a
 * fourteen-step wall from reading as fourteen obligations.
 */
export function Setup() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setStatus(await api.setupStatus());
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <Loading label="Checking your setup…" />;
  if (!status) {
    return (
      <Notice tone="error">
        Couldn't reach the local server. Make sure <Chip>npm run dev</Chip> is still running.
      </Notice>
    );
  }

  const moodleDone = status.moodle.connected;
  const keyDone = status.openai;
  const timetableDone = Boolean(status.timetable.url) || status.timetable.classes > 0;
  const ready = moodleDone && keyDone;
  const syncDone = status.sync.google || status.sync.notion || status.sync.apple;

  return (
    <div className="max-w-3xl">
      <PageHeader
        size="hero"
        title={
          <>
            Let's get you <span className="swash">set up</span>
          </>
        }
        subtitle={
          <>
            Two steps are essential; the rest you can do now or come back to. Everything stays on this
            machine — your credentials go straight to your university, OpenAI, Google or Notion, never
            anywhere else.
          </>
        }
      />

      <div className="space-y-4">
        <Prerequisites deps={status.deps} />

        <Phase title="Connect" note="Nothing works without these two." />

        <Step n={1} title="Connect your Moodle" done={moodleDone} required>
          {moodleDone ? (
            <ConnectedMoodle status={status} onChange={refresh} />
          ) : (
            <MoodleConnect initialUrl={status.moodle.url} onDone={refresh} />
          )}
          {!moodleDone && status.moodle.error && (
            <Notice tone="warn" className="mt-4">
              Saved credentials aren't working: {status.moodle.error}
            </Notice>
          )}
        </Step>

        <Step n={2} title="Add an OpenAI key" done={keyDone} required>
          {keyDone ? (
            <p className="text-sm text-ink-muted">
              Key saved. Transcripts, study notes, cheat sheets, flashcards and chat are all live.
            </p>
          ) : (
            <OpenAiKey onDone={refresh} />
          )}
        </Step>

        <Phase
          title="Fill in your semester"
          note="Each of these feeds the calendar, the workload heatmap and the weekly digest."
        />

        <Step n={3} title="Import your timetable" done={timetableDone}>
          {timetableDone && !status.timetable.url && (
            <Notice className="mb-4">
              Found {status.timetable.classes} classes from a <Chip>.ics</Chip> file in the project
              folder. Paste the subscribe link below instead and it'll stay current on its own.
            </Notice>
          )}
          <Timetable initialUrl={status.timetable.url} onDone={refresh} />
        </Step>

        <Step n={4} title="Lecture recordings" done={status.echo360}>
          <Lectures connected={status.echo360} ffmpeg={status.deps.ffmpeg} />
        </Step>

        <Step n={5} title="Download your course files" done={status.materials > 0}>
          <Materials count={status.materials} onDone={refresh} />
        </Step>

        <Step n={6} title="Weightings, so grades can be calculated" done={status.grades.weighted > 0}>
          <Grades grades={status.grades} onDone={refresh} />
        </Step>

        <Step n={7} title="Your life outside class" done={status.commitments > 0}>
          <Life count={status.commitments} />
        </Step>

        <Phase title="Keep it flowing" note="Set these once and they run on their own." />

        <Step n={8} title="Send deadlines to your calendar" done={syncDone}>
          <Sync sync={status.sync} />
        </Step>

        <Step n={9} title="Weekly digest email" done={status.digest}>
          <Digest enabled={status.digest} />
        </Step>
      </div>

      <Finish ready={ready} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Phase({ title, note }: { title: string; note: string }) {
  return (
    <div className="pt-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{title}</h2>
      <p className="mt-1 text-[13px] text-ink-muted">{note}</p>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  required = false,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-xs font-semibold ${
            done ? "bg-accent text-ink" : "bg-chip text-ink-muted"
          }`}
        >
          {done ? <Check /> : n}
        </span>
        <h2 className="flex-1 font-display text-[17px] font-bold tracking-tight text-ink">{title}</h2>
        {done ? (
          <Badge tone="green">done</Badge>
        ) : required ? (
          <Badge tone="amber">needed</Badge>
        ) : (
          <Badge>optional</Badge>
        )}
      </div>
      {children}
    </Card>
  );
}

function Prerequisites({ deps }: { deps: SetupStatus["deps"] }) {
  const major = Number((deps.node.match(/^v(\d+)/) ?? [])[1] ?? 0);
  const nodeOk = major >= 20;
  if (nodeOk && deps.ffmpeg) return null;

  return (
    <Notice tone="warn">
      <div className="font-medium">Two things to install first</div>
      <ul className="mt-2 space-y-1.5">
        {!nodeOk && (
          <li>
            Node {deps.node} is too old — this needs 20 or newer. Grab it from nodejs.org, then
            restart <Chip>npm run dev</Chip>.
          </li>
        )}
        {!deps.ffmpeg && (
          <li>
            <strong className="font-semibold">ffmpeg</strong> isn't installed, so lecture audio can't
            be transcribed. Run <Chip>brew install ffmpeg</Chip> (macOS) or{" "}
            <Chip>sudo apt install ffmpeg</Chip> (Linux), then restart the server. Everything else
            works without it.
          </li>
        )}
      </ul>
    </Notice>
  );
}

function ConnectedMoodle({ status, onChange }: { status: SetupStatus; onChange: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true);
    setResult(null);
    try {
      const r = await api.sync();
      setResult(
        r.ok
          ? `Pulled ${r.counts?.courses ?? 0} courses and ${r.counts?.events ?? 0} calendar items.`
          : `Sync failed: ${r.error}`,
      );
    } catch (e) {
      setResult(`Sync failed: ${e}`);
    } finally {
      setSyncing(false);
      onChange();
    }
  }

  return (
    <div>
      <p className="text-sm text-ink-muted">
        Connected to <strong className="font-semibold text-ink">{status.moodle.site}</strong>
        {status.moodle.user ? ` as ${status.moodle.user}` : ""}.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={syncNow} disabled={syncing}>
          {syncing ? "Pulling your courses…" : "Pull my courses now"}
        </Button>
        {result && <span className="text-[13px] text-ink-muted">{result}</span>}
      </div>
    </div>
  );
}

const METHODS = [
  { key: "signin" as const, label: "Sign in" },
  { key: "token" as const, label: "Paste a token" },
];

/**
 * Find it for them.
 *
 * "Your Moodle address" assumes the student has ever looked at it, and most
 * haven't — they arrive from a bookmark or a portal tile and the hostname is
 * something nobody memorises. Being stuck on the first field of setup is the
 * worst place to be stuck, so this asks for the one thing every student knows
 * and goes looking.
 */
function MoodleFinder({ onPick }: { onPick: (url: string) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.setupMoodleFind>> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await api.setupMoodleFind(email.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-field border border-hair bg-chip/40 p-4">
      <div className="mb-1 text-[13px] font-medium text-ink">Don't know your Moodle address?</div>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">
        Type your university email and it'll go and look. Nothing is sent anywhere except your own
        university's servers.
      </p>
      <div className="flex flex-wrap gap-2">
        <div className="min-w-[15rem] flex-1">
          <Input
            density="sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && email.trim() && !busy && find()}
            placeholder="you@student.your-uni.ac.nz"
            aria-label="Your university email address"
          />
        </div>
        <Button size="sm" onClick={find} disabled={!email.trim() || busy}>
          {busy ? "Looking…" : "Find it"}
        </Button>
      </div>

      {err && <p className="mt-2 text-[12px] text-rose-700">{err}</p>}

      {result && result.sites.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {result.sites.map((site) => (
            <button
              key={site.url}
              onClick={() => onPick(site.url)}
              className="flex w-full items-start gap-2.5 rounded-field border border-hair bg-surface px-3 py-2.5 text-left transition duration-200 hover:border-accent-deep"
            >
              <span className="mt-0.5 text-sm" aria-hidden="true">
                {site.webServices ? "✓" : "!"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {site.name ?? site.url.replace(/^https?:\/\//, "")}
                </span>
                <span className="block truncate font-mono text-[11px] text-ink-muted">
                  {site.url}
                </span>
                {/* The thing that actually decides whether this app can work,
                    said here rather than discovered three steps later. */}
                {site.note && (
                  <span className="mt-1 block text-[12px] leading-snug text-amber-800">
                    {site.note}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[12px] font-medium text-accent-deep">Use this</span>
            </button>
          ))}
        </div>
      )}

      {result && result.sites.length === 0 && result.advice && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">{result.advice}</p>
      )}
    </div>
  );
}

function MoodleConnect({ initialUrl, onDone }: { initialUrl: string; onDone: () => void }) {
  const [method, setMethod] = useState<"signin" | "token">("signin");
  const [url, setUrl] = useState(initialUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suggestFallback, setSuggestFallback] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    setSuggestFallback(false);
    try {
      if (method === "signin") await api.setupMoodleLogin(url, username, password);
      else await api.setupMoodleToken(url, token);
      setPassword("");
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      // The server flags cases where password sign-in can't work on this site.
      if (method === "signin") setSuggestFallback(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <MoodleFinder onPick={setUrl} />

      <Field
        label="Your Moodle address"
        hint="Or paste any page from it — a course, the dashboard, the login screen."
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="learn.your-uni.ac.nz"
          aria-label="Moodle address"
        />
      </Field>

      <div className="mb-4 mt-5">
        <Tabs tabs={METHODS} value={method} onChange={setMethod} />
      </div>

      {method === "signin" ? (
        <>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
            Moodle mints a token for you — the same way the official Moodle app signs in. Your
            password is sent once to your own university and{" "}
            <strong className="font-semibold text-ink">is never saved</strong>.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="abc123"
                aria-label="Moodle username"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-label="Moodle password"
              />
            </Field>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            Use this if your university logs in through Microsoft, Google or Okta — password sign-in
            can't work through those.
          </p>
          <ol className="mb-4 space-y-2 text-[13px] leading-relaxed text-ink-muted">
            <li>
              <span className="font-medium text-ink">1.</span> Open{" "}
              <Chip>{(url || "your-moodle") + "/user/managetoken.php"}</Chip> — or in Moodle:{" "}
              <span className="text-ink">your avatar → Preferences → Security keys</span>.
            </li>
            <li>
              <span className="font-medium text-ink">2.</span> Find the row for{" "}
              <span className="text-ink">Moodle mobile web service</span>.
            </li>
            <li>
              <span className="font-medium text-ink">3.</span> Copy the 32-character key and paste it
              below.
            </li>
          </ol>
          <Field label="Token">
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="32 letters and numbers"
              spellCheck={false}
              aria-label="Moodle web services token"
            />
          </Field>
          <ClaudePrompt url={url} />
        </>
      )}

      {err && (
        <Notice tone="error" className="mt-4">
          {err}
          {suggestFallback && (
            <>
              {" "}
              <button
                className="font-medium underline"
                onClick={() => {
                  setMethod("token");
                  setErr(null);
                }}
              >
                Try the token method instead
              </button>
            </>
          )}
        </Notice>
      )}

      <div className="mt-5">
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !url.trim() || (method === "signin" ? !username || !password : !token.trim())}
        >
          {busy ? "Checking…" : "Connect Moodle"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Fallback for sites whose Security-keys page is hard to find. Points an
 * in-browser assistant at the real token page rather than scraping session
 * cookies — the token is the user's own, shown on their own screen.
 */
function ClaudePrompt({ url }: { url: string }) {
  const site = url.trim() || "https://learn.your-uni.edu";
  const prompt = `I'm logged into my university's Moodle at ${site} and I need my own Web Services token so a study app on my laptop can read my courses.

1. Go to ${site}/user/managetoken.php (it's also under: my avatar -> Preferences -> Security keys).
2. Find the row whose Service is "Moodle mobile web service".
3. Tell me the value in the Key column - it's 32 letters and numbers.

If that page shows no tokens, say so rather than guessing, and tell me whether there's a "reset" or "create token" link on it. Don't read anything else from the page.`;

  return (
    <Details summary="Can't find the Security keys page?" className="mt-4">
      Paste this into Claude in Chrome (or any browser assistant) while logged into Moodle, and it
      will walk you to the token:
      <CopyBlock text={prompt} />
    </Details>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3">
      <pre className="pane max-h-56 whitespace-pre-wrap rounded-field bg-chip p-3.5 font-mono text-[12px] leading-relaxed text-ink-soft">
        {text}
      </pre>
      <Button
        size="sm"
        className="mt-2"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy prompt"}
      </Button>
    </div>
  );
}

function OpenAiKey({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.setupOpenai(key);
      setKey("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        Powers transcription, study notes, cheat sheets, flashcards and chat. Create one at{" "}
        <a
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-deep hover:underline"
        >
          platform.openai.com/api-keys
        </a>
        . It's stored in this repo's <Chip>.env</Chip> and used only from your machine.
      </p>
      <Field label="API key">
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-…"
          spellCheck={false}
          aria-label="OpenAI API key"
        />
      </Field>
      {err && <Notice tone="error" className="mt-4">{err}</Notice>}
      <div className="mt-5">
        <Button variant="primary" onClick={save} disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save key"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The file path.
 *
 * Some timetabling systems only offer a download, and some "subscribe" links sit
 * behind a login, so pasting one fetches a sign-in page instead of a calendar.
 * Either way the student ends up holding a .ics with nowhere to put it — the
 * previous answer was "drop it in the repo folder", which is not a thing most
 * people will do.
 */
function TimetableUpload({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/setup/timetable/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Upload failed (${res.status})`);
      setMsg({
        ok: true,
        text: `Imported ${json.classes} classes from ${json.filename}. A file is a snapshot, so re-upload it if your classes change.`,
      });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <input
        ref={fileRef}
        type="file"
        accept=".ics,text/calendar"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-muted">Only offered a download?</span>
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Reading…" : "Upload a .ics file"}
        </Button>
      </div>
      {msg && (
        <p
          className={`mt-2 text-[12px] leading-relaxed ${msg.ok ? "text-ink-muted" : "text-rose-700"}`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Timetable({ initialUrl, onDone }: { initialUrl: string; onDone: () => void }) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [classes, setClasses] = useState<number | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    setClasses(null);
    try {
      const r = await api.setupTimetable(url);
      setClasses(r.classes);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        Your Moodle knows your deadlines but not when your classes are. Your university's timetable
        site publishes a subscribe link that fills in today's schedule, rooms, the week grid, and the
        contact hours in your workload heatmap.
      </p>
      <Field label="Timetable iCal URL" hint="Starts with https:// or webcal://">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mytimetable.your-uni.edu/…/timetable.ics"
          spellCheck={false}
          aria-label="Timetable iCal URL"
        />
      </Field>

      <TimetableUpload onDone={onDone} />

      <Details summary="Where do I find that link?" className="mt-4">
        <div className="space-y-2">
          <p>
            On your timetable site, look for <span className="text-ink">Export</span>,{" "}
            <span className="text-ink">Subscribe</span>,{" "}
            <span className="text-ink">Add to calendar</span> or an{" "}
            <span className="text-ink">iCal / .ics</span> option — usually near the top of the week
            view.
          </p>
          <p>
            If yours is <span className="text-ink">MyTimetable</span> or{" "}
            <span className="text-ink">Allocate+</span>, it's behind the calendar icon.{" "}
            <span className="text-ink">Celcat</span> and <span className="text-ink">TimeEdit</span>{" "}
            use a “Subscribe” button. <span className="text-ink">Syllabus+</span> often only offers a
            download — use <span className="text-ink">Upload a .ics file</span> above for that.
          </p>
          <p>
            A link beats a file because it re-syncs when your classes move. But a link that needs a
            login won't work from here — if pasting it returns a web page, download the file instead.
          </p>
        </div>
      </Details>

      {err && <Notice tone="error" className="mt-4">{err}</Notice>}
      {classes !== null && (
        <Notice className="mt-4">
          {classes > 0
            ? `Imported ${classes} class sessions. They're on your calendar, today's schedule and the heatmap now.`
            : "That feed parsed but had no classes in the next 16 weeks — it may be last semester's link."}
        </Notice>
      )}

      <div className="mt-5">
        <Button variant="primary" onClick={save} disabled={busy || !url.trim()}>
          {busy ? "Importing…" : initialUrl ? "Re-import" : "Import timetable"}
        </Button>
      </div>
    </div>
  );
}

function Lectures({ connected, ffmpeg }: { connected: boolean; ffmpeg: boolean }) {
  const nav = useNavigate();
  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        {connected
          ? "Echo360 is connected — new recordings download and transcribe themselves each launch, then get study notes and a flashcard deck."
          : "If your lectures are recorded in Echo360, connecting it once means every new recording downloads, transcribes, and turns into notes and flashcards on its own. You can skip this and do it later."}
      </p>
      {!ffmpeg && !connected && (
        <Notice tone="warn" className="mb-4">
          Install ffmpeg first, or audio can't be transcribed.
        </Notice>
      )}
      <Button onClick={() => nav("/settings")}>
        {connected ? "Manage in Settings" : "Set up Echo360 in Settings"}
      </Button>
    </div>
  );
}

function Materials({ count, onDone }: { count: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.materialsSync();
      setMsg(
        r.downloaded > 0
          ? `Downloaded ${r.downloaded} files into ${r.root}, sorted into week folders.`
          : r.found > 0
            ? `Found ${r.found} files, all already downloaded.`
            : "No downloadable files found in your active courses yet.",
      );
      onDone();
    } catch (e) {
      setMsg(`Couldn't download: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        {count > 0
          ? `${count} files downloaded and filed by course and week. New ones arrive automatically each launch.`
          : "Pulls every slide deck, reading and handout out of Moodle and files them by course and week — a real folder you can browse, plus the text extracted so flashcards and chat can use it."}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={count > 0 ? "outline" : "primary"} onClick={run} disabled={busy}>
          {busy ? "Downloading…" : count > 0 ? "Check for new files" : "Download my course files"}
        </Button>
        {count > 0 && (
          <Link to="/materials" className="text-[13px] font-medium text-accent-deep hover:underline">
            Browse them →
          </Link>
        )}
      </div>
      {msg && <Notice className="mt-4">{msg}</Notice>}
    </div>
  );
}

function Grades({ grades, onDone }: { grades: SetupStatus["grades"]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.gradesSync();
      setMsg(
        r.weighted > 0
          ? `Found ${r.items} graded items, ${r.weighted} with weightings. The calculator's live.`
          : `Found ${r.items} items but no weightings — your gradebook doesn't publish them. Type them in on the Grades page from your course outline; it's a two-minute job you do once.`,
      );
      onDone();
    } catch (e) {
      setMsg(`Couldn't read the gradebook: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        {grades.weighted > 0
          ? `${grades.weighted} of ${grades.items} assessments have a weighting, so “what do I need on the final to get an A?” has a real answer.`
          : "Pulls your marks and weightings from the Moodle gradebook. With weightings in place the app can tell you exactly what you need on each remaining assessment to hit a given grade — and warn you when a target slips out of reach."}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={grades.weighted > 0 ? "outline" : "primary"} onClick={run} disabled={busy}>
          {busy ? "Reading gradebook…" : "Pull my grades"}
        </Button>
        <Link to="/grades" className="text-[13px] font-medium text-accent-deep hover:underline">
          Open Grades →
        </Link>
      </div>
      {grades.weighted > 0 && grades.targets === 0 && (
        <Notice className="mt-4">
          Last thing: set the grade you're aiming for in each course, and the app will tell you what
          it takes — and speak up in the weekly email if it's slipping.
        </Notice>
      )}
      {msg && <Notice className="mt-4">{msg}</Notice>}
    </div>
  );
}

function Life({ count }: { count: number }) {
  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        {count > 0
          ? `${count} commitment${count === 1 ? "" : "s"} recorded. They show on the week grid and count towards your workload.`
          : "A workload chart that ignores your job is fiction. Add the weekly pattern — shifts, training, family — and the heatmap tells you which weeks are actually going to hurt, not just which ones have deadlines."}
      </p>
      <Link to="/calendar">
        <Button variant={count > 0 ? "outline" : "primary"}>
          {count > 0 ? "Manage in the week view" : "Add my commitments"}
        </Button>
      </Link>
    </div>
  );
}

function Sync({ sync }: { sync: SetupStatus["sync"] }) {
  const connected = [
    sync.google && "Google Calendar",
    sync.apple && "Apple Calendar",
    sync.notion && "Notion",
  ].filter(Boolean) as string[];

  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        {connected.length
          ? `Syncing to ${connected.join(" and ")}. Deadlines update in place after every sync, and cancelled ones are removed.`
          : "Every deadline, exam and opening date, pushed where you already look. Google Calendar and Notion connect properly; Apple Calendar subscribes to a feed that refreshes hourly even when this app is closed."}
      </p>
      <ul className="mb-4 space-y-1.5 text-[13px] text-ink-muted">
        <li>
          <strong className="font-semibold text-ink">Google Calendar</strong> — writes to its own “Uni
          Study” calendar so you can hide it in one click.
        </li>
        <li>
          <strong className="font-semibold text-ink">Apple Calendar</strong> — one subscription link,
          with alarms at your reminder lead time.
        </li>
        <li>
          <strong className="font-semibold text-ink">Notion</strong> — builds a deadlines database
          with course, type, weighting and status.
        </li>
      </ul>
      <Link to="/settings">
        <Button variant={connected.length ? "outline" : "primary"}>
          {connected.length ? "Manage sync" : "Choose where deadlines go"}
        </Button>
      </Link>
    </div>
  );
}

function Digest({ enabled }: { enabled: boolean }) {
  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        {enabled
          ? "On. You'll get the week's rundown before it starts."
          : "One email on Sunday night: what's due, how heavy the week looks compared with the last one, what's new since you last checked, cards waiting, and any grade target that's slipping. Sent through your own mail account — nothing passes through a third party."}
      </p>
      <Link to="/settings">
        <Button variant={enabled ? "outline" : "primary"}>
          {enabled ? "Change the schedule" : "Set up the weekly email"}
        </Button>
      </Link>
    </div>
  );
}

function Finish({ ready }: { ready: boolean }) {
  const nav = useNavigate();
  return (
    <div className="mt-8 border-t border-hair pt-6">
      {ready ? (
        <>
          <p className="mb-4 text-sm text-ink-muted">
            The essentials are done — everything else can be picked up whenever, from Settings or the
            page it belongs to.
          </p>
          <Button variant="primary" onClick={() => nav("/")}>
            Go to my dashboard
          </Button>
        </>
      ) : (
        <p className="text-sm text-ink-muted">
          Steps 1 and 2 are the ones that matter — the rest can wait.
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

function Check() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

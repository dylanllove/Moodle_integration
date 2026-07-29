import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
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

  return (
    <div className="max-w-3xl">
      <PageHeader
        size="hero"
        title={
          <>
            Let's get you <span className="swash">connected</span>
          </>
        }
        subtitle={
          <>
            Four steps, mostly copy-and-paste. Everything stays on this machine — your credentials go
            straight to your university and OpenAI, never anywhere else.
          </>
        }
      />

      <div className="space-y-4">
        <Prerequisites deps={status.deps} />

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
              Key saved. Transcripts, study notes, cheat sheets and chat are all live.
            </p>
          ) : (
            <OpenAiKey onDone={refresh} />
          )}
        </Step>

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
      </div>

      <Finish ready={ready} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

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
      <Field label="Your Moodle address" hint="The page you normally log in to.">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="learn.canterbury.ac.nz"
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
        Powers transcription, study notes, cheat sheets and chat. Create one at{" "}
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
        site publishes a subscribe link that fills in today's schedule, rooms and lecture times.
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

      <Details summary="Where do I find that link?" className="mt-4">
        On your university's timetable site, look for <span className="text-ink">Export</span>,{" "}
        <span className="text-ink">Subscribe</span>, <span className="text-ink">Add to calendar</span>{" "}
        or an <span className="text-ink">iCal / .ics</span> option — usually near the top of your
        weekly view. Copy the link it gives you rather than downloading the file. If you only have a
        downloaded <Chip>.ics</Chip> file, drop it in the repo folder and it'll be picked up
        automatically. A link is better: it re-syncs when your classes change.
      </Details>

      {err && <Notice tone="error" className="mt-4">{err}</Notice>}
      {classes !== null && (
        <Notice className="mt-4">
          {classes > 0
            ? `Imported ${classes} class sessions. They're on your calendar and today's schedule now.`
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
          ? "Echo360 is connected — new recordings download and transcribe themselves each time the app starts."
          : "If your lectures are recorded in Echo360, connecting it once means every new recording downloads and transcribes itself on launch. You can skip this and do it later."}
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

function Finish({ ready }: { ready: boolean }) {
  const nav = useNavigate();
  return (
    <div className="mt-8 border-t border-hair pt-6">
      {ready ? (
        <>
          <p className="mb-4 text-sm text-ink-muted">
            That's the essentials done. You can change any of it later in Settings.
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

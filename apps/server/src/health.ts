import { spawn } from "node:child_process";
import { getSetting, setSetting } from "@uni/db";
import { localStatus } from "@uni/ai";
import { localTranscriber, whisperCppBinary } from "@uni/transcribe";
import {
  acquireEchoContext,
  echoConnected,
  ensureEchoLoggedIn,
  moodleApiConfigured,
  moodleWs,
  persistEchoSession,
  withEchoLock,
} from "@uni/lms";
import { syncRunning } from "./sync-job.js";

/**
 * Is each thing the app depends on actually working — not just configured?
 *
 * "Connected via API token" used to mean "there is a token in .env". A token
 * Moodle had revoked a month earlier still said connected, and the sync reported
 * "nothing new" on every run, so the only symptom was lectures quietly stopping.
 * Every check here makes a real (read-only, free) request and says in plain
 * words what's wrong and what to do about it.
 */

export type CheckState = "ok" | "broken" | "missing" | "optional";

export interface Check {
  key: "moodle" | "echo360" | "openai" | "whisper" | "ffmpeg" | "ollama";
  label: string;
  state: CheckState;
  detail: string;
  /** What the student should do, when there's something to do. */
  fix?: string;
  /** In-app place to do it. */
  to?: string;
}

export interface Health {
  checkedAt: string;
  ok: boolean;
  checks: Check[];
}

let last: Health | null = null;
let running: Promise<Health> | null = null;
const TTL_MS = 5 * 60_000;

/**
 * The last result, re-checked when stale. `deep` also opens Echo360 in the
 * background browser, which takes a few seconds — worth it when someone presses
 * "Check connections", not on every page load.
 */
export function connectionHealth(opts: { force?: boolean; deep?: boolean } = {}): Promise<Health> {
  if (!opts.force && last && Date.now() - Date.parse(last.checkedAt) < TTL_MS) return Promise.resolve(last);
  // A page load never waits behind a slow check already in progress; the
  // previous answer is good enough for that.
  if (running) return !opts.force && last ? Promise.resolve(last) : running;
  // A running sync holds the Echo360 browser for minutes at a time and is
  // exercising the session anyway — it records the outcome through
  // noteConnection, so read that instead of queueing behind it.
  const deep = (opts.deep ?? false) && !syncRunning();
  running = (async () => {
    const checks = await Promise.all([
      checkMoodle(),
      checkEcho(deep),
      checkOpenAi(),
      checkWhisper(),
      checkFfmpeg(),
      checkOllama(),
    ]);
    last = {
      checkedAt: new Date().toISOString(),
      ok: checks.every((c) => c.state === "ok" || c.state === "optional"),
      checks,
    };
    return last;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Called by the sync when it learns something, so the banner doesn't wait for a re-check. */
export function noteConnection(key: "moodle" | "echo360", ok: boolean, detail?: string): void {
  setSetting(`${key}_health`, JSON.stringify({ ok, detail: detail ?? null, at: new Date().toISOString() }));
  last = null;
}

/** Something changed that a cached check can't know about (a new key was saved). */
export function forgetConnectionCheck(): void {
  last = null;
}

function remembered(key: "moodle" | "echo360"): { ok: boolean; detail: string | null } | null {
  try {
    const raw = getSetting(`${key}_health`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function checkMoodle(): Promise<Check> {
  const base: Pick<Check, "key" | "label" | "to"> = { key: "moodle", label: "Moodle", to: "/setup" };
  if (!moodleApiConfigured()) {
    return { ...base, state: "missing", detail: "Not connected yet.", fix: "Sign in to Moodle in setup." };
  }
  try {
    const info = await moodleWs<{ sitename?: string; fullname?: string }>("core_webservice_get_site_info");
    noteConnection("moodle", true);
    return { ...base, state: "ok", detail: `Signed in as ${info.fullname ?? "you"} on ${info.sitename ?? "Moodle"}.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/invalidtoken|accessexception|invalidlogin/i.test(msg)) {
      noteConnection("moodle", false, "expired");
      return {
        ...base,
        state: "broken",
        detail: "Moodle no longer accepts the saved sign-in (the token was revoked or expired).",
        fix: "Sign in to Moodle again in setup — it takes a few seconds and nothing else is lost.",
      };
    }
    return {
      ...base,
      state: "broken",
      detail: `Couldn't reach Moodle: ${msg.slice(0, 140)}`,
      fix: "Check your internet connection (and VPN, if your university needs one).",
    };
  }
}

async function checkEcho(deep: boolean): Promise<Check> {
  const base: Pick<Check, "key" | "label" | "to"> = { key: "echo360", label: "Echo360 recordings", to: "/settings" };
  if (!echoConnected()) {
    return {
      ...base,
      state: "missing",
      detail: "Not signed in, so no lecture recordings are being picked up.",
      fix: "Sign in to Echo360 from Settings.",
    };
  }
  if (!deep) {
    const r = remembered("echo360");
    if (r && !r.ok) {
      return {
        ...base,
        state: "broken",
        detail: "The saved Echo360 session has expired.",
        fix: "Sign in to Echo360 again from Settings.",
      };
    }
    return { ...base, state: "ok", detail: r ? `Session working as of the last check.` : "Session saved." };
  }
  // A real authenticated page load, under the same lock as everything else that
  // drives the Echo browser, with the refreshed cookies written back.
  const result = await withEchoLock(async () => {
    const acquired = await acquireEchoContext().catch(() => null);
    if (!acquired) return { ok: false, reason: "no usable session" };
    try {
      const live = await ensureEchoLoggedIn(acquired.ctx);
      await persistEchoSession(acquired.ctx).catch(() => {});
      return live;
    } finally {
      await acquired.done();
    }
  });
  if (result.ok) {
    noteConnection("echo360", true);
    return { ...base, state: "ok", detail: "Signed in — recordings will be picked up on each sync." };
  }
  if (result.reason?.startsWith("unreachable")) {
    return { ...base, state: "broken", detail: "Couldn't reach Echo360 just now.", fix: "Check your connection and try again." };
  }
  noteConnection("echo360", false, result.reason);
  return {
    ...base,
    state: "broken",
    detail: "The saved Echo360 session has expired.",
    fix: "Sign in to Echo360 again from Settings.",
  };
}

async function checkOpenAi(): Promise<Check> {
  const base: Pick<Check, "key" | "label" | "to"> = { key: "openai", label: "OpenAI", to: "/setup" };
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      ...base,
      state: "optional",
      detail: "No key — fine if a local model handles notes, but nothing paid will run.",
    };
  }
  try {
    // Listing models is free and proves the key without spending anything.
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      return { ...base, state: "broken", detail: "OpenAI rejected the key.", fix: "Paste a fresh key in setup." };
    }
    if (!res.ok) return { ...base, state: "broken", detail: `OpenAI answered ${res.status}.` };
    return { ...base, state: "ok", detail: "Key accepted." };
  } catch {
    return { ...base, state: "broken", detail: "Couldn't reach OpenAI.", fix: "Check your internet connection." };
  }
}

async function checkWhisper(): Promise<Check> {
  const base: Pick<Check, "key" | "label" | "to"> = { key: "whisper", label: "Free local transcription", to: "/settings" };
  const found = await localTranscriber(true);
  if (found) {
    return {
      ...base,
      state: "ok",
      detail: `Ready (${found.model?.split("/").pop() ?? found.engine}${found.vadModel ? ", skips silence" : ""}).`,
    };
  }
  const pref = getSetting("transcribe_provider");
  const binary = await whisperCppBinary();
  return {
    ...base,
    // Local-only with no model means lectures will wait — that's broken, not optional.
    state: pref === "local" ? "broken" : "missing",
    detail: binary ? "whisper.cpp is installed but its model isn't downloaded." : "whisper.cpp isn't installed.",
    fix: binary
      ? "Press “Download model” under AI cost in Settings (~550 MB, one-off)."
      : "Run `brew install whisper-cpp`, then download the model from Settings.",
  };
}

function checkFfmpeg(): Promise<Check> {
  const base: Pick<Check, "key" | "label"> = { key: "ffmpeg", label: "ffmpeg (audio)" };
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () =>
      resolve({ ...base, state: "broken", detail: "Not installed — recordings can't be read.", fix: "Run `brew install ffmpeg`." }),
    );
    p.on("close", (code) =>
      resolve(code === 0 ? { ...base, state: "ok", detail: "Installed." } : { ...base, state: "broken", detail: "ffmpeg failed to start." }),
    );
  });
}

async function checkOllama(): Promise<Check> {
  const local = await localStatus(true);
  return local.ok
    ? { key: "ollama", label: "Local AI model", state: "ok", detail: `Running (${local.models[0] ?? "model"}).` }
    : {
        key: "ollama",
        label: "Local AI model",
        state: "optional",
        detail: "Not running — notes and flashcards use OpenAI (about a cent a lecture).",
      };
}

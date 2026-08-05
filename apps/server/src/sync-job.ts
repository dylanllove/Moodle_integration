import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@uni/db";
import { resetSourceCache } from "./sources.js";

/**
 * The one sync.
 *
 * There used to be two: a full pipeline on launch, and a "Sync Moodle" button
 * that only refreshed courses and deadlines — so pressing the obvious button
 * quietly did less than doing nothing and restarting. Both now run this, and it
 * reports where it's up to, because a sync that pulls a semester of slide decks
 * is not something to represent as a spinner.
 */
export type PhaseStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface SyncPhase {
  key: string;
  label: string;
  status: PhaseStatus;
  /** One line of outcome: "4 courses, 12 deadlines" or why it was skipped. */
  detail: string | null;
}

export interface SyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phases: SyncPhase[];
  error: string | null;
}

const PHASES: { key: string; label: string }[] = [
  { key: "personal", label: "Your commitments" },
  { key: "moodle", label: "Moodle courses & deadlines" },
  { key: "grades", label: "Gradebook" },
  { key: "materials", label: "Course files" },
  { key: "index", label: "Search index" },
  { key: "push", label: "Calendar & Notion" },
  { key: "echo", label: "Echo360 lectures" },
  { key: "transcripts", label: "Transcripts & notes" },
];

let state: SyncState = idle();
let inFlight: Promise<SyncState> | null = null;

function idle(): SyncState {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    phases: PHASES.map((p) => ({ ...p, status: "pending" as PhaseStatus, detail: null })),
    error: null,
  };
}

export function syncState(): SyncState {
  return state;
}

export function syncRunning(): boolean {
  return state.running;
}

function set(key: string, status: PhaseStatus, detail: string | null = null): void {
  const phase = state.phases.find((p) => p.key === key);
  if (phase) {
    phase.status = status;
    phase.detail = detail;
  }
}

/**
 * Run every step, in order. A step that fails is recorded and the rest carry on
 * — a Notion token that expired shouldn't cost you your lecture transcripts.
 * Concurrent callers join the run already in progress rather than starting a
 * second one over the same database.
 */
export function runFullSync(app: FastifyInstance): Promise<SyncState> {
  if (inFlight) return inFlight;
  inFlight = execute(app).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function execute(app: FastifyInstance): Promise<SyncState> {
  state = idle();
  state.running = true;
  state.startedAt = new Date().toISOString();

  const step = async (
    key: string,
    fn: () => Promise<string | null>,
    skipReason?: () => string | null,
  ): Promise<void> => {
    const skip = skipReason?.();
    if (skip) return set(key, "skipped", skip);
    set(key, "running");
    try {
      set(key, "done", await fn());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      app.log.warn(`Sync step ${key} failed: ${message}`);
      set(key, "error", message.slice(0, 200));
    }
  };

  try {
    const lms = await import("@uni/lms");

    // Local, so it runs even with nothing connected: the week view and heatmap
    // shouldn't run dry just because Moodle isn't set up.
    await step("personal", async () => {
      const { occurrences } = lms.syncPersonal();
      return occurrences ? `${occurrences} occurrences rebuilt` : "none set up yet";
    });

    const moodleReady = lms.moodleApiConfigured();

    await step(
      "moodle",
      async () => {
        const r = (await lms.sync()) as { counts?: Record<string, number> };
        const c = r.counts ?? {};
        setSetting("last_synced", new Date().toISOString());
        resetSourceCache();
        return summarise(c);
      },
      () => (moodleReady ? null : "Moodle isn't connected yet"),
    );

    await step(
      "grades",
      async () => {
        return summarise({ ...(await lms.syncGrades()) });
      },
      () => (moodleReady ? null : "needs Moodle"),
    );

    await step(
      "materials",
      async () => {
        const { extractFileText } = await import("./extract.js");
        const m = (await lms.syncMaterials({ extractText: extractFileText })) as {
          found: number;
          downloaded: number;
          failed: number;
        };
        return m.downloaded > 0
          ? `${m.downloaded} new file${m.downloaded === 1 ? "" : "s"} of ${m.found}`
          : `${m.found} files, all current`;
      },
      () =>
        !moodleReady
          ? "needs Moodle"
          : getSetting("auto_materials") === "false"
            ? "turned off in Settings"
            : null,
    );

    // After the files land, not before — otherwise everything downloaded this
    // run stays invisible to search and the assistant until the next one.
    await step("index", async () => {
      const { indexAll } = await import("@uni/ai");
      const { chunks } = indexAll();
      return `${chunks} passages indexed`;
    });

    await step(
      "push",
      async () => {
        const out: string[] = [];
        const { pushToGoogleCalendar, googleConnected } = await import("./google.js");
        if (googleConnected()) {
          await pushToGoogleCalendar();
          out.push("Google Calendar");
        }
        const { notionConnected } = await import("./notion-links.js");
        const { syncNotion } = await import("./notion-sync.js");
        if (notionConnected()) {
          const r = await syncNotion();
          // Say which way things actually moved — a pull is the interesting one.
          out.push(r.pulled ? `Notion (${r.pulled} pulled back)` : "Notion");
        }
        return out.length ? `pushed to ${out.join(" & ")}` : "nothing connected";
      },
      () => (getSetting("auto_push_on_sync") === "false" ? "turned off in Settings" : null),
    );

    await step(
      "echo",
      async () => {
        const res = await app.inject({ method: "POST", url: "/api/echo360/sync" });
        const body = JSON.parse(res.body || "{}") as {
          error?: string;
          counts?: { lessons: number; sections: number; transcribed: number; failed: number };
        };
        if (body.error) throw new Error(body.error);
        const c = body.counts;
        if (!c) return "up to date";
        return c.transcribed > 0
          ? `${c.transcribed} newly transcribed of ${c.lessons} recording${c.lessons === 1 ? "" : "s"}`
          : `${c.lessons} recording${c.lessons === 1 ? "" : "s"}, all current`;
      },
      () => (lms.echoConnected() ? null : "Echo360 isn't connected"),
    );

    // Everything still missing a transcript, whatever it came from — Echo
    // lessons that weren't ready last time, uploads, and the slide decks Moodle
    // files as lectures. Runs even with no Echo360, because most of that list
    // has nothing to do with Echo360.
    let newTranscripts = 0;
    await step("transcripts", async () => {
      const { backfillTranscripts } = await import("./transcripts.js");
      const r = await backfillTranscripts(app);
      newTranscripts = r.transcribed;
      if (!r.attempted) {
        return r.noted ? `notes written for ${r.noted}` : "everything's transcribed";
      }
      const parts = [`${r.transcribed} new`];
      if (r.stillWaiting) parts.push(`${r.stillWaiting} not published yet`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.deferred) parts.push(`${r.deferred} queued for next run`);
      if (r.noted) parts.push(`notes for ${r.noted}`);
      return parts.join(", ");
    });

    // The index only sees what existed when it ran; a transcript that landed in
    // the step above would otherwise stay unsearchable until the next sync.
    if (newTranscripts > 0) {
      try {
        const { indexAll } = await import("@uni/ai");
        indexAll();
      } catch {
        /* non-fatal — the next run will pick it up */
      }
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    app.log.warn(`Sync aborted: ${state.error}`);
  }

  state.running = false;
  state.finishedAt = new Date().toISOString();
  return state;
}

/** "3 courses, 12 assignments" from a counts object, skipping the zeroes. */
function summarise(counts: Record<string, unknown>): string {
  const parts = Object.entries(counts)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${v} ${k}`);
  return parts.length ? parts.join(", ") : "nothing new";
}

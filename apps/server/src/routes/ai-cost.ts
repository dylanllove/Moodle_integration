import type { FastifyInstance } from "fastify";
import { getDb, getSetting, setSetting } from "@uni/db";
import { connectionHealth } from "../health.js";
import { aiHealth, budgetUsd, cacheStats, clearCache, complete, localStatus, setBudgetUsd, spend } from "@uni/ai";
import { ensureWhisperModel, localTranscriber, whisperCppBinary, whisperInstallProgress } from "@uni/transcribe";

/**
 * Where the money goes, and how to stop it.
 *
 * A local tool that quietly bills a student per lecture is a tool they turn off.
 * This reports the running total by task, whether a free local model is available
 * for text and for audio, and lets both be preferred over the paid path.
 */
export async function registerAiCostRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ai/status", async () => {
    const [local, whisper, binary] = await Promise.all([localStatus(), localTranscriber(), whisperCppBinary()]);
    return {
      health: aiHealth(),
      spend: spend(),
      cache: cacheStats(),
      provider: getSetting("ai_provider") || "auto",
      transcribeProvider: getSetting("transcribe_provider") || "auto",
      cleanTranscripts: getSetting("clean_transcripts") === "true",
      budgetUsd: budgetUsd(),
      local: {
        text: { ok: local.ok, models: local.models, url: process.env.AI_LOCAL_URL || "http://127.0.0.1:11434" },
        audio: whisper
          ? { ok: true, engine: whisper.engine, model: whisper.model, vad: Boolean(whisper.vadModel) }
          : { ok: false, binary: Boolean(binary), install: whisperInstallProgress() },
      },
      transcripts: transcriptSources(),
    };
  });

  app.put<{
    Body: {
      provider?: string;
      transcribeProvider?: string;
      budgetUsd?: number | null;
      cleanTranscripts?: boolean;
    };
  }>("/api/ai/options", async (req) => {
    const p = req.body?.provider;
    if (p === "auto" || p === "local" || p === "openai") setSetting("ai_provider", p);
    const t = req.body?.transcribeProvider;
    if (t === "auto" || t === "local" || t === "openai") setSetting("transcribe_provider", t);
    if (req.body?.budgetUsd !== undefined) setBudgetUsd(req.body.budgetUsd);
    if (req.body?.cleanTranscripts !== undefined) {
      setSetting("clean_transcripts", req.body.cleanTranscripts ? "true" : "false");
    }
    const [local, whisper] = await Promise.all([localStatus(true), localTranscriber(true)]);
    return { ok: true, spend: spend(), local: { text: local, audio: Boolean(whisper) } };
  });

  /**
   * Re-test the AI path after a fault, instead of trusting a stored verdict.
   *
   * A quota fault records the moment the account ran dry — but topping up
   * happens on OpenAI's website, where the app can't see it, so the banner
   * would otherwise outlive the problem indefinitely. One deliberately tiny
   * completion (a fraction of a cent) settles it either way: success clears
   * the fault through the same noteSuccess path as any real call.
   */
  app.post("/api/ai/recheck", async () => {
    try {
      await complete("Reply with the single word: ok", { maxTokens: 4, task: "health-check" });
      return { ok: true, health: aiHealth() };
    } catch (e) {
      return { ok: false, health: aiHealth(), error: String(e).slice(0, 200) };
    }
  });

  /**
   * Download the local transcription model (~550 MB) into the data directory.
   * Returns straight away; progress is on /api/ai/status under local.audio.install.
   * whisper.cpp itself still has to be installed (`brew install whisper-cpp`).
   */
  app.post("/api/ai/install-whisper", async () => {
    void ensureWhisperModel().catch((e) => app.log.warn(`Whisper model install: ${String(e)}`));
    return { ok: true, install: whisperInstallProgress() };
  });

  /** Re-probe for a local model without waiting for the cache to lapse. */
  app.post("/api/ai/probe-local", async () => {
    const [local, whisper] = await Promise.all([localStatus(true), localTranscriber(true)]);
    return { ok: true, text: local, audio: whisper };
  });

  /** Is everything the app depends on working? Cached for a few minutes. */
  app.get("/api/connections", async () => connectionHealth());

  /** Check everything now, including a real Echo360 page load (a few seconds). */
  app.post("/api/connections/check", async () => connectionHealth({ force: true, deep: true }));

  app.post("/api/ai/cache/clear", async () => ({ ok: true, cleared: clearCache() }));
}

/** How this student's transcripts were made — "captions" and "local-whisper" cost nothing. */
function transcriptSources(): { source: string; count: number; minutes: number }[] {
  return getDb()
    .prepare(
      `SELECT COALESCE(t.source, 'unknown') AS source, COUNT(*) AS count,
              ROUND(COALESCE(SUM(COALESCE(t.speech_sec, l.duration_sec)), 0) / 60.0) AS minutes
         FROM transcripts t JOIN lectures l ON l.id = t.lecture_id
        WHERE t.status = 'done' GROUP BY 1 ORDER BY 2 DESC`,
    )
    .all() as { source: string; count: number; minutes: number }[];
}

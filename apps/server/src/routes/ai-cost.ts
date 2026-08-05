import type { FastifyInstance } from "fastify";
import { getSetting, setSetting } from "@uni/db";
import { aiHealth, budgetUsd, cacheStats, clearCache, localStatus, setBudgetUsd, spend } from "@uni/ai";
import { localTranscriber } from "@uni/transcribe";

/**
 * Where the money goes, and how to stop it.
 *
 * A local tool that quietly bills a student per lecture is a tool they turn off.
 * This reports the running total by task, whether a free local model is available
 * for text and for audio, and lets both be preferred over the paid path.
 */
export async function registerAiCostRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ai/status", async () => {
    const [local, whisper] = await Promise.all([localStatus(), localTranscriber()]);
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
        audio: whisper ? { ok: true, engine: whisper.engine, model: whisper.model } : { ok: false },
      },
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

  /** Re-probe for a local model without waiting for the cache to lapse. */
  app.post("/api/ai/probe-local", async () => {
    const [local, whisper] = await Promise.all([localStatus(true), localTranscriber(true)]);
    return { ok: true, text: local, audio: whisper };
  });

  app.post("/api/ai/cache/clear", async () => ({ ok: true, cleared: clearCache() }));
}

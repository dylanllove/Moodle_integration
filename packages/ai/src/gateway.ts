import { createHash } from "node:crypto";
import { getDb, getSetting, setSetting } from "@uni/db";

/**
 * One way in and out for every model call.
 *
 * A ChatGPT subscription cannot pay for API calls — they're separately billed
 * products and the only bridge would be driving the web session, which breaks
 * OpenAI's terms. So the way to stop the bill growing is to stop sending the work
 * to OpenAI: this routes anything that doesn't need a frontier model to a model
 * running on the machine, remembers answers it has already paid for, keeps a
 * ledger, and refuses to spend past a cap.
 *
 * Two tiers, because the distinction that matters is not which model is best but
 * which work is worth paying for:
 *   bulk    — cleaning a transcript, writing lecture notes, making flashcards.
 *             High volume, low stakes, and a 7B model on an M-series chip is
 *             perfectly good at it. Free.
 *   quality — reading an assessment schedule out of a course outline, building a
 *             cheat sheet. Done rarely, and being wrong is expensive.
 */
export type AiTier = "bulk" | "quality";
export type Provider = "local" | "openai";

export const MODEL_FAST = process.env.AI_MODEL_FAST || "gpt-4o-mini";
export const MODEL_DRAFT = process.env.AI_MODEL_DRAFT || "gpt-4o";
const LOCAL_URL = () => process.env.AI_LOCAL_URL || "http://127.0.0.1:11434";
const LOCAL_MODEL = () => process.env.AI_LOCAL_MODEL || "llama3.1:8b";

/**
 * Published per-million-token rates, used only to estimate a running total so the
 * cap means something. Wrong-but-close beats no number at all; override via env
 * when the rates move.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
};
const price = (model: string) => PRICES[model] ?? { in: 0.15, out: 0.6 };
/** Tokens are estimated as characters ÷ 4 — close enough to budget against. */
const tokens = (chars: number) => Math.ceil(chars / 4);

export function estimateCost(model: string, inChars: number, outChars: number): number {
  const p = price(model);
  return (tokens(inChars) * p.in + tokens(outChars) * p.out) / 1e6;
}

/* --- Is there a local model? ----------------------------------------------- */

let localSeen: { at: number; ok: boolean; models: string[] } | null = null;
const PROBE_TTL_MS = 60_000;

export async function localStatus(force = false): Promise<{ ok: boolean; models: string[] }> {
  if (!force && localSeen && Date.now() - localSeen.at < PROBE_TTL_MS) {
    return { ok: localSeen.ok, models: localSeen.models };
  }
  try {
    const res = await fetch(`${LOCAL_URL()}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    const json = (await res.json()) as { models?: { name: string }[] };
    const models = (json.models ?? []).map((m) => m.name);
    localSeen = { at: Date.now(), ok: res.ok, models };
  } catch {
    localSeen = { at: Date.now(), ok: false, models: [] };
  }
  return { ok: localSeen.ok, models: localSeen.models };
}

/** "auto" (default), "local" to never pay, "openai" to never use the local one. */
function preference(): "auto" | "local" | "openai" {
  const raw = (getSetting("ai_provider") || process.env.AI_PROVIDER || "auto").toLowerCase();
  return raw === "local" || raw === "openai" ? raw : "auto";
}

export function hasApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function choose(tier: AiTier): Promise<{ provider: Provider; model: string }> {
  const pref = preference();
  const local = await localStatus();
  const localModel = LOCAL_MODEL();

  if (pref === "local") {
    if (!local.ok) throw new Error(`No local model at ${LOCAL_URL()} — start Ollama, or switch the provider back to Auto in Settings.`);
    return { provider: "local", model: localModel };
  }
  if (pref === "openai") return { provider: "openai", model: tier === "quality" ? MODEL_DRAFT : MODEL_FAST };

  // Auto: bulk goes local whenever a local model is up; quality stays on OpenAI
  // unless there's no key, in which case a local answer beats no answer.
  if (tier === "bulk" && local.ok) return { provider: "local", model: localModel };
  if (!hasApiKey() && local.ok) return { provider: "local", model: localModel };
  return { provider: "openai", model: tier === "quality" ? MODEL_DRAFT : MODEL_FAST };
}

/* --- Spend ----------------------------------------------------------------- */

export interface Spend {
  monthUsd: number;
  todayUsd: number;
  budgetUsd: number | null;
  overBudget: boolean;
  byTask: { task: string; provider: string; calls: number; usd: number }[];
}

export function budgetUsd(): number | null {
  const raw = getSetting("ai_budget_usd");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setBudgetUsd(usd: number | null): void {
  setSetting("ai_budget_usd", usd && usd > 0 ? String(usd) : "");
}

export function spend(): Spend {
  const db = getDb();
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const sum = (where: string, arg: string) =>
    ((db.prepare(`SELECT COALESCE(SUM(usd),0) AS s FROM ai_usage WHERE ${where}`).get(arg) as {
      s: number;
    }).s ?? 0);

  const monthUsd = sum("substr(at,1,7) = ?", month);
  const cap = budgetUsd();
  return {
    monthUsd: round4(monthUsd),
    todayUsd: round4(sum("substr(at,1,10) = ?", today)),
    budgetUsd: cap,
    overBudget: cap != null && monthUsd >= cap,
    byTask: (
      db
        .prepare(
          `SELECT task, provider, COUNT(*) AS calls, COALESCE(SUM(usd),0) AS usd
             FROM ai_usage WHERE substr(at,1,7) = ?
            GROUP BY task, provider ORDER BY usd DESC LIMIT 20`,
        )
        .all(month) as { task: string; provider: string; calls: number; usd: number }[]
    ).map((r) => ({ ...r, usd: round4(r.usd) })),
  };
}

export function record(entry: {
  provider: Provider | "openai-whisper" | "local-whisper";
  model: string;
  task: string;
  inChars: number;
  outChars: number;
  usd: number;
  cached?: boolean;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_usage (at, provider, model, task, in_chars, out_chars, usd, cached)
         VALUES (datetime('now'), ?,?,?,?,?,?,?)`,
      )
      .run(
        entry.provider,
        entry.model,
        entry.task,
        entry.inChars,
        entry.outChars,
        entry.usd,
        entry.cached ? 1 : 0,
      );
  } catch {
    /* a ledger write must never break the thing it's measuring */
  }
}

/* --- Cache ----------------------------------------------------------------- */

/**
 * Answers to identical questions, kept.
 *
 * The pipeline re-runs every twenty minutes and retries after failures, so the
 * same transcript could be turned into the same notes several times over — paid
 * for each time. Only used where the work is deterministic; a chat reply is not
 * cached, because asking the same question twice is a person wanting another go.
 */
function cacheKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function cacheGet(key: string): string | null {
  try {
    const row = getDb().prepare("SELECT text FROM ai_cache WHERE key = ?").get(key) as
      | { text: string }
      | undefined;
    return row?.text ?? null;
  } catch {
    return null;
  }
}

function cachePut(key: string, task: string, text: string): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_cache (key, task, text, at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(key) DO UPDATE SET text = excluded.text, at = excluded.at`,
      )
      .run(key, task, text);
  } catch {
    /* cache is a nicety */
  }
}

export function cacheStats(): { entries: number; savedUsd: number } {
  try {
    const db = getDb();
    const entries = (db.prepare("SELECT COUNT(*) AS n FROM ai_cache").get() as { n: number }).n;
    const saved = (
      db.prepare("SELECT COALESCE(SUM(usd),0) AS s FROM ai_usage WHERE cached = 1").get() as {
        s: number;
      }
    ).s;
    return { entries, savedUsd: round4(saved) };
  } catch {
    return { entries: 0, savedUsd: 0 };
  }
}

export function clearCache(): number {
  try {
    return getDb().prepare("DELETE FROM ai_cache").run().changes as number;
  } catch {
    return 0;
  }
}

/* --- Health ---------------------------------------------------------------- */

export type AiFault = "quota" | "auth" | "rate-limit" | "network" | "budget" | "no-provider" | "other";

export interface AiHealth {
  ok: boolean;
  fault: AiFault | null;
  message: string | null;
  at: string | null;
  /** Which provider served the last successful call. */
  provider: Provider | null;
}

let health: AiHealth | null = null;

function loadHealth(): AiHealth {
  if (health) return health;
  try {
    const raw = getSetting("ai_last_fault");
    if (raw) {
      const parsed = JSON.parse(raw) as AiHealth;
      health = { ok: false, fault: parsed.fault, message: parsed.message, at: parsed.at, provider: null };
      return health;
    }
  } catch {
    /* unreadable — assume healthy and let the next call decide */
  }
  health = { ok: true, fault: null, message: null, at: null, provider: null };
  return health;
}

export function aiHealth(): AiHealth {
  return loadHealth();
}

function classify(message: string): AiFault {
  const m = message.toLowerCase();
  if (/no credits|insufficient_quota|exceeded your current quota|billing/.test(m)) return "quota";
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized|401/.test(m)) return "auth";
  if (/rate limit|429/.test(m)) return "rate-limit";
  if (/monthly budget/.test(m)) return "budget";
  if (/no local model|no provider/.test(m)) return "no-provider";
  if (/fetch failed|econnreset|enotfound|timeout|socket hang up/.test(m)) return "network";
  return "other";
}

export function noteFailure(message: string): void {
  health = {
    ok: false,
    fault: classify(message),
    message: message.slice(0, 300),
    at: new Date().toISOString(),
    provider: null,
  };
  try {
    setSetting("ai_last_fault", JSON.stringify(health));
  } catch {
    /* in-memory is enough for this run */
  }
}

export function noteSuccess(provider: Provider): void {
  const before = loadHealth();
  health = { ok: true, fault: null, message: null, at: null, provider };
  if (!before.ok) {
    try {
      setSetting("ai_last_fault", "");
    } catch {
      /* nothing to undo */
    }
  }
}

/* --- The call itself -------------------------------------------------------- */

export interface CompleteOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object — used where the answer is data, not prose. */
  json?: boolean;
  /** Which half of the split above this work belongs to. Defaults to bulk. */
  tier?: AiTier;
  /** Names the line in the spend ledger. */
  task?: string;
  /** Reuse an identical previous answer. Only for deterministic work. */
  cache?: boolean;
}

export interface Routed {
  text: string;
  provider: Provider;
  model: string;
  cached: boolean;
  usd: number;
}

export async function route(prompt: string, opts: CompleteOpts = {}): Promise<Routed> {
  const tier = opts.tier ?? "bulk";
  const task = opts.task ?? "other";
  const { provider, model } = opts.model
    ? { provider: "openai" as Provider, model: opts.model }
    : await choose(tier);

  const key = cacheKey([provider, model, opts.system ?? "", prompt, opts.maxTokens, opts.temperature, opts.json]);
  if (opts.cache) {
    const hit = cacheGet(key);
    if (hit != null) {
      // Recorded so "what the cache saved you" is a real number rather than a claim.
      record({
        provider,
        model,
        task,
        inChars: prompt.length,
        outChars: hit.length,
        usd: provider === "openai" ? estimateCost(model, prompt.length + (opts.system?.length ?? 0), hit.length) : 0,
        cached: true,
      });
      return { text: hit, provider, model, cached: true, usd: 0 };
    }
  }

  if (provider === "openai") {
    const cap = budgetUsd();
    if (cap != null && spend().monthUsd >= cap) {
      const msg = `This month's OpenAI spend has hit the $${cap.toFixed(2)} monthly budget. Raise it in Settings, or install a local model to keep going for free.`;
      noteFailure(msg);
      throw new Error(msg);
    }
  }

  const text =
    provider === "local"
      ? await callLocal(prompt, model, opts)
      : await callOpenAi(prompt, model, opts);

  const usd = provider === "openai"
    ? estimateCost(model, prompt.length + (opts.system?.length ?? 0), text.length)
    : 0;
  record({ provider, model, task, inChars: prompt.length, outChars: text.length, usd });
  if (opts.cache) cachePut(key, task, text);
  noteSuccess(provider);
  return { text, provider, model, cached: false, usd };
}

async function callOpenAi(prompt: string, model: string, opts: CompleteOpts): Promise<string> {
  if (!hasApiKey()) {
    const msg = "No OpenAI key and no local model — add a key in setup, or install Ollama to run one on this machine for free.";
    noteFailure(msg);
    throw new Error(msg);
  }
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (json.error) {
    noteFailure(json.error.message ?? "OpenAI request failed");
    throw new Error(`OpenAI: ${json.error.message}`);
  }
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

async function callLocal(prompt: string, model: string, opts: CompleteOpts): Promise<string> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const res = await fetch(`${LOCAL_URL()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(opts.json ? { format: "json" } : {}),
      options: {
        temperature: opts.temperature ?? 0.3,
        num_predict: opts.maxTokens ?? 2048,
      },
    }),
    // A local model is slower per token than the API; a long transcript chunk
    // genuinely can take minutes, and timing out mid-way wastes the whole run.
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = `Local model (${model}): ${body.slice(0, 200) || res.statusText}`;
    noteFailure(msg);
    throw new Error(msg);
  }
  const json = (await res.json()) as { message?: { content?: string } };
  return (json.message?.content ?? "").trim();
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

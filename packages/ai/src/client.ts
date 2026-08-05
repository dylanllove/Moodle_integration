import { getSetting, setSetting } from "@uni/db";

// OpenAI-backed completion. Kept behind the same complete()/hasApiKey()
// interface the routes already use, so switching providers touched only here.
export const MODEL_FAST = process.env.AI_MODEL_FAST || "gpt-4o-mini";
export const MODEL_DRAFT = process.env.AI_MODEL_DRAFT || "gpt-4o";

export function hasApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Why the AI features aren't working, when they aren't.
 *
 * Transcripts, study notes, cheat sheets, flashcards, the outline reader and the
 * chat all run through here, so when the account runs out of credits every one of
 * them stops at once — and each one fails in its own quiet corner: a sync step
 * logs a warning, a deck never appears, the assistant returns a sentence. The
 * student is left to conclude the app is broken. Recording the reason centrally
 * lets the UI say it once, plainly.
 */
export type AiFault = "quota" | "auth" | "rate-limit" | "network" | "other";

export interface AiHealth {
  ok: boolean;
  fault: AiFault | null;
  message: string | null;
  at: string | null;
}

let health: AiHealth | null = null;

/**
 * Remembered across restarts. An exhausted quota does not fix itself, and the
 * server restarts often in development — starting up claiming everything is fine
 * hid the banner until the next call happened to fail, which is the moment the
 * student least needs to rediscover it.
 */
function load(): AiHealth {
  if (health) return health;
  try {
    const raw = getSetting("ai_last_fault");
    if (raw) {
      const parsed = JSON.parse(raw) as AiHealth;
      health = { ok: false, fault: parsed.fault, message: parsed.message, at: parsed.at };
      return health;
    }
  } catch {
    /* unreadable — treat as healthy and let the next call decide */
  }
  health = { ok: true, fault: null, message: null, at: null };
  return health;
}

export function aiHealth(): AiHealth {
  return load();
}

function classify(message: string): AiFault {
  const m = message.toLowerCase();
  if (/no credits|insufficient_quota|exceeded your current quota|billing/.test(m)) return "quota";
  if (/invalid[_ ]api[_ ]key|incorrect api key|unauthorized|401/.test(m)) return "auth";
  if (/rate limit|429/.test(m)) return "rate-limit";
  if (/fetch failed|econnreset|enotfound|timeout|socket hang up/.test(m)) return "network";
  return "other";
}

function noteFailure(message: string): void {
  health = {
    ok: false,
    fault: classify(message),
    message: message.slice(0, 300),
    at: new Date().toISOString(),
  };
  try {
    setSetting("ai_last_fault", JSON.stringify(health));
  } catch {
    /* the in-memory copy is enough to show the banner this run */
  }
}

function noteSuccess(): void {
  if (load().ok) return;
  health = { ok: true, fault: null, message: null, at: null };
  try {
    setSetting("ai_last_fault", "");
  } catch {
    /* nothing to undo */
  }
}

export interface CompleteOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the model for a JSON object — used where the answer is data, not prose. */
  json?: boolean;
}

/** Single-turn chat completion returning the assistant's text. */
export async function complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
  if (!hasApiKey()) throw new Error("OPENAI_API_KEY is not set — add it to your .env file.");

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
      model: opts.model ?? MODEL_FAST,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  const json = (await res.json()) as any;
  if (json.error) {
    noteFailure(json.error.message ?? "OpenAI request failed");
    throw new Error(`OpenAI: ${json.error.message}`);
  }
  noteSuccess();
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * The same call, yielding text as it arrives. Waiting in silence for a long
 * answer reads as "broken"; watching it write reads as "thinking" — so the
 * assistant streams even though the finished text is identical.
 */
export async function* completeStream(
  prompt: string,
  opts: CompleteOpts = {},
): AsyncGenerator<string> {
  if (!hasApiKey()) throw new Error("OPENAI_API_KEY is not set — add it to your .env file.");

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
      model: opts.model ?? MODEL_FAST,
      messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    // A failed stream still returns a JSON error body — surface it as itself
    // rather than as an empty answer.
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {
      /* not JSON — use the raw text */
    }
    noteFailure(message || res.statusText);
    throw new Error(`OpenAI: ${message || res.statusText}`);
  }

  noteSuccess();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    // SSE frames are separated by a blank line; a frame can straddle chunks.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) yield delta as string;
        } catch {
          /* partial or non-JSON keepalive — skip */
        }
      }
    }
  }
}

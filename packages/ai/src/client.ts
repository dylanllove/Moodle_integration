import {
  MODEL_DRAFT,
  MODEL_FAST,
  estimateCost,
  hasApiKey,
  localStatus,
  noteFailure,
  noteSuccess,
  record,
  route,
  type CompleteOpts,
} from "./gateway.js";

// Every model call goes through the gateway, which decides whether it costs
// anything. This file is only the shape the rest of the app already calls.
export { MODEL_FAST, MODEL_DRAFT, hasApiKey };
export type { CompleteOpts };

/** Single-turn completion. Returns just the text, as it always did. */
export async function complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
  return (await route(prompt, opts)).text;
}

/** The same, but say which provider answered — for anything that reports cost. */
export async function completeWhere(
  prompt: string,
  opts: CompleteOpts = {},
): Promise<{ text: string; provider: string; model: string; cached: boolean; usd: number }> {
  return route(prompt, opts);
}

/**
 * Streaming, token by token.
 *
 * Streams from whichever provider is chosen — Ollama's newline-delimited JSON and
 * OpenAI's server-sent events are different enough on the wire to be worth
 * keeping apart, and identical enough afterwards that the caller can't tell.
 */
export async function* completeStream(
  prompt: string,
  opts: CompleteOpts = {},
): AsyncGenerator<string> {
  const local = await localStatus();
  const preferLocal = local.ok && (opts.tier ?? "bulk") === "bulk" && !opts.model;

  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const model = preferLocal
    ? process.env.AI_LOCAL_MODEL || "llama3.1:8b"
    : (opts.model ?? MODEL_FAST);
  const inChars = prompt.length + (opts.system?.length ?? 0);
  let out = "";

  try {
    const stream = preferLocal
      ? streamLocal(messages, model, opts)
      : streamOpenAi(messages, model, opts);
    for await (const piece of stream) {
      out += piece;
      yield piece;
    }
  } finally {
    // Recorded even if the stream broke part-way: those tokens were still spent.
    record({
      provider: preferLocal ? "local" : "openai",
      model,
      task: opts.task ?? "chat",
      inChars,
      outChars: out.length,
      usd: preferLocal ? 0 : estimateCost(model, inChars, out.length),
    });
  }
}

async function* streamOpenAi(
  messages: { role: string; content: string }[],
  model: string,
  opts: CompleteOpts,
): AsyncGenerator<string> {
  if (!hasApiKey()) {
    const msg =
      "No OpenAI key and no local model — add a key in setup, or install Ollama to run one on this machine for free.";
    noteFailure(msg);
    throw new Error(msg);
  }
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

  noteSuccess("openai");
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

async function* streamLocal(
  messages: { role: string; content: string }[],
  model: string,
  opts: CompleteOpts,
): AsyncGenerator<string> {
  const url = process.env.AI_LOCAL_URL || "http://127.0.0.1:11434";
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature: opts.temperature ?? 0.3, num_predict: opts.maxTokens ?? 2048 },
    }),
  });
  if (!res.ok || !res.body) {
    const msg = `Local model (${model}): ${res.statusText}`;
    noteFailure(msg);
    throw new Error(msg);
  }
  noteSuccess("local");

  // Ollama streams one JSON object per line rather than SSE frames.
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const piece = JSON.parse(line)?.message?.content;
        if (piece) yield piece as string;
      } catch {
        /* partial line — it'll arrive with the next chunk */
      }
    }
  }
}

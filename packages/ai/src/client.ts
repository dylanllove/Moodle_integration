// OpenAI-backed completion. Kept behind the same complete()/hasApiKey()
// interface the routes already use, so switching providers touched only here.
export const MODEL_FAST = process.env.AI_MODEL_FAST || "gpt-4o-mini";
export const MODEL_DRAFT = process.env.AI_MODEL_DRAFT || "gpt-4o";

export function hasApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export interface CompleteOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
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
    }),
  });

  const json = (await res.json()) as any;
  if (json.error) throw new Error(`OpenAI: ${json.error.message}`);
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
    throw new Error(`OpenAI: ${message || res.statusText}`);
  }

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

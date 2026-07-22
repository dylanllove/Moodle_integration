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

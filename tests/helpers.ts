import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test scaffolding: a throwaway data directory (so a test run can never touch the
 * student's real database) and a stand-in for Ollama that answers the way a
 * local model would, so the AI half of the pipeline runs for free and gives the
 * same answer every time.
 */

export const REPO = resolve(import.meta.dirname, "..");

/** Point the app at a fresh data dir. Must run before anything opens the DB. */
export function isolatedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uni-test-"));
  process.env.DATA_DIR = dir;
  // Reuse the real transcription models rather than downloading 550 MB per run.
  const models = join(REPO, "data", "models");
  if (existsSync(models)) symlinkSync(models, join(dir, "models"));
  else mkdirSync(join(dir, "models"));
  return dir;
}

export interface FakeModel {
  url: string;
  calls: { format: unknown; prompt: string; numCtx: number | undefined }[];
  /** While true, every chat request fails the way an overloaded model does. */
  failing: boolean;
  close: () => Promise<void>;
}

/**
 * An Ollama look-alike. Answers structured requests from the shape of the schema
 * it's handed — which is also a check that the app sends one.
 */
export async function fakeOllama(): Promise<FakeModel> {
  const calls: FakeModel["calls"] = [];
  const fake: FakeModel = {
    url: "",
    calls,
    failing: false,
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake:latest" }] }));
      if (req.url !== "/api/chat") return res.writeHead(404).end("{}");
      if (fake.failing) return res.writeHead(500).end("model crashed");
      const j = JSON.parse(body || "{}");
      const prompt: string = j.messages?.at(-1)?.content ?? "";
      calls.push({ format: j.format, prompt, numCtx: j.options?.num_ctx });
      res.end(JSON.stringify({ message: { content: JSON.stringify(answerFor(j.format, prompt)) } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  fake.url = `http://127.0.0.1:${port}`;
  return fake;
}

function answerFor(format: any, prompt: string): unknown {
  const props = format?.properties ?? {};
  if (props.sections) {
    // Point at the last numbered line shown, so the test can check that line
    // numbers really do come back as seconds of the recording.
    const lines = [...prompt.matchAll(/^\[(\d+)[|\]]/gm)].map((m) => Number(m[1]));
    const first = lines[0] ?? 0;
    const last = lines.at(-1) ?? 0;
    return {
      tldr: "A speech about civic duty.",
      topics: ["Civic duty", "Public service"],
      sections: [
        { title: "Opening", summary: "The speaker addresses the audience.", line: first },
        { title: "The ask", summary: "Ask what you can do for your country.", line: last },
      ],
      concepts: [
        { kind: "concept", name: "Civic duty", explanation: "Contributing to your country.", section: 1, line: last },
        { kind: "term", name: "Fellow Americans", explanation: "The audience being addressed.", section: 0, line: first },
      ],
      emphasis: [{ quote: "ask what you can do for your country", why: "The central line.", line: last }],
      questions: [
        { q: "What does the speaker ask the audience to consider?", a: "What they can do for their country.", concept: "Civic duty", line: last },
        { q: "Who is the speech addressed to?", a: "Fellow Americans.", concept: "Fellow Americans", line: first },
        { q: "What should you not ask?", a: "What your country can do for you.", concept: "Civic duty", line: last },
        // A bad line number must not produce a bogus timestamp.
        { q: "Is this question anchored?", a: "No — its line is out of range.", concept: "", line: 99999 },
      ],
    };
  }
  if (props.tldr) return { tldr: "Merged overview.", topics: ["Merged"] };
  if (props.cards) return { cards: [{ q: "Q?", a: "A." }] };
  return { ok: true };
}

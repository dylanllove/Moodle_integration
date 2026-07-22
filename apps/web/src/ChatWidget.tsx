import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "Which of my classes are compulsory?",
  "What do I have to physically attend on campus?",
  "What's due this week?",
  "Where and when is my next COSC121 class?",
];

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: question }]);
    setBusy(true);
    try {
      const { answer } = await api.ask(question, history);
      setMsgs((m) => [...m, { role: "assistant", content: answer }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `Sorry — ${e}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-2xl text-white shadow-lg transition hover:bg-indigo-500"
        title="Ask about your courses"
      >
        {open ? "×" : "💬"}
      </button>

      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[32rem] w-[24rem] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="text-sm font-semibold text-slate-900">Ask about your study</div>
            <div className="text-xs text-slate-400">Quick questions across your courses</div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">Try:</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-800"
                  }`}
                >
                  {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
                </div>
              </div>
            ))}
            {busy && <div className="text-xs text-slate-400">Thinking…</div>}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2 border-t border-slate-200 p-3"
          >
            <input
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              placeholder="Ask a question…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Ask
            </button>
          </form>
        </div>
      )}
    </>
  );
}

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo-root .env, same file index.ts loads at boot. */
export const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");

/** Quote only when the value would otherwise break dotenv parsing. */
function serialise(key: string, value: string): string {
  return /[\s#"']/.test(value) ? `${key}="${value.replace(/"/g, '\\"')}"` : `${key}=${value}`;
}

/**
 * Persist keys to the repo-root .env *and* to process.env.
 *
 * Every consumer reads process.env lazily on each call (moodle-api's BASE()/
 * TOKEN(), ai/client's hasApiKey()), so updating process.env here makes the new
 * credentials live immediately — the setup flow never asks for a restart. The
 * .env write is what makes them survive one.
 *
 * The file is written 0600: it holds a Moodle token and an API key.
 */
export function saveEnv(updates: Record<string, string>): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
    const line = serialise(key, value);
    const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }

  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(ENV_PATH, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

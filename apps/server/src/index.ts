import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load .env from the repo root regardless of cwd.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { getDb } from "@uni/db";
import { registerCoreRoutes } from "./routes/core.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerLmsRoutes } from "./routes/lms.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerTranscribeRoutes } from "./routes/transcribe.js";
import { registerNotesRoutes } from "./routes/notes.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerGcalRoutes } from "./routes/gcal.js";
import { registerExportRoutes } from "./routes/export.js";
import { registerCheatsheetRoutes } from "./routes/cheatsheet.js";
import { registerEcho360Routes } from "./routes/echo360.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerMaterialsRoutes } from "./routes/materials.js";
import { registerGradesRoutes } from "./routes/grades.js";
import { registerWorkloadRoutes } from "./routes/workload.js";
import { registerFlashcardRoutes } from "./routes/flashcards.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerDigestRoutes } from "./routes/digest.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerNotionRoutes } from "./routes/notion.js";
import { registerPlanRoutes } from "./routes/plan.js";
import { startScheduler } from "./scheduler.js";
import { runFullSync } from "./sync-job.js";

// Echo360 lesson ids are long (they embed timestamps), so allow long route params.
const app = Fastify({ logger: true, maxParamLength: 1000 });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

// Treat an empty JSON body as {} instead of 400 — many POSTs take no body.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const s = (body as string).trim();
  if (!s) return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch (err) {
    done(err as Error);
  }
});

// Ensure DB + schema exist before serving.
getDb();

app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

await registerSettingsRoutes(app);
await registerSetupRoutes(app);
await registerCoreRoutes(app);
await registerLmsRoutes(app);
await registerCalendarRoutes(app);
await registerTranscribeRoutes(app);
await registerNotesRoutes(app);
await registerAiRoutes(app);
await registerGcalRoutes(app);
await registerExportRoutes(app);
await registerCheatsheetRoutes(app);
await registerEcho360Routes(app);
await registerAskRoutes(app);
await registerMaterialsRoutes(app);
await registerGradesRoutes(app);
await registerWorkloadRoutes(app);
await registerFlashcardRoutes(app);
await registerSyncRoutes(app);
await registerDigestRoutes(app);
await registerSearchRoutes(app);
await registerNotionRoutes(app);
await registerPlanRoutes(app);

const port = Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    app.log.info(`Uni Study server on http://127.0.0.1:${port}`);
    // Sync-on-launch: refresh everything in the background so the app is up to
    // date the moment it opens. Non-blocking; the UI watches /api/sync/progress.
    void autoSyncOnLaunch(app);
    // Weekly digest — ticks quietly, catches up if the laptop was shut.
    startScheduler(app);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

async function autoSyncOnLaunch(app: import("fastify").FastifyInstance): Promise<void> {
  app.log.info("Auto-sync starting…");
  const state = await runFullSync(app);
  app.log.info({ phases: state.phases }, "Auto-sync done");
}

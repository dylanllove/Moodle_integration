import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { getDb } from "@uni/db";
import { materialsRoot, syncMaterials } from "@uni/lms";
import { extractFileText } from "../extract.js";

/** One sync at a time — a second click shouldn't double-download the library. */
let running: Promise<unknown> | null = null;

export async function registerMaterialsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // The organised library, newest week first within each course.
  app.get<{ Querystring: { course_id?: string } }>("/api/materials", async (req) => {
    const rows = req.query.course_id
      ? db
          .prepare(
            `SELECT id, course_id, week, section, module, title, kind, mimetype, path, bytes,
                    modified_at, length(text) AS text_len
             FROM materials WHERE course_id = ? ORDER BY week IS NULL, week, title`,
          )
          .all(req.query.course_id)
      : db
          .prepare(
            `SELECT m.id, m.course_id, m.week, m.section, m.module, m.title, m.kind, m.mimetype,
                    m.path, m.bytes, m.modified_at, length(m.text) AS text_len
             FROM materials m JOIN courses c ON c.id = m.course_id
             WHERE c.active = 1 ORDER BY c.name, m.week IS NULL, m.week, m.title`,
          )
          .all();
    return { root: materialsRoot(), materials: rows };
  });

  app.post<{ Body: { course_id?: string } }>("/api/materials/sync", async (req, reply) => {
    if (running) return reply.code(409).send({ error: "A materials sync is already running." });
    running = syncMaterials({ courseId: req.body?.course_id, extractText: extractFileText });
    try {
      return { ok: true, ...(await (running as Promise<Awaited<ReturnType<typeof syncMaterials>>>)) };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    } finally {
      running = null;
    }
  });

  // Serve a downloaded file back to the browser (inline, so PDFs just open).
  app.get<{ Params: { id: string } }>("/api/materials/:id/file", async (req, reply) => {
    const row = local(req.params.id);
    if (!row) return reply.code(404).send({ error: "file not downloaded" });
    reply.header("content-type", row.mimetype || "application/octet-stream");
    reply.header("content-disposition", `inline; filename="${basename(row.path)}"`);
    return createReadStream(row.path);
  });

  // Extracted text, for reading a deck without opening PowerPoint.
  app.get<{ Params: { id: string } }>("/api/materials/:id/text", async (req, reply) => {
    const row = db.prepare("SELECT title, text, path, mimetype FROM materials WHERE id = ?").get(
      req.params.id,
    ) as { title: string; text: string | null; path: string | null; mimetype: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    // Extract on demand for anything downloaded before extraction was wired in.
    if (!row.text && row.path && existsSync(row.path)) {
      const text = await extractFileText(row.path, row.mimetype ?? "").catch(() => "");
      if (text) {
        db.prepare("UPDATE materials SET text = ? WHERE id = ?").run(text, req.params.id);
        return { title: row.title, text };
      }
    }
    return { title: row.title, text: row.text ?? "" };
  });

  /**
   * Open the library folder in the OS file manager. This is a local-only app and
   * the whole point of the feature is a folder you can browse yourself.
   */
  app.post<{ Body: { course_id?: string } }>("/api/materials/reveal", async (req, reply) => {
    let dir = materialsRoot();
    if (req.body?.course_id) {
      const row = db
        .prepare("SELECT path FROM materials WHERE course_id = ? AND path IS NOT NULL LIMIT 1")
        .get(req.body.course_id) as { path: string } | undefined;
      if (row) dir = resolve(row.path, "..", "..");
    }
    if (!existsSync(dir)) return reply.code(404).send({ error: "Nothing downloaded yet." });
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try {
      spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref();
    } catch {
      return reply.code(500).send({ error: `Couldn't open ${dir}` });
    }
    return { ok: true, dir };
  });

  // Zip one course's materials, folder structure intact.
  app.get<{ Params: { id: string } }>("/api/materials/course/:id/zip", async (req, reply) => {
    const course = db.prepare("SELECT code, name FROM courses WHERE id = ?").get(req.params.id) as
      | { code: string | null; name: string }
      | undefined;
    if (!course) return reply.code(404).send({ error: "course not found" });
    const rows = db
      .prepare("SELECT path, week FROM materials WHERE course_id = ? AND path IS NOT NULL")
      .all(req.params.id) as { path: string; week: number | null }[];

    const zip = new JSZip();
    const root = materialsRoot();
    let added = 0;
    for (const r of rows) {
      if (!existsSync(r.path)) continue;
      zip.file(relative(root, r.path), await readFile(r.path));
      added++;
    }
    if (!added) return reply.code(404).send({ error: "Nothing downloaded for this course yet." });
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    reply.header("content-type", "application/zip");
    reply.header(
      "content-disposition",
      `attachment; filename="${(course.code || course.name).replace(/[^\w.-]+/g, "_")}-materials.zip"`,
    );
    return buf;
  });

  /** A downloaded file that's still where we left it. */
  function local(id: string): { path: string; mimetype: string | null } | null {
    const row = db.prepare("SELECT path, mimetype FROM materials WHERE id = ?").get(id) as
      | { path: string | null; mimetype: string | null }
      | undefined;
    if (!row?.path || !existsSync(row.path)) return null;
    // Refuse anything that escaped the library — ids come from the client.
    if (!resolve(row.path).startsWith(resolve(materialsRoot()))) return null;
    return { path: row.path, mimetype: row.mimetype };
  }
}

import { readFileSync } from "node:fs";
import JSZip from "jszip";

/** Extract readable text from a lecture-slide file (PDF or PPTX). */
export async function extractSlideText(url: string, mimetype = ""): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const kind = mimetype || guessFromUrl(url);
  if (/pdf/i.test(kind)) return extractPdf(buf);
  if (/presentation|powerpoint|pptx?/i.test(kind)) return extractPptx(buf);
  return "";
}

/**
 * Same extraction, for a file already on disk — used by the materials library so
 * a downloaded deck is fetched once and read from local bytes thereafter.
 */
export async function extractFileText(path: string, mimetype = ""): Promise<string> {
  const kind = mimetype || guessFromUrl(path);
  if (/pdf/i.test(kind)) return extractPdf(readFileSync(path));
  if (/presentation|powerpoint|pptx?/i.test(kind)) return extractPptx(readFileSync(path));
  if (/word|docx/i.test(kind) || /\.docx$/i.test(path)) return extractDocx(readFileSync(path));
  if (/text|markdown|csv/i.test(kind) || /\.(txt|md|csv|tsv)$/i.test(path)) {
    return readFileSync(path, "utf8").slice(0, 400_000);
  }
  return "";
}

/** DOCX is a zip whose document.xml holds the text runs — same trick as PPTX. */
async function extractDocx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) return "";
  const xml = await doc.async("string");
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => decode(l).trim())
    .filter(Boolean)
    .join("\n");
}

function guessFromUrl(url: string): string {
  const clean = url.split("?")[0]!.toLowerCase();
  if (clean.endsWith(".pdf")) return "pdf";
  if (clean.endsWith(".pptx") || clean.endsWith(".ppt")) return "pptx";
  return "";
}

async function extractPdf(buf: Buffer): Promise<string> {
  // unpdf bundles a serverless build of pdf.js — no native deps.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).trim();
}

/** PPTX is a zip of slide XML — pull the text runs out of each slide in order. */
async function extractPptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  const parts: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name]!.async("string");
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1] ?? ""));
    const slideText = runs.join(" ").replace(/\s+/g, " ").trim();
    if (slideText) parts.push(`### Slide ${slideNum(name)}\n${slideText}`);
  }
  return parts.join("\n\n");
}

const slideNum = (n: string) => Number(n.match(/slide(\d+)\.xml/)?.[1] ?? 0);

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

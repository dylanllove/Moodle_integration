import { complete, MODEL_DRAFT, MODEL_FAST } from "./client.js";
import { retrieve } from "./retrieval.js";

export interface AssignmentContext {
  title: string;
  brief: string;
  courseId?: string | null;
}

const INTEGRITY_SYSTEM =
  "You are a study and drafting assistant for a university student. You help them think, structure, and draft — the student remains the author and will edit and verify everything. Ground your help in the student's OWN provided notes and lecture material; when you use it, refer to it. Never fabricate sources or citations. Encourage the student to check their institution's academic-integrity rules and cite properly.";

function contextBlock(query: string, courseId?: string | null): string {
  const chunks = retrieve(query, courseId, 6);
  if (!chunks.length) return "(No matching material found in your notes/transcripts yet.)";
  return chunks
    .map((c, i) => `[${i + 1}] (${c.sourceType}) ${c.text}`)
    .join("\n\n");
}

/** Build a structured outline for the assignment, drawing on the student's material. */
export function outlineAssignment(ctx: AssignmentContext): Promise<string> {
  const material = contextBlock(ctx.title + " " + ctx.brief, ctx.courseId);
  return complete(
    `Assignment: "${ctx.title}"\n\nBRIEF:\n${ctx.brief}\n\nRELEVANT MATERIAL FROM MY OWN NOTES:\n${material}\n\nProduce a clear markdown outline: the argument/approach, main sections with 2–4 bullet points each of what to cover, and where my own notes above are relevant (reference by [n]). Do not write the essay — just the plan.`,
    { system: INTEGRITY_SYSTEM, model: MODEL_FAST, maxTokens: 1800 },
  );
}

/** Draft a single section (clearly a first draft for the student to edit). */
export function draftSection(
  ctx: AssignmentContext,
  sectionTitle: string,
): Promise<string> {
  const material = contextBlock(sectionTitle + " " + ctx.title, ctx.courseId);
  return complete(
    `Assignment: "${ctx.title}"\nBRIEF:\n${ctx.brief}\n\nSECTION TO DRAFT: "${sectionTitle}"\n\nRELEVANT MATERIAL FROM MY OWN NOTES:\n${material}\n\nWrite a first-draft of this section in markdown, grounded in the material above (reference by [n] where used). Keep it focused. Flag with [CHECK] anything I should verify or cite. This is a draft I will revise in my own words.`,
    { system: INTEGRITY_SYSTEM, model: MODEL_DRAFT, maxTokens: 2200 },
  );
}

/** Give structured feedback on the student's own draft. */
export function feedbackOnDraft(ctx: AssignmentContext, draft: string): Promise<string> {
  return complete(
    `Assignment: "${ctx.title}"\nBRIEF:\n${ctx.brief}\n\nMY DRAFT:\n${draft}\n\nGive constructive feedback in markdown: does it answer the brief? Strengths, weaknesses, structure, clarity, and gaps. Be specific and suggest concrete improvements. Do NOT rewrite it for me — I want to improve it myself.`,
    { system: INTEGRITY_SYSTEM, model: MODEL_FAST, maxTokens: 1800 },
  );
}

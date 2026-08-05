/**
 * Markdown ↔ Notion blocks.
 *
 * Study notes are generated as markdown, and pasting that into a Notion page as
 * one paragraph — hashes, asterisks and all — is the "just dumping stuff there"
 * failure mode. Notion has headings, bulleted lists and bold text; using them is
 * the difference between a note that reads like a note and a note that reads like
 * output. This goes the other way too, so a page the student wrote can come back
 * as markdown for the search index and the assistant.
 */

const LIMIT = 2000; // Notion rejects a rich_text run longer than this.

interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

/**
 * Inline markdown → rich text runs. Handles the marks that actually appear in
 * generated notes: bold, italic, inline code and links.
 */
export function inlineToRich(line: string): RichText[] {
  const out: RichText[] = [];
  // One pass, alternating between plain text and the first mark that matches.
  const pattern =
    /(\*\*|__)(?=\S)([\s\S]*?\S)\1|(\*|_)(?=\S)([\s\S]*?\S)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/;
  let rest = line;

  while (rest) {
    const m = pattern.exec(rest);
    if (!m) {
      push(out, rest, {});
      break;
    }
    if (m.index > 0) push(out, rest.slice(0, m.index), {});

    if (m[2] != null) push(out, m[2], { bold: true });
    else if (m[4] != null) push(out, m[4], { italic: true });
    else if (m[5] != null) push(out, m[5], { code: true });
    else if (m[6] != null) out.push({ type: "text", text: { content: m[6].slice(0, LIMIT), link: { url: m[7]! } } });

    rest = rest.slice(m.index + m[0].length);
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

function push(out: RichText[], content: string, annotations: RichText["annotations"]): void {
  if (!content) return;
  // Long runs are split rather than truncated — losing the tail of a paragraph
  // silently would be worse than an extra run.
  for (let i = 0; i < content.length; i += LIMIT) {
    const slice = content.slice(i, i + LIMIT);
    out.push(
      Object.keys(annotations ?? {}).length
        ? { type: "text", text: { content: slice }, annotations }
        : { type: "text", text: { content: slice } },
    );
  }
}

/** Notion caps a single create call at 100 children. */
const MAX_BLOCKS = 100;

export function markdownToBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false;
  let code: string[] = [];
  let codeLang = "plain text";

  const flushCode = () => {
    if (!code.length) return;
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: [{ type: "text", text: { content: code.join("\n").slice(0, LIMIT) } }],
        language: codeLang,
      },
    });
    code = [];
  };

  for (const raw of lines) {
    if (blocks.length >= MAX_BLOCKS) break;
    const line = raw.trimEnd();

    const fence = line.match(/^```\s*(\w+)?/);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLang = notionLanguage(fence[1]);
      }
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }

    if (!line.trim()) continue;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // Notion only has three heading levels; deeper ones become the third.
      const level = Math.min(heading[1]!.length, 3);
      blocks.push({
        object: "block",
        type: `heading_${level}`,
        [`heading_${level}`]: { rich_text: inlineToRich(heading[2]!) },
      });
      continue;
    }

    const todo = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: { rich_text: inlineToRich(todo[2]!), checked: todo[1]!.toLowerCase() === "x" },
      });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: inlineToRich(bullet[1]!) },
      });
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: inlineToRich(numbered[1]!) },
      });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: inlineToRich(quote[1]!) },
      });
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: inlineToRich(line) },
    });
  }
  flushCode();

  if (blocks.length >= MAX_BLOCKS) {
    blocks[MAX_BLOCKS - 1] = {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: "… continued in Uni Study — open the lecture there for the full notes." },
            annotations: { italic: true },
          },
        ],
      },
    };
  }
  return blocks;
}

/** Notion's `code` block only accepts languages from its own list. */
function notionLanguage(lang: string | undefined): string {
  if (!lang) return "plain text";
  const known = [
    "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html", "java",
    "javascript", "json", "kotlin", "latex", "less", "lua", "makefile", "markdown", "matlab",
    "mermaid", "php", "python", "r", "ruby", "rust", "sass", "scala", "shell", "sql", "swift",
    "typescript", "xml", "yaml",
  ];
  const l = lang.toLowerCase();
  const alias: Record<string, string> = { js: "javascript", ts: "typescript", py: "python", sh: "shell", yml: "yaml" };
  const resolved = alias[l] ?? l;
  return known.includes(resolved) ? resolved : "plain text";
}

/* --- The other direction --------------------------------------------------- */

const richToMarkdown = (rich: any[]): string =>
  (Array.isArray(rich) ? rich : [])
    .map((t: any) => {
      let s = t?.plain_text ?? "";
      const a = t?.annotations ?? {};
      if (a.code) s = `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      const url = t?.text?.link?.url ?? t?.href;
      return url ? `[${s}](${url})` : s;
    })
    .join("");

/** Notion blocks → markdown, for the search index and the study assistant. */
export function blocksToMarkdown(blocks: any[]): string {
  const out: string[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const body = b?.[b?.type];
    const rich = richToMarkdown(body?.rich_text ?? []);
    switch (b?.type) {
      case "heading_1":
        out.push(`# ${rich}`);
        break;
      case "heading_2":
        out.push(`## ${rich}`);
        break;
      case "heading_3":
        out.push(`### ${rich}`);
        break;
      case "bulleted_list_item":
        out.push(`- ${rich}`);
        break;
      case "numbered_list_item":
        out.push(`1. ${rich}`);
        break;
      case "to_do":
        out.push(`- [${body?.checked ? "x" : " "}] ${rich}`);
        break;
      case "quote":
        out.push(`> ${rich}`);
        break;
      case "code":
        out.push(`\`\`\`${body?.language ?? ""}\n${rich}\n\`\`\``);
        break;
      case "divider":
        out.push("---");
        break;
      case "callout":
        out.push(`> ${rich}`);
        break;
      case "toggle":
        out.push(`- ${rich}`);
        break;
      case "table_row": {
        const cells = (body?.cells ?? []).map((c: any) => richToMarkdown(c));
        out.push(`| ${cells.join(" | ")} |`);
        break;
      }
      default:
        if (rich) out.push(rich);
    }
  }
  return out.join("\n\n");
}

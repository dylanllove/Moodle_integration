import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ breaks: true, gfm: true });

/** Render trusted local markdown (from our own AI endpoints / the user's notes). */
export function Markdown({ children }: { children: string }) {
  const html = useMemo(() => marked.parse(children ?? "") as string, [children]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

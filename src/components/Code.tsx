import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

export function Code({ code, lang = "sql" }: { code: string; lang?: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let alive = true;
    codeToHtml(code, { lang, theme: "github-dark" })
      .then((h) => {
        if (alive) setHtml(h);
      })
      .catch(() => {
        if (alive) setHtml("");
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  if (!html)
    return (
      <pre className="mono overflow-auto p-3 text-xs leading-relaxed text-zinc-300">{code}</pre>
    );
  return (
    <div
      className="[&_pre]:overflow-auto [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

export function SqlEditor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbRef = useRef({ onChange, onRun });
  cbRef.current = { onChange, onRun };

  useEffect(() => {
    if (!ref.current) return;
    const view = new EditorView({
      parent: ref.current,
      doc: value,
      extensions: [
        basicSetup,
        sql(),
        oneDark,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbRef.current.onChange(u.state.doc.toString());
        }),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              cbRef.current.onRun();
              return true;
            },
          },
        ]),
        EditorView.theme({
          "&": { backgroundColor: "#09090b", fontSize: "13px", maxHeight: "min(42vh, 420px)" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  useEffect(() => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-md border border-zinc-800 [&_.cm-editor]:rounded-md [&_.cm-content]:min-h-[76px] [&_.cm-content]:py-2"
    />
  );
}

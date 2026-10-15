// Syntax-highlighted, non-wrapping code with optional line numbers and the blank marker.

import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import type { LangId } from '../content/types';

hljs.registerLanguage('python', python);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('java', java);

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Splits highlighted HTML into lines, closing any spans still open at the end of a
 * line and reopening them on the next, so every line is valid HTML on its own.
 */
export function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else {
      cur += m[4];
    }
  }
  lines.push(cur);
  return lines;
}

export function highlightLines(code: string, lang: LangId, blank: string): string[] {
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  const b = escapeHtml(blank);
  const marked = html.split(b).join(`<span class="code-blank">${b}</span>`);
  return splitHtmlLines(marked);
}

export function CodeBlock({
  code,
  lang,
  blank,
  showLineNumbers,
  label,
}: {
  code: string;
  lang: LangId;
  blank: string;
  showLineNumbers: boolean;
  label: string;
}) {
  const lines = useMemo(() => highlightLines(code, lang, blank), [code, lang, blank]);
  return (
    <div
      className="code-scroll focus-ring rounded-xl border border-slate-200 bg-slate-50 font-mono text-slate-800"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <pre className="m-0">
        <code className="code-inner block">
          {lines.map((html, i) => (
            <span className="code-line" key={i}>
              {showLineNumbers && <span className="code-ln" data-n={i + 1} aria-hidden />}
              <span className="code-text" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

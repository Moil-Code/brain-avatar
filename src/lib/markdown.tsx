import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

// A small, dependency-free markdown renderer for chat replies. It builds React
// elements (never dangerouslySetInnerHTML), so it is XSS-safe by construction.
// Covers what the model actually emits: headings, bold/italic/strike, inline +
// fenced code, links, bullet/numbered lists, blockquotes, rules, and GFM tables.

let keySeq = 0;
const nk = () => `md${keySeq++}`;

/** Open links in the system browser, never inside the avatar's webview. */
function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

// Inline tokens, ordered so code/link match before emphasis.
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;

/** Parse inline markdown in one line of text into React nodes. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // inline() RECURSES (bold/italic/strike/link inner text). INLINE_RE is a module-level
  // /g regex, so a shared lastIndex would be clobbered by nested calls — when the outer
  // loop resumed, exec() restarted from 0 and re-matched the same token forever, hanging
  // the render and bricking the window. Use a fresh regex instance per call.
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={nk()} className="md-code-inline">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(<strong key={nk()}>{inline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("~~")) {
      nodes.push(<del key={nk()}>{inline(tok.slice(2, -2))}</del>);
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (mm) {
        nodes.push(
          <ExtLink key={nk()} href={mm[2]}>
            {inline(mm[1])}
          </ExtLink>
        );
      } else {
        nodes.push(tok);
      }
    } else if (tok.startsWith("http")) {
      nodes.push(
        <ExtLink key={nk()} href={tok}>
          {tok}
        </ExtLink>
      );
    } else {
      // single * or _ emphasis
      nodes.push(<em key={nk()}>{inline(tok.slice(1, -1))}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Inline parse that preserves soft line breaks within a paragraph. */
function inlineWithBreaks(text: string): ReactNode[] {
  const parts = text.split("\n");
  const out: ReactNode[] = [];
  parts.forEach((p, idx) => {
    out.push(...inline(p));
    if (idx < parts.length - 1) out.push(<br key={nk()} />);
  });
  return out;
}

const isUl = (l: string) => /^\s*[-*+]\s+/.test(l);
const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
const splitRow = (l: string) =>
  l
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

const MAX_BLOCK_DEPTH = 16;

/** Public entry: reset the key counter ONCE, then render. Recursive block parsing
 *  (blockquotes) goes through renderBlocks so keySeq stays monotonic across the whole
 *  tree — resetting it inside recursion previously produced duplicate React keys. */
export function renderMarkdown(src: string): ReactNode {
  keySeq = 0;
  return renderBlocks(src, 0);
}

/** Render a markdown string into safe React nodes for a chat bubble. */
function renderBlocks(src: string, depth: number): ReactNode {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={nk()} className="md-pre">
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={nk()} className="md-hr" />);
      i++;
      continue;
    }

    // Heading
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      blocks.push(
        <div key={nk()} className={`md-h md-h${lvl}`}>
          {inline(h[2])}
        </div>
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={nk()} className="md-quote">
          {depth < MAX_BLOCK_DEPTH
            ? renderBlocks(body.join("\n"), depth + 1)
            : body.join("\n")}
        </blockquote>
      );
      continue;
    }

    // GFM table: a header row with pipes followed by a separator row of dashes
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("-") &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      const header = splitRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <table key={nk()} className="md-table">
          <thead>
            <tr>
              {header.map((c) => (
                <th key={nk()}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={nk()}>
                {r.map((c) => (
                  <td key={nk()}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    // Unordered list
    if (isUl(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(<li key={nk()}>{inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>);
        i++;
      }
      blocks.push(
        <ul key={nk()} className="md-ul">
          {items}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (isOl(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(<li key={nk()}>{inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>);
        i++;
      }
      blocks.push(
        <ol key={nk()} className="md-ol">
          {items}
        </ol>
      );
      continue;
    }

    // Paragraph: consume until a blank line or the next block starter
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s/.test(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={nk()} className="md-p">
        {inlineWithBreaks(para.join("\n"))}
      </p>
    );
  }

  return <div className="md">{blocks}</div>;
}

"use client";

/**
 * Dependency-free mini-markdown renderer for assistant chat bubbles. Builds
 * React nodes directly — no dangerouslySetInnerHTML anywhere, so raw HTML in
 * the input renders as literal text (XSS-safe by construction).
 *
 * Supported: paragraphs (single \n → <br/>), ordered + bulleted lists,
 * `inline code`, **bold**, *italic* / _italic_. Code wins over everything
 * and nothing nests inside it.
 */
import { Fragment, type ReactNode } from "react";
import { cn } from "@/components/ui";

const ORDERED_RE = /^\d+[.)]\s+/;
const BULLET_RE = /^[-*•]\s+/;

/** Single-pass inline tokenizer; recurses only into bold/italic content. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        out.push(
          <code key={out.length} className="rounded bg-surface-3 px-1 font-mono text-[11px]">
            {text.slice(i + 1, close)}
          </code>,
        );
        i = close + 1;
        continue;
      }
    } else if (text.startsWith("**", i)) {
      const close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        flush();
        out.push(<strong key={out.length}>{renderInline(text.slice(i + 2, close))}</strong>);
        i = close + 2;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      // `_` opens only at a word boundary (snake_case survives); both reject
      // whitespace-adjacent content so "2 * 3 * 4" stays literal.
      const boundaryOk = ch === "*" || i === 0 || /\s/.test(text[i - 1]!);
      const close = text.indexOf(ch, i + 1);
      if (
        boundaryOk &&
        close > i + 1 &&
        !/\s/.test(text[i + 1]!) &&
        !/\s/.test(text[close - 1]!)
      ) {
        flush();
        out.push(<em key={out.length}>{renderInline(text.slice(i + 1, close))}</em>);
        i = close + 1;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Paragraph body: single newlines become <br/>. */
function renderLines(lines: string[]): ReactNode {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {renderInline(line)}
    </Fragment>
  ));
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className={cn("space-y-1.5", className)}>
      {blocks.map((block, i) => {
        const lines = block.split("\n").map((l) => l.trim());
        if (lines.every((l) => ORDERED_RE.test(l))) {
          return (
            <ol key={i} className="list-decimal pl-4 space-y-0.5">
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(ORDERED_RE, ""))}</li>
              ))}
            </ol>
          );
        }
        if (lines.every((l) => BULLET_RE.test(l))) {
          return (
            <ul key={i} className="list-disc pl-4 space-y-0.5">
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(BULLET_RE, ""))}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{renderLines(lines)}</p>;
      })}
    </div>
  );
}

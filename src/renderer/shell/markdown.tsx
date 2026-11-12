import type { JSX, ReactNode } from "react";

/**
 * A deliberately small Markdown renderer. Every value becomes a React text node
 * or an element this file created; nothing is ever injected as HTML, so raw
 * HTML in model or tool output cannot execute. Links are rendered as inert
 * labels with the destination in `title`, never as navigation in the privileged
 * window.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
const FENCE = /^\s{0,3}```([A-Za-z0-9_+.-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.+)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.+)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.+)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/;

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const key = `${keyPrefix}-i${index}`;
    index += 1;
    if (token.startsWith("`")) {
      nodes.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const url = link ? safeUrl(link[2] ?? "") : null;
      nodes.push(
        <span className="md-link" key={key} title={url ?? "link was not a safe https URL"}>
          {label}
          {url ? <span className="md-link__url"> ({url})</span> : null}
        </span>,
      );
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: JSX.Element[] = [];
  let i = 0;
  let key = 0;
  const nextKey = (): string => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre className="md-pre" key={nextKey()}>
          <code data-language={language || undefined}>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1]?.length ?? 1);
      const content = renderInline(heading[2] ?? "", nextKey());
      if (level === 1) blocks.push(<h3 key={nextKey()}>{content}</h3>);
      else if (level === 2) blocks.push(<h4 key={nextKey()}>{content}</h4>);
      else blocks.push(<h5 key={nextKey()}>{content}</h5>);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={nextKey()} />);
      i += 1;
      continue;
    }

    if (BULLET.test(line)) {
      const items: JSX.Element[] = [];
      while (i < lines.length && BULLET.test(lines[i] ?? "")) {
        const item = BULLET.exec(lines[i] ?? "");
        items.push(<li key={nextKey()}>{renderInline(item?.[1] ?? "", nextKey())}</li>);
        i += 1;
      }
      blocks.push(<ul key={nextKey()}>{items}</ul>);
      continue;
    }

    if (NUMBERED.test(line)) {
      const items: JSX.Element[] = [];
      while (i < lines.length && NUMBERED.test(lines[i] ?? "")) {
        const item = NUMBERED.exec(lines[i] ?? "");
        items.push(<li key={nextKey()}>{renderInline(item?.[1] ?? "", nextKey())}</li>);
        i += 1;
      }
      blocks.push(<ol key={nextKey()}>{items}</ol>);
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        body.push(QUOTE.exec(lines[i] ?? "")?.[1] ?? "");
        i += 1;
      }
      blocks.push(
        <blockquote key={nextKey()}>{renderInline(body.join(" "), nextKey())}</blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !FENCE.test(lines[i] ?? "") &&
      !HEADING.test(lines[i] ?? "") &&
      !BULLET.test(lines[i] ?? "") &&
      !NUMBERED.test(lines[i] ?? "") &&
      !QUOTE.test(lines[i] ?? "") &&
      !RULE.test(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(<p key={nextKey()}>{renderInline(paragraph.join("\n"), nextKey())}</p>);
  }

  return <div className="markdown">{blocks}</div>;
}

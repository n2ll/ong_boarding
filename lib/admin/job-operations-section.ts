function operationsSection(body: string) {
  const headings = [...body.matchAll(/^[ \t]*\[([^\[\]\r\n]+)\][ \t]*(?:\r?\n|$)/gm)];
  const matches = headings.filter((heading) => heading[1].trim() === "운행 안내");
  if (matches.length !== 1) return null;
  const heading = matches[0];
  const next = headings[headings.indexOf(heading) + 1];
  const start = heading.index + heading[0].length;
  const end = next?.index ?? body.length;
  const raw = body.slice(start, end);
  // One newline belongs to the next heading's boundary; all others remain editable.
  const content = next ? raw.replace(/\r?\n$/, "") : raw;
  return { start, end, content, hasNext: !!next, hasHeaderNewline: heading[0].endsWith("\n"),
    newline: heading[0].endsWith("\r\n") || (!heading[0].endsWith("\n") && body.includes("\r\n")) ? "\r\n" : "\n" };
}

/** Only a unique standalone [운행 안내] heading identifies editable operations. */
export function getJobOperationsSection(body: string): string | null {
  return operationsSection(body)?.content ?? null;
}

/** Fast editing is safe only when no operations or clock times remain outside the section. */
export function canEditJobOperationsSection(body: string): boolean {
  const section = operationsSection(body);
  if (!section) return false;
  const outside = body.slice(0, section.start) + body.slice(section.end);
  return !/상차|수거|회수|재방문|반납|\d{1,2}:\d{2}|\d{1,2}\s*시/.test(outside);
}

/** Replaces only this section; a missing or ambiguous heading leaves the body untouched. */
export function replaceJobOperationsSection(body: string, content: string): string {
  const section = operationsSection(body);
  if (!section) return body;
  const nextContent = content.replace(/\r?\n/g, section.newline);
  if (nextContent === section.content) return body;
  const headerNewline = !section.hasHeaderNewline && nextContent ? section.newline : "";
  const boundary = section.hasNext ? section.newline : "";
  return body.slice(0, section.start) + headerNewline + nextContent + boundary + body.slice(section.end);
}

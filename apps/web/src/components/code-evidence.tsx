/** Verified code excerpts from the learner's pull request, with file and line references. */
export interface EvidenceItem {
  path: string;
  startLine?: number;
  endLine?: number;
  excerpt: string;
  rationale?: string;
}

function lineLabel(item: EvidenceItem) {
  if (!item.startLine) return item.path;
  const end = item.endLine && item.endLine !== item.startLine ? `–${item.endLine}` : "";
  return `${item.path}:${item.startLine}${end}`;
}

export function CodeEvidence({
  items,
  showRationale = true,
}: {
  items: EvidenceItem[];
  showRationale?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-3">
      {items.map((item, index) => (
        <li key={`${item.path}-${index}`} className="space-y-1">
          <div className="break-all font-mono text-xs text-stone-500">{lineLabel(item)}</div>
          <pre className="overflow-x-auto rounded-md bg-stone-100 p-3 text-xs dark:bg-stone-900">
            <code>{item.excerpt}</code>
          </pre>
          {showRationale && item.rationale && (
            <p className="text-sm text-stone-600 dark:text-stone-400">{item.rationale}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Lesson prose: paragraphs split on blank lines, `inline code` rendered as code. Never HTML. */
export function Prose({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`}>
      {text
        .split(/\n\s*\n/)
        .filter((paragraph) => paragraph.trim() !== "")
        .map((paragraph, index) => (
          <p key={index}>
            {paragraph.split(/(`[^`\n]+`)/).map((part, partIndex) =>
              part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
                <code
                  key={partIndex}
                  className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-stone-900"
                >
                  {part.slice(1, -1)}
                </code>
              ) : (
                part
              ),
            )}
          </p>
        ))}
    </div>
  );
}

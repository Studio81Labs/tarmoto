export function VarChips({
  vars,
  onInsert,
}: {
  vars: string[];
  onInsert: (token: string) => void;
}) {
  if (vars.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {vars.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`{${v}}`)}
          className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-fg-dim transition hover:border-accent hover:text-ink"
        >
          {`{${v}}`}
        </button>
      ))}
    </div>
  );
}

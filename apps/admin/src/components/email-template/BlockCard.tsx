import type { components } from "@tarmoto/openapi-client";
import { Button, Input, Select } from "@tarmoto/ui";
import { VarChips } from "./VarChips.js";

export type EditorBlock = components["schemas"]["EmailBlockDto"];

interface BlockCardProps {
  block: EditorBlock;
  index: number;
  total: number;
  textVars: string[];
  urlVars: string[];
  onChange: (next: EditorBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

export function BlockCard({
  block,
  index,
  total,
  textVars,
  urlVars,
  onChange,
  onMove,
  onRemove,
}: BlockCardProps) {
  const patch = (partial: Partial<EditorBlock>) =>
    onChange({ ...block, ...partial });

  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-fg-dim">
          {block.type}
        </span>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            aria-label="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Remove block"
            onClick={onRemove}
          >
            ✕
          </Button>
        </div>
      </div>

      {(block.type === "heading" || block.type === "paragraph") && (
        <div>
          <Input
            value={block.text ?? ""}
            onChange={(v) => patch({ text: v })}
            ariaLabel="Text"
            placeholder="Text (may contain {vars})"
          />
          <VarChips
            vars={textVars}
            onInsert={(token) => patch({ text: (block.text ?? "") + token })}
          />
        </div>
      )}

      {block.type === "stat-row" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={block.label ?? ""}
            onChange={(v) => patch({ label: v })}
            ariaLabel="Label"
            placeholder="Label"
          />
          <div>
            <Input
              value={block.value ?? ""}
              onChange={(v) => patch({ value: v })}
              ariaLabel="Value"
              placeholder="Value (may contain {vars})"
            />
            <VarChips
              vars={textVars}
              onInsert={(token) =>
                patch({ value: (block.value ?? "") + token })
              }
            />
          </div>
        </div>
      )}

      {block.type === "button" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={block.label ?? ""}
            onChange={(v) => patch({ label: v })}
            ariaLabel="Button label"
            placeholder="Button label"
          />
          <Select
            value={block.urlVar ?? ""}
            onChange={(v) => patch({ urlVar: v })}
            ariaLabel="Button link"
            options={[
              { value: "", label: "Choose a link…" },
              // Whitelist-only: the admin can only pick a vetted url var.
              ...urlVars.map((u) => ({ value: u, label: `{${u}}` })),
            ]}
          />
        </div>
      )}

      {(block.type === "divider" || block.type === "spacer") && (
        <p className="text-xs text-fg-dim">
          No content — renders a {block.type}.
        </p>
      )}
    </div>
  );
}

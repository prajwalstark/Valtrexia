import { cn } from "@/lib/utils";

export interface Segment {
  key: string;
  label: string;
  value: number;
  /** A CSS colour, normally a status token. */
  fill: string;
}

/**
 * One whole split into parts: a thin bar with no text on it. The figures are
 * always written out beside it, so the bar only has to show proportion.
 *
 * Parts are separated by a 2px gap of the surface behind them, never by a
 * border. A part at zero draws nothing.
 */
export function SegmentedBar({
  segments,
  label,
  dense = false,
  className,
}: {
  segments: Segment[];
  /** What the whole is, for screen readers: "Clients by health". */
  label: string;
  /** 4px for use inside list rows, 8px otherwise. */
  dense?: boolean;
  className?: string;
}) {
  const shown = segments.filter((segment) => segment.value > 0);
  const total = shown.reduce((sum, segment) => sum + segment.value, 0);
  const spoken = `${label}: ${shown.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(", ") || "none"}`;

  return (
    <div
      role="img"
      aria-label={spoken}
      className={cn(
        "flex w-full gap-0.5 overflow-hidden rounded-full",
        dense ? "h-1" : "h-2",
        total === 0 && "bg-line",
        className,
      )}
    >
      {shown.map((segment) => (
        <div
          key={segment.key}
          title={`${segment.label}: ${segment.value} of ${total}`}
          // min-width keeps a small part visible instead of vanishing.
          style={{
            flexGrow: segment.value,
            backgroundColor: segment.fill,
            minWidth: dense ? 3 : 4,
          }}
          className="basis-0"
        />
      ))}
    </div>
  );
}

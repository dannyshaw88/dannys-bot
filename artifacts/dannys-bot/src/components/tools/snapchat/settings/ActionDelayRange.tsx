import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ActionDelayRangeProps = {
  minSeconds: number;
  maxSeconds: number;
  disabled: boolean;
  onChange: (patch: { delayMinSeconds?: number; delayMaxSeconds?: number }) => void;
};

const clampSeconds = (value: number) =>
  Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));

export function ActionDelayRange({
  minSeconds,
  maxSeconds,
  disabled,
  onChange,
}: ActionDelayRangeProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
      <Label className="text-[11px] text-muted-foreground">Delay (seconds)</Label>
      <Input
        type="number"
        min={1}
        aria-label="Minimum seconds between actions"
        className="box-content w-[6ch] h-7 px-1 text-center text-xs"
        value={clampSeconds(minSeconds)}
        onChange={event => onChange({ delayMinSeconds: clampSeconds(Number(event.target.value)) })}
        disabled={disabled}
      />
      <span className="text-xs text-muted-foreground">–</span>
      <Input
        type="number"
        min={1}
        aria-label="Maximum seconds between actions"
        className="box-content w-[6ch] h-7 px-1 text-center text-xs"
        value={clampSeconds(maxSeconds)}
        onChange={event => onChange({ delayMaxSeconds: clampSeconds(Number(event.target.value)) })}
        disabled={disabled}
      />
    </div>
  );
}

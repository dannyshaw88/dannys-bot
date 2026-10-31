import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function clampSettingNumber(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));
}

type NumberRangeFieldsProps = {
  label: string;
  minValue: number;
  maxValue: number;
  min: number;
  max: number;
  disabled: boolean;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
};

export function NumberRangeFields({
  label,
  minValue,
  maxValue,
  min,
  max,
  disabled,
  onMinChange,
  onMaxChange,
}: NumberRangeFieldsProps) {
  const clamp = (value: number) => Math.max(min, Math.min(max, clampSettingNumber(value)));
  return (
    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        className="box-content w-[3ch] h-7 px-1 text-center text-xs"
        value={clamp(minValue)}
        onChange={event => onMinChange(clamp(Number(event.target.value)))}
        disabled={disabled}
      />
      <span className="text-xs text-muted-foreground">–</span>
      <Input
        type="number"
        min={min}
        max={max}
        className="box-content w-[3ch] h-7 px-1 text-center text-xs"
        value={clamp(maxValue)}
        onChange={event => onMaxChange(clamp(Number(event.target.value)))}
        disabled={disabled}
      />
    </div>
  );
}

type ShuffleToolOrderSettingProps = {
  value: boolean;
  disabled: boolean;
  id: string;
  onChange: (value: boolean) => void;
};

export function ShuffleToolOrderSetting({ value, disabled, id, onChange }: ShuffleToolOrderSettingProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        id={id}
        checked={value}
        onChange={event => onChange(event.target.checked)}
        disabled={disabled}
        className="w-4 h-4 accent-primary cursor-pointer"
      />
      <span className="text-sm text-muted-foreground">Shuffle tool order</span>
    </label>
  );
}

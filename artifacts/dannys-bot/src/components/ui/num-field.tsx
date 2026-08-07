import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

interface NumFieldProps {
  value: number | undefined | null;
  min?: number;
  max?: number;
  className?: string;
  onChange: (v: number) => void;
}

export function NumField({ value, min, max, className, onChange }: NumFieldProps) {
  const [local, setLocal] = useState(String(value ?? ""));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setLocal(String(value ?? ""));
  }, [value]);

  const commit = () => {
    focused.current = false;
    let v = parseFloat(local);
    if (isNaN(v)) v = min ?? 0;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    setLocal(String(v));
    onChange(v);
  };

  return (
    <Input
      type="number"
      className={className}
      min={min}
      max={max}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={commit}
    />
  );
}

import "flag-icons/css/flag-icons.min.css";

export function SimFlag({ code }: { code: string }) {
  return (
    <span
      className={`fi fi-${code.toLowerCase()} inline-block shrink-0 overflow-hidden rounded-[1px]`}
      style={{ width: 19.2, height: 12.8 }}
      aria-hidden="true"
      data-testid={`flag-sim-country-${code.toLowerCase()}`}
    />
  );
}

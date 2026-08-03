export function FlagIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 12 16"
      fill="currentColor"
      className={className}
      aria-label={title}
    >
      <rect x="1" y="0" width="1.5" height="16" rx="0.5" />
      <polygon points="2.5,1 11,4.5 2.5,8.5" />
    </svg>
  );
}

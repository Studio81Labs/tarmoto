interface BrandMarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 20, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="18" y="20" width="64" height="12" rx="4" fill="var(--road)" />
      <rect x="40" y="20" width="20" height="42" rx="4" fill="var(--road)" />
      <path
        d="M 16 80 L 30 80 L 38 70 L 46 86 L 54 68 L 62 82 L 70 76 L 84 76"
        stroke="var(--road)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

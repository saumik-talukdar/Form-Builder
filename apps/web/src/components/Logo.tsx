export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="4" fill="#FFD84D" />
      <g stroke="#0F1B2D" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M9 8v16M14.5 8v16M20 8v16" />
        <path d="M6 21L26 11" />
      </g>
    </svg>
  );
}

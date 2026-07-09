import { LOGO_MARK_PATHS, LOGO_MARK_VIEWBOX } from "@/lib/brand/logo-mark";

/** The arima "A" mark. Colors via `currentColor` — set text color on a parent. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={LOGO_MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {LOGO_MARK_PATHS.map((d) => (
        <path key={d} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}

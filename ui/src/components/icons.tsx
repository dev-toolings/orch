import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 16, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    />
  );
}

export const IconLayout = (p: IconProps) => <I {...p}><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></I>;
export const IconQueue = (p: IconProps) => <I {...p}><path d="M4 6h16M4 12h16M4 18h10" /></I>;
export const IconCheck = (p: IconProps) => <I {...p}><path d="M20 6 9 17l-5-5" /></I>;
export const IconShield = (p: IconProps) => <I {...p}><path d="M12 3 20 7v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7z" /></I>;
export const IconPeople = (p: IconProps) => <I {...p}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.4" /><path d="M3 19c.6-3 3-5 6-5s5.4 2 6 5M15 19c.3-1.6 1.4-3 3-3.6" /></I>;
export const IconGrid = (p: IconProps) => <I {...p}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></I>;
export const IconBolt = (p: IconProps) => <I {...p}><path d="M13 3 4 14h7l-1 7 9-11h-7z" /></I>;
export const IconCoins = (p: IconProps) => <I {...p}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></I>;
export const IconBook = (p: IconProps) => <I {...p}><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M6 3v16" /></I>;
export const IconPulse = (p: IconProps) => <I {...p}><path d="M3 12h4l2-6 4 12 2-6h6" /></I>;
export const IconBox = (p: IconProps) => <I {...p}><path d="M3 8 12 3l9 5-9 5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></I>;
export const IconSearch = (p: IconProps) => <I {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></I>;
export const IconBell = (p: IconProps) => <I {...p}><path d="M6 9a6 6 0 1 1 12 0c0 7 2 7 2 7H4s2 0 2-7" /><path d="M10 20a2 2 0 0 0 4 0" /></I>;
export const IconSun = (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></I>;
export const IconMoon = (p: IconProps) => <I {...p}><path d="M17 15.5A7 7 0 1 1 10 4a7 7 0 0 0 7 11.5z" /></I>;
export const IconChevron = (p: IconProps) => <I {...p}><path d="m9 6 6 6-6 6" /></I>;
export const IconDot = (p: IconProps) => <I {...p}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></I>;
export const IconAlert = (p: IconProps) => <I {...p}><path d="M12 9v4M12 17h.01" /><path d="m10.3 4.3-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-2.7l-8-14a2 2 0 0 0-3.4 0z" /></I>;
export const IconMail = (p: IconProps) => <I {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></I>;
export const IconX = (p: IconProps) => <I {...p}><path d="M6 6 18 18M18 6 6 18" /></I>;
export const IconFlow = (p: IconProps) => <I {...p}><rect x="2.5" y="4" width="6" height="5" rx="1.2" /><rect x="15.5" y="4" width="6" height="5" rx="1.2" /><rect x="9" y="15" width="6" height="5" rx="1.2" /><path d="M8.5 6.5h7M5.5 9v3.5H12V15M18.5 9v3.5H12" /></I>;

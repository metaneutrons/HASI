import type { SVGProps } from "react";

import {
  HASI_BRAND_PATHS,
  HASI_BRAND_STROKE_WIDTH,
  HASI_BRAND_VIEW_BOX,
} from "@/lib/hasi-brand";

export type HasiIconProps = Omit<
  SVGProps<SVGSVGElement>,
  "viewBox" | "width" | "height" | "role" | "aria-hidden"
> & {
  decorative?: boolean;
  size?: number;
};

export function HasiIcon({
  size = 24,
  decorative = true,
  "aria-label": ariaLabel,
  ...props
}: HasiIconProps) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={HASI_BRAND_VIEW_BOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={HASI_BRAND_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative}
      aria-label={decorative ? undefined : (ariaLabel ?? "HASI")}
      focusable="false"
    >
      <path d={HASI_BRAND_PATHS.bubble} />
      <path d={HASI_BRAND_PATHS.h} />
    </svg>
  );
}

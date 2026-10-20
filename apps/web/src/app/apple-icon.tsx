import { ImageResponse } from "next/og";

import { HasiIcon } from "@/components/hasi-icon";
import { HASI_BRAND_COLORS } from "@/lib/hasi-brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: HASI_BRAND_COLORS.lightAccent,
      }}
    >
      <HasiIcon
        size={120}
        style={{ color: HASI_BRAND_COLORS.appIconForeground }}
      />
    </div>,
    size,
  );
}

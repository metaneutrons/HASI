import { ImageResponse } from "next/og";
import { HasiIcon } from "@/components/hasi-icon";
import { HASI_BRAND_COLORS } from "@/lib/hasi-brand";

export const alt = "HASI — öffentliche Testumgebung mit synthetischen Campusdaten";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#f5f4f1", color: "#20221f", padding: "64px 72px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 25 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><HasiIcon size={40} style={{ color: HASI_BRAND_COLORS.lightAccent }} /><span style={{ fontWeight: 700 }}>hasi</span></div>
        <span style={{ color: "#686d66" }}>Öffentliche Testumgebung</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", fontSize: 78, lineHeight: 1.08, letterSpacing: "-3px", fontWeight: 700 }}>
        <span>Dein Campus.</span>
        <span style={{ color: "#cf6b43" }}>Ein Assistent.</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 23, color: "#686d66" }}>
        <span>Frag HASI. Erledige deinen nächsten Schritt.</span>
        <span>Ausschließlich Testdaten</span>
      </div>
    </div>,
    size,
  );
}

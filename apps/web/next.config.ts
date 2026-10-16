import type { NextConfig } from "next";

const apiOrigin = process.env.HASI_API_ORIGIN ?? "http://127.0.0.1:4100";
const publicBrowserDemo = process.env.NEXT_PUBLIC_HASI_PUBLIC_DEMO === "1";

const nextConfig: NextConfig = {
  async rewrites() {
    if (publicBrowserDemo) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

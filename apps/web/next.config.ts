import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appDirectory, "../..");
const apiOrigin = process.env.HASI_API_ORIGIN ?? "http://127.0.0.1:4100";
const publicDemoBuild = process.env.NEXT_PUBLIC_HASI_PUBLIC_DEMO === "1";
const standaloneBuild = process.env.HASI_STANDALONE_BUILD === "1";

const nextConfig: NextConfig = {
  ...(standaloneBuild
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: workspaceRoot,
        outputFileTracingIncludes: {
          "/*": [
            "../../fixtures/anny-hsh-rooms-v1.json",
            "../../fixtures/knowledge-demo-v1.json",
          ],
        },
      }
    : {}),
  rewrites() {
    if (publicDemoBuild) return Promise.resolve([]);
    return Promise.resolve([
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
    ]);
  },
};

export default nextConfig;

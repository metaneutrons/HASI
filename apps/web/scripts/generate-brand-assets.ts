import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HASI_BRAND_COLORS,
  HASI_BRAND_PATHS,
  HASI_BRAND_STROKE_WIDTH,
  HASI_BRAND_VIEW_BOX,
} from "../src/lib/hasi-brand.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const checkMode = process.argv.includes("--check");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unexpectedArguments.length > 0) {
  throw new Error("Unsupported arguments: " + unexpectedArguments.join(", "));
}

function markGroup(color: string, transform: string): string {
  return [
    '<g transform="' + transform + '" fill="none" stroke="' + color + '" stroke-width="' + String(HASI_BRAND_STROKE_WIDTH) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '  <path d="' + HASI_BRAND_PATHS.bubble + '" />',
    '  <path d="' + HASI_BRAND_PATHS.h + '" />',
    "</g>",
  ].join("\n");
}

function heroSvg(theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const accent = dark ? HASI_BRAND_COLORS.darkAccent : HASI_BRAND_COLORS.lightAccent;
  const wordmark = dark ? HASI_BRAND_COLORS.darkWordmark : HASI_BRAND_COLORS.lightWordmark;
  const institution = dark
    ? HASI_BRAND_COLORS.darkInstitution
    : HASI_BRAND_COLORS.lightInstitution;
  const divider = dark ? HASI_BRAND_COLORS.darkDivider : HASI_BRAND_COLORS.lightDivider;

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="280" viewBox="0 0 1200 280" role="img" aria-labelledby="title desc">',
    '  <title id="title">HASI product identity</title>',
    '  <desc id="desc">The HASI dialogue mark and lowercase wordmark. Hochschule Hannover is shown separately as institutional attribution.</desc>',
    "  " + markGroup(accent, "translate(156 76) scale(1.3)"),
    '  <text x="322" y="166" fill="' + wordmark + '" font-family="-apple-system, BlinkMacSystemFont, &quot;SF Pro Display&quot;, &quot;SF Pro Text&quot;, &quot;Segoe UI&quot;, sans-serif" font-size="96" font-weight="680" letter-spacing="-0.075em">hasi</text>',
    '  <path d="M604 89v102" stroke="' + divider + '" stroke-width="2" />',
    '  <text x="650" y="151" fill="' + institution + '" font-family="-apple-system, BlinkMacSystemFont, &quot;SF Pro Display&quot;, &quot;SF Pro Text&quot;, &quot;Segoe UI&quot;, sans-serif" font-size="28" font-weight="500" letter-spacing="0.075em">HOCHSCHULE HANNOVER</text>',
    "</svg>",
    "",
  ].join("\n");
}

function appIconSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-labelledby="title desc">',
    '  <title id="title">HASI app icon</title>',
    '  <desc id="desc">Scalable HASI dialogue mark for 32 or 64 pixel display.</desc>',
    '  <rect x="1" y="1" width="62" height="62" rx="15" fill="' + HASI_BRAND_COLORS.lightAccent + '" />',
    '  <svg x="8" y="8" width="48" height="48" viewBox="' + HASI_BRAND_VIEW_BOX + '" fill="none" stroke="' + HASI_BRAND_COLORS.appIconForeground + '" stroke-width="' + String(HASI_BRAND_STROKE_WIDTH) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
    '    <path d="' + HASI_BRAND_PATHS.bubble + '" />',
    '    <path d="' + HASI_BRAND_PATHS.h + '" />',
    "  </svg>",
    "</svg>",
    "",
  ].join("\n");
}

const assets = new Map<string, string>([
  ["docs/assets/hasi-hero-light.svg", heroSvg("light")],
  ["docs/assets/hasi-hero-dark.svg", heroSvg("dark")],
  ["apps/web/src/app/icon.svg", appIconSvg()],
]);

const changed: string[] = [];

for (const [relativePath, expected] of assets) {
  const absolutePath = resolve(repositoryRoot, relativePath);

  if (checkMode) {
    let actual: string | undefined;
    try {
      actual = await readFile(absolutePath, "utf8");
    } catch {
      actual = undefined;
    }
    if (actual !== expected) changed.push(relativePath);
    continue;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, expected, "utf8");
  console.log("Wrote " + relativePath);
}

if (checkMode) {
  if (changed.length > 0) {
    console.error("Generated brand assets are out of date:");
    for (const relativePath of changed) console.error("  " + relativePath);
    process.exitCode = 1;
  } else {
    console.log("Generated brand assets match.");
  }
}

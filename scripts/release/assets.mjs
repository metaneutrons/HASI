#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const architectures = ["amd64", "arm64"];
const inventoryName = "SHA256SUMS";

function fail(message) {
  throw new Error(message);
}

export function expectedPayloadName(tag, architecture) {
  if (!architectures.includes(architecture)) fail(`unsupported release architecture: ${architecture}`);
  return `hasi-${tag}-linux-${architecture}.oci.tar`;
}

export function expectedReleaseAssetNames(tag) {
  return architectures.flatMap((architecture) => {
    const payload = expectedPayloadName(tag, architecture);
    return [payload, `${payload}.spdx.json`, `${payload}.sigstore.json`];
  }).sort();
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertFlatRegularFiles(directory) {
  const entries = await readdir(directory);
  for (const entry of entries) {
    const stats = await lstat(path.join(directory, entry));
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`release asset is not a regular file: ${entry}`);
  }
  return entries.sort();
}

export async function createChecksumInventory(directory, tag) {
  const expected = expectedReleaseAssetNames(tag);
  const actual = await assertFlatRegularFiles(directory);
  if (actual.includes(inventoryName)) fail(`${inventoryName} already exists; refusing to replace it.`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`release assets differ from the expected inventory. Expected: ${expected.join(", ")}; found: ${actual.join(", ")}.`);
  }

  const lines = [];
  for (const name of expected) lines.push(`${await sha256(path.join(directory, name))}  ${name}`);
  await writeFile(path.join(directory, inventoryName), `${lines.join("\n")}\n`, { flag: "wx" });
  return lines;
}

export async function verifyChecksumInventory(directory, tag) {
  const expected = [...expectedReleaseAssetNames(tag), inventoryName].sort();
  const actual = await assertFlatRegularFiles(directory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`downloaded release inventory differs from the expected set. Expected: ${expected.join(", ")}; found: ${actual.join(", ")}.`);
  }

  const inventory = await readFile(path.join(directory, inventoryName), "utf8");
  const records = inventory.trimEnd().split("\n");
  if (records.length !== expected.length - 1) fail(`${inventoryName} has an unexpected number of entries.`);
  const parsed = new Map();
  for (const record of records) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(record);
    if (!match || parsed.has(match[2])) fail(`${inventoryName} contains an invalid or duplicate entry.`);
    parsed.set(match[2], match[1]);
  }

  const names = [...parsed.keys()].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedReleaseAssetNames(tag))) {
    fail(`${inventoryName} names differ from the expected asset set.`);
  }
  for (const name of names) {
    const digest = await sha256(path.join(directory, name));
    if (digest !== parsed.get(name)) fail(`checksum mismatch for ${name}.`);
  }
  return names;
}

export async function verifyReadback(localDirectory, downloadedDirectory, tag) {
  const localNames = await verifyChecksumInventory(localDirectory, tag);
  const downloadedNames = await verifyChecksumInventory(downloadedDirectory, tag);
  if (JSON.stringify(localNames) !== JSON.stringify(downloadedNames)) {
    fail("downloaded release assets differ from the locally qualified inventory.");
  }
  const localInventory = await readFile(path.join(localDirectory, inventoryName));
  const downloadedInventory = await readFile(path.join(downloadedDirectory, inventoryName));
  if (!localInventory.equals(downloadedInventory)) {
    fail("downloaded SHA256SUMS differs from the locally qualified inventory.");
  }
  return downloadedNames;
}

async function main() {
  const [mode, directory, tag] = process.argv.slice(2);
  if (!mode || !directory || !tag) fail("usage: assets.mjs create|verify <directory> <release-tag> [downloaded-directory]");
  if (mode === "create") {
    const records = await createChecksumInventory(directory, tag);
    process.stdout.write(`Wrote ${inventoryName} for ${records.length} release assets.\n`);
    return;
  }
  if (mode === "verify") {
    const names = await verifyChecksumInventory(directory, tag);
    process.stdout.write(`Verified ${names.length} release assets against ${inventoryName}.\n`);
    return;
  }
  if (mode === "compare") {
    const [downloadedDirectory] = process.argv.slice(5);
    if (!downloadedDirectory) fail("usage: assets.mjs compare <local-directory> <release-tag> <downloaded-directory>");
    const names = await verifyReadback(directory, downloadedDirectory, tag);
    process.stdout.write(`Verified exact byte-identical readback for ${names.length} qualified release assets.\n`);
    return;
  }
  fail("usage: assets.mjs create|verify|compare <directory> <release-tag> [downloaded-directory]");
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`release asset inventory failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}

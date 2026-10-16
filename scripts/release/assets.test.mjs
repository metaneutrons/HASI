import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createChecksumInventory,
  expectedPayloadName,
  expectedReleaseAssetNames,
  verifyChecksumInventory,
  verifyReadback,
} from "./assets.mjs";

const tag = "v0.1.0";

async function withAssetDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hasi-release-assets-"));
  try {
    for (const name of expectedReleaseAssetNames(tag)) {
      await writeFile(path.join(directory, name), `test fixture for ${name}\n`);
    }
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creates and verifies an exact, sorted release asset inventory", async () => {
  await withAssetDirectory(async (directory) => {
    const lines = await createChecksumInventory(directory, tag);
    const verified = await verifyChecksumInventory(directory, tag);
    assert.equal(lines.length, 6);
    assert.deepEqual(verified, expectedReleaseAssetNames(tag));
    assert.match(await readFile(path.join(directory, "SHA256SUMS"), "utf8"), /^[a-f0-9]{64}  hasi-/);
  });
});

test("rejects a checksum mismatch in an isolated corrupted copy", async () => {
  await withAssetDirectory(async (directory) => {
    await createChecksumInventory(directory, tag);
    const payload = expectedPayloadName(tag, "amd64");
    await writeFile(path.join(directory, payload), "corrupted isolated fixture\n");
    await assert.rejects(verifyChecksumInventory(directory, tag), /checksum mismatch/);
  });
});

test("rejects a missing platform asset and a duplicate checksum line", async () => {
  await withAssetDirectory(async (directory) => {
    const payload = expectedPayloadName(tag, "arm64");
    await rm(path.join(directory, payload));
    await assert.rejects(createChecksumInventory(directory, tag), /differ from the expected inventory/);
  });

  await withAssetDirectory(async (directory) => {
    await createChecksumInventory(directory, tag);
    const checksumFile = path.join(directory, "SHA256SUMS");
    const current = await readFile(checksumFile, "utf8");
    await writeFile(checksumFile, `${current}${current.split("\n")[0]}\n`);
    await assert.rejects(verifyChecksumInventory(directory, tag), /unexpected number of entries/);
  });
});

test("rejects extra assets instead of selecting the first matching file", async () => {
  await withAssetDirectory(async (directory) => {
    await mkdir(path.join(directory, "unexpected"));
    await assert.rejects(createChecksumInventory(directory, tag), /not a regular file/);
  });
});

test("requires remote asset readback to match the exact local qualified bytes", async () => {
  await withAssetDirectory(async (localDirectory) => {
    await createChecksumInventory(localDirectory, tag);
    const downloadedDirectory = await mkdtemp(path.join(os.tmpdir(), "hasi-release-readback-"));
    try {
      for (const name of [...expectedReleaseAssetNames(tag), "SHA256SUMS"]) {
        await writeFile(path.join(downloadedDirectory, name), await readFile(path.join(localDirectory, name)));
      }
      assert.equal((await verifyReadback(localDirectory, downloadedDirectory, tag)).length, 6);

      const payload = expectedPayloadName(tag, "amd64");
      await writeFile(path.join(downloadedDirectory, payload), "different but internally checksummed bytes\n");
      await rm(path.join(downloadedDirectory, "SHA256SUMS"));
      await createChecksumInventory(downloadedDirectory, tag);
      await assert.rejects(
        verifyReadback(localDirectory, downloadedDirectory, tag),
        /differs from the locally qualified inventory/,
      );
    } finally {
      await rm(downloadedDirectory, { recursive: true, force: true });
    }
  });
});

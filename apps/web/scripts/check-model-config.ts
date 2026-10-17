import { readFile } from 'node:fs/promises';
import { modelConfigurationSchema } from '../src/lib/server/model-config.js';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: pnpm config:models <configuration.json>');
    process.exitCode = 1;
  } else {
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > 65_536) throw new Error('size');
      const result = modelConfigurationSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!result.success) {
        // Only structural locations, never config/credential values or causes.
        console.error('Invalid model configuration. Check these structural paths:');
        for (const issue of result.error.issues.slice(0, 12)) console.error(`- ${issue.path.join('.') || '(root)'}`);
        process.exitCode = 1;
      } else {
        console.log(`Valid v${String(result.data.schemaVersion)} configuration: ${String(result.data.connections.length)} connections, ${String(result.data.profiles.length)} profiles. No credentials resolved or providers contacted.`);
      }
    } catch {
      console.error('Cannot read a valid model configuration JSON document (maximum 64 KiB).');
      process.exitCode = 1;
    }
  }

}

void main();

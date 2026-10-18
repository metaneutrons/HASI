import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { annyAppViewSha256 } from './app-view-metadata.generated.js';

export { annyAppViewSha256 };

/** Reads the build-generated, SDK-pinned asset only when an installation opts into the app view. */
export function loadAnnyAppView(): string {
  const html = readFileSync(new URL('./app-view.generated.html', import.meta.url), 'utf8');
  const actualSha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  if (actualSha256 !== annyAppViewSha256) {
    throw new Error('The packaged Anny app resource does not match its generated SHA-256');
  }
  return html;
}

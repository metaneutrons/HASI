# Reviewed Anny app touch activation

Date: 2026-10-21. This is bounded P2-A3 technical touch evidence, not a milestone acceptance record.

The normative P2-A3 requirement includes feeding theme, locale, time zone and dimensions to the view and testing theme changes, keyboard/focus, touch, text enlargement and loss of the view resource; it also requires a useful fallback and recording qualified protocol/library versions. The plan explicitly assigns native hardware and screen-reader acceptance to M8-A7 (`docs/plans/consolidated-delivery.md:351-356`). This run addresses only the touch activation previously left open in [`reviewed-app-mobile.md`](reviewed-app-mobile.md).

## Method and result

I ran the existing local TestIdP, Next, HASI API and Anny reviewed view at `http://127.0.0.1:3002` against the existing isolated `hasi_topology_test` database. The test selected the explicit offline Dialog-Demo, asked “Zeig mir Räume.”, opened the reviewed Anny view and observed its initial authorized `anny.view_resources` read. In each headless browser, a 1.2-second no-action interval kept the call count at 1. Two separate `Locator.tap()` actions on the view’s Refresh button each emitted trusted `pointerdown`/`pointerup` (`pointerType: touch`) and `touchstart`/`touchend`; each action caused exactly one additional HTTP 200 `POST /api/tools/call` for `anny.view_resources`, followed by the successful `43 Treffer · Seite 1 von 8` UI state.

| Engine | Browser | Context | No action | Two touch activations | Total typed reads | Model generation / booking writes |
|---|---|---|---|---|---:|---:|
| Chromium | 156.0.8078.4 | 390×844, `isMobile`, `hasTouch`, coarse pointer, 1 touch point | 1 → 1 | 2 × one trusted touch → one HTTP 200 view read | 3 | 0 / 0 |
| WebKit | 27.2 | 390×844, `isMobile`, `hasTouch`, coarse pointer, `maxTouchPoints=0` | 1 → 1 | 2 × one trusted touch → one HTTP 200 view read | 3 | 0 / 0 |

WebKit reported zero for `navigator.maxTouchPoints`, despite the configured touch context. The iframe still received trusted browser touch events for both Refresh actions; the captured `pointerType` was `touch`. That event evidence, rather than the reported maximum-point count, establishes this browser-emulation result. The iframe’s actual width was 330 CSS px inside the 390 px host because of host gutters; its viewport remained coarse-pointer/touch-capable. Both engines loaded the same reviewed resource bytes, SHA-256 `0c4bd34f8c35d9d224e3d90ee8938f885cfb62efba2d45e6bd324f09d5b887be`.

The request observer recorded zero `POST /api/chat` model-generation requests and zero booking, cancellation, or non-view tool writes. Each run did use the deterministic `POST /api/chat/dialogue` route to create the local reviewed view and one ordinary `PUT /api/chat/workspace` save for synthetic chat state; those are not provider or booking actions. No page errors occurred. The aggregate records three console diagnostics per engine, but their exact text was not retained in durable evidence. No conclusion about CSP follows from that count.

## Runtime and source identities

- HASI revision: `0d021e5540f869e34a79108a977b113e621b9c1e`.
- Node `v26.11.1`, pnpm `12.11.2`, Playwright Core `1.64.0` from `/Volumes/Dev/Source/aidesk/node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core`; Chromium `156.0.8078.4`; WebKit `27.2`.
- Anny app SDK dependency: `@modelcontextprotocol/ext-apps@2.0.3`; manifest `mcpVersion` is `2026-07-28`. The actual `ui/initialize` protocol version observed in both frames was `2026-01-26`; these are recorded separately as manifest and negotiated runtime values.
- Relevant SHA-256 identities: `scripts/dev.ts` `3f2d6a26533d9fec85d1b73ba67d0c057d6707f824170ea60114d9c090afed47`; Anny template `f8aadc0c0ca1c4080678c1de2c05316fb48e1548d536fe9fe4a0723e862a91d9`; generated resource `0c4bd34f8c35d9d224e3d90ee8938f885cfb62efba2d45e6bd324f09d5b887be`; generated metadata `f10da752d660107c5b28564774ba3fe7dcb277cd9258ca281004ccaaf189cd2e`; manifest `f11226727e1c6b8a0808f32f7facd3f868eefe5dbe3241dbb44531f4c8eee7fb`; view bridge `bc5b4e7183e2efc0a91dcde11c45a7e7ba5e3c1de83cdc506b97982c0a434e7e`; host components `assistant-page.tsx` `6402903175b69b17bd2be4869f7223e171e7709982e9edc66d8150a68541110f`, `plugin-result-app.tsx` `0f7f1e2c72064ae4f557e6fac4c451e5b554efc8b20a306703725f56f7acdc5d`, `plugin-app-view.tsx` `8115e043b444d5a7783d6f53b0fade7a791fa03b03144cea4f4b32ae731f8b4f`.
- The exact executed harness is embedded below. Its SHA-256 is `0d1b2975c1bc13ae1e70dfb3c71b9bc69964de3587648f5d8261fd96e0d2ad58`; captured result JSON SHA-256 is `9d0c5311b453e67681e4951d63ac43b466c2b20feca31027fea25ac31092a3f8`. The durable aggregate is [`reviewed-app-touch.json`](reviewed-app-touch.json). The temporary harness and raw output were kept under the owned `/private/tmp/hasi-touch-syejp98_/` directory during the run and deleted after the exact harness was embedded here and the aggregate was saved.

## Isolated database observation

Before the run, the available state snapshot grouped rows and fingerprinted namespace, key, revision and expiry metadata; it did not include values. After the run, the same metadata fingerprint and an additional value hash (`MD5(value::text)` nested in the sorted aggregate) were recorded. Raw values were never selected. The metadata fingerprints and row counts for every group except the synthetic workspace group match exactly. Since no pre-run value digest exists, this is not proof that all values were unchanged.

| Namespace group | Before → after rows | Metadata fingerprint before → after | After-only value fingerprint |
|---|---:|---|---|
| `anny-source-test` | 2888 → 2888 | `36973c71d7a8c4af853574151426e103` → `36973c71d7a8c4af853574151426e103` | `257cc8b0c418a32c29edb8e0c1fb4ec9` |
| `demo-test` | 26438 → 26438 | `76ac5f4c9f82cbe245b2902c33811ca8` → `76ac5f4c9f82cbe245b2902c33811ca8` | `f9f04115458053a0753deea4d45968d4` |
| `journey` | 249 → 249 | `6d6c91c9ca036ed28fc9bbae0b2de2d9` → `6d6c91c9ca036ed28fc9bbae0b2de2d9` | `f0c610fd87f5f03fe884662855d8f142` |
| `model-budgets` | 1 → 1 | `12f1c177654e8590e57c63ee113f8f1e` → `12f1c177654e8590e57c63ee113f8f1e` | `d353843da853d4b3e1d22489a4476a33` |
| `plugin-route-process` | 140 → 140 | `ae029b50b44ccff86ebebb86c7d2f6d9` → `ae029b50b44ccff86ebebb86c7d2f6d9` | `7db31f4f274d6fcf331aa36928228abd` |
| `production` | 157 → 157 | `98680478d20454c7942a9a7f741031ee` → `98680478d20454c7942a9a7f741031ee` | `5d0a0676d1ac3654083d102f7d31f4aa` |
| `protected-chat-workspaces` | 55 → 56 | `1c83424fa054849b65a0ac9bd52d6da8` → `5f7e15d9103fb2b892fc6c742e675922` | `ae08c502a8f400fe454a9f8b805b4b5d` |
| `topology` | 14 → 14 | `43664bd58076f19ec1bf73bcdca2ff2f` → `43664bd58076f19ec1bf73bcdca2ff2f` | `2ff25e3956771d86b1313c2c04b2b236` |

The `protected-chat-workspaces` group increased by one row, consistent with the synthetic TestIdP chat/workspace created by this UI run. The row is retained; the database was not reset or deleted. This local isolated database is not the live HASI service, and no model provider was called. The `production` label above is an existing namespace group inside this isolated test database.

## Limits and cleanup

This is browser touch emulation, not an iPhone or Android device. It does not establish native Safari/Chrome, native keyboards or safe areas, VoiceOver/TalkBack, participant acceptance, or complete real-device journeys. Those remain M8-A7 (`docs/plans/hasi-mvp.md:215-224`). It does not by itself accept the remaining P2-A3 checks or the M2 milestone; see the separate theme/layout, keyboard, resource-loss and fallback evidence in [`reviewed-app-mobile.md`](reviewed-app-mobile.md).

Both browser contexts closed in the harness `finally` block. I stopped only the launcher process session I had started; no listeners remained on ports 3002 or 4100–4103, and no touch harness/browser process remained. The dev launcher temporarily changed `apps/web/next-env.d.ts` to import `.next/dev/types`. After launcher shutdown, it matched HEAD again; no generated diff remains. No repository source or application asset was changed by this proof.

## Exact executed harness

```js
import fs from 'node:fs/promises';
import { chromium, webkit } from '/Volumes/Dev/Source/aidesk/node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/index.mjs';

const origin = 'http://127.0.0.1:3002';
const outputPath = '/private/tmp/hasi-touch-syejp98_/touch-proof-output.json';
const results = [];
const toolCallIsViewRead = (body) => body?.pluginId === 'de.hsh.hasi.anny' && body?.name === 'anny.view_resources' && body?.source === 'app';
const summarizeResourceResponse = (json) => json && typeof json === 'object' ? {
  resourceSha256: json.resourceSha256 ?? null,
  resourceCount: Array.isArray(json.resources) ? json.resources.length : null,
  total: Number.isSafeInteger(json.total) ? json.total : null,
  page: Number.isSafeInteger(json.page) ? json.page : null,
} : null;
const waitUntil = async (predicate, label, timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

for (const browserType of [chromium, webkit]) {
  const engine = browserType.name();
  const entry = {
    engine,
    browserVersion: null,
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'light' },
    requests: [],
    calls: [],
    modelGenerationPosts: 0,
    bookingCancellationWrites: [],
    sourceDigest: null,
    appProtocolVersions: [],
    hostTouchEnvironment: null,
    initialRead: null,
    noActionControl: null,
    activations: [],
    finalUi: null,
    consoleErrors: [],
    pageErrors: [],
    error: null,
  };
  let browser;
  let context;
  try {
    browser = await browserType.launch({ headless: true });
    entry.browserVersion = browser.version();
    context = await browser.newContext(entry.context);
    const page = await context.newPage();
    const apiRecords = new Map();
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
      const record = { method: request.method(), path: url.pathname, status: null, body: null, response: null };
      if (url.pathname === '/api/tools/call' && request.method() === 'POST') {
        try {
          const body = request.postDataJSON();
          record.body = {
            pluginId: body?.pluginId ?? null,
            name: body?.name ?? null,
            source: body?.source ?? null,
            argumentKeys: body?.arguments && typeof body.arguments === 'object' ? Object.keys(body.arguments).sort() : [],
          };
        } catch { record.body = { invalidJson: true }; }
      }
      entry.requests.push(record);
      apiRecords.set(request, record);
      if (url.pathname === '/api/chat' && request.method() === 'POST') entry.modelGenerationPosts++;
      if ((url.pathname.startsWith('/api/proposals/') && url.pathname.endsWith('/confirm') && request.method() !== 'GET')
        || (url.pathname.startsWith('/api/bookings') && request.method() !== 'GET')
        || (url.pathname === '/api/tools/call' && request.method() === 'POST' && record.body?.name && !['anny.view_resources'].includes(record.body.name))) {
        entry.bookingCancellationWrites.push({ method: request.method(), path: url.pathname, tool: record.body?.name ?? null });
      }
    });
    page.on('response', response => {
      const record = apiRecords.get(response.request());
      if (!record) return;
      record.status = response.status();
      if (record.path === '/api/plugin-apps/de.hsh.hasi.anny/resources' && response.ok()) {
        void response.json().then(json => {
          const summary = summarizeResourceResponse(json);
          record.response = summary;
          if (summary?.resourceSha256) entry.sourceDigest = summary.resourceSha256;
        }).catch(() => { record.response = { json: false }; });
      } else if (record.path === '/api/tools/call' && response.ok()) {
        void response.json().then(json => {
          const summary = summarizeResourceResponse(json);
          record.response = summary ?? { topLevelKeys: json && typeof json === 'object' ? Object.keys(json).sort() : [] };
          if (toolCallIsViewRead(record.body)) entry.calls.push({
            method: record.method, path: record.path, status: record.status,
            request: record.body, response: record.response,
          });
        }).catch(() => { record.response = { json: false }; });
      }
    });
    page.on('console', message => { if (message.type() === 'error') entry.consoleErrors.push(message.text().slice(0, 240)); });
    page.on('pageerror', error => entry.pageErrors.push(error.message.slice(0, 240)));

    await page.addInitScript(() => {
      window.__hasiMcpVersions = [];
      window.addEventListener('message', event => {
        const data = event.data;
        if (data && typeof data === 'object' && data.method === 'ui/initialize' && data.params && typeof data.params.protocolVersion === 'string') {
          window.__hasiMcpVersions.push(data.params.protocolVersion);
        }
      });
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const chat = page.getByRole('region', { name: 'HASI Chat' });
    const loginButton = page.getByRole('button', { name: 'Mit SSO anmelden' });
    const profileSelect = chat.getByLabel('Sprachmodell');
    const initialSurface = await Promise.race([
      loginButton.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'login'),
      profileSelect.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'chat'),
    ]);
    if (initialSurface === 'login') {
      await loginButton.tap({ timeout: 10000 });
      await profileSelect.waitFor({ state: 'visible', timeout: 30000 });
    }
    if (await chat.locator('.chat-transcript').count()) {
      const newChat = chat.getByRole('button', { name: 'Neuer Chat' });
      if (await newChat.isEnabled()) {
        await newChat.tap();
        await chat.getByRole('textbox', { name: 'Nachricht an HASI' }).waitFor({ state: 'visible', timeout: 10000 });
      }
    }
    await profileSelect.selectOption('offline');
    await chat.getByText('Dialog-Demo · ohne Sprachmodell', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const composer = chat.getByRole('textbox', { name: 'Nachricht an HASI' });
    await composer.fill('Zeig mir Räume.');
    const send = chat.getByRole('button', { name: 'Nachricht senden' });
    await send.tap({ timeout: 10000 });
    await chat.getByText('Interaktive Plugin-Ansicht öffnen', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await chat.getByText('Interaktive Plugin-Ansicht öffnen', { exact: true }).tap({ timeout: 10000 });
    const iframe = page.locator('iframe[title="Räume und Arbeitsplätze"]');
    await iframe.waitFor({ state: 'attached', timeout: 30000 });
    const frame = await (await iframe.elementHandle()).contentFrame();
    if (!frame) throw new Error('The reviewed iframe frame could not be resolved.');
    await frame.locator('#reload').waitFor({ state: 'visible', timeout: 30000 });
    await waitUntil(async () => {
      const count = entry.calls.length;
      const status = await frame.locator('#status').textContent().catch(() => '');
      return count === 1 && /Treffer/u.test(status ?? '');
    }, 'the initial authorized Anny view read and results', 30000);
    entry.hostTouchEnvironment = await page.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    entry.appProtocolVersions = await page.evaluate(() => window.__hasiMcpVersions ?? []);
    entry.initialRead = {
      totalAuthorizedViewReads: entry.calls.length,
      call: entry.calls[0] ?? null,
      frameStatus: await frame.locator('#status').textContent(),
      frameTheme: await frame.locator('html').getAttribute('data-theme'),
      frameLocale: await frame.locator('html').evaluate(el => navigator.language),
      frameTimeZone: await frame.locator('html').evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      resourceDigest: entry.sourceDigest,
    };
    const iframeEnvironment = await frame.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    entry.initialRead.iframeEnvironment = iframeEnvironment;
    if (entry.hostTouchEnvironment.viewport.width !== 390 || entry.hostTouchEnvironment.viewport.height !== 844 || !entry.hostTouchEnvironment.coarsePointer) {
      throw new Error(`Expected the host to use a 390x844 touch-capable mobile context; observed ${JSON.stringify(entry.hostTouchEnvironment)}`);
    }
    if (!iframeEnvironment.coarsePointer) {
      throw new Error(`Expected the iframe to inherit a touch-capable mobile context; observed ${JSON.stringify(iframeEnvironment)}`);
    }

    await frame.evaluate(() => {
      const state = { events: [], mutations: [] };
      window.__hasiTouchProof = state;
      const reload = document.getElementById('reload');
      const isReloadTarget = target => target instanceof Element && target.closest('#reload') !== null;
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
        document.addEventListener(type, event => {
          if (!isReloadTarget(event.target)) return;
          state.events.push({ type, trusted: event.isTrusted, pointerType: 'pointerType' in event ? event.pointerType : null, targetId: event.target.closest('#reload')?.id ?? null });
        }, true);
      }
      const status = document.getElementById('status');
      const button = document.getElementById('reload');
      const record = () => state.mutations.push({ at: Math.round(performance.now()), status: status.textContent, button: button.textContent, disabled: button.disabled });
      new MutationObserver(record).observe(status, { childList: true, characterData: true, subtree: true });
      new MutationObserver(record).observe(button, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    });
    const callsBeforeControl = entry.calls.length;
    await page.waitForTimeout(1200);
    entry.noActionControl = {
      observationMs: 1200,
      before: callsBeforeControl,
      after: entry.calls.length,
      unchanged: callsBeforeControl === entry.calls.length,
    };
    if (!entry.noActionControl.unchanged || callsBeforeControl !== 1) throw new Error('No-action count-before control failed: view-read count changed without a touch activation.');

    const refreshButton = frame.getByRole('button', { name: 'Aktualisieren' });
    for (let activation = 1; activation <= 2; activation++) {
      const before = entry.calls.length;
      const eventStart = await frame.evaluate(() => window.__hasiTouchProof.events.length);
      const mutationStart = await frame.evaluate(() => window.__hasiTouchProof.mutations.length);
      await refreshButton.tap({ timeout: 10000 });
      await waitUntil(() => entry.calls.length === before + 1, `activation ${activation} one new authorized view read`, 20000);
      await waitUntil(async () => {
        const disabled = await frame.locator('#reload').isDisabled().catch(() => true);
        const status = await frame.locator('#status').textContent().catch(() => '');
        return !disabled && /Treffer/u.test(status ?? '');
      }, `activation ${activation} successful results UI`, 20000);
      await page.waitForTimeout(400);
      const observed = await frame.evaluate(({ eventStart, mutationStart }) => ({
        events: window.__hasiTouchProof.events.slice(eventStart),
        mutations: window.__hasiTouchProof.mutations.slice(mutationStart),
        status: document.getElementById('status')?.textContent ?? '',
        button: document.getElementById('reload')?.textContent ?? '',
      }), { eventStart, mutationStart });
      const touchEvents = observed.events.filter(event => ['pointerdown', 'pointerup', 'touchstart', 'touchend'].includes(event.type));
      const trusted = touchEvents.length > 0 && touchEvents.every(event => event.trusted && event.targetId === 'reload');
      const pointerDown = touchEvents.find(event => event.type === 'pointerdown');
      const touchStart = touchEvents.find(event => event.type === 'touchstart');
      const call = entry.calls.at(-1);
      const stage = {
        activation,
        beforeReads: before,
        afterReads: entry.calls.length,
        readDelta: entry.calls.length - before,
        call,
        trustedBrowserTouchEvents: touchEvents,
        allObservedTouchEventsTrustedForRefresh: trusted,
        pointerType: pointerDown?.pointerType ?? null,
        touchStartTrusted: touchStart?.trusted ?? false,
        ui: observed,
        successUi: !await frame.locator('#reload').isDisabled() && /Treffer/u.test(observed.status),
      };
      entry.activations.push(stage);
      if (stage.readDelta !== 1 || call?.status !== 200 || !toolCallIsViewRead(call?.request) || !stage.successUi || !stage.allObservedTouchEventsTrustedForRefresh || stage.pointerType !== 'touch' || !stage.touchStartTrusted) {
        throw new Error(`Activation ${activation} did not establish exactly one trusted touch-driven typed read and successful UI: ${JSON.stringify(stage)}`);
      }
    }
    entry.finalUi = {
      status: await frame.locator('#status').textContent(),
      refreshLabel: await frame.locator('#reload').textContent(),
      finalAuthorizedViewReads: entry.calls.length,
      sourceDigest: entry.sourceDigest,
    };
    if (entry.modelGenerationPosts !== 0 || entry.bookingCancellationWrites.length !== 0) throw new Error('Unexpected model-generation or booking/cancellation write request was observed.');
    if (entry.sourceDigest !== '0c4bd34f8c35d9d224e3d90ee8938f885cfb62efba2d45e6bd324f09d5b887be') throw new Error(`Live reviewed resource digest mismatch: ${entry.sourceDigest}`);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  const apiSummary = {};
  for (const request of entry.requests) {
    const key = `${request.method} ${request.path}`;
    apiSummary[key] = (apiSummary[key] ?? 0) + 1;
  }
  entry.apiRequestCounts = apiSummary;
  entry.modelGenerationPosts = entry.requests.filter(r => r.method === 'POST' && r.path === '/api/chat').length;
  entry.bookingCancellationWrites = entry.requests.filter(r =>
    (r.path.startsWith('/api/proposals/') && r.path.endsWith('/confirm') && r.method !== 'GET')
    || (r.path.startsWith('/api/bookings') && r.method !== 'GET')
    || (r.path === '/api/tools/call' && r.method === 'POST' && r.body?.name && r.body.name !== 'anny.view_resources')
  ).map(r => ({ method: r.method, path: r.path, tool: r.body?.name ?? null }));
  results.push(entry);
}
await fs.writeFile(outputPath, `${JSON.stringify({ origin, runtime: process.version, playwrightCore: '1.64.0', results }, null, 2)}\n`);
console.log(JSON.stringify({ origin, runtime: process.version, playwrightCore: '1.64.0', results }, null, 2));
if (results.length !== 2 || results.some(result => result.error)) process.exitCode = 1;

```

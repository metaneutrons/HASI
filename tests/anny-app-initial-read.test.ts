import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// This exercises the authored app controller's DOM and SDK event flow. Authenticated
// tool authorization and API behavior are covered separately by anny-app-view.test.ts.
const template = readFileSync(new URL('../apps/anny-plugin/src/app-view-template.html', import.meta.url), 'utf8');
const scriptMatch = /<script\s+type="module">\/\*__HASI_APP_SDK_BUNDLE__\*\/([\s\S]*?)<\/script>/u.exec(template);
if (!scriptMatch?.[1]) throw new Error('Could not find the Anny app controller in its source template');
const appControllerSource = scriptMatch[1];

interface ToolCall { name: string; arguments: Record<string, unknown> }
interface ToolResult { isError?: boolean; structuredContent?: unknown }
interface HostToolInput { arguments: Record<string, unknown> }

class FakeElement {
  textContent = '';
  value = '';
  className = '';
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();

  append(...elements: FakeElement[]): void {
    this.children.push(...elements);
  }

  replaceChildren(...elements: FakeElement[]): void {
    this.children = [...elements];
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeApp {
  ontoolinput?: (input: HostToolInput) => unknown;
  readonly calls: ToolCall[] = [];

  constructor(private readonly responses: ToolResult[]) {}

  connect(_transport: unknown): Promise<void> {
    return Promise.resolve();
  }

  getHostContext(): Record<string, never> {
    return {};
  }

  callServerTool(call: ToolCall): Promise<ToolResult> {
    this.calls.push({
      name: call.name,
      arguments: JSON.parse(JSON.stringify(call.arguments)) as Record<string, unknown>,
    });
    return Promise.resolve(this.responses.shift() ?? { isError: true });
  }
}

interface ViewHarness {
  app: FakeApp;
  elements: Map<string, FakeElement>;
  flushTimers: () => Promise<void>;
}

async function mountView(responses: ToolResult[]): Promise<ViewHarness> {
  const ids = [
    'cards', 'search', 'kind', 'status', 'period', 'availability-note', 'pager',
    'previous', 'next', 'reload', 'current-page',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const document = {
    documentElement: new FakeElement(),
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (_tag: string) => new FakeElement(),
  };
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  const window = {
    parent: {},
    matchMedia: (_query: string) => ({ matches: false }),
    setTimeout: (callback: () => void) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  const apps: FakeApp[] = [];
  class App extends FakeApp {
    constructor(_metadata: unknown, _options: unknown, _config: unknown) {
      super(responses);
      apps.push(this);
    }
  }
  class PostMessageTransport {
    constructor(readonly target: unknown, readonly origin: unknown) {}
  }

  await runInNewContext(`(async () => {${appControllerSource}\n})()`, {
    __HASI_APPS_SDK__: { App, PostMessageTransport },
    document,
    window,
  });
  if (apps.length !== 1) throw new Error('Expected exactly one SDK app instance');
  const app = apps[0];
  if (!app) throw new Error('The Anny app controller did not construct its SDK app');

  return {
    app,
    elements,
    flushTimers: async () => {
      let iterations = 0;
      while (timers.size > 0) {
        if (++iterations > 20) throw new Error('The app scheduled too many timer callbacks');
        const [id, callback] = timers.entries().next().value as [number, () => void];
        timers.delete(id);
        callback();
        await settleMicrotasks();
      }
    },
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function sendHostInput(view: ViewHarness, input: HostToolInput): Promise<void> {
  await view.app.ontoolinput?.(input);
  await settleMicrotasks();
}

function textContentDeep(element: FakeElement): string {
  return element.textContent + element.children.map(textContentDeep).join('');
}

const requestedStartDate = '2026-10-20T09:00:00+02:00';
const requestedEndDate = '2026-10-20T10:00:00+02:00';
const hostInput: HostToolInput = {
  arguments: { requestedStartDate, requestedEndDate, chatAvailabilityChecked: false },
};

function resourceResult(name: string): ToolResult {
  return {
    structuredContent: {
      resources: [{ id: 'room-1', name, kind: 'meeting_room', location: 'Hannover' }],
      total: 1,
      page: 0,
      pageSize: 6,
      availabilityChecked: false,
      requestedStartDate,
      requestedEndDate,
    },
  };
}

describe('Anny app initial catalog read', () => {
  it('reads one typed first page after the first valid host input and renders the response', async () => {
    const view = await mountView([resourceResult('Seminarraum E123')]);

    await sendHostInput(view, hostInput);

    expect(view.app.calls).toEqual([{
      name: 'anny.view_resources',
      arguments: {
        page: 0,
        pageSize: 6,
        requestedStartDate,
        requestedEndDate,
      },
    }]);
    expect(textContentDeep(view.elements.get('cards')!)).toContain('Seminarraum E123');
    expect(view.elements.get('status')?.textContent).toBe('1 Treffer · Seite 1 von 1');
    expect(view.elements.get('period')?.textContent).toContain('Zeitraum aus dem Chat:');
    expect(view.elements.get('availability-note')?.textContent).toContain('Diese Ansicht prüft keine Verfügbarkeit.');

    await sendHostInput(view, hostInput);
    expect(view.app.calls).toHaveLength(1);
    expect(view.app.calls.every(({ name }) => name === 'anny.view_resources')).toBe(true);
  });

  it('shows a refreshable error and retries the same catalog read', async () => {
    const view = await mountView([{ isError: true }, resourceResult('Raum nach erneutem Laden')]);

    await sendHostInput(view, hostInput);

    expect(view.app.calls).toHaveLength(1);
    expect(view.elements.get('status')?.textContent).toMatch(/Katalogsuche.*nicht verfügbar/iu);
    expect(view.elements.get('reload')?.textContent).toBe('Aktualisieren');
    expect(view.elements.get('reload')?.disabled).toBe(false);

    view.elements.get('reload')?.dispatch('click');
    await view.flushTimers();

    expect(view.app.calls).toHaveLength(2);
    expect(view.app.calls[0]).toEqual(view.app.calls[1]);
    expect(view.app.calls.every(({ name }) => name === 'anny.view_resources')).toBe(true);
    expect(textContentDeep(view.elements.get('cards')!)).toContain('Raum nach erneutem Laden');
    expect(view.elements.get('status')?.textContent).toBe('1 Treffer · Seite 1 von 1');
    expect(view.elements.get('availability-note')?.textContent).toContain('Diese Ansicht prüft keine Verfügbarkeit.');
  });
  it('loads an undated view once, ignoring invalid inputs without claiming an empty catalogue', async () => {
    const view = await mountView([resourceResult('Raum ohne Zeitraum')]);
    expect(view.app.calls).toHaveLength(0);
    expect(view.elements.get('status')?.textContent).toBe('Räume werden geladen …');
    await sendHostInput(view, { arguments: null as unknown as Record<string, unknown> });
    expect(view.app.calls).toHaveLength(0);
    await sendHostInput(view, { arguments: {} });
    expect(view.app.calls).toEqual([{ name: 'anny.view_resources', arguments: { page: 0, pageSize: 6 } }]);
    expect(textContentDeep(view.elements.get('cards')!)).toContain('Raum ohne Zeitraum');
  });

  it.each([{ isError: true }, { structuredContent: { unexpected: [] } }])(
    'removes previous catalogue data after an unauthorized or invalid refresh: %j', async (failedResult) => {
      const view = await mountView([resourceResult('Früher freigegebener Raum'), failedResult]);
      await sendHostInput(view, hostInput);
      expect(textContentDeep(view.elements.get('cards')!)).toContain('Früher freigegebener Raum');
      view.elements.get('reload')?.dispatch('click');
      await view.flushTimers();
      expect(view.elements.get('cards')?.children).toHaveLength(0);
      expect(view.elements.get('pager')?.hidden).toBe(true);
      expect(view.elements.get('status')?.textContent).toContain('Aktualisieren');
      expect(view.elements.get('reload')?.disabled).toBe(false);
    },
  );

});

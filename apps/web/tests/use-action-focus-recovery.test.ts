import { describe, expect, it } from 'vitest';
import { createActionFocusRecoveryController } from '../src/lib/use-action-focus-recovery';

type TestElement = HTMLElement & { disabled: boolean; focusCount: number };

class TestWindow extends EventTarget {
  private readonly blurListeners = new Set<EventListenerOrEventListenerObject>();

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, callback, options);
    if (type === 'blur' && callback) this.blurListeners.add(callback);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, callback, options);
    if (type === 'blur' && callback) this.blurListeners.delete(callback);
  }

  dispatchCapturedBlur(target: object) {
    const event = new Event('blur');
    Object.defineProperty(event, 'target', { value: target });
    for (const listener of this.blurListeners) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
  }
}

function createHarness() {
  const eventTarget = new EventTarget();
  const windowTarget = new TestWindow();
  let activeElement: HTMLElement | null = null;
  let documentHasFocus = true;
  const makeElement = (): TestElement => {
    const element = {
      isConnected: true,
      disabled: false,
      focusCount: 0,
      matches: (selector: string) => selector === ':disabled' && element.disabled,
      contains: () => false,
      focus: () => {
        element.focusCount += 1;
        activeElement = element as unknown as HTMLElement;
        eventTarget.dispatchEvent(new Event('focusin'));
      },
    };
    return element as unknown as TestElement;
  };
  const body = makeElement();
  activeElement = body;
  Object.defineProperties(eventTarget, {
    activeElement: { get: () => activeElement },
    body: { value: body },
    hasFocus: { value: () => documentHasFocus },
    defaultView: { value: windowTarget },
  });
  const documentRef = eventTarget as unknown as Document;
  return {
    documentRef,
    makeElement,
    setActive(element: HTMLElement) {
      activeElement = element;
      eventTarget.dispatchEvent(new Event('focusin'));
    },
    pointerDown() { eventTarget.dispatchEvent(new Event('pointerdown')); },
    keyDown() { eventTarget.dispatchEvent(new Event('keydown')); },
    descendantBlur(target: object) { windowTarget.dispatchCapturedBlur(target); },
    setDocumentHasFocus(value: boolean) {
      documentHasFocus = value;
      if (!value) windowTarget.dispatchEvent(new Event('blur'));
    },
  };
}

describe('action focus recovery', () => {
  it('restores once after a disabled trigger loses focus and waits for an enabled target', () => {
    const harness = createHarness();
    const recovery = createActionFocusRecoveryController(harness.documentRef);
    const origin = harness.makeElement();
    const target = harness.makeElement();
    harness.setActive(origin);
    const token = recovery.begin(origin);
    recovery.complete(token, () => target);

    origin.disabled = true;
    harness.setActive(harness.documentRef.body);
    target.disabled = true;
    recovery.flush();
    expect(target.focusCount).toBe(0);

    target.disabled = false;
    recovery.flush();
    recovery.flush();
    expect(target.focusCount).toBe(1);
    expect(harness.documentRef.activeElement).toBe(target);
    recovery.dispose();
  });

  it('does not cancel recovery when the disabled trigger emits a captured blur', () => {
    const harness = createHarness();
    const recovery = createActionFocusRecoveryController(harness.documentRef);
    const origin = harness.makeElement();
    const target = harness.makeElement();
    harness.setActive(origin);
    const token = recovery.begin(origin);
    recovery.complete(token, () => target);

    origin.disabled = true;
    harness.descendantBlur(origin);
    harness.setActive(harness.documentRef.body);
    recovery.flush();

    expect(target.focusCount).toBe(1);
    expect(harness.documentRef.activeElement).toBe(target);
    recovery.dispose();
  });

  it('keeps a user-focused control and does not steal focus after pointer or keyboard movement', () => {
    for (const moveFocus of [
      (harness: ReturnType<typeof createHarness>, other: HTMLElement) => { harness.setActive(other); },
      (harness: ReturnType<typeof createHarness>, other: HTMLElement) => { harness.pointerDown(); harness.setActive(other); },
      (harness: ReturnType<typeof createHarness>, other: HTMLElement) => { harness.keyDown(); harness.setActive(other); },
    ]) {
      const harness = createHarness();
      const recovery = createActionFocusRecoveryController(harness.documentRef);
      const origin = harness.makeElement();
      const target = harness.makeElement();
      const other = harness.makeElement();
      harness.setActive(origin);
      const token = recovery.begin(origin);
      recovery.complete(token, () => target);
      origin.disabled = true;
      harness.setActive(harness.documentRef.body);
      moveFocus(harness, other);

      recovery.flush();
      expect(target.focusCount).toBe(0);
      expect(harness.documentRef.activeElement).toBe(other);
      recovery.dispose();
    }
  });

  it('does not restore focus after the document loses focus or the controller is disposed', () => {
    const harness = createHarness();
    const recovery = createActionFocusRecoveryController(harness.documentRef);
    const origin = harness.makeElement();
    const target = harness.makeElement();
    const token = recovery.begin(origin);
    recovery.complete(token, () => target);
    origin.disabled = true;
    harness.setActive(harness.documentRef.body);
    harness.setDocumentHasFocus(false);
    harness.setDocumentHasFocus(true);
    recovery.flush();
    expect(target.focusCount).toBe(0);

    recovery.dispose();
    const secondToken = recovery.begin(origin);
    recovery.complete(secondToken, () => target);
    recovery.flush();
    expect(target.focusCount).toBe(0);
  });
});

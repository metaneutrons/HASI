'use client';

import { useCallback, useEffect, useRef } from 'react';

interface PendingFocusRecovery {
  origin: HTMLElement | null;
  target?: () => HTMLElement | null;
  userMovedFocus: boolean;
}

export interface ActionFocusRecoveryController {
  begin(origin: HTMLElement | null): symbol;
  complete(token: symbol, target: () => HTMLElement | null): void;
  cancel(token: symbol | null): void;
  flush(): void;
  dispose(): void;
}

function isDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled');
}

/** A one-shot recovery controller kept separate so its focus rules can be tested without a browser. */
export function createActionFocusRecoveryController(documentRef: Document): ActionFocusRecoveryController {
  const pending = new Map<symbol, PendingFocusRecovery>();
  let disposed = false;
  let applyingFocus = false;

  const cancelPendingRecovery = () => {
    for (const request of pending.values()) request.userMovedFocus = true;
  };
  const cancelForWindowBlur = (event: Event) => {
    if (event.target === documentRef.defaultView) cancelPendingRecovery();
  };
  const observeFocus = () => {
    if (applyingFocus) return;
    const active = documentRef.activeElement;
    if (!active || active === documentRef.body) return;
    for (const request of pending.values()) {
      if (active !== request.origin && !request.origin?.contains(active)) request.userMovedFocus = true;
    }
  };

  documentRef.addEventListener('focusin', observeFocus, true);
  documentRef.addEventListener('pointerdown', cancelPendingRecovery, true);
  documentRef.addEventListener('keydown', cancelPendingRecovery, true);
  documentRef.defaultView?.addEventListener('blur', cancelForWindowBlur, true);

  return {
    begin(origin) {
      const token = Symbol('action-focus-recovery');
      if (!disposed) pending.set(token, { origin, userMovedFocus: false });
      return token;
    },
    complete(token, target) {
      const request = pending.get(token);
      if (request) request.target = target;
    },
    cancel(token) {
      if (token) pending.delete(token);
    },
    flush() {
      if (disposed) return;
      for (const [token, request] of pending) {
        if (!request.target) continue;
        const active = documentRef.activeElement as HTMLElement | null;
        if (request.userMovedFocus || !documentRef.hasFocus()) {
          pending.delete(token);
          continue;
        }

        const focusIsElsewhere = active !== null
          && active !== documentRef.body
          && active !== request.origin
          && !request.origin?.contains(active);
        if (focusIsElsewhere) {
          pending.delete(token);
          continue;
        }

        const originUnavailable = request.origin === null
          || !request.origin.isConnected
          || isDisabled(request.origin);
        const focusWasLost = active === null || active === documentRef.body;
        if (!focusWasLost && !originUnavailable) {
          pending.delete(token);
          continue;
        }

        const target = request.target();
        if (!target?.isConnected) {
          pending.delete(token);
          continue;
        }
        if (isDisabled(target)) continue;
        applyingFocus = true;
        try { target.focus(); } finally { applyingFocus = false; }
        pending.delete(token);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      documentRef.removeEventListener('focusin', observeFocus, true);
      documentRef.removeEventListener('pointerdown', cancelPendingRecovery, true);
      documentRef.removeEventListener('keydown', cancelPendingRecovery, true);
      documentRef.defaultView?.removeEventListener('blur', cancelForWindowBlur, true);
    },
  };
}

export function useActionFocusRecovery() {
  const controller = useRef<ActionFocusRecoveryController | null>(null);

  useEffect(() => {
    const activeController = createActionFocusRecoveryController(document);
    controller.current = activeController;
    return () => {
      activeController.dispose();
      if (controller.current === activeController) controller.current = null;
    };
  }, []);

  const beginFocusRecovery = useCallback((origin: HTMLElement | null) => controller.current?.begin(origin) ?? null, []);
  const completeFocusRecovery = useCallback((token: symbol | null, target: () => HTMLElement | null) => {
    if (token) controller.current?.complete(token, target);
  }, []);
  const cancelFocusRecovery = useCallback((token: symbol | null) => controller.current?.cancel(token), []);
  const flushFocusRecovery = useCallback(() => controller.current?.flush(), []);

  return { beginFocusRecovery, completeFocusRecovery, cancelFocusRecovery, flushFocusRecovery };
}

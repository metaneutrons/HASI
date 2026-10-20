export type UiFeedbackName = "navigation" | "actions-open" | "results" | "theme";
export type UiFeedbackTheme = "light" | "dark";
export type UiFeedbackDelay = 0 | 250;

export interface UiFeedbackArmOptions {
  delayMs?: UiFeedbackDelay;
  theme?: UiFeedbackTheme;
}

export interface UiFeedbackSample {
  name: UiFeedbackName;
  status: "passed" | "failed";
  delayMs: UiFeedbackDelay;
  elapsedMs?: number;
  failure?: string;
}

export interface UiFeedbackProbe {
  arm(name: UiFeedbackName, options?: UiFeedbackArmOptions): void;
  read(): UiFeedbackSample[];
  dispose(): void;
}

export interface UiFeedbackInteractionGate {
  passed: boolean;
  count: number;
  maxMs: number | null;
  failures: string[];
}

export interface UiFeedbackGate {
  passed: boolean;
  thresholdMs: 200;
  requiredCount: number;
  invalidSamples: number;
  interactions: Record<UiFeedbackName, UiFeedbackInteractionGate>;
}

export function installUiFeedbackProbe(): UiFeedbackProbe {
  type FailureCode =
    | "invalid-options"
    | "hidden-page"
    | "missing-target"
    | "ambiguous-target"
    | "unsupported-state"
    | "missing-input"
    | "untrusted-input"
    | "wrong-target"
    | "target-changed"
    | "overlap"
    | "feedback-timeout"
    | "missing-feedback"
    | "disposed"
    | "capacity";
  interface Selection {
    target: HTMLElement;
    canStart(): boolean;
    feedbackReady(): boolean;
  }
  interface ActiveSample {
    name: UiFeedbackName;
    delayMs: UiFeedbackDelay;
    selection: Selection;
    phase: "armed" | "measuring";
    armedAt: number;
    startedAt: number | null;
    timer: number | null;
    observer: MutationObserver | null;
    frameOne: number | null;
    frameTwo: number | null;
    checkScheduled: boolean;
  }
  type ProbeWindow = Window & { __hasiUiFeedbackProbe?: UiFeedbackProbe };

  const names: UiFeedbackName[] = ["navigation", "actions-open", "results", "theme"];
  const maxSamples = 512;
  const armDeadlineMs = 10_000;
  const feedbackDeadlineMs = 2_000;
  const hostWindow = window as ProbeWindow;
  if (hostWindow.location.origin !== "http://127.0.0.1:3001") {
    throw new Error("HASI UI probe only admits http://127.0.0.1:3001");
  }
  if (hostWindow.__hasiUiFeedbackProbe) {
    throw new Error("HASI UI probe is already installed");
  }

  const samples: UiFeedbackSample[] = [];
  let active: ActiveSample | null = null;
  let disposed = false;
  let capacityReached = false;

  function append(sample: UiFeedbackSample): void {
    const safeSample: UiFeedbackSample = {
      name: sample.name,
      status: sample.status,
      delayMs: sample.delayMs,
      ...(typeof sample.elapsedMs === "number" && Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0
        ? { elapsedMs: sample.elapsedMs }
        : {}),
      ...(sample.failure ? { failure: sample.failure } : {}),
    };
    if (samples.length < maxSamples) {
      samples.push(safeSample);
      return;
    }
    capacityReached = true;
    samples[maxSamples - 1] = {
      name: safeSample.name,
      status: "failed",
      delayMs: safeSample.delayMs,
      failure: "capacity",
    };
  }

  function currentElapsed(sample: ActiveSample): number | undefined {
    const startedAt = sample.startedAt ?? sample.armedAt;
    const elapsed = hostWindow.performance.now() - startedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
  }

  function cleanupActive(sample: ActiveSample): void {
    if (sample.timer !== null) hostWindow.clearTimeout(sample.timer);
    if (sample.observer) sample.observer.disconnect();
    if (sample.frameOne !== null) hostWindow.cancelAnimationFrame(sample.frameOne);
    if (sample.frameTwo !== null) hostWindow.cancelAnimationFrame(sample.frameTwo);
    if (active === sample) active = null;
  }

  function failActive(failure: FailureCode): void {
    if (!active) return;
    const sample = active;
    const elapsedMs = currentElapsed(sample);
    cleanupActive(sample);
    append({
      name: sample.name,
      status: "failed",
      delayMs: sample.delayMs,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      failure,
    });
  }

  function failArm(name: UiFeedbackName, delayMs: UiFeedbackDelay, failure: FailureCode): never {
    append({ name, status: "failed", delayMs, failure });
    throw new Error(`HASI UI probe arm rejected: ${failure}`);
  }

  function isVisible(element: Element | null): element is HTMLElement {
    if (!element || !element.isConnected || document.visibilityState !== "visible") return false;
    if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;

    let current: Element | null = element;
    while (current) {
      const style = hostWindow.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      current = current.parentElement;
    }

    const bounds = element.getBoundingClientRect();
    const width = document.documentElement.clientWidth || hostWindow.innerWidth;
    const height = document.documentElement.clientHeight || hostWindow.innerHeight;
    let left = Math.max(bounds.left, 0);
    let top = Math.max(bounds.top, 0);
    let right = Math.min(bounds.right, width);
    let bottom = Math.min(bounds.bottom, height);
    if (left >= right || top >= bottom) return false;

    let topLayer: Element | null = null;
    try {
      topLayer = element.closest(":popover-open, dialog:modal");
    } catch {
      // Older engines can still measure non-top-layer controls.
    }
    current = topLayer === element ? null : element.parentElement;
    while (current) {
      const style = hostWindow.getComputedStyle(current);
      const clipsX = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
      const clipsY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
      if (current instanceof HTMLElement && (clipsX || clipsY)) {
        const clipBounds = current.getBoundingClientRect();
        const scaleX = current.offsetWidth > 0 ? clipBounds.width / current.offsetWidth : 1;
        const scaleY = current.offsetHeight > 0 ? clipBounds.height / current.offsetHeight : 1;
        const clipLeft = clipBounds.left + current.clientLeft * scaleX;
        const clipTop = clipBounds.top + current.clientTop * scaleY;
        if (clipsX) {
          left = Math.max(left, clipLeft);
          right = Math.min(right, clipLeft + current.clientWidth * scaleX);
        }
        if (clipsY) {
          top = Math.max(top, clipTop);
          bottom = Math.min(bottom, clipTop + current.clientHeight * scaleY);
        }
        if (left >= right || top >= bottom) return false;
      }
      if (current === topLayer) break;
      current = current.parentElement;
    }
    return true;
  }

  function uniqueVisible(elements: HTMLElement[]): HTMLElement {
    const visible = elements.filter(element => isVisible(element));
    if (visible.length === 0) throw new Error("missing-target");
    if (visible.length !== 1) throw new Error("ambiguous-target");
    const target = visible[0];
    if (!target) throw new Error("missing-target");
    return target;
  }

  function controlledElement(target: HTMLElement): HTMLElement {
    const id = target.getAttribute("aria-controls");
    const validId = typeof id === "string" && id.length > 0 && id.trim() === id && !id.includes(" ");
    if (!validId) throw new Error("unsupported-state");
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) throw new Error("unsupported-state");
    return element;
  }

  function ariaBoolean(target: HTMLElement, attribute: string): boolean {
    const value = target.getAttribute(attribute);
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("unsupported-state");
  }

  function popoverIsOpen(element: HTMLElement): boolean {
    return element.matches(":popover-open");
  }

  function resolveSelection(name: UiFeedbackName, theme: UiFeedbackTheme | undefined): Selection {
    if (name === "navigation") {
      const target = uniqueVisible(Array.from(document.querySelectorAll<HTMLElement>("button.primary-nav-chat-toggle")));
      const controlled = controlledElement(target);
      const beforeExpanded = ariaBoolean(target, "aria-expanded");
      if (controlled.hidden !== !beforeExpanded) throw new Error("unsupported-state");
      const afterExpanded = !beforeExpanded;
      return {
        target,
        canStart: () => ariaBoolean(target, "aria-expanded") === beforeExpanded
          && controlled.hidden === !beforeExpanded && target.isConnected && isVisible(target),
        feedbackReady: () => ariaBoolean(target, "aria-expanded") === afterExpanded
          && controlled.hidden === !afterExpanded && isVisible(target)
          && (!afterExpanded || isVisible(controlled)),
      };
    }

    if (name === "actions-open") {
      const activeRows = Array.from(document.querySelectorAll<HTMLElement>(".chat-session-row"))
        .filter(row => isVisible(row) && row.querySelector('.chat-session-select[aria-current="true"]') !== null);
      const targets = activeRows.flatMap(row => Array.from(row.querySelectorAll<HTMLElement>("button.chat-session-menu")));
      const target = uniqueVisible(targets);
      const menu = controlledElement(target);
      if (menu.getAttribute("role") !== "menu" || !menu.hasAttribute("popover")
        || typeof (menu as HTMLElement & { showPopover?: unknown }).showPopover !== "function") {
        throw new Error("unsupported-state");
      }
      if (ariaBoolean(target, "aria-expanded") || popoverIsOpen(menu)) throw new Error("unsupported-state");
      return {
        target,
        canStart: () => !ariaBoolean(target, "aria-expanded") && !popoverIsOpen(menu)
          && target.isConnected && isVisible(target),
        feedbackReady: () => ariaBoolean(target, "aria-expanded")
          && popoverIsOpen(menu) && isVisible(menu),
      };
    }

    if (name === "results") {
      const target = uniqueVisible(Array.from(document.querySelectorAll<HTMLElement>("button.chat-room-results__toggle")));
      const list = controlledElement(target);
      const beforeExpanded = ariaBoolean(target, "aria-expanded");
      const beforeCount = list.querySelectorAll(".chat-room-result").length;
      const beforeLabel = target.textContent.trim();
      if ((beforeExpanded && beforeCount <= 4) || (!beforeExpanded && beforeCount !== 4)) {
        throw new Error("unsupported-state");
      }
      if (!beforeLabel) throw new Error("unsupported-state");
      const afterExpanded = !beforeExpanded;
      return {
        target,
        canStart: () => ariaBoolean(target, "aria-expanded") === beforeExpanded
          && list.querySelectorAll(".chat-room-result").length === beforeCount
          && target.isConnected && isVisible(target),
        feedbackReady: () => {
          const cards = list.querySelectorAll<HTMLElement>(".chat-room-result");
          if (ariaBoolean(target, "aria-expanded") !== afterExpanded) return false;
          if (afterExpanded) {
            const heading = cards[4]?.querySelector<HTMLElement>(".chat-room-result__title h3") ?? null;
            return cards.length > 4 && Boolean(heading?.textContent.trim()) && isVisible(heading);
          }
          return cards.length === 4 && target.textContent.trim() !== beforeLabel && isVisible(target);
        },
      };
    }

    {
      if (theme !== "light" && theme !== "dark") throw new Error("unsupported-state");
      const detailElements = Array.from(document.querySelectorAll<HTMLDetailsElement>("details.theme-control"));
      const details = uniqueVisible(detailElements) as HTMLDetailsElement;
      const summary = details.querySelector<HTMLElement>("summary");
      if (!details.open || !summary || !isVisible(summary)) throw new Error("unsupported-state");
      const label = theme === "light" ? "Hell" : "Dunkel";
      const expectedSummaryLabel = `Darstellung: ${label}`;
      const target = uniqueVisible(Array.from(details.querySelectorAll<HTMLElement>("button.theme-option"))
        .filter(button => {
          const labelElement = button.querySelector("span");
          return labelElement !== null && labelElement.textContent.trim() === label;
        }));
      const initialRootTheme = document.documentElement.dataset.theme;
      if (target.getAttribute("aria-pressed") !== "false" || initialRootTheme === theme) {
        throw new Error("unsupported-state");
      }
      function detailsIsOpen(): boolean {
        return details.open;
      }
      return {
        target,
        canStart: () => detailsIsOpen() && target.getAttribute("aria-pressed") === "false"
          && document.documentElement.dataset.theme === initialRootTheme
          && summary.getAttribute("aria-label") !== expectedSummaryLabel
          && target.isConnected && isVisible(target),
        feedbackReady: () => document.documentElement.dataset.theme === theme
          && target.getAttribute("aria-pressed") === "true"
          && summary.getAttribute("aria-label") === expectedSummaryLabel
          && !details.open && isVisible(summary),
      };
    }

    throw new Error("unsupported-state");
  }

  function setupFailure(cause: unknown): FailureCode {
    if (cause instanceof Error) {
      const known: FailureCode[] = ["missing-target", "ambiguous-target", "unsupported-state"];
      if (known.includes(cause.message as FailureCode)) return cause.message as FailureCode;
    }
    return "unsupported-state";
  }

  function completeSuccess(sample: ActiveSample): void {
    const elapsedMs = currentElapsed(sample);
    cleanupActive(sample);
    if (elapsedMs === undefined) {
      append({ name: sample.name, status: "failed", delayMs: sample.delayMs, failure: "missing-feedback" });
      return;
    }
    append({ name: sample.name, status: "passed", delayMs: sample.delayMs, elapsedMs });
  }

  function scheduleCommitCheck(sample: ActiveSample): void {
    if (sample.checkScheduled) return;
    sample.checkScheduled = true;
    sample.frameOne = hostWindow.requestAnimationFrame(() => {
      sample.frameOne = null;
      sample.frameTwo = hostWindow.requestAnimationFrame(() => {
        sample.frameTwo = null;
        sample.checkScheduled = false;
        if (active !== sample) return;
        if (document.visibilityState !== "visible") {
          failActive("hidden-page");
        } else {
          try {
            if (sample.selection.feedbackReady()) completeSuccess(sample);
          } catch {
            failActive("target-changed");
          }
        }
      });
    });
  }

  function onClickCapture(event: MouseEvent): void {
    if (!active) return;
    const sample = active;
    if (sample.phase === "measuring") {
      if (event.isTrusted) failActive("overlap");
      return;
    }

    if (!event.composedPath().includes(sample.selection.target)) {
      if (event.isTrusted) failActive("wrong-target");
      return;
    }
    if (!event.isTrusted) {
      failActive("untrusted-input");
      return;
    }
    if (!isVisible(sample.selection.target) || !sample.selection.target.isConnected || !sample.selection.canStart()) {
      failActive("target-changed");
      return;
    }

    sample.startedAt = hostWindow.performance.now();
    sample.phase = "measuring";
    if (sample.timer !== null) hostWindow.clearTimeout(sample.timer);
    sample.timer = hostWindow.setTimeout(() => { failActive("feedback-timeout"); }, feedbackDeadlineMs);
    sample.observer = new MutationObserver(() => {
      if (active !== sample) return;
      if (document.visibilityState !== "visible") {
        failActive("hidden-page");
        return;
      }
      try {
        if (sample.selection.feedbackReady()) scheduleCommitCheck(sample);
      } catch {
        failActive("target-changed");
      }
    });
    sample.observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });

    if (sample.delayMs === 250) {
      const until = hostWindow.performance.now() + 250;
      while (hostWindow.performance.now() < until) {
        // This deliberate countercase runs only in the locally installed probe.
      }
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState !== "visible") failActive("hidden-page");
  }

  function arm(name: UiFeedbackName, options: UiFeedbackArmOptions = {}): void {
    if (!names.includes(name)) throw new Error("HASI UI probe rejected an unknown interaction");
    let delayMs: UiFeedbackDelay = 0;
    const rawOptions: unknown = options;
    if (rawOptions !== undefined) {
      if (typeof rawOptions !== "object" || rawOptions === null || Array.isArray(rawOptions)) {
        failArm(name, delayMs, "invalid-options");
      }
      const supplied = rawOptions as Record<string, unknown>;
      const allowedKeys = name === "theme" ? ["delayMs", "theme"] : ["delayMs"];
      if (Object.keys(supplied).some(key => !allowedKeys.includes(key))) {
        failArm(name, delayMs, "invalid-options");
      }
      if (Object.hasOwn(supplied, "delayMs")) {
        if (supplied.delayMs !== 0 && supplied.delayMs !== 250) failArm(name, delayMs, "invalid-options");
        delayMs = supplied.delayMs;
      }
      if (name === "theme" && supplied.theme !== "light" && supplied.theme !== "dark") {
        failArm(name, delayMs, "invalid-options");
      }
      if (name !== "theme" && Object.hasOwn(supplied, "theme")) failArm(name, delayMs, "invalid-options");
    }
    if (disposed) failArm(name, delayMs, "disposed");
    if (capacityReached) throw new Error("HASI UI probe sample capacity was reached");
    if (active) {
      failActive("overlap");
      failArm(name, delayMs, "overlap");
    }
    if (document.visibilityState !== "visible") failArm(name, delayMs, "hidden-page");

    let selection: Selection;
    try {
      selection = resolveSelection(name, name === "theme" ? options.theme : undefined);
    } catch (cause) {
      failArm(name, delayMs, setupFailure(cause));
    }

    const armedAt = hostWindow.performance.now();
    const sample: ActiveSample = {
      name,
      delayMs,
      selection,
      phase: "armed",
      armedAt,
      startedAt: null,
      timer: null,
      observer: null,
      frameOne: null,
      frameTwo: null,
      checkScheduled: false,
    };
    active = sample;
    sample.timer = hostWindow.setTimeout(() => { failActive("missing-input"); }, armDeadlineMs);
  }

  function read(): UiFeedbackSample[] {
    return samples.map(sample => ({ ...sample }));
  }

  function dispose(): void {
    if (disposed) return;
    if (active) failActive("disposed");
    disposed = true;
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("visibilitychange", onVisibilityChange, true);
    if (hostWindow.__hasiUiFeedbackProbe === api) delete hostWindow.__hasiUiFeedbackProbe;
  }

  const api: UiFeedbackProbe = { arm, read, dispose };
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("visibilitychange", onVisibilityChange, true);
  hostWindow.__hasiUiFeedbackProbe = api;
  return api;
}

export function gateUiFeedback(samples: readonly unknown[], requiredCount = 20): UiFeedbackGate {
  type Name = UiFeedbackName;
  type Interaction = UiFeedbackInteractionGate & { failureSet: Set<string> };

  const names: Name[] = ["navigation", "actions-open", "results", "theme"];
  function makeInteraction(): Interaction {
    return {
    passed: false,
    count: 0,
    maxMs: null,
    failures: [],
    failureSet: new Set<string>(),
    };
  }
  const interactions: Record<Name, Interaction> = {
    navigation: makeInteraction(),
    "actions-open": makeInteraction(),
    results: makeInteraction(),
    theme: makeInteraction(),
  };
  let invalidSamples = 0;

  function addFailure(interaction: Interaction, failure: string): void {
    interaction.failureSet.add(failure);
  }

  const validRequiredCount = Number.isInteger(requiredCount) && requiredCount > 0 && requiredCount <= 1000;
  if (!validRequiredCount) {
    for (const interaction of Object.values(interactions)) addFailure(interaction, "invalid-required-count");
  }

  if (!Array.isArray(samples)) {
    invalidSamples = 1;
  } else {
    for (const item of samples) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        invalidSamples += 1;
        continue;
      }
      const sample = item as Record<string, unknown>;
      if (typeof sample.name !== "string" || !names.includes(sample.name as Name)) {
        invalidSamples += 1;
        continue;
      }
      const interaction = interactions[sample.name as Name];
      interaction.count += 1;

      if (sample.status !== "passed") {
        const knownFailures = ["hidden-page", "feedback-timeout", "missing-input", "overlap", "disposed", "wrong-target", "untrusted-input", "missing-feedback"];
        addFailure(interaction, typeof sample.failure === "string" && knownFailures.includes(sample.failure)
          ? sample.failure
          : "failed-sample");
      } else if (sample.failure !== undefined) {
        addFailure(interaction, "malformed-sample");
      }

      if (sample.delayMs !== 0 && sample.delayMs !== 250) {
        addFailure(interaction, "invalid-delay");
      }
      if (typeof sample.elapsedMs !== "number" || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0) {
        addFailure(interaction, "invalid-timing");
        continue;
      }

      interaction.maxMs = interaction.maxMs === null ? sample.elapsedMs : Math.max(interaction.maxMs, sample.elapsedMs);
      if (sample.elapsedMs > 200) addFailure(interaction, "over-limit");
      if (sample.delayMs === 250 && sample.elapsedMs <= 200) addFailure(interaction, "countercase-not-detected");
    }
  }

  let passed = validRequiredCount && invalidSamples === 0;
  for (const name of names) {
    const interaction = interactions[name];
    if (interaction.count < requiredCount) addFailure(interaction, "too-few-samples");
    interaction.passed = validRequiredCount && interaction.count >= requiredCount && interaction.failureSet.size === 0;
    interaction.failures = [...interaction.failureSet].sort();
    delete (interaction as Partial<Interaction>).failureSet;
    passed = passed && interaction.passed;
  }

  return {
    passed,
    thresholdMs: 200,
    requiredCount,
    invalidSamples,
    interactions,
  };
}

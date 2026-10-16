"use client";

import { useEffect, useRef } from "react";
import { chatViewport } from "@/lib/chat-viewport";

export function useChatViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = ref.current;
    if (!enabled || !frame) return;
    const viewport = window.visualViewport;
    let pending = 0;
    const update = () => {
      pending = 0;
      const editing = Boolean(document.activeElement?.matches("textarea, input, [contenteditable='true']"));
      const value = chatViewport(window.innerHeight, viewport, window.matchMedia("(max-width: 760px), (max-width: 1024px) and (max-height: 500px)").matches, editing);
      if (value) {
        frame.style.setProperty("--chat-viewport-height", `${value.height}px`);
        frame.style.setProperty("--chat-viewport-top", `${value.top}px`);
      } else {
        frame.style.removeProperty("--chat-viewport-height");
        frame.style.removeProperty("--chat-viewport-top");
      }
      frame.toggleAttribute("data-keyboard-open", value?.keyboard ?? false);
      frame.toggleAttribute("data-chat-cramped", Boolean(value && value.height < 260));
      frame.toggleAttribute("data-chat-minimal", Boolean(value && value.height < 180));
    };
    const schedule = () => { if (!pending) pending = requestAnimationFrame(update); };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(pending);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      frame.style.removeProperty("--chat-viewport-height");
      frame.style.removeProperty("--chat-viewport-top");
      frame.removeAttribute("data-keyboard-open");
      frame.removeAttribute("data-chat-cramped");
      frame.removeAttribute("data-chat-minimal");
    };
  }, [enabled]);
  return ref;
}

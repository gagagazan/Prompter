import { useEffect, useRef, type RefObject } from "react";

type KeydownHandler = (event: KeyboardEvent) => void;

const handlers = new Set<RefObject<KeydownHandler>>();
let listening = false;

const dispatchKeydown = (event: KeyboardEvent) => {
  for (const handler of handlers) handler.current?.(event);
};

function updateListener() {
  if (handlers.size > 0 && !listening) {
    window.addEventListener("keydown", dispatchKeydown);
    listening = true;
  } else if (handlers.size === 0 && listening) {
    window.removeEventListener("keydown", dispatchKeydown);
    listening = false;
  }
}

export function useWindowKeydown(handler: KeydownHandler) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    handlers.add(handlerRef);
    updateListener();
    return () => {
      handlers.delete(handlerRef);
      updateListener();
    };
  }, []);
}

export function matchesPrimaryShortcut(
  event: KeyboardEvent,
  code: "Comma" | "KeyS",
) {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.altKey ||
    event.shiftKey ||
    (!event.metaKey && !event.ctrlKey)
  ) {
    return false;
  }
  const fallbackKey = code === "Comma" ? "," : "s";
  return event.code === code || event.key.toLowerCase() === fallbackKey;
}

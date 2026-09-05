/**
 * GitHub-style "g + <key>" keyboard navigation shortcuts.
 *
 * Usage: call useKeyboardNav(navigate) once at the app root.
 * Returns isHelpOpen + closeHelp so the caller can render a help modal.
 *
 * Shortcuts:
 *   g o  → Overview
 *   g s  → Suppliers
 *   g p  → Products
 *   g c  → Scouted (candidates)
 *   g r  → Orders (routes)
 *   g l  → Logs
 *   g a  → Analytics
 *   g x  → Settings
 *   ?    → Open this help modal
 *   Esc  → Close help modal / deactivate prefix
 */
import { useEffect, useRef, useState } from "react";
import { NavigateFunction } from "react-router-dom";

const ROUTES: Record<string, string> = {
  o: "/",
  s: "/suppliers",
  p: "/products",
  c: "/scouted",
  r: "/orders",
  l: "/logs",
  a: "/analytics",
  x: "/settings",
};

export function useKeyboardNav(navigate: NavigateFunction) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  // Track whether the user just pressed "g" (the prefix key)
  const gPending = useRef(false);
  const gTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Never fire when focus is inside an input, textarea, or select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // Close help modal with Escape
      if (e.key === "Escape") {
        setIsHelpOpen(false);
        gPending.current = false;
        if (gTimer.current) clearTimeout(gTimer.current);
        return;
      }

      // Open help modal with "?"
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        setIsHelpOpen(prev => !prev);
        return;
      }

      // "g" prefix
      if (e.key === "g" && !e.ctrlKey && !e.metaKey) {
        gPending.current = true;
        if (gTimer.current) clearTimeout(gTimer.current);
        // Auto-cancel after 1500ms if no second key arrives
        gTimer.current = setTimeout(() => { gPending.current = false; }, 1500);
        return;
      }

      // Second key after "g"
      if (gPending.current) {
        gPending.current = false;
        if (gTimer.current) clearTimeout(gTimer.current);
        const route = ROUTES[e.key.toLowerCase()];
        if (route !== undefined) {
          navigate(route);
          e.preventDefault();
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (gTimer.current) clearTimeout(gTimer.current);
    };
  }, [navigate]);

  return { isHelpOpen, closeHelp: () => setIsHelpOpen(false) };
}

/** Exported for the help modal to display */
export const KEYBOARD_SHORTCUTS = [
  { keys: ["g", "o"], label: "Go to Overview" },
  { keys: ["g", "s"], label: "Go to Suppliers" },
  { keys: ["g", "p"], label: "Go to Products" },
  { keys: ["g", "c"], label: "Go to Scouted items" },
  { keys: ["g", "r"], label: "Go to Orders" },
  { keys: ["g", "l"], label: "Go to Logs" },
  { keys: ["g", "a"], label: "Go to Analytics" },
  { keys: ["g", "x"], label: "Go to Settings" },
  { keys: ["?"],      label: "Toggle this help" },
  { keys: ["⌘", "K"], label: "Open global search" },
  { keys: ["Esc"],    label: "Close modal / cancel" },
];

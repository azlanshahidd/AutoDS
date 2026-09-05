import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";

export function Modal({ open, onClose, title, description, children, className }: {
  open: boolean; onClose: () => void; title: string;
  description?: string; children: ReactNode; className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-base/80 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal aria-labelledby="modal-title"
        className={cn("animate-fade-in relative w-full max-w-lg card", className)}>
        <div className="flex items-start justify-between p-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div>
            <h2 id="modal-title" className="text-sm font-semibold text-ink">{title}</h2>
            {description && <p className="mt-1 text-xs text-ink-3">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="ml-4 rounded-md p-2 text-ink-4 hover:bg-surface-2 hover:text-ink-2">
            <X size={15} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

import { createContext, useCallback, useContext, useState, ReactNode } from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "../../lib/cn";

type Tone = "success" | "danger" | "info";
interface Toast { id: number; message: string; tone: Tone; }
interface Ctx { showToast: (msg: string, tone?: Tone) => void; }
const ToastCtx = createContext<Ctx | null>(null);

export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast must be inside ToastProvider");
  return c;
}

const cfg: Record<Tone, { icon: typeof CheckCircle2; accent: string }> = {
  success: { icon: CheckCircle2, accent: "bg-success" },
  danger:  { icon: XCircle,      accent: "bg-danger" },
  info:    { icon: Info,         accent: "bg-cyan" },
};

const iconColor: Record<Tone, string> = {
  success: "text-success", danger: "text-danger", info: "text-cyan",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const showToast = useCallback((message: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { id, message, tone }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4500);
  }, []);

  return (
    <ToastCtx.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2.5" aria-live="polite">
        {toasts.map(t => {
          const { icon: Icon, accent } = cfg[t.tone];
          return (
            <div key={t.id} className="animate-fade-in flex w-80 items-stretch overflow-hidden rounded-2xl bg-surface-2 shadow-card" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className={cn("w-1 shrink-0", accent)} />
              <div className="flex flex-1 items-center gap-3 px-4 py-3">
                <Icon size={16} className={cn("shrink-0", iconColor[t.tone])} />
                <span className="flex-1 text-sm text-ink-2">{t.message}</span>
                <button onClick={() => setToasts(p => p.filter(x => x.id !== t.id))}
                  className="shrink-0 rounded p-0.5 text-ink-5 hover:text-ink-3"><X size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

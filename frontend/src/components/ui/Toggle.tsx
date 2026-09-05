import { cn } from "../../lib/cn";

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-all duration-200",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40",
        checked ? "bg-cyan shadow-glow-sm" : "bg-surface-3"
      )}>
      <span className={cn(
        "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 mt-0.5",
        checked ? "translate-x-[22px]" : "translate-x-0.5"
      )} />
    </button>
  );
}

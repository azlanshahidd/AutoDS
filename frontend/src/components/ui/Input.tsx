import { InputHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string; error?: string; hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, id, ...props }, ref) => (
    <div className="flex flex-col gap-2">
      {label && <label htmlFor={id} className="text-xs font-medium text-ink-3">{label}</label>}
      <input ref={ref} id={id}
        className={cn("input", error && "border-danger/50 focus:border-danger focus:shadow-[0_0_0_3px_rgba(239,68,68,0.15)]", className)}
        {...props} />
      {error ? <span className="text-xs text-danger">{error}</span>
        : hint ? <span className="text-xs text-ink-4">{hint}</span> : null}
    </div>
  )
);
Input.displayName = "Input";

import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "xs" | "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => (
    <button ref={ref} className={cn(
      "inline-flex items-center justify-center gap-2 font-medium transition-all duration-150 select-none",
      "disabled:pointer-events-none disabled:opacity-40",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40",
      size === "xs" && "h-6 rounded-md px-2 text-xs gap-1",
      size === "sm" && "h-7 rounded-md px-3 text-xs gap-1",
      size === "md" && "h-8 rounded-lg px-4 text-sm gap-2",
      size === "lg" && "h-10 rounded-lg px-5 text-sm gap-2",
      variant === "primary" && "bg-cyan text-white font-semibold hover:bg-cyan-l shadow-glow-sm active:scale-[0.97]",
      variant === "secondary" && "bg-surface-2 text-ink-2 border border-[rgba(255,255,255,0.10)] hover:bg-surface-3 hover:text-ink active:scale-[0.97]",
      variant === "ghost" && "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
      variant === "danger" && "bg-danger-bg text-danger border border-[rgba(239,68,68,0.2)] hover:bg-danger/20",
      className
    )} {...props} />
  )
);
Button.displayName = "Button";

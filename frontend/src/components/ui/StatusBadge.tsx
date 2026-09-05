import { cn } from "../../lib/cn";

export type StatusTone = "success" | "danger" | "warning" | "neutral" | "info" | "cyan" | "purple";

const styles: Record<StatusTone, string> = {
  success: "bg-success-bg text-success border border-[rgba(16,185,129,0.2)]",
  danger:  "bg-danger-bg  text-danger  border border-[rgba(239,68,68,0.2)]",
  warning: "bg-warning-bg text-warning border border-[rgba(245,158,11,0.2)]",
  info:    "bg-info-bg    text-info    border border-[rgba(59,130,246,0.2)]",
  cyan:    "bg-cyan-bg    text-cyan    border border-[rgba(6,182,212,0.2)]",
  purple:  "bg-purple-bg  text-purple  border border-[rgba(139,92,246,0.2)]",
  neutral: "bg-surface-2  text-ink-4   border border-[rgba(255,255,255,0.06)]",
};

const dots: Record<StatusTone, string> = {
  success: "bg-success", danger: "bg-danger", warning: "bg-warning",
  info: "bg-info", cyan: "bg-cyan", purple: "bg-purple", neutral: "bg-ink-5",
};

export function StatusBadge({ label, tone, pulse = false, className }: {
  label: string; tone: StatusTone; pulse?: boolean; className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-medium", styles[tone], className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dots[tone], pulse && "animate-pulse-dot")} />
      {label}
    </span>
  );
}

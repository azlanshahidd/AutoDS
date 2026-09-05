import { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

// ── Card ──────────────────────────────────────────────────────────────────────

export function Card({ className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("card", className)}
      style={style}
      {...props}
    />
  );
}

// ── CardHeader ────────────────────────────────────────────────────────────────

export function CardHeader({ className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between px-6 py-4", className)}
      style={{
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        ...style,
      }}
      {...props}
    />
  );
}

// ── CardTitle ─────────────────────────────────────────────────────────────────

export function CardTitle({ className, style, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-sm font-semibold tracking-wide", className)}
      style={{ color: "#C8CCDA", ...style }}
      {...props}
    />
  );
}

// ── CardContent ───────────────────────────────────────────────────────────────

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-6 py-5", className)} {...props} />
  );
}

import { LucideIcon, TrendingUp, TrendingDown, Minus } from "lucide-react";

// ── Tone config ───────────────────────────────────────────────────────────────

type Tone = "cyan" | "green" | "red" | "purple" | "amber" | "blue";

interface ToneConfig {
  iconBg:    string;
  iconColor: string;
  glow:      string; // CSS color for the background blob
}

const tones: Record<Tone, ToneConfig> = {
  cyan:   { iconBg: "rgba(6,182,212,0.14)",  iconColor: "#06B6D4", glow: "#06B6D4" },
  green:  { iconBg: "rgba(34,197,94,0.12)",   iconColor: "#22C55E", glow: "#22C55E" },
  red:    { iconBg: "rgba(239,68,68,0.12)",   iconColor: "#EF4444", glow: "#EF4444" },
  purple: { iconBg: "rgba(139,92,246,0.12)",  iconColor: "#8B5CF6", glow: "#8B5CF6" },
  amber:  { iconBg: "rgba(245,158,11,0.12)",  iconColor: "#F59E0B", glow: "#F59E0B" },
  blue:   { iconBg: "rgba(56,189,248,0.12)",  iconColor: "#38BDF8", glow: "#38BDF8" },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface StatCardProps {
  label:      string;
  value:      string | number;
  icon:       LucideIcon;
  tone?:      Tone;
  change?:    string;       // e.g. "+12.4% from last month"
  changeDir?: "up" | "down" | "neutral";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "cyan",
  change,
  changeDir,
}: StatCardProps) {
  const t = tones[tone];

  const ChangeIcon =
    changeDir === "up"   ? TrendingUp   :
    changeDir === "down" ? TrendingDown :
                           Minus;

  const deltaCls =
    changeDir === "up"   ? "delta-up"   :
    changeDir === "down" ? "delta-down" :
                           "delta-neutral";

  return (
    <div
      className="relative overflow-hidden rounded-2xl p-5 transition-all duration-150"
      style={{
        background:  "linear-gradient(145deg, #1C1D24 0%, #191A20 100%)",
        border:      "1px solid rgba(255,255,255,0.06)",
        boxShadow:   "0 4px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04)",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 8px 32px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 4px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04)";
      }}
    >
      {/* Ambient glow blob — top-right corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full"
        style={{
          background: t.glow,
          opacity:    0.12,
          filter:     "blur(28px)",
        }}
      />

      <div className="relative flex items-center justify-between gap-4">
        {/* Left — label + value + delta */}
        <div className="flex min-w-0 flex-col">
          {/* Eyebrow label */}
          <p className="metric-label truncate">{label}</p>

          {/* Big stat number */}
          <p
            className="mt-3 font-bold tabular-nums tracking-tight leading-none"
            style={{ fontSize: "32px", color: "#F5F5F7", letterSpacing: "-0.02em" }}
          >
            {value}
          </p>

          {/* Delta badge */}
          {change && (
            <div className="mt-3">
              <span className={deltaCls}>
                <ChangeIcon size={10} strokeWidth={2.5} />
                {change}
              </span>
            </div>
          )}
        </div>

        {/* Right — icon box */}
        <div
          className="icon-chip shrink-0"
          style={{
            width:      "44px",
            height:     "44px",
            borderRadius: "12px",
            background: t.iconBg,
          }}
        >
          <Icon size={20} strokeWidth={1.8} style={{ color: t.iconColor }} />
        </div>
      </div>
    </div>
  );
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Canvas ──────────────────────────────────────────────────
        page:        "#08080A",
        shell:       "#111318",
        surface:     "#111318",
        "surface-1": "#1A1B21",
        "surface-2": "#1E2028",
        "surface-3": "#22242C",

        // ── Accent — cyan ────────────────────────────────────────────
        accent:        "#06B6D4",
        "accent-d":    "#0891B2",
        "accent-l":    "#22D3EE",
        "accent-bg":   "rgba(6,182,212,0.12)",
        "accent-glow": "rgba(6,182,212,0.30)",

        // ── Semantic ─────────────────────────────────────────────────
        success:        "#22C55E",
        "success-bg":   "rgba(34,197,94,0.10)",
        danger:         "#EF4444",
        "danger-bg":    "rgba(239,68,68,0.10)",
        warning:        "#F59E0B",
        "warning-bg":   "rgba(245,158,11,0.10)",
        info:           "#38BDF8",
        "info-bg":      "rgba(56,189,248,0.10)",
        purple:         "#8B5CF6",
        "purple-bg":    "rgba(139,92,246,0.12)",

        // ── Text ─────────────────────────────────────────────────────
        ink:     "#F5F5F7",
        "ink-2": "#C8CCDA",
        "ink-3": "#9297A5",
        "ink-4": "#5C606B",
        "ink-5": "#3A3D47",

        // ── Borders ──────────────────────────────────────────────────
        border:    "rgba(255,255,255,0.06)",
        "border-2":"rgba(255,255,255,0.10)",

        // ── Legacy aliases (pages not yet rewritten still use these) ─
        base:       "#08080A",
        cyan:       "#06B6D4",
        "cyan-d":   "#0891B2",
        "cyan-l":   "#22D3EE",
        "cyan-bg":  "rgba(6,182,212,0.12)",
        "cyan-glow":"rgba(6,182,212,0.30)",
        hi:         "#22D3EE",
        "hi-bg":    "rgba(34,211,238,0.10)",
      },

      borderRadius: {
        none:    "0",
        sm:      "4px",
        DEFAULT: "6px",
        md:      "8px",
        lg:      "10px",
        xl:      "12px",
        "2xl":   "16px",
        "3xl":   "20px",
        "4xl":   "24px",
        full:    "9999px",
      },

      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },

      fontSize: {
        "2xs": ["0.625rem",  { lineHeight: "1rem"    }],
        xs:    ["0.6875rem", { lineHeight: "1rem"    }],
        sm:    ["0.8125rem", { lineHeight: "1.25rem" }],
        base:  ["0.875rem",  { lineHeight: "1.375rem"}],
        lg:    ["1rem",      { lineHeight: "1.5rem"  }],
        xl:    ["1.125rem",  { lineHeight: "1.625rem"}],
        "2xl": ["1.25rem",   { lineHeight: "1.75rem" }],
        "3xl": ["1.5rem",    { lineHeight: "2rem"    }],
        "4xl": ["2rem",      { lineHeight: "2.5rem"  }],
        "5xl": ["2.25rem",   { lineHeight: "2.75rem" }],
      },

      spacing: {
        0.5: "2px",  1: "4px",   1.5: "6px",  2: "8px",   2.5: "10px",
        3:   "12px", 3.5: "14px",4: "16px",   5: "20px",  6:   "24px",
        7:   "28px", 8:   "32px",10: "40px",  11: "44px", 12:  "48px",
        13:  "52px", 14:  "56px",16: "64px",  18: "72px", 20:  "80px",
      },

      boxShadow: {
        card:          "0 4px 24px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.04)",
        "card-hover":  "0 8px 32px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.06)",
        glow:          "0 0 24px rgba(6,182,212,0.40)",
        "glow-sm":     "0 0 12px rgba(6,182,212,0.25)",
        "glow-success":"0 0 12px rgba(34,197,94,0.25)",
        inner:         "inset 0 1px 0 rgba(255,255,255,0.04)",
      },

      keyframes: {
        fadeIn:  { "0%":{ opacity:"0", transform:"translateY(8px)" }, "100%":{ opacity:"1", transform:"translateY(0)" } },
        pulse2:  { "0%,100%":{ opacity:"1" }, "50%":{ opacity:"0.4" } },
        shimmer: { "0%":{ backgroundPosition:"200% 0" }, "100%":{ backgroundPosition:"-200% 0" } },
      },
      animation: {
        "fade-in":   "fadeIn 0.2s ease-out both",
        "pulse-dot": "pulse2 2s ease-in-out infinite",
        shimmer:     "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [],
};

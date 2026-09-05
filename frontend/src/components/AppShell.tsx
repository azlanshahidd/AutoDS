import { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard, Plug, Package, ShoppingCart, ScrollText,
  Radar, Settings, Satellite, Sparkles, TrendingUp, Bell, Search,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useSearch } from "../lib/searchContext";
import { GlobalSearch } from "./GlobalSearch";

// ── Nav definition ────────────────────────────────────────────────────────────

const mainNav = [
  { to: "/",             label: "Overview",     icon: LayoutDashboard, end: true },
  { to: "/suppliers",    label: "Suppliers",    icon: Plug },
  { to: "/products",     label: "Products",     icon: Package },
  { to: "/scouted",      label: "Scouted",      icon: Radar },
  { to: "/analytics",   label: "Analytics",    icon: TrendingUp },
  { to: "/ai-providers", label: "AI Providers", icon: Sparkles },
];

const systemNav = [
  { to: "/scrapers",  label: "Scrapers",  icon: Satellite },
  { to: "/orders",    label: "Orders",    icon: ShoppingCart },
  { to: "/logs",      label: "Logs",      icon: ScrollText },
  { to: "/settings",  label: "Settings",  icon: Settings },
];

// ── NavItem ───────────────────────────────────────────────────────────────────

function NavItem({ to, label, icon: Icon, end }: {
  to: string; label: string; icon: typeof LayoutDashboard; end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-[10px] px-4 font-medium transition-all duration-150",
          "text-[13px] h-[44px] select-none",
          isActive ? "sidebar-active" : "sidebar-default"
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={18} strokeWidth={isActive ? 2.2 : 1.8} className="shrink-0" />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

// ── AppShell ──────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: ReactNode }) {
  const { query, setQuery, open, setOpen } = useSearch();

  function openSearch() {
    setOpen(true);
  }

  return (
    <div
      className="flex h-screen w-full items-stretch overflow-hidden"
      style={{ background: "#08080A" }}
    >
      <div className="flex flex-1 overflow-hidden" style={{ background: "#111318" }}>

        {/* ════ SIDEBAR ════ */}
        <aside
          className="flex h-screen shrink-0 flex-col"
          style={{ width: "240px", background: "#111318", borderRight: "1px solid rgba(255,255,255,0.06)" }}
        >
          {/* Logo */}
          <div
            className="flex h-[64px] shrink-0 items-center gap-3 px-6"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg,#0891B2 0%,#22D3EE 100%)", boxShadow: "0 0 20px rgba(6,182,212,0.40)" }}
            >
              <svg width="22" height="22" viewBox="0 0 18 18" fill="none">
                <path d="M9 1L17 9L9 17L1 9Z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
                <circle cx="9" cy="9" r="2.5" fill="#fff" />
              </svg>
            </div>
            <div>
              <p className="text-xl font-bold tracking-tight" style={{ color: "#F5F5F7" }}>CoreDash</p>
              <p className="mt-0.5 leading-none" style={{ fontSize: "12px", color: "#3A3D47" }}>Dropship Automation</p>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-5">
            <p className="nav-section-label mb-3">Main Menu</p>
            <div className="flex flex-col gap-[4px]">
              {mainNav.map(item => <NavItem key={item.to} {...item} />)}
            </div>
            <div className="my-6" style={{ height: "1px", background: "rgba(255,255,255,0.06)" }} />
            <p className="nav-section-label mb-3">System</p>
            <div className="flex flex-col gap-[4px]">
              {systemNav.map(item => <NavItem key={item.to} {...item} />)}
            </div>
          </nav>

          {/* Footer status */}
          <div className="shrink-0 px-3 pb-5" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "20px" }}>
            <div
              className="flex items-center gap-2.5 rounded-xl px-4 py-3"
              style={{ background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.14)" }}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "#22C55E" }} />
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "#22C55E" }} />
              </span>
              <span className="text-xs font-medium" style={{ color: "#22C55E" }}>All systems running</span>
            </div>
          </div>
        </aside>

        {/* ════ MAIN CONTENT ════ */}
        <div className="flex flex-1 flex-col overflow-hidden">

          {/* Header */}
          <header
            className="flex h-[64px] shrink-0 items-center justify-between px-8"
            style={{ background: "#111318", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            {/* Left — fixed-width spacer matching right cluster so search stays centred */}
            <div style={{ width: "96px" }} />

            {/* Search bar — clicking or typing opens the GlobalSearch overlay */}
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: "#5C606B" }}
              />
              <input
                type="text"
                className="search-bar"
                placeholder="Search here…  ⌘K"
                readOnly
                onClick={openSearch}
                onFocus={openSearch}
                value=""
                style={{ cursor: "pointer" }}
              />
            </div>

            <div className="flex items-center gap-4">
              <button className="header-icon-btn" aria-label="Notifications">
                <Bell size={15} />
              </button>
              <div className="avatar text-sm" aria-label="User menu">U</div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>

      {/* Global search overlay — rendered outside the layout flow */}
      <GlobalSearch />
    </div>
  );
}

// ── PageHeader ────────────────────────────────────────────────────────────────

export function PageHeader({ title, description, action }: {
  title: string; description?: string; action?: ReactNode;
}) {
  return (
    <div
      className="sticky top-0 z-10 flex shrink-0 items-center justify-between px-8 py-5"
      style={{ background: "#111318", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div>
        <h1 className="text-lg font-semibold tracking-tight" style={{ color: "#F5F5F7" }}>{title}</h1>
        {description && <p className="mt-1 text-xs" style={{ color: "#5C606B" }}>{description}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

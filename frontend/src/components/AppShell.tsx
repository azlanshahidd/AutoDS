import { ReactNode, useState, useRef, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Plug, Package, ShoppingCart, ScrollText,
  Radar, Settings, Satellite, Sparkles, TrendingUp, Bell, Search,
  X, Menu, CheckCircle2, AlertTriangle, Info, Keyboard,
  ChevronRight, ShieldAlert, RefreshCw,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useSearch } from "../lib/searchContext";
import { GlobalSearch } from "./GlobalSearch";
import { useNotifications, NotificationTone } from "../lib/notificationContext";
import { useKeyboardNav, KEYBOARD_SHORTCUTS } from "../lib/useKeyboardNav";
import { Modal } from "./ui/Modal";
import { api, ApiError } from "../lib/api";
import { useToast } from "./ui/Toast";

// ── Nav definition ────────────────────────────────────────────────────────────

const mainNav = [
  { to: "/",             label: "Overview",     icon: LayoutDashboard, end: true },
  { to: "/suppliers",    label: "Suppliers",    icon: Plug },
  { to: "/products",     label: "Products",     icon: Package },
  { to: "/scouted",      label: "Scouted",      icon: Radar },
  { to: "/analytics",    label: "Analytics",    icon: TrendingUp },
  { to: "/ai-providers", label: "AI Providers", icon: Sparkles },
];

const systemNav = [
  { to: "/scrapers",  label: "Scrapers",  icon: Satellite },
  { to: "/orders",    label: "Orders",    icon: ShoppingCart },
  { to: "/logs",      label: "Logs",      icon: ScrollText },
  { to: "/settings",  label: "Settings",  icon: Settings },
];

// ── NavItem ───────────────────────────────────────────────────────────────────

function NavItem({ to, label, icon: Icon, end, onClick }: {
  to: string; label: string; icon: typeof LayoutDashboard; end?: boolean;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
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

// ── Sidebar content (shared between desktop and mobile drawer) ────────────────

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  return (
    <>
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
          {mainNav.map(item => <NavItem key={item.to} {...item} onClick={onNavClick} />)}
        </div>
        <div className="my-6" style={{ height: "1px", background: "rgba(255,255,255,0.06)" }} />
        <p className="nav-section-label mb-3">System</p>
        <div className="flex flex-col gap-[4px]">
          {systemNav.map(item => <NavItem key={item.to} {...item} onClick={onNavClick} />)}
        </div>
      </nav>

      {/* Footer */}
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
    </>
  );
}

// ── Notification tone config ──────────────────────────────────────────────────

const toneCfg: Record<NotificationTone, { icon: typeof CheckCircle2; color: string }> = {
  success: { icon: CheckCircle2,  color: "#22C55E" },
  danger:  { icon: AlertTriangle, color: "#EF4444" },
  warning: { icon: AlertTriangle, color: "#F59E0B" },
  info:    { icon: Info,          color: "#06B6D4" },
};

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Notification center dropdown ──────────────────────────────────────────────

function NotificationCenter() {
  const { notifications, unreadCount, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function handleOpen() {
    setOpen(prev => !prev);
    if (!open && unreadCount > 0) markAllRead();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        className="header-icon-btn relative"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
            style={{ background: "#EF4444", fontSize: "9px" }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-50 flex flex-col overflow-hidden rounded-2xl"
          style={{
            width: 340,
            background: "#1C1D24",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
            <span className="text-sm font-semibold text-ink">Notifications</span>
            <div className="flex items-center gap-2">
              {notifications.length > 0 && (
                <button
                  onClick={clear}
                  className="text-xs text-ink-5 hover:text-ink-3 transition-colors"
                >
                  Clear all
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-ink-5 hover:text-ink-3">
                <X size={14} />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Bell size={22} className="text-ink-5" />
                <p className="text-xs text-ink-5">No notifications yet.</p>
                <p className="text-xs text-ink-5 px-6">
                  Job failures, listings published, and orders placed will appear here.
                </p>
              </div>
            ) : (
              notifications.map(n => {
                const { icon: Icon, color } = toneCfg[n.tone];
                return (
                  <div
                    key={n.id}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <Icon size={14} className="mt-0.5 shrink-0" style={{ color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-ink-3 leading-snug">{n.message}</p>
                      <p className="mt-0.5 text-[10px] text-ink-5">{fmtRelative(n.timestamp)}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Keyboard shortcuts help modal ─────────────────────────────────────────────

function KeyboardHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" className="max-w-sm">
      <div className="space-y-1.5">
        {KEYBOARD_SHORTCUTS.map(({ keys, label }) => (
          <div key={label} className="flex items-center justify-between py-1">
            <span className="text-xs text-ink-3">{label}</span>
            <div className="flex items-center gap-1">
              {keys.map((k, i) => (
                <span key={i} className="flex items-center gap-1">
                  <kbd
                    className="rounded px-1.5 py-0.5 text-[11px] font-mono font-semibold"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.14)",
                      color: "#C8CCDA",
                    }}
                  >
                    {k}
                  </kbd>
                  {i < keys.length - 1 && (
                    <ChevronRight size={10} className="text-ink-5" />
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-ink-5">
        Shortcuts don't fire when focus is inside an input or textarea.
      </p>
    </Modal>
  );
}

// ── Emergency Stop banner ─────────────────────────────────────────────────────

/**
 * Polls GET /api/emergency-stop on mount and every 30 seconds.
 * When active: shows a full-width red banner with a Resume button.
 * The banner is shown ABOVE the main layout so it's impossible to miss.
 */
function EmergencyStopBanner() {
  const { showToast } = useToast();
  const [stopped,   setStopped]   = useState(false);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const [reason,    setReason]    = useState<string | null>(null);
  const [resuming,  setResuming]  = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const s = await api.getEmergencyStop();
        setStopped(s.emergencyStopped);
        setStoppedAt(s.stoppedAt);
        setReason(s.reason);
      } catch { /* non-fatal — banner just stays hidden */ }
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!stopped) return null;

  async function handleResume() {
    setResuming(true);
    try {
      await api.resumeFromEmergencyStop();
      setStopped(false);
      showToast("Emergency stop cleared. Restart the service to resume automation.", "info");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed to clear emergency stop.", "danger");
    } finally {
      setResuming(false);
    }
  }

  const fmtStop = stoppedAt
    ? new Date(stoppedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div
      className="flex items-center justify-between gap-4 px-6 py-3 shrink-0"
      style={{ background: "#7F1D1D", borderBottom: "1px solid rgba(239,68,68,0.4)" }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <ShieldAlert size={16} className="shrink-0 text-red-300" />
        <div className="min-w-0">
          <span className="text-sm font-bold text-red-100">EMERGENCY STOP ACTIVE</span>
          <span className="ml-2 text-xs text-red-300">
            All automation is paused.{fmtStop ? ` Stopped at ${fmtStop}.` : ""}
            {reason ? ` Reason: ${reason}` : ""}
          </span>
        </div>
      </div>
      <button
        onClick={handleResume}
        disabled={resuming}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60"
        style={{ background: "rgba(239,68,68,0.25)", border: "1px solid rgba(239,68,68,0.5)", color: "#FCA5A5" }}
      >
        {resuming ? <RefreshCw size={12} className="animate-spin" /> : null}
        {resuming ? "Clearing…" : "Clear & restart service"}
      </button>
    </div>
  );
}

// ── AppShell ──────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: ReactNode }) {
  const { setOpen: openSearch } = useSearch();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isHelpOpen, closeHelp } = useKeyboardNav(navigate);

  return (
    <div
      className="flex h-screen w-full items-stretch overflow-hidden"
      style={{ background: "#08080A" }}
    >
      {/* ── Mobile overlay backdrop ── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div className="flex flex-1 overflow-hidden" style={{ background: "#111318" }}>

        {/* ════ SIDEBAR — hidden on mobile, slide-in drawer ════ */}
        <aside
          className={cn(
            "flex h-screen shrink-0 flex-col transition-transform duration-300 z-50",
            "fixed lg:relative lg:translate-x-0",
            mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          )}
          style={{ width: "240px", background: "#111318", borderRight: "1px solid rgba(255,255,255,0.06)" }}
        >
          {/* Close button on mobile */}
          <button
            className="absolute right-3 top-3 rounded-lg p-1.5 text-ink-5 hover:text-ink-3 lg:hidden"
            onClick={() => setMobileOpen(false)}
          >
            <X size={16} />
          </button>

          <SidebarContent onNavClick={() => setMobileOpen(false)} />
        </aside>

        {/* ════ MAIN CONTENT ════ */}
        <div className="flex flex-1 flex-col overflow-hidden">

          {/* Emergency stop banner — above everything when active */}
          <EmergencyStopBanner />

          {/* Header */}
          <header
            className="flex h-[64px] shrink-0 items-center justify-between px-4 sm:px-8"
            style={{ background: "#111318", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            {/* Left — mobile hamburger or spacer */}
            <div className="flex items-center gap-3" style={{ minWidth: "96px" }}>
              <button
                className="rounded-lg p-2 text-ink-5 hover:bg-white/5 hover:text-ink-3 lg:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation"
              >
                <Menu size={18} />
              </button>
            </div>

            {/* Search bar */}
            <div className="relative hidden sm:block">
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
                onClick={() => openSearch(true)}
                onFocus={() => openSearch(true)}
                value=""
                style={{ cursor: "pointer" }}
              />
            </div>

            <div className="flex items-center gap-2 sm:gap-4">
              {/* Mobile search icon */}
              <button
                className="rounded-lg p-2 text-ink-5 hover:bg-white/5 hover:text-ink-3 sm:hidden"
                onClick={() => openSearch(true)}
                aria-label="Search"
              >
                <Search size={15} />
              </button>

              {/* Keyboard shortcuts hint */}
              <button
                className="header-icon-btn hidden sm:flex"
                onClick={() => {}}
                aria-label="Keyboard shortcuts"
                title="Press ? for keyboard shortcuts"
              >
                <Keyboard size={15} />
              </button>

              {/* Notification center */}
              <NotificationCenter />

              <div className="avatar text-sm" aria-label="User menu">U</div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>

      {/* Global search overlay */}
      <GlobalSearch />

      {/* Keyboard shortcuts help modal */}
      <KeyboardHelpModal open={isHelpOpen} onClose={closeHelp} />
    </div>
  );
}

// ── PageHeader ────────────────────────────────────────────────────────────────

export function PageHeader({ title, description, action }: {
  title: string; description?: string; action?: ReactNode;
}) {
  return (
    <div
      className="sticky top-0 z-10 flex shrink-0 items-center justify-between px-4 py-4 sm:px-8 sm:py-5"
      style={{ background: "#111318", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div>
        <h1 className="text-base font-semibold tracking-tight sm:text-lg" style={{ color: "#F5F5F7" }}>{title}</h1>
        {description && <p className="mt-1 text-xs" style={{ color: "#5C606B" }}>{description}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

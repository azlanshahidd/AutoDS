/**
 * GlobalSearch — floating dropdown that searches across all data types.
 *
 * Data fetched once on first open, then filtered client-side on every
 * keystroke (debounced 120 ms so fast typing stays smooth).
 *
 * Searchable types:
 *   Products    — internal_sku, product_title, supplier_type, ebay_sku
 *   Orders      — ebay_order_id, supplier_order_id, tracking_number, status
 *   Suppliers   — displayName, supplierKey, status
 *   Scouted     — title, ai_title, matched_supplier, trend_signal, status
 *   Scrapers    — name, baseUrl, status
 *   AI Providers— name, providerType, baseUrl, model
 */
import {
  useEffect, useRef, useState, useCallback, KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Package, ShoppingCart, Plug, Radar, Satellite, Sparkles,
  ArrowRight, Search, Loader2,
} from "lucide-react";
import {
  api,
  ProductRow, OrderRow, Supplier, ScoutedProduct, Scraper, AiProvider,
} from "../lib/api";
import { useSearch } from "../lib/searchContext";

// ── Result types ──────────────────────────────────────────────────────────────

type ResultKind = "product" | "order" | "supplier" | "scouted" | "scraper" | "ai-provider";

interface SearchResult {
  id:       string;
  kind:     ResultKind;
  label:    string;   // primary text
  sub:      string;   // secondary text
  route:    string;   // nav target
  badge?:   string;   // optional right-side badge text
}

// ── Kind config ───────────────────────────────────────────────────────────────

const kindCfg: Record<ResultKind, {
  label: string;
  icon:  typeof Package;
  color: string;
  bg:    string;
}> = {
  product:     { label: "Product",     icon: Package,      color: "#06B6D4", bg: "rgba(6,182,212,0.12)"  },
  order:       { label: "Order",       icon: ShoppingCart, color: "#38BDF8", bg: "rgba(56,189,248,0.12)"  },
  supplier:    { label: "Supplier",    icon: Plug,         color: "#22C55E", bg: "rgba(34,197,94,0.12)"   },
  scouted:     { label: "Scouted",     icon: Radar,        color: "#8B5CF6", bg: "rgba(139,92,246,0.12)"  },
  scraper:     { label: "Scraper",     icon: Satellite,    color: "#F59E0B", bg: "rgba(245,158,11,0.12)"  },
  "ai-provider":{ label: "AI Provider", icon: Sparkles,   color: "#EF4444", bg: "rgba(239,68,68,0.12)"   },
};

// ── Normalise helpers ─────────────────────────────────────────────────────────

function s(v: string | null | undefined): string { return v ?? ""; }

function fromProducts(rows: ProductRow[]): SearchResult[] {
  return rows.map(r => ({
    id:    `product-${r.internal_sku}`,
    kind:  "product",
    label: r.product_title || r.internal_sku,
    sub:   `SKU: ${r.internal_sku} · ${r.supplier_type}`,
    route: "/products",
    badge: r.current_stock != null ? `Stock: ${r.current_stock}` : undefined,
  }));
}

function fromOrders(rows: OrderRow[]): SearchResult[] {
  return rows.map(r => ({
    id:    `order-${r.ebay_order_id}`,
    kind:  "order",
    label: r.ebay_order_id,
    sub:   `${r.supplier_type} · ${r.status}${r.tracking_number ? ` · ${r.tracking_number}` : ""}`,
    route: "/orders",
    badge: r.status,
  }));
}

function fromSuppliers(rows: Supplier[]): SearchResult[] {
  return rows.map(r => ({
    id:    `supplier-${r.id}`,
    kind:  "supplier",
    label: r.displayName,
    sub:   r.supplierKey,
    route: "/suppliers",
    badge: r.status,
  }));
}

function fromScouted(rows: ScoutedProduct[]): SearchResult[] {
  return rows.map(r => ({
    id:    `scouted-${r.id}`,
    kind:  "scouted",
    label: r.title,
    sub:   [r.matched_supplier, r.trend_signal, r.status].filter(Boolean).join(" · "),
    route: "/scouted",
    badge: r.status,
  }));
}

function fromScrapers(rows: Scraper[]): SearchResult[] {
  return rows.map(r => ({
    id:    `scraper-${r.id}`,
    kind:  "scraper",
    label: r.name,
    sub:   r.baseUrl,
    route: "/scrapers",
    badge: r.status,
  }));
}

function fromAiProviders(rows: AiProvider[]): SearchResult[] {
  return rows.map(r => ({
    id:    `ai-${r.id}`,
    kind:  "ai-provider",
    label: r.name,
    sub:   `${r.providerType} · ${r.model}`,
    route: "/ai-providers",
    badge: r.status,
  }));
}

// ── Filter ────────────────────────────────────────────────────────────────────

function matches(result: SearchResult, q: string): boolean {
  const lq = q.toLowerCase();
  return (
    result.label.toLowerCase().includes(lq) ||
    result.sub.toLowerCase().includes(lq)   ||
    (result.badge ?? "").toLowerCase().includes(lq)
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface AllData {
  products:    SearchResult[];
  orders:      SearchResult[];
  suppliers:   SearchResult[];
  scouted:     SearchResult[];
  scrapers:    SearchResult[];
  aiProviders: SearchResult[];
}

const ORDER: ResultKind[] = ["product", "order", "scouted", "supplier", "scraper", "ai-provider"];

export function GlobalSearch() {
  const { query, setQuery, open, setOpen } = useSearch();
  const navigate   = useNavigate();
  const inputRef   = useRef<HTMLInputElement>(null);
  const panelRef   = useRef<HTMLDivElement>(null);

  const [data,    setData]    = useState<AllData | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor,  setCursor]  = useState(-1); // keyboard selection index

  // Fetch all data once when first opened
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, o, sup, sc, scr, ai] = await Promise.all([
        api.listProducts(),
        api.listOrders(),
        api.listSuppliers(),
        api.listScouted(),
        api.listScrapers(),
        api.listAiProviders(),
      ]);
      setData({
        products:    fromProducts(p.products    ?? []),
        orders:      fromOrders(o.orders        ?? []),
        suppliers:   fromSuppliers(sup.suppliers ?? []),
        scouted:     fromScouted(sc.scoutedProducts ?? []),
        scrapers:    fromScrapers(scr.scrapers   ?? []),
        aiProviders: fromAiProviders(ai.providers ?? []),
      });
    } catch {
      // silently degrade — user sees empty results
    } finally {
      setLoading(false);
    }
  }, []);

  // F17: refresh data on every open so new/deleted items are always current.
  // The previous `!data` guard caused stale results after adding/removing items.
  useEffect(() => {
    if (open) fetchAll();
  }, [open, fetchAll]);

  // Reset cursor whenever query changes
  useEffect(() => { setCursor(-1); }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open, setOpen]);

  // Close on Escape globally
  useEffect(() => {
    function handle(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); setQuery(""); }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [setOpen, setQuery]);

  // Build flat filtered list for keyboard nav
  const trimmed = query.trim();
  const allResults: SearchResult[] = trimmed.length < 1 ? [] : ORDER.flatMap(kind => {
    const bucket =
      kind === "product"      ? data?.products    :
      kind === "order"        ? data?.orders       :
      kind === "supplier"     ? data?.suppliers    :
      kind === "scouted"      ? data?.scouted      :
      kind === "scraper"      ? data?.scrapers     :
      kind === "ai-provider"  ? data?.aiProviders  : [];
    return (bucket ?? []).filter(r => matches(r, trimmed));
  });

  // Grouped for rendering
  const grouped: Partial<Record<ResultKind, SearchResult[]>> = {};
  for (const r of allResults) {
    if (!grouped[r.kind]) grouped[r.kind] = [];
    grouped[r.kind]!.push(r);
  }

  // Keyboard nav
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, allResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // F19: wrap to last item when pressing ↑ at the top boundary
      setCursor(c => c <= 0 ? allResults.length - 1 : c - 1);
    } else if (e.key === "Enter") {
      const target = cursor >= 0 ? allResults[cursor] : allResults[0];
      if (target) navigate(target.route);
      setOpen(false);
      setQuery("");
    }
  }

  function onSelect(r: SearchResult) {
    navigate(r.route);
    setOpen(false);
    setQuery("");
  }

  if (!open) return null;

  const showEmpty = trimmed.length > 0 && !loading && allResults.length === 0;
  const showIdle  = trimmed.length === 0;

  // Running index for cursor tracking across groups
  let runningIdx = 0;

  return (
    /* Full-screen backdrop */
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ paddingTop: "80px", background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
    >
      <div
        ref={panelRef}
        className="w-full max-w-xl overflow-hidden rounded-2xl"
        style={{
          background: "#1A1B21",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
        }}
      >
        {/* Search input row */}
        <div
          className="flex items-center gap-3 px-4"
          style={{ height: "56px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
        >
          {loading
            ? <Loader2 size={16} className="animate-spin shrink-0" style={{ color: "#06B6D4" }} />
            : <Search size={16} className="shrink-0" style={{ color: "#5C606B" }} />
          }
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search products, orders, suppliers…"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: "14px", color: "#F5F5F7" }}
          />
          <kbd style={{
            fontSize: "11px", fontWeight: 600, color: "#5C606B",
            background: "rgba(255,255,255,0.06)", borderRadius: "5px",
            padding: "2px 6px", border: "1px solid rgba(255,255,255,0.08)",
          }}>
            ESC
          </kbd>
        </div>

        {/* Results area */}
        <div style={{ maxHeight: "480px", overflowY: "auto" }}>

          {/* Idle state — show categories */}
          {showIdle && (
            <div className="px-4 py-5">
              <p style={{ fontSize: "11px", fontWeight: 600, color: "#3A3D47",
                textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "12px" }}>
                Browse
              </p>
              <div className="grid grid-cols-3 gap-2">
                {ORDER.map(kind => {
                  const cfg = kindCfg[kind];
                  const Icon = cfg.icon;
                  return (
                    <button key={kind}
                      onClick={() => { navigate(`/${kind === "ai-provider" ? "ai-providers" : kind === "scouted" ? "scouted" : kind + "s"}`); setOpen(false); }}
                      className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-all duration-150"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                        style={{ background: cfg.bg }}>
                        <Icon size={13} style={{ color: cfg.color }} strokeWidth={1.8} />
                      </div>
                      <span style={{ fontSize: "12px", fontWeight: 500, color: "#C8CCDA" }}>
                        {cfg.label}s
                      </span>
                    </button>
                  );
                })}
              </div>
              <p style={{ fontSize: "11px", color: "#3A3D47", marginTop: "16px", textAlign: "center" }}>
                Type to search across all data  ·  ↑↓ to navigate  ·  ↵ to open
              </p>
            </div>
          )}

          {/* Empty state */}
          {showEmpty && (
            <div className="flex flex-col items-center gap-2 py-10">
              <Search size={20} style={{ color: "#3A3D47" }} />
              <p style={{ fontSize: "13px", color: "#5C606B" }}>
                No results for <span style={{ color: "#C8CCDA" }}>"{trimmed}"</span>
              </p>
            </div>
          )}

          {/* Grouped results */}
          {!showIdle && !showEmpty && ORDER.map(kind => {
            const rows = grouped[kind];
            if (!rows?.length) return null;
            const cfg = kindCfg[kind];
            const Icon = cfg.icon;

            return (
              <div key={kind}>
                {/* Group header */}
                <div className="flex items-center gap-2 px-4 py-2"
                  style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <Icon size={11} style={{ color: cfg.color }} strokeWidth={2} />
                  <p style={{ fontSize: "10px", fontWeight: 700, color: "#5C606B",
                    textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {cfg.label}s
                  </p>
                  <span style={{ fontSize: "10px", fontWeight: 600, color: "#3A3D47",
                    background: "rgba(255,255,255,0.06)", borderRadius: "9999px",
                    padding: "0 6px" }}>
                    {rows.length}
                  </span>
                </div>

                {/* Result rows */}
                {rows.slice(0, 6).map(r => {
                  const idx = runningIdx++;
                  const isActive = idx === cursor;
                  return (
                    <button
                      key={r.id}
                      onClick={() => onSelect(r)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-all duration-100"
                      style={{
                        background: isActive ? "rgba(6,182,212,0.09)" : "transparent",
                        borderLeft: isActive ? "2px solid #06B6D4" : "2px solid transparent",
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
                        setCursor(idx);
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLElement).style.background = isActive ? "rgba(6,182,212,0.09)" : "transparent";
                      }}
                    >
                      {/* Icon chip */}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                        style={{ background: cfg.bg }}>
                        <Icon size={14} style={{ color: cfg.color }} strokeWidth={1.8} />
                      </div>

                      {/* Label + sub */}
                      <div className="flex flex-1 flex-col overflow-hidden" style={{ gap: "2px" }}>
                        <p className="truncate" style={{ fontSize: "13px", fontWeight: 500, color: "#F5F5F7" }}>
                          {r.label}
                        </p>
                        <p className="truncate" style={{ fontSize: "11px", color: "#5C606B" }}>
                          {r.sub}
                        </p>
                      </div>

                      {/* Badge */}
                      {r.badge && (
                        <span style={{
                          fontSize: "10px", fontWeight: 600,
                          padding: "2px 8px", borderRadius: "9999px",
                          background: "rgba(255,255,255,0.06)",
                          color: "#9297A5", flexShrink: 0,
                        }}>
                          {r.badge}
                        </span>
                      )}

                      <ArrowRight size={12} style={{ color: "#3A3D47", flexShrink: 0 }} />
                    </button>
                  );
                })}

                {rows.length > 6 && (
                  <button onClick={() => { navigate(kind === "ai-provider" ? "/ai-providers" : kind === "scouted" ? "/scouted" : `/${kind}s`); setOpen(false); }}
                    className="w-full px-4 py-2 text-left transition-colors duration-100"
                    style={{ fontSize: "11px", color: "#06B6D4" }}
                    onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#22D3EE")}
                    onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#06B6D4")}
                  >
                    +{rows.length - 6} more — view all →
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {!showIdle && allResults.length > 0 && (
          <div className="flex items-center justify-between px-4 py-2.5"
            style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <p style={{ fontSize: "11px", color: "#3A3D47" }}>
              {allResults.length} result{allResults.length !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-3" style={{ fontSize: "11px", color: "#3A3D47" }}>
              <span>↑↓ navigate</span>
              <span>↵ open</span>
              <span>ESC close</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

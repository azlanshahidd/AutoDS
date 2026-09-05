import { useEffect, useState, useRef, useCallback } from "react";
import { Package, Pencil, Check, X } from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatusBadge } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, ProductRow, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

const fmt = (ts: string | null) =>
  !ts ? "Never" :
  new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

// ── Inline price cell ─────────────────────────────────────────────────────────

function InlinePriceCell({
  sku,
  price,
  onSaved,
}: {
  sku:     string;
  price:   number | null;
  onSaved: (sku: string, newPrice: number) => void;
}) {
  const { showToast } = useToast();
  const [editing,  setEditing]  = useState(false);
  const [draft,    setDraft]    = useState("");
  const [saving,   setSaving]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(price !== null ? price.toFixed(2) : "");
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 0);
  }

  function cancel() {
    setEditing(false);
    setDraft("");
  }

  async function save() {
    const parsed = parseFloat(draft);
    if (isNaN(parsed) || parsed < 0) {
      showToast("Enter a valid price (e.g. 19.99).", "danger");
      return;
    }
    setSaving(true);
    try {
      const { currentPrice } = await api.patchVariantPrice(sku, parsed);
      onSaved(sku, currentPrice);
      setEditing(false);
      showToast(`Price updated to $${currentPrice.toFixed(2)}.`, "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed to update price.", "danger");
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter")  { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-5">$</span>
          <input
            ref={inputRef}
            type="number"
            step="0.01"
            min="0"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className="w-24 rounded-lg border py-1 pl-5 pr-2 text-xs font-mono font-semibold text-ink focus:outline-none"
            style={{
              background: "rgba(255,255,255,0.05)",
              borderColor: "rgba(6,182,212,0.4)",
            }}
            autoFocus
          />
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="rounded p-1 text-success hover:bg-success/10 disabled:opacity-50"
          title="Save (Enter)"
        >
          <Check size={12} />
        </button>
        <button
          onClick={cancel}
          className="rounded p-1 text-ink-5 hover:text-ink-3"
          title="Cancel (Esc)"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={startEdit}
      className={cn(
        "group flex items-center gap-1.5 rounded-lg px-1 py-0.5 font-mono font-semibold text-ink",
        "transition-colors hover:bg-white/5"
      )}
      title="Click to edit price"
    >
      {price !== null ? `$${price.toFixed(2)}` : "—"}
      <Pencil
        size={11}
        className="text-ink-5 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ProductsPage() {
  const { showToast } = useToast();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    try {
      const { products } = await api.listProducts();
      setProducts(products ?? []);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  function handlePriceSaved(sku: string, newPrice: number) {
    setProducts(prev =>
      prev.map(p => p.internal_sku === sku ? { ...p, current_price: newPrice } : p)
    );
  }

  return (
    <div>
      <PageHeader
        title="Products"
        description="Every tracked variant from your suppliers — click any price to edit inline"
        action={!loading && (
          <span
            className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-4"
            style={{ border: "1px solid rgba(255,255,255,0.06)" }}
          >
            {products.length} variant{products.length !== 1 ? "s" : ""}
          </span>
        )}
      />
      <div className="p-4 sm:p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
            </div>
          ) : products.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No products tracked"
              description="Fetch a variant from a supplier to see it here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>SKU / Title</th>
                    <th>Supplier</th>
                    <th>
                      Price
                      <span className="ml-1.5 text-[10px] font-normal text-ink-5">(click to edit)</span>
                    </th>
                    <th>Stock</th>
                    <th>Status</th>
                    <th>Last synced</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map(p => (
                    <tr key={p.internal_sku}>
                      <td>
                        <p className="font-semibold text-ink">{p.internal_sku}</p>
                        <p className="mt-0.5 max-w-xs truncate text-xs text-ink-5">{p.product_title}</p>
                      </td>
                      <td>
                        <span className="rounded-lg bg-cyan-bg px-2 py-0.5 text-xs font-semibold text-cyan">
                          {p.supplier_type}
                        </span>
                      </td>
                      <td>
                        <InlinePriceCell
                          sku={p.internal_sku}
                          price={p.current_price}
                          onSaved={handlePriceSaved}
                        />
                      </td>
                      <td className="font-mono text-ink-3">{p.current_stock ?? "—"}</td>
                      <td>
                        <StatusBadge
                          label={p.ebay_sku ? "Published" : "Not published"}
                          tone={p.ebay_sku ? "success" : "neutral"}
                        />
                      </td>
                      <td className="text-xs text-ink-5">{fmt(p.last_synced_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

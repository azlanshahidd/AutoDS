import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatusBadge } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, ProductRow, ApiError } from "../lib/api";

const fmt = (ts: string|null) => !ts ? "Never" :
  new Date(ts.replace(" ","T")+"Z").toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

export function ProductsPage() {
  const { showToast } = useToast();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let c = false;
    async function load() {
      try { const { products } = await api.listProducts(); if(!c) setProducts(products??[]); }
      catch(e) { if(!c) showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
      finally { if(!c) setLoading(false); }
    }
    load(); const id = setInterval(load, 8000); return () => { c=true; clearInterval(id); };
  }, []); // eslint-disable-line

  return (
    <div>
      <PageHeader title="Products" description="Every tracked variant from your suppliers"
        action={!loading && (
          <span className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-4" style={{border:"1px solid rgba(255,255,255,0.06)"}}>
            {products.length} variant{products.length!==1?"s":""}
          </span>
        )} />
      <div className="p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan"/></div>
          ) : products.length===0 ? (
            <EmptyState icon={Package} title="No products tracked" description="Fetch a variant from a supplier to see it here."/>
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead><tr><th>SKU / Title</th><th>Supplier</th><th>Price</th><th>Stock</th><th>Status</th><th>Last synced</th></tr></thead>
                <tbody>
                  {products.map(p => (
                    <tr key={p.internal_sku}>
                      <td>
                        <p className="font-semibold text-ink">{p.internal_sku}</p>
                        <p className="mt-0.5 max-w-xs truncate text-xs text-ink-5">{p.product_title}</p>
                      </td>
                      <td><span className="rounded-lg bg-cyan-bg px-2 py-0.5 text-xs font-semibold text-cyan">{p.supplier_type}</span></td>
                      <td className="font-mono font-semibold text-ink">{p.current_price!==null ? `$${p.current_price.toFixed(2)}` : "—"}</td>
                      <td className="font-mono text-ink-3">{p.current_stock ?? "—"}</td>
                      <td><StatusBadge label={p.ebay_sku ? "Published" : "Not published"} tone={p.ebay_sku ? "success" : "neutral"}/></td>
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


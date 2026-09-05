import { useEffect, useState } from "react";
import { ShoppingCart } from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, OrderRow, ApiError } from "../lib/api";

const sCfg: Record<string, { label:string; tone:StatusTone }> = {
  pending:                     { label:"Pending",     tone:"neutral" },
  submitted:                   { label:"Submitted",   tone:"purple" },
  shipped:                     { label:"Shipped",     tone:"info" },
  fulfilled:                   { label:"Fulfilled",   tone:"success" },
  failed:                      { label:"Failed",      tone:"danger" },
  skipped_auto_order_disabled: { label:"Logged only", tone:"neutral" },
};

const fmt = (ts: string) =>
  new Date(ts.replace(" ","T")+"Z").toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

export function OrdersPage() {
  const { showToast } = useToast();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let c=false;
    async function load() {
      try { const { orders } = await api.listOrders(); if(!c) setOrders(orders??[]); }
      catch(e) { if(!c) showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
      finally { if(!c) setLoading(false); }
    }
    load(); const id=setInterval(load,8000); return () => { c=true; clearInterval(id); };
  }, []); // eslint-disable-line

  return (
    <div>
      <PageHeader title="Orders" description="eBay orders and fulfillment status"
        action={!loading && (
          <span className="rounded-full bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-4" style={{border:"1px solid rgba(255,255,255,0.06)"}}>
            {orders.length} order{orders.length!==1?"s":""}
          </span>
        )} />
      <div className="p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan"/></div>
          ) : orders.length===0 ? (
            <EmptyState icon={ShoppingCart} title="No orders yet" description="Paid eBay orders appear here once the routing loop picks them up."/>
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead><tr><th>eBay Order ID</th><th>Supplier Order</th><th>Status</th><th>Tracking</th><th>Created</th></tr></thead>
                <tbody>
                  {orders.map(o => {
                    const st = sCfg[o.status] ?? { label:o.status, tone:"neutral" as StatusTone };
                    return (
                      <tr key={o.ebay_order_id}>
                        <td className="font-mono text-xs font-semibold text-ink">{o.ebay_order_id}</td>
                        <td className="font-mono text-xs text-ink-4">{o.supplier_order_id||"—"}</td>
                        <td><StatusBadge label={st.label} tone={st.tone}/></td>
                        <td className="text-xs text-ink-4">{o.tracking_number ? `${o.carrier?o.carrier+" ":""}${o.tracking_number}` : "—"}</td>
                        <td className="text-xs text-ink-5">{fmt(o.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}


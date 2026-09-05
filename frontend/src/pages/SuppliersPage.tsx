import { useEffect, useState, FormEvent } from "react";
import { Plug, Plus, RefreshCw, Trash2, Power, PowerOff, KeyRound, Zap, DollarSign, X } from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/ui/Toast";
import { api, Supplier, AvailablePlugin, CoreSettings, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

const sCfg: Record<Supplier["status"], { label: string; tone: StatusTone; pulse?: boolean }> = {
  connected:    { label: "Connected",  tone: "success", pulse: true },
  failed:       { label: "Failed",     tone: "danger" },
  unconfigured: { label: "Not tested", tone: "neutral" },
  disabled:     { label: "Disabled",   tone: "neutral" },
};

function fmt(ts: string) {
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Pricing override badge ────────────────────────────────────────────────────

function PricingBadge({ s }: { s: Supplier }) {
  const hasMargin = s.marginOverride !== null && s.marginOverride !== undefined;
  const hasFee    = s.feeOverride    !== null && s.feeOverride    !== undefined;
  if (!hasMargin && !hasFee) return null;
  const parts: string[] = [];
  if (hasMargin) parts.push(`${((s.marginOverride as number) * 100).toFixed(0)}% margin`);
  if (hasFee)    parts.push(`$${(s.feeOverride as number).toFixed(2)} fee`);
  return (
    <span
      className="ml-1.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ background: "rgba(6,182,212,0.10)", border: "1px solid rgba(6,182,212,0.2)", color: "#06b6d4" }}
      title="Custom pricing override active"
    >
      <DollarSign size={9} />
      {parts.join(" · ")}
    </span>
  );
}

// ── Pricing override modal ────────────────────────────────────────────────────

function PricingModal({
  open, onClose, supplier, globalSettings, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  supplier: Supplier | null;
  globalSettings: Pick<CoreSettings, "profitMarginPercent" | "ebayFeeEstimate"> | null;
  onSaved: (s: Supplier) => void;
}) {
  const { showToast } = useToast();
  const [marginStr, setMarginStr] = useState("");
  const [feeStr,    setFeeStr]    = useState("");
  const [saving,    setSaving]    = useState(false);

  // Sync local state when supplier changes
  useEffect(() => {
    if (supplier) {
      setMarginStr(supplier.marginOverride !== null && supplier.marginOverride !== undefined
        ? String(((supplier.marginOverride) * 100).toFixed(2))
        : "");
      setFeeStr(supplier.feeOverride !== null && supplier.feeOverride !== undefined
        ? String(supplier.feeOverride.toFixed(2))
        : "");
    }
  }, [supplier?.id, supplier?.marginOverride, supplier?.feeOverride]); // eslint-disable-line

  if (!supplier) return null;

  // Capture non-null reference for use inside async callbacks
  const s = supplier;

  const globalMarginPct = globalSettings ? (globalSettings.profitMarginPercent * 100).toFixed(0) : "–";
  const globalFee       = globalSettings ? globalSettings.ebayFeeEstimate.toFixed(2) : "–";

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // Empty string → clear override (null); otherwise parse the value
      const marginOverride = marginStr.trim() === ""
        ? null
        : Math.max(0, parseFloat(marginStr) / 100);
      const feeOverride = feeStr.trim() === ""
        ? null
        : Math.max(0, parseFloat(feeStr));

      if (marginStr.trim() !== "" && isNaN(marginOverride as number)) {
        showToast("Margin must be a number (e.g. 40 for 40%).", "danger");
        return;
      }
      if (feeStr.trim() !== "" && isNaN(feeOverride as number)) {
        showToast("Fee must be a number (e.g. 2.50).", "danger");
        return;
      }

      const { supplier: updated } = await api.editSupplier(s.id, {
        marginOverride,
        feeOverride,
      });
      onSaved(updated);
      showToast("Pricing overrides saved.", "success");
      onClose();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to save.", "danger");
    } finally {
      setSaving(false);
    }
  }

  function handleClear() {
    setMarginStr("");
    setFeeStr("");
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pricing overrides — ${supplier.displayName}`}
      description="Leave a field blank to use the global setting from Settings → Pricing."
      className="max-w-md"
    >
      <form onSubmit={handleSave} className="space-y-5">
        {/* Margin override */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-ink-3">
            Profit margin %
            <span className="ml-2 text-xs font-normal text-ink-5">
              global: {globalMarginPct}%
            </span>
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.1"
              min="0"
              max="500"
              value={marginStr}
              onChange={e => setMarginStr(e.target.value)}
              placeholder={`${globalMarginPct} (global)`}
              className="input pr-7"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-5">%</span>
          </div>
          <p className="text-xs text-ink-5">
            e.g. 40 for 40%. Overrides the global setting only for this supplier's variants.
          </p>
        </div>

        {/* Fee override */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-ink-3">
            eBay fee estimate ($)
            <span className="ml-2 text-xs font-normal text-ink-5">
              global: ${globalFee}
            </span>
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-ink-5">$</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={feeStr}
              onChange={e => setFeeStr(e.target.value)}
              placeholder={`${globalFee} (global)`}
              className="input pl-6"
            />
          </div>
          <p className="text-xs text-ink-5">
            Flat USD estimate added to every listing price for this supplier.
          </p>
        </div>

        {/* Per-tier pricing note */}
        <div
          className="rounded-lg px-3.5 py-3 text-xs text-ink-3"
          style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.15)" }}
        >
          <strong className="text-ink-3">Per-tier rules</strong> (e.g. higher margin on low-cost items)
          are configured globally in <strong className="text-ink-3">Settings → Pricing Tiers</strong>{" "}
          and apply on top of these overrides.
        </div>

        {/* Formula preview */}
        {(marginStr.trim() !== "" || feeStr.trim() !== "") && (() => {
          const m = marginStr.trim() !== "" ? parseFloat(marginStr) / 100 : (globalSettings?.profitMarginPercent ?? 0);
          const f = feeStr.trim()    !== "" ? parseFloat(feeStr)          : (globalSettings?.ebayFeeEstimate    ?? 0);
          if (isNaN(m) || isNaN(f)) return null;
          return (
            <div
              className="rounded-lg px-3.5 py-3 text-xs font-mono text-ink-3"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
            >
              price = (cost + shipping) × {(1 + m).toFixed(2)} + ${f.toFixed(2)}
            </div>
          );
        })()}

        <div className="flex items-center justify-between border-t pt-4"
          style={{ borderColor: "rgba(255,255,255,0.07)" }}>
          <Button type="button" variant="ghost" size="sm" onClick={handleClear}
            title="Clear both overrides (revert to global)">
            <X size={13} />Clear overrides
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving}>
              <DollarSign size={13} />
              {saving ? "Saving..." : "Save overrides"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SuppliersPage() {
  const { showToast } = useToast();
  const [suppliers,      setSuppliers]      = useState<Supplier[]>([]);
  const [plugins,        setPlugins]        = useState<AvailablePlugin[]>([]);
  const [globalSettings, setGlobalSettings] = useState<Pick<CoreSettings, "profitMarginPercent" | "ebayFeeEstimate"> | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [addOpen,        setAddOpen]        = useState(false);
  const [testingId,      setTestingId]      = useState<number | null>(null);
  const [pricingSupplier, setPricingSupplier] = useState<Supplier | null>(null);

  async function loadAll() {
    setLoading(true);
    try {
      const [sr, pr, st] = await Promise.all([
        api.listSuppliers(),
        api.availablePlugins(),
        api.getSettings(),
      ]);
      setSuppliers(sr.suppliers ?? []);
      setPlugins(pr.plugins ?? []);
      setGlobalSettings({
        profitMarginPercent: st.settings.profitMarginPercent,
        ebayFeeEstimate:     st.settings.ebayFeeEstimate,
      });
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadAll(); }, []); // eslint-disable-line

  async function handleTest(id: number) {
    setTestingId(id);
    try {
      const { supplier } = await api.testConnection(id);
      setSuppliers(p => p.map(s => s.id === id ? supplier : s));
      showToast(
        supplier.status === "connected"
          ? `${supplier.displayName} connected.`
          : `${supplier.displayName} failed.`,
        supplier.status === "connected" ? "success" : "danger"
      );
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Test failed.", "danger");
    } finally {
      setTestingId(null);
    }
  }

  async function handleToggle(s: Supplier) {
    try {
      const en = s.status === "disabled";
      const { supplier } = await api.setSupplierEnabled(s.id, en);
      setSuppliers(p => p.map(x => x.id === s.id ? supplier : x));
      showToast(`${s.displayName} ${en ? "enabled" : "disabled"}.`, "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    }
  }

  async function handleRemove(s: Supplier) {
    if (!window.confirm(`Remove "${s.displayName}"? Its encrypted credentials will be deleted permanently.`)) return;
    try {
      await api.removeSupplier(s.id);
      setSuppliers(p => p.filter(x => x.id !== s.id));
      showToast(`${s.displayName} removed.`, "info");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    }
  }

  return (
    <div>
      <PageHeader
        title="Suppliers"
        description="Manage your dropship supplier connections"
        action={<Button onClick={() => setAddOpen(true)}><Plus size={14} />Add Supplier</Button>}
      />
      <div className="p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
            </div>
          ) : suppliers.length === 0 ? (
            <EmptyState icon={Plug} title="No suppliers yet" description="Add a supplier to start syncing."
              action={<Button onClick={() => setAddOpen(true)}><Plus size={14} />Add Supplier</Button>} />
          ) : (
            <table className="dt">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>API Key</th>
                  <th>Pricing</th>
                  <th>Status</th>
                  <th>Last tested</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map(s => {
                  const st = sCfg[s.status];
                  const hasMargin = s.marginOverride !== null && s.marginOverride !== undefined;
                  const hasFee    = s.feeOverride    !== null && s.feeOverride    !== undefined;
                  return (
                    <tr key={s.id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-bg">
                            <Zap size={14} className="text-cyan" />
                          </div>
                          <div>
                            <p className="font-semibold text-ink">{s.displayName}</p>
                            <p className="text-xs text-ink-5">{s.supplierKey}</p>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-ink-4">{s.maskedApiKey || "—"}</span>
                      </td>
                      {/* Pricing column */}
                      <td>
                        <button
                          type="button"
                          onClick={() => setPricingSupplier(s)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                            hasMargin || hasFee
                              ? "text-cyan"
                              : "text-ink-5 hover:text-ink-3"
                          )}
                          style={hasMargin || hasFee
                            ? { background: "rgba(6,182,212,0.10)", border: "1px solid rgba(6,182,212,0.2)" }
                            : { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                          title="Edit pricing overrides for this supplier"
                        >
                          <DollarSign size={11} />
                          {hasMargin || hasFee ? (
                            <span>
                              {hasMargin && `${((s.marginOverride as number) * 100).toFixed(0)}%`}
                              {hasMargin && hasFee && " · "}
                              {hasFee    && `$${(s.feeOverride as number).toFixed(2)}`}
                            </span>
                          ) : (
                            <span>Global</span>
                          )}
                        </button>
                      </td>
                      <td><StatusBadge label={st.label} tone={st.tone} pulse={st.pulse} /></td>
                      <td className="text-xs text-ink-4">
                        {s.lastTestedAt ? fmt(s.lastTestedAt) : "Never"}
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => handleTest(s.id)}
                            disabled={testingId === s.id}>
                            <RefreshCw size={13} className={testingId === s.id ? "animate-spin" : ""} />
                            Test
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleToggle(s)}>
                            {s.status === "disabled" ? <Power size={13} /> : <PowerOff size={13} />}
                            {s.status === "disabled" ? "Enable" : "Disable"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setPricingSupplier(s)}
                            title="Edit pricing overrides">
                            <DollarSign size={13} className={cn(
                              (hasMargin || hasFee) ? "text-cyan" : "text-ink-5"
                            )} />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleRemove(s)}>
                            <Trash2 size={13} className="text-danger" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* CSV supplier help card */}
        {suppliers.some(s => s.supplierKey === "CSV") && (
          <div
            className="mt-4 rounded-xl px-5 py-4 text-xs text-ink-3"
            style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)" }}
          >
            <p className="font-semibold text-ink-3 mb-1">Manual / CSV Supplier</p>
            <p>
              Place your variant catalogue at{" "}
              <code className="font-mono text-cyan">config/csv-supplier-catalogue.json</code>{" "}
              (see <code className="font-mono text-cyan">csv-supplier-catalogue.example.json</code> for the format).
              Orders are dispatched to your webhook URL (API Key field) or logged to{" "}
              <code className="font-mono text-cyan">logs/manual-orders.jsonl</code> when no webhook is set.
            </p>
          </div>
        )}
      </div>

      <AddModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        plugins={plugins}
        onAdded={s => {
          setSuppliers(p => [...p, s]);
          setAddOpen(false);
          showToast(
            s.status === "connected"
              ? `${s.displayName} connected.`
              : `${s.displayName} saved — test failed.`,
            s.status === "connected" ? "success" : "danger"
          );
        }}
      />

      <PricingModal
        open={pricingSupplier !== null}
        onClose={() => setPricingSupplier(null)}
        supplier={pricingSupplier}
        globalSettings={globalSettings}
        onSaved={updated => setSuppliers(p => p.map(s => s.id === updated.id ? updated : s))}
      />
    </div>
  );
}

// ── Add supplier modal ────────────────────────────────────────────────────────

function AddModal({ open, onClose, plugins, onAdded }: {
  open: boolean;
  onClose: () => void;
  plugins: AvailablePlugin[];
  onAdded: (s: Supplier) => void;
}) {
  const [key,    setKey]    = useState("");
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [sub,    setSub]    = useState(false);
  const [err,    setErr]    = useState<string | null>(null);

  useEffect(() => {
    if (open && (plugins ?? []).length > 0 && !key) setKey(plugins[0].key);
    if (!open) { setApiKey(""); setSecret(""); setErr(null); }
  }, [open, plugins]); // eslint-disable-line

  // Label the key/secret fields differently for CSV supplier
  const isCsv = key === "CSV";
  const keyLabel    = isCsv ? "Webhook URL (optional)"  : "API Key";
  const secretLabel = isCsv ? "Bearer token (optional)" : "API Secret (optional)";
  const keyHint     = isCsv ? "Leave blank to log orders to logs/manual-orders.jsonl instead." : undefined;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // CSV supplier can be added with no API key (manual mode)
    if (!key || (!isCsv && !apiKey.trim())) {
      setErr(isCsv ? "Choose a supplier." : "Choose a supplier and enter its API key.");
      return;
    }
    setSub(true); setErr(null);
    try {
      const { supplier } = await api.addSupplier({
        supplierKey: key,
        apiKey:      apiKey.trim() || "none",  // backend requires non-empty for CSV manual mode
        apiSecret:   secret.trim() || undefined,
      });
      onAdded(supplier);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Failed.");
    } finally {
      setSub(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Supplier"
      description="Credentials are encrypted at rest.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-widest text-ink-4">
            Supplier
          </label>
          <select value={key} onChange={e => setKey(e.target.value)} className="input">
            {(plugins ?? []).map(p => (
              <option key={p.key} value={p.key}>{p.displayName}</option>
            ))}
          </select>
        </div>

        <Input
          label={keyLabel}
          type={isCsv ? "text" : "password"}
          placeholder={isCsv ? "https://hooks.zapier.com/…" : "Paste your API key"}
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          autoComplete="off"
        />
        {keyHint && <p className="text-xs text-ink-5 -mt-2">{keyHint}</p>}

        <Input
          label={secretLabel}
          type="password"
          placeholder={isCsv ? "Bearer token sent on webhook calls" : "Only if required"}
          value={secret}
          onChange={e => setSecret(e.target.value)}
          autoComplete="off"
        />

        {isCsv && (
          <div
            className="rounded-lg px-3.5 py-3 text-xs text-ink-3"
            style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.15)" }}
          >
            Place your variant catalogue at{" "}
            <code className="font-mono text-cyan">config/csv-supplier-catalogue.json</code>.
            Copy <code className="font-mono text-cyan">csv-supplier-catalogue.example.json</code>{" "}
            as a starting point.
          </div>
        )}

        {err && <p className="text-sm text-danger">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={sub}>
            <KeyRound size={14} />
            {sub ? "Saving..." : "Save & Test"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

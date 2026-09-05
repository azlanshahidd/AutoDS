import { useEffect, useState, FormEvent, ReactNode } from "react";
import {
  ShoppingBag, Zap, Bell, Link2, DollarSign, Save, RefreshCw,
  Eye, EyeOff, AlertTriangle, Server, Lock, Truck, Search,
  Plus, Trash2,
} from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { api, CoreSettings, ServerInfo, ApiError, clearStoredToken } from "../lib/api";
import { cn } from "../lib/cn";

// ── Shared layout helpers ──────────────────────────────────────────────────────

function Sec({ icon: Icon, title, desc, children }: {
  icon: typeof Save; title: string; desc?: string; children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-cyan-bg">
            <Icon size={14} className="text-cyan" />
          </div>
          <div>
            <CardTitle className="text-base font-semibold text-ink">{title}</CardTitle>
            {desc && <p className="mt-0.5 text-xs text-ink-4">{desc}</p>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/** Two-column label + control row */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-ink-3">{label}</label>
      {hint && <p className="text-xs text-ink-5">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }} />;
}

function Secret({ label, value, onChange, placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <Row label={label} hint={hint}>
      <div className="relative">
        <input type={show ? "text" : "password"} value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? "Enter value"}
          autoComplete="off" spellCheck={false} className="input pr-10" />
        <button type="button" onClick={() => setShow(s => !s)} tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-5 hover:text-ink-3">
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Row>
  );
}

function NumInput({ value, onChange, step = 1, min = 0, w = "w-32" }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; w?: string;
}) {
  return (
    <input type="number" step={step} min={min} value={value}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      className={cn("input", w)} />
  );
}

// ── Pricing tiers section ────────────────────────────────────────────────────

/**
 * Inline editor for PRICING_TIERS — a JSON array of cost-bracket rules stored
 * in the config table. Lets operators define different margins per cost range,
 * e.g. 60% for items under $10, 30% for $10–$50, 20% above $50.
 *
 * Priority in the pricing formula: matching tier > per-supplier override > global margin.
 */

interface PricingTier {
  maxCost:       number;
  marginPercent: number;
  flatMarkup:    number;
}

function parseTiers(raw: string): PricingTier[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is PricingTier =>
        t && typeof t === "object" &&
        typeof t.maxCost === "number" &&
        typeof t.marginPercent === "number"
      )
      .map(t => ({ maxCost: t.maxCost, marginPercent: t.marginPercent, flatMarkup: t.flatMarkup ?? 0 }));
  } catch { return []; }
}

function stringifyTiers(tiers: PricingTier[]): string {
  return JSON.stringify(tiers);
}

function PricingTiersSection({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [tiers, setTiers] = useState<PricingTier[]>(() => parseTiers(value));

  // Sync outward whenever tiers change
  useEffect(() => {
    onChange(stringifyTiers(tiers));
  }, [tiers]); // eslint-disable-line

  // Sync inward only on initial load / external reset
  useEffect(() => {
    const parsed = parseTiers(value);
    // Compare JSON to avoid loops
    if (JSON.stringify(parsed) !== JSON.stringify(tiers)) {
      setTiers(parsed);
    }
  }, [value]); // eslint-disable-line

  function addTier() {
    const lastMaxCost = tiers.length > 0 ? tiers[tiers.length - 1].maxCost : 0;
    setTiers(prev => [
      ...prev,
      { maxCost: lastMaxCost + 10, marginPercent: 0.35, flatMarkup: 0 },
    ]);
  }

  function removeTier(idx: number) {
    setTiers(prev => prev.filter((_, i) => i !== idx));
  }

  function updateTier(idx: number, field: keyof PricingTier, raw: string) {
    const num = parseFloat(raw);
    if (isNaN(num)) return;
    setTiers(prev => prev.map((t, i) =>
      i === idx ? { ...t, [field]: field === "marginPercent" ? num / 100 : num } : t
    ));
  }

  // Live example using the first tier (or global margin placeholder)
  const exampleCost = tiers.length > 0 ? Math.min(tiers[0].maxCost * 0.6, tiers[0].maxCost) : 8;
  const exampleTier = tiers.find(t => exampleCost <= t.maxCost);

  return (
    <Sec
      icon={DollarSign}
      title="Pricing Tiers"
      desc="Per-cost-bracket margins. Tier rules take priority over per-supplier overrides and the global margin."
    >
      {tiers.length === 0 ? (
        <p className="text-sm text-ink-4">
          No tiers configured — the global profit margin applies to all items.
          Add a tier to charge different margins based on supplier cost.
        </p>
      ) : (
        <div className="space-y-2">
          {/* Column headers */}
          <div className="grid items-center gap-2 text-xs font-medium text-ink-5"
            style={{ gridTemplateColumns: "1fr 1fr 1fr auto" }}>
            <span>Max total cost ($)</span>
            <span>Margin (%)</span>
            <span>Flat markup ($)</span>
            <span />
          </div>

          {tiers.map((tier, idx) => {
            const prevMax = idx > 0 ? tiers[idx - 1].maxCost : 0;
            return (
              <div key={idx} className="grid items-center gap-2"
                style={{ gridTemplateColumns: "1fr 1fr 1fr auto" }}>
                {/* Max cost */}
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-ink-5">$</span>
                  <input type="number" step="1" min={prevMax + 0.01}
                    value={tier.maxCost}
                    onChange={e => updateTier(idx, "maxCost", e.target.value)}
                    className="input pl-6 text-sm font-mono"
                    title={`Items with cost ≤ $${tier.maxCost} use this margin`} />
                </div>
                {/* Margin % */}
                <div className="relative">
                  <input type="number" step="0.1" min="0" max="500"
                    value={(tier.marginPercent * 100).toFixed(1)}
                    onChange={e => updateTier(idx, "marginPercent", e.target.value)}
                    className="input pr-7 text-sm font-mono" />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-5">%</span>
                </div>
                {/* Flat markup */}
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-ink-5">$</span>
                  <input type="number" step="0.01" min="0"
                    value={tier.flatMarkup}
                    onChange={e => updateTier(idx, "flatMarkup", e.target.value)}
                    className="input pl-6 text-sm font-mono" />
                </div>
                {/* Remove */}
                <button type="button" onClick={() => removeTier(idx)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-danger/70 hover:bg-danger/10 hover:text-danger transition-colors"
                  title="Remove tier">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}

          {/* Fallback note */}
          <p className="text-xs text-ink-5 pt-1">
            Items with cost exceeding the highest tier fall back to the global / per-supplier margin.
          </p>
        </div>
      )}

      <button type="button" onClick={addTier}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-cyan transition-colors hover:bg-cyan/10"
        style={{ border: "1px solid rgba(6,182,212,0.25)" }}>
        <Plus size={12} />Add tier
      </button>

      {/* Live formula preview for the first tier */}
      {tiers.length > 0 && exampleTier && (
        <div className="rounded-lg px-3.5 py-3 text-xs font-mono text-ink-3"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <span className="text-ink-5">Example — cost ${exampleCost.toFixed(2)}: </span>
          price = (${exampleCost.toFixed(2)} + shipping) × {(1 + exampleTier.marginPercent).toFixed(2)}
          {exampleTier.flatMarkup > 0 && ` + $${exampleTier.flatMarkup.toFixed(2)}`}
          {" + eBay fee"}
        </div>
      )}

      <div className="rounded-lg px-3.5 py-3 text-xs text-ink-3"
        style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.15)" }}>
        <strong className="text-ink-3">Tier priority:</strong>{" "}
        matching tier &gt; per-supplier override (Suppliers page) &gt; global margin above.
        Tiers apply to <em>total cost</em> (unit cost + shipping cost).
      </div>
    </Sec>
  );
}

// ── Change password ────────────────────────────────────────────────────────────

function ChangePasswordSection({ showToast }: {
  showToast: (m: string, t?: "success" | "danger" | "info") => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) { setError("New passwords don't match."); return; }
    if (newPassword.trim().length < 8) { setError("New password must be at least 8 characters."); return; }
    setSaving(true);
    try {
      await api.changePassword(currentPassword, newPassword.trim());
      clearStoredToken();
      showToast("Password changed. Signing you out...", "success");
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to change password.");
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={handleChange} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-ink-3">Current password</label>
          <p className="text-xs text-ink-5">Required to confirm identity.</p>
          <div className="relative mt-1">
            <input type={showCur ? "text" : "password"} value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="Current password" autoComplete="current-password" className="input pr-10" />
            <button type="button" onClick={() => setShowCur(s => !s)} tabIndex={-1}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-5 hover:text-ink-3">
              {showCur ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-ink-3">New password</label>
          <p className="text-xs text-ink-5">Min 8 characters. You'll be signed out.</p>
          <div className="relative mt-1">
            <input type={showNew ? "text" : "password"} value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="New password" autoComplete="new-password" className="input pr-10" />
            <button type="button" onClick={() => setShowNew(s => !s)} tabIndex={-1}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-5 hover:text-ink-3">
              {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <input type="password" value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password" autoComplete="new-password" className="input mt-1.5" />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-danger"
          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <AlertTriangle size={13} className="shrink-0" />{error}
        </div>
      )}

      <div className="flex justify-end border-t pt-2" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <Button type="submit" size="sm" disabled={saving || !currentPassword || !newPassword || !confirmPassword}>
          {saving
            ? <><RefreshCw size={12} className="animate-spin" />Changing...</>
            : <><Lock size={12} />Change password</>}
        </Button>
      </div>
    </form>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<CoreSettings | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [draft, setDraft] = useState<CoreSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then(({ settings, serverInfo }) => {
        setSettings(settings); setDraft(settings); setServerInfo(serverInfo);
      })
      .catch(e => showToast(e instanceof ApiError ? e.message : "Failed to load.", "danger"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  function set<K extends keyof CoreSettings>(k: K, v: CoreSettings[K]) {
    setDraft(p => {
      if (!p) return p;
      const n = { ...p, [k]: v };
      setDirty(JSON.stringify(n) !== JSON.stringify(settings));
      return n;
    });
  }

  async function handleSave(e?: FormEvent) {
    e?.preventDefault(); if (!draft) return;
    setSaving(true);
    try {
      // F14: strip empty-string credential fields so they don't overwrite
      // real stored values — the backend's "••••" guard only skips masked
      // placeholders, not empty strings which would clear the credential.
      const MASKED_FIELDS: (keyof CoreSettings)[] = [
        "ebayClientSecret", "ebayRefreshToken",
        "cjApiKey", "cjApiSecret", "alertTelegramBotToken",
      ];
      const safeDraft: Partial<CoreSettings> = { ...draft };
      for (const field of MASKED_FIELDS) {
        const v = safeDraft[field] as string | undefined;
        if (!v || v === "") {
          delete safeDraft[field];
        }
      }
      const { settings: u, serverInfo: si } = await api.patchSettings(safeDraft as CoreSettings);
      setSettings(u); setDraft(u); setServerInfo(si); setDirty(false);
      showToast("Settings saved.", "success");
    } catch (err) { showToast(err instanceof ApiError ? err.message : "Failed.", "danger"); }
    finally { setSaving(false); }
  }

  if (loading || !draft) return (
    <div>
      <PageHeader title="Settings" description="All configuration — no .env editing needed" />
      <div className="flex justify-center py-24">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader title="Settings" description="All configuration — no .env editing needed" />

      <div className="p-6">
        <div className="grid grid-cols-2 gap-5">

          {/* eBay Credentials */}
          <Sec icon={ShoppingBag} title="eBay Credentials" desc="API credentials for the eBay Sell API.">
            <div className="grid grid-cols-1 gap-3">
              <Secret label="Client ID" value={draft.ebayClientId} onChange={v => set("ebayClientId", v)}
                placeholder="App Client ID" hint="From developer.ebay.com under Your Application Keys." />
              <Secret label="Client Secret" value={draft.ebayClientSecret} onChange={v => set("ebayClientSecret", v)}
                placeholder="App Client Secret" />
              <Secret label="Refresh Token" value={draft.ebayRefreshToken} onChange={v => set("ebayRefreshToken", v)}
                placeholder="Long-lived refresh token" hint="Obtained via OAuth flow. See README Phase 3." />
            </div>
            <Divider />
            <Row label="Environment" hint="Use sandbox while testing, production when live.">
              <div className="flex gap-2 mt-1">
                {(["sandbox", "production"] as const).map(env => (
                  <button key={env} type="button" onClick={() => set("ebayEnvironment", env)}
                    className={cn("rounded-lg border px-4 py-1.5 text-sm font-semibold capitalize transition-all",
                      draft.ebayEnvironment === env
                        ? "border-cyan/40 bg-cyan text-white shadow-glow-sm"
                        : "text-ink-4 hover:bg-surface-2 hover:text-ink-3"
                    )} style={draft.ebayEnvironment !== env ? { border: "1px solid rgba(6,182,212,0.2)" } : {}}>
                    {env}
                  </button>
                ))}
              </div>
            </Row>
            <Divider />
            <Row label="Merchant location key"
              hint="Required for publishing listings. Create one with: npm run ebay-create-location -- --key=my-warehouse ...">
              <Input value={draft.ebayMerchantLocation ?? ""} onChange={e => set("ebayMerchantLocation", e.target.value)}
                placeholder="e.g. my-warehouse" className="mt-1 font-mono" />
            </Row>
            <Row label="Marketplace ID"
              hint="eBay marketplace for new listings. EBAY_US for the US marketplace (default).">
              <Input value={draft.ebayMarketplaceId ?? "EBAY_US"} onChange={e => set("ebayMarketplaceId", e.target.value)}
                placeholder="EBAY_US" className="mt-1 font-mono" />
            </Row>
            <Divider />
            <Row label="Auto-list approved items"
              hint={`Off (default): approved Scouted items queue for a final "Publish to eBay" click — you see the preview before anything goes live. On: approved items are immediately published to eBay without a review step. Only turn this on once you trust the AI content quality and pricing.`}>
              <div className="flex gap-2 mt-1">
                {([false, true] as const).map(val => (
                  <button key={String(val)} type="button"
                    onClick={() => set("autoListEnabled", val)}
                    className={cn("rounded-lg border px-4 py-1.5 text-sm font-semibold transition-all",
                      draft.autoListEnabled === val
                        ? val
                          ? "border-warning/40 bg-warning/20 text-warning"
                          : "border-cyan/40 bg-cyan text-white shadow-glow-sm"
                        : "text-ink-4 hover:bg-surface-2 hover:text-ink-3"
                    )}
                    style={(draft.autoListEnabled !== val) ? { border: "1px solid rgba(6,182,212,0.2)" } : {}}>
                    {val ? "On (auto-publish)" : "Off (review first)"}
                  </button>
                ))}
              </div>
              {draft.autoListEnabled && (
                <div className="flex items-start gap-2 mt-2 rounded-lg px-3 py-2"
                  style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)" }}>
                  <AlertTriangle size={12} className="text-warning shrink-0 mt-0.5" />
                  <p className="text-xs text-warning/80">
                    Auto-list is <strong>on</strong> — approved items will publish to eBay automatically.
                    Make sure your merchant location, category mappings, and images are correct before approving items.
                  </p>
                </div>
              )}
            </Row>
          </Sec>

          {/* Supplier */}
          <Sec icon={Truck} title="Supplier" desc="CJ Dropshipping credentials and global supplier switch.">
            <Row label="Active supplier" hint="Which supplier plugin the sync loops use by default.">
              <div className="flex gap-2 mt-1">
                {["CJ", "TEST"].map(s => (
                  <button key={s} type="button" onClick={() => set("activeSupplier", s)}
                    className={cn("rounded-lg border px-4 py-1.5 text-sm font-semibold transition-all",
                      draft.activeSupplier === s
                        ? "border-cyan/40 bg-cyan text-white shadow-glow-sm"
                        : "text-ink-4 hover:bg-surface-2 hover:text-ink-3"
                    )} style={draft.activeSupplier !== s ? { border: "1px solid rgba(6,182,212,0.2)" } : {}}>
                    {s}
                  </button>
                ))}
              </div>
            </Row>
            <Divider />
            <div className="grid grid-cols-1 gap-3">
              <Secret label="CJ API Key" value={draft.cjApiKey} onChange={v => set("cjApiKey", v)}
                placeholder="Paste CJ API key" hint="From CJ Dropshipping: My CJ > Authorization > API." />
              <Secret label="CJ API Secret" value={draft.cjApiSecret} onChange={v => set("cjApiSecret", v)}
                placeholder="CJ API Secret (if required)" />
            </div>
            <Divider />
            <Row label="VeRO blocklist path" hint="Path to the VeRO keyword blocklist file.">
              <Input value={draft.veroBlocklistPath} onChange={e => set("veroBlocklistPath", e.target.value)}
                placeholder="./config/vero-blocklist.txt" className="mt-1" />
            </Row>
          </Sec>

          {/* Pricing */}
          <Sec icon={DollarSign} title="Pricing" desc="Formula: (cost + shipping) × (1 + margin) + eBay fee.">
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              <Row label="Profit margin %" hint="e.g. 0.30 = 30% above cost.">
                <NumInput value={draft.profitMarginPercent} onChange={v => set("profitMarginPercent", v)} step={0.01} />
              </Row>
              <Row label="eBay fee estimate ($)" hint="Added to every listing. Typically $2–$4.">
                <NumInput value={draft.ebayFeeEstimate} onChange={v => set("ebayFeeEstimate", v)} step={0.01} />
              </Row>
            </div>
          </Sec>

          {/* Pricing Tiers */}
          <PricingTiersSection
            value={draft.pricingTiersJson ?? "[]"}
            onChange={v => set("pricingTiersJson", v)}
          />

          {/* Sync & Guardrails */}
          <Sec icon={Zap} title="Sync & Guardrails" desc="How often syncs run and how inventory is protected.">
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              <Row label="Sync interval (minutes)" hint="Minimum 5. Needs restart to apply.">
                <NumInput value={draft.syncIntervalMinutes} onChange={v => set("syncIntervalMinutes", Math.max(5, Math.round(v)))} min={5} />
              </Row>
              <Row label="Safety stock buffer" hint="Stock at or below this is listed as 0 on eBay.">
                <NumInput value={draft.safetyStockBuffer} onChange={v => set("safetyStockBuffer", Math.round(v))} />
              </Row>
            </div>
            <div className="flex items-start gap-2.5 rounded-lg px-3.5 py-3 mt-1"
              style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.18)" }}>
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-cyan" />
              <p className="text-xs text-ink-3">Changing sync interval requires a service restart.</p>
            </div>
          </Sec>

          {/* Scout Pull */}
          <Sec icon={Link2} title="Scout Pull Settings" desc="Controls how Core pulls from connected scrapers.">
            <p className="text-sm text-ink-4">
              Connect scrapers from the <strong className="text-ink-3">Scrapers</strong> page
              using a single connection token — no URL or API key to configure here.
            </p>
            <Divider />
            <Row label="Pull timeout (ms)" hint="Maximum wait time per scheduled pull.">
              <NumInput value={draft.scoutPullTimeoutMs} onChange={v => set("scoutPullTimeoutMs", v)} step={500} min={1000} />
            </Row>
          </Sec>

          {/* Alerts */}
          <Sec icon={Bell} title="Alerts" desc="Get notified when jobs fail repeatedly.">
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              <Row label="Failure threshold" hint="Consecutive failures before an alert fires.">
                <NumInput value={draft.alertFailureThreshold} onChange={v => set("alertFailureThreshold", Math.max(1, Math.round(v)))} min={1} />
              </Row>
              <Row label="Telegram chat ID" hint="Get from api.telegram.org/bot<TOKEN>/getUpdates.">
                <Input value={draft.alertTelegramChatId} onChange={e => set("alertTelegramChatId", e.target.value)}
                  placeholder="-100123456789" className="mt-1" />
              </Row>
              <Row label="Margin floor %" hint="Analytics alerts flag any listing whose gross margin falls below this threshold.">
                <NumInput value={Math.round((draft.marginFloorPercent ?? 0.10) * 100)}
                  onChange={v => set("marginFloorPercent", Math.min(1, Math.max(0, v / 100)))}
                  step={1} min={0} w="w-24" />
              </Row>
            </div>
            <Divider />
            <div className="grid grid-cols-1 gap-3">
              <Row label="Webhook URL" hint="Slack/Discord webhook. Leave blank to disable.">
                <Input value={draft.alertWebhookUrl} onChange={e => set("alertWebhookUrl", e.target.value)}
                  placeholder="https://hooks.slack.com/services/..." className="mt-1" />
              </Row>
              <Secret label="Telegram bot token" value={draft.alertTelegramBotToken} onChange={v => set("alertTelegramBotToken", v)}
                placeholder="123456789:ABCdef..." hint="Create via @BotFather." />
            </div>
          </Sec>

          {/* SEO Metadata */}
          <Sec icon={Search} title="SEO Metadata"
            desc="Auto-generate meta title &amp; description for Google search and social link previews.">
            <Row label="Auto-regenerate on listing changes"
              hint="When on, SEO fields are regenerated automatically whenever a listing's title, category, or price changes materially. Turn off to keep manual control.">
              <div className="flex gap-2 mt-1">
                {([true, false] as const).map(val => (
                  <button key={String(val)} type="button"
                    onClick={() => set("seoAutoRegenerate", val)}
                    className={cn(
                      "rounded-lg border px-4 py-1.5 text-sm font-semibold transition-all",
                      draft.seoAutoRegenerate === val
                        ? "border-cyan/40 bg-cyan text-white shadow-glow-sm"
                        : "text-ink-4 hover:bg-surface-2 hover:text-ink-3"
                    )}
                    style={draft.seoAutoRegenerate !== val
                      ? { border: "1px solid rgba(6,182,212,0.2)" }
                      : {}}>
                    {val ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </Row>
            <Divider />
            <div className="flex items-start gap-2.5 rounded-lg px-3.5 py-3"
              style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.18)" }}>
              <Search size={13} className="mt-0.5 shrink-0 text-cyan" />
              <p className="text-xs text-ink-3">
                Meta title (50–60 chars) and meta description (150–160 chars) are generated
                alongside the eBay listing title in one AI call — no extra API cost.
                Edit them any time from the <strong className="text-ink-3">Scouted Items</strong> page.
              </p>
            </div>
          </Sec>

          {/* Security */}
          <Sec icon={Lock} title="Security" desc="Change your dashboard login password.">
            <ChangePasswordSection showToast={showToast} />
          </Sec>

          {/* Server Info */}
          {serverInfo && (
            <Sec icon={Server} title="Server Info" desc="Read-only. Change in .env or Railway Variables and restart.">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5">
                {[
                  ["Port",            String(serverInfo.port)],
                  ["Host",            serverInfo.host],
                  ["Database file",   serverInfo.databaseFile],
                  ["Log file",        serverInfo.logFile],
                  ["Encryption key",  serverInfo.encryptionKeySet ? "Set (64-char hex)" : "NOT SET"],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <dt className="text-xs font-medium text-ink-4">{label}</dt>
                    <dd className="font-mono text-sm text-ink-3 truncate" title={value}>{value}</dd>
                  </div>
                ))}
              </dl>
            </Sec>
          )}

        </div>
      </div>

      {/* Sticky unsaved bar */}
      {dirty && (
        <div className="sticky bottom-0 z-20 border-t px-6 py-3"
          style={{ background: "#111318", borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-warning">
              <AlertTriangle size={12} />Unsaved changes
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setDraft(settings); setDirty(false); }} disabled={saving}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <><RefreshCw size={12} className="animate-spin" />Saving...</> : <><Save size={12} />Save changes</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

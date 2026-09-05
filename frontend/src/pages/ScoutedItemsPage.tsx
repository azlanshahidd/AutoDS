import { useEffect, useState, useCallback } from "react";
import { Radar, Download, Check, X, ExternalLink, Trash2, Sparkles, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, ScoutedProduct, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

const sCfg: Record<ScoutedProduct["status"], { label: string; tone: StatusTone }> = {
  pending_review: { label: "Pending",   tone: "warning" },
  approved:       { label: "Approved",  tone: "success" },
  discarded:      { label: "Discarded", tone: "neutral" },
};

const fmt = (ts: string) =>
  new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, { month: "short", day: "numeric" });

// ── Char counter helper ───────────────────────────────────────────────────────

function CharCounter({ value, max, warn }: { value: number; max: number; warn: number }) {
  const over = value > max;
  const close = !over && value >= warn;
  return (
    <span className={cn(
      "text-xs tabular-nums",
      over  ? "text-danger font-semibold" :
      close ? "text-warning"             : "text-ink-5"
    )}>
      {value} / {max}
    </span>
  );
}

// ── Google SERP preview mockup ────────────────────────────────────────────────

function GooglePreview({ title, description }: { title: string; description: string }) {
  const displayTitle = title.trim() || "Meta title preview";
  const displayDesc  = description.trim() || "Meta description preview will appear here once generated.";
  return (
    <div
      className="rounded-xl px-4 py-3 space-y-0.5"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
    >
      {/* Breadcrumb / URL line */}
      <div className="flex items-center gap-1.5">
        <div className="h-4 w-4 rounded-sm flex items-center justify-center"
          style={{ background: "rgba(6,182,212,0.15)" }}>
          <Search size={9} className="text-cyan" />
        </div>
        <span className="text-xs" style={{ color: "#8ab4f8" }}>ebay.com › itm › ...</span>
      </div>
      {/* Blue title link */}
      <p
        className="text-sm font-medium leading-snug truncate"
        style={{ color: "#8ab4f8" }}
        title={displayTitle}
      >
        {displayTitle}
      </p>
      {/* Gray description snippet */}
      <p
        className="text-xs leading-relaxed"
        style={{
          color: "#bdc1c6",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        } as React.CSSProperties}
      >
        {displayDesc}
      </p>
    </div>
  );
}

// ── AI Content Modal ──────────────────────────────────────────────────────────

function AiContentModal({
  open,
  onClose,
  item,
  onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  item: ScoutedProduct | null;
  onUpdated: (updated: Partial<ScoutedProduct> & { id: number }) => void;
}) {
  const { showToast } = useToast();

  // Local editable state for SEO fields — initialised from item on open
  const [metaTitle, setMetaTitle]       = useState("");
  const [metaDesc,  setMetaDesc]        = useState("");
  const [savingMeta,  setSavingMeta]    = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Sync local state whenever the item changes (new item opened, or parent refreshes it)
  useEffect(() => {
    if (item) {
      setMetaTitle(item.meta_title ?? "");
      setMetaDesc(item.meta_description ?? "");
    }
  }, [item?.id, item?.meta_title, item?.meta_description]); // eslint-disable-line

  const handleRegenerate = useCallback(async () => {
    if (!item) return;
    setRegenerating(true);
    try {
      const result = await api.generateAiListing(item.id);
      setMetaTitle(result.metaTitle);
      setMetaDesc(result.metaDescription);
      onUpdated({
        id:                    item.id,
        ai_title:              result.aiTitle,
        ai_description:        result.aiDescription,
        meta_title:            result.metaTitle,
        meta_description:      result.metaDescription,
        meta_generated_at:     result.metaGeneratedAt,
        meta_generation_source: result.metaGenerationSource,
      });
      showToast("AI content regenerated.", "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Regeneration failed.", "danger");
    } finally { setRegenerating(false); }
  }, [item, onUpdated, showToast]);

  const handleSaveMeta = useCallback(async () => {
    if (!item) return;
    if (metaTitle.length > 60) { showToast("Meta title must be 60 chars or fewer.", "danger"); return; }
    if (metaDesc.length > 160)  { showToast("Meta description must be 160 chars or fewer.", "danger"); return; }
    setSavingMeta(true);
    try {
      await api.saveSeoFields(item.id, {
        metaTitle: metaTitle.trim(),
        metaDescription: metaDesc.trim(),
      });
      onUpdated({ id: item.id, meta_title: metaTitle.trim(), meta_description: metaDesc.trim() });
      showToast("SEO fields saved.", "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Save failed.", "danger");
    } finally { setSavingMeta(false); }
  }, [item, metaTitle, metaDesc, onUpdated, showToast]);

  if (!item) return null;

  const metaTitleDirty = metaTitle !== (item.meta_title ?? "");
  const metaDescDirty  = metaDesc  !== (item.meta_description ?? "");
  const seoFieldsDirty = metaTitleDirty || metaDescDirty;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI-generated listing content"
      description={item.title}
      className="max-w-2xl"
    >
      <div className="space-y-5">

        {/* ── eBay listing fields (read-only) ──────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-4">eBay Listing</span>
            <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.07)" }} />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-ink-3">Listing Title</label>
              <CharCounter value={item.ai_title?.length ?? 0} max={80} warn={70} />
            </div>
            <div
              className="rounded-xl px-4 py-3 font-mono text-sm text-ink"
              style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)" }}
            >
              {item.ai_title ?? <span className="text-ink-5 italic">Not generated yet</span>}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-3">HTML Description</label>
            <div
              className="max-h-40 overflow-y-auto rounded-xl px-4 py-3 font-mono text-xs text-ink-3"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <pre className="whitespace-pre-wrap break-words">
                {item.ai_description ?? <span className="text-ink-5 italic">Not generated yet</span>}
              </pre>
            </div>
          </div>
        </div>

        {/* ── SEO Meta fields (editable) ────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Search size={11} className="text-cyan shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-4">SEO / Search &amp; Social</span>
            <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.07)" }} />
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={regenerating}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-cyan transition-colors hover:bg-cyan/10 disabled:opacity-50"
              style={{ border: "1px solid rgba(6,182,212,0.25)" }}
            >
              {regenerating
                ? <><RefreshCw size={10} className="animate-spin" />Regenerating...</>
                : <><Sparkles size={10} />Regenerate</>}
            </button>
          </div>

          {/* Meta title */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-ink-3">
                Meta Title
                <span className="ml-1.5 text-ink-5 font-normal">— for Google &amp; link previews</span>
              </label>
              <CharCounter value={metaTitle.length} max={60} warn={50} />
            </div>
            <input
              type="text"
              value={metaTitle}
              onChange={e => setMetaTitle(e.target.value)}
              maxLength={60}
              placeholder="e.g. Blue Widget Pro - Lightweight, Waterproof"
              className="input text-sm"
              spellCheck
            />
            {metaTitle.length > 0 && metaTitle.length < 50 && (
              <p className="text-xs text-ink-5">Aim for 50–60 chars for best Google display.</p>
            )}
          </div>

          {/* Meta description */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-ink-3">
                Meta Description
                <span className="ml-1.5 text-ink-5 font-normal">— plain text, no HTML</span>
              </label>
              <CharCounter value={metaDesc.length} max={160} warn={140} />
            </div>
            <textarea
              value={metaDesc}
              onChange={e => setMetaDesc(e.target.value)}
              maxLength={160}
              rows={3}
              placeholder="e.g. Shop the Blue Widget Pro — featherlight and fully waterproof. Fast dispatch, great prices. See it on eBay today."
              className="input resize-none text-sm leading-relaxed"
              spellCheck
            />
            {metaDesc.length > 0 && metaDesc.length < 140 && (
              <p className="text-xs text-ink-5">Aim for 140–160 chars for best click-through.</p>
            )}
          </div>

          {/* Google SERP preview */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-3">Google result preview</label>
            <GooglePreview title={metaTitle} description={metaDesc} />
          </div>

          {/* Generation source + timestamp */}
          {item.meta_generated_at && (
            <p className="text-xs text-ink-5">
              Generated {new Date(item.meta_generated_at.replace(" ", "T") + "Z").toLocaleString(undefined, {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
              })}
              {item.meta_generation_source && (
                <span className="ml-1.5 font-mono"
                  style={{ color: "rgba(6,182,212,0.7)" }}>
                  via {item.meta_generation_source}
                </span>
              )}
            </p>
          )}
        </div>

        {/* ── Footer actions ────────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-t pt-4"
          style={{ borderColor: "rgba(255,255,255,0.07)" }}>
          <span className="text-xs text-ink-5">
            {seoFieldsDirty
              ? <span className="text-warning font-medium">Unsaved SEO changes</span>
              : "All SEO fields saved"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
            {seoFieldsDirty && (
              <Button size="sm" onClick={handleSaveMeta} disabled={savingMeta}>
                {savingMeta
                  ? <><RefreshCw size={12} className="animate-spin" />Saving...</>
                  : "Save SEO"}
              </Button>
            )}
          </div>
        </div>

      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ScoutedItemsPage() {
  const { showToast } = useToast();
  const [items, setItems] = useState<ScoutedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [generatingIds, setGeneratingIds] = useState<Set<number>>(new Set());
  const [previewItem, setPreviewItem] = useState<ScoutedProduct | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  async function load() {
    try {
      const { scoutedProducts } = await api.listScouted();
      setItems(scoutedProducts ?? []);
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line

  async function handlePull() {
    setPulling(true);
    try {
      const s = await api.pullScoutedNow();
      // F12: backend returns 502 when Scout is unreachable — request() throws
      // ApiError, handled by the catch below. If we reach here, pull succeeded.
      showToast(
        s.result === "success"
          ? `Pulled ${s.fetched} items — ${s.stored} new.`
          : `Scout error: ${s.errorMessage ?? "Unknown error"}`,
        s.result === "success" ? "success" : "danger"
      );
      load();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to pull from Scout.";
      showToast(`Scout pull failed: ${msg}`, "danger");
    } finally { setPulling(false); }
  }

  async function handleApprove(id: number) {
    setActingId(id);
    try {
      await api.approveScouted(id);
      setItems(p => p.map(i => i.id === id ? { ...i, status: "approved" as const } : i));
      showToast("Approved.", "success");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setActingId(null); }
  }

  async function handleDiscard(id: number) {
    setActingId(id);
    try {
      await api.discardScouted(id);
      setItems(p => p.map(i => i.id === id ? { ...i, status: "discarded" as const } : i));
      showToast("Discarded.", "info");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setActingId(null); }
  }

  async function handleDelete(id: number) {
    setActingId(id);
    try {
      await api.deleteScouted(id);
      setItems(p => p.filter(i => i.id !== id));
      showToast("Deleted.", "info");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setActingId(null); }
  }

  async function handleClearAll() {
    if (!window.confirm(`Delete all ${items.length} scouted items? This cannot be undone.`)) return;
    setClearing(true);
    try {
      const { deleted } = await api.clearScouted();
      setItems([]);
      showToast(`Cleared ${deleted} item${deleted !== 1 ? "s" : ""}.`, "info");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setClearing(false); }
  }

  async function handleGenerateAi(id: number) {
    setGeneratingIds(prev => new Set(prev).add(id));
    try {
      const result = await api.generateAiListing(id);
      setItems(prev => prev.map(i =>
        i.id === id
          ? {
              ...i,
              ai_title:               result.aiTitle,
              ai_description:         result.aiDescription,
              meta_title:             result.metaTitle,
              meta_description:       result.metaDescription,
              meta_generated_at:      result.metaGeneratedAt,
              meta_generation_source: result.metaGenerationSource,
            }
          : i
      ));
      // Keep the preview modal in sync if it's open for this item
      setPreviewItem(prev =>
        prev?.id === id
          ? {
              ...prev,
              ai_title:               result.aiTitle,
              ai_description:         result.aiDescription,
              meta_title:             result.metaTitle,
              meta_description:       result.metaDescription,
              meta_generated_at:      result.metaGeneratedAt,
              meta_generation_source: result.metaGenerationSource,
            }
          : prev
      );
      showToast("AI content generated.", "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Generation failed.", "danger");
    } finally {
      setGeneratingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  /** Called by AiContentModal when the operator saves/regenerates SEO fields. */
  function handleItemUpdated(updated: Partial<ScoutedProduct> & { id: number }) {
    setItems(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i));
    setPreviewItem(prev => prev?.id === updated.id ? { ...prev, ...updated } : prev);
  }

  function handlePreview(item: ScoutedProduct) {
    setPreviewItem(item);
    setPreviewOpen(true);
  }

  const pending = items.filter(i => i.status === "pending_review").length;

  return (
    <div>
      <PageHeader
        title="Scouted Items"
        description="Trending candidates from Scout awaiting review"
        action={
          <div className="flex items-center gap-2">
            {pending > 0 && (
              <span className="rounded-full px-2.5 py-1 text-xs font-semibold text-warning"
                style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.2)" }}>
                {pending} pending
              </span>
            )}
            {items.length > 0 && (
              <Button variant="danger" size="sm" onClick={handleClearAll} disabled={clearing}>
                <Trash2 size={13} />
                {clearing ? "Clearing..." : "Clear all"}
              </Button>
            )}
            <Button onClick={handlePull} disabled={pulling}>
              <Download size={14} className={pulling ? "animate-spin" : ""} />
              {pulling ? "Pulling..." : "Pull now"}
            </Button>
          </div>
        }
      />
      <div className="p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={Radar} title="No scouted items yet"
              description="Click Pull now to fetch trending candidates from Scout."
              action={<Button onClick={handlePull} disabled={pulling}><Download size={14} />Pull now</Button>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Price</th>
                    <th>Supplier match</th>
                    <th>Est. margin</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const st = sCfg[item.status];
                    const isPending = item.status === "pending_review";
                    const isGenerating = generatingIds.has(item.id);
                    return (
                      <tr key={item.id} className={cn(!isPending && "opacity-50")}>
                        <td>
                          <div className="flex items-start gap-2">
                            <div>
                              <p className="font-semibold text-ink leading-snug">{item.title}</p>
                              {item.trend_signal && (
                                <span className="mt-1 inline-block rounded-md px-2 py-0.5 text-xs font-medium text-warning"
                                  style={{ background: "rgba(245,158,11,0.12)" }}>
                                  {item.trend_signal}
                                </span>
                              )}
                              {/* AI title / SEO ready badge */}
                              {item.ai_title && (
                                <button
                                  type="button"
                                  onClick={() => handlePreview(item)}
                                  className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-cyan hover:underline"
                                  style={{ background: "rgba(6,182,212,0.08)" }}
                                  title="Click to preview AI content"
                                >
                                  <Sparkles size={10} />
                                  {item.meta_title ? "SEO ready" : "AI title ready"}
                                </button>
                              )}
                            </div>
                            {item.source_url && /^https?:\/\//i.test(item.source_url) && (
                              <a href={item.source_url} target="_blank" rel="noopener noreferrer"
                                className="mt-0.5 shrink-0 text-ink-5 hover:text-cyan">
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="font-mono font-semibold text-ink">
                          {item.scraped_price !== null ? `$${item.scraped_price.toFixed(2)}` : "—"}
                        </td>
                        <td className="text-ink-4">
                          {item.matched_supplier || <span className="text-ink-5">No match</span>}
                        </td>
                        <td>
                          {item.estimated_margin !== null ? (
                            <span className={cn("font-mono font-semibold",
                              item.estimated_margin >= 0 ? "text-success" : "text-danger")}>
                              {item.estimated_margin >= 0 ? "+" : ""}${item.estimated_margin.toFixed(2)}
                            </span>
                          ) : <span className="text-ink-5">—</span>}
                        </td>
                        <td><StatusBadge label={st.label} tone={st.tone} /></td>
                        <td className="text-xs text-ink-5">{fmt(item.scouted_at || item.created_at)}</td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            {/* Generate with AI */}
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleGenerateAi(item.id)}
                              disabled={isGenerating}
                              title="Generate eBay listing with AI"
                            >
                              {isGenerating
                                ? <RefreshCw size={13} className="animate-spin" />
                                : <Sparkles size={13} className="text-cyan" />}
                              {isGenerating ? "Generating..." : "AI"}
                            </Button>
                            <Button variant="secondary" size="sm"
                              onClick={() => handleApprove(item.id)}
                              disabled={!isPending || actingId === item.id}>
                              <Check size={13} />Approve
                            </Button>
                            <Button variant="ghost" size="sm"
                              onClick={() => handleDiscard(item.id)}
                              disabled={!isPending || actingId === item.id}>
                              <X size={13} className="text-danger" />
                            </Button>
                            <Button variant="ghost" size="sm"
                              onClick={() => handleDelete(item.id)}
                              disabled={actingId === item.id}
                              title="Delete row">
                              <Trash2 size={13} className="text-danger" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <AiContentModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        item={previewItem}
        onUpdated={handleItemUpdated}
      />
    </div>
  );
}


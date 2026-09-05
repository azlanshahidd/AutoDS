import { useEffect, useState, useCallback } from "react";
import {
  Radar, Download, Check, X, ExternalLink, Trash2, Sparkles, RefreshCw,
  Search, Eye, Send, AlertTriangle, ImageIcon, Tag, Plus,
} from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, ScoutedProduct, ListingPreview, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

// ── Status config maps ────────────────────────────────────────────────────────

const sCfg: Record<ScoutedProduct["status"], { label: string; tone: StatusTone }> = {
  pending_review: { label: "Pending",   tone: "warning" },
  approved:       { label: "Approved",  tone: "success" },
  discarded:      { label: "Discarded", tone: "neutral" },
};

const lCfg: Record<ScoutedProduct["listing_status"], { label: string; tone: StatusTone }> = {
  none:         { label: "Not listed",   tone: "neutral"  },
  queued:       { label: "Ready",        tone: "info"     },
  vero_blocked: { label: "VeRO blocked", tone: "danger"   },
  quality_fail: { label: "Quality fail", tone: "danger"   },
  publishing:   { label: "Publishing…",  tone: "warning"  },
  published:    { label: "Published",    tone: "success"  },
  failed:       { label: "Failed",       tone: "danger"   },
};

const fmt = (ts: string) =>
  new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, { month: "short", day: "numeric" });

// ── Char counter ──────────────────────────────────────────────────────────────

function CharCounter({ value, max, warn }: { value: number; max: number; warn: number }) {
  const over = value > max;
  const close = !over && value >= warn;
  return (
    <span className={cn("text-xs tabular-nums",
      over ? "text-danger font-semibold" : close ? "text-warning" : "text-ink-5")}>
      {value} / {max}
    </span>
  );
}

// ── Google SERP preview ───────────────────────────────────────────────────────

function GooglePreview({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl px-4 py-3 space-y-0.5"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div className="flex items-center gap-1.5">
        <div className="h-4 w-4 rounded-sm flex items-center justify-center"
          style={{ background: "rgba(6,182,212,0.15)" }}>
          <Search size={9} className="text-cyan" />
        </div>
        <span className="text-xs" style={{ color: "#8ab4f8" }}>ebay.com › itm › ...</span>
      </div>
      <p className="text-sm font-medium leading-snug truncate" style={{ color: "#8ab4f8" }}
        title={title || "Meta title preview"}>
        {title || "Meta title preview"}
      </p>
      <p className="text-xs leading-relaxed" style={{
        color: "#bdc1c6",
        display: "-webkit-box", WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical", overflow: "hidden",
      } as React.CSSProperties}>
        {description || "Meta description preview will appear here once generated."}
      </p>
    </div>
  );
}

// ── Listing Preview Modal ─────────────────────────────────────────────────────

function ListingPreviewModal({
  open, onClose, item, onPublished, onItemUpdated,
}: {
  open: boolean;
  onClose: () => void;
  item: ScoutedProduct | null;
  onPublished: (id: number, result: { listingId?: string; price?: number }) => void;
  onItemUpdated: (updated: Partial<ScoutedProduct> & { id: number }) => void;
}) {
  const { showToast } = useToast();
  const [preview, setPreview]         = useState<ListingPreview | null>(null);
  const [loadingPreview, setLoading]  = useState(false);
  const [publishing, setPublishing]   = useState(false);
  // Editable fields the user can fix before publishing
  const [categoryId,  setCategoryId]  = useState("");
  const [imageInput,  setImageInput]  = useState("");
  const [imageUrls,   setImageUrls]   = useState<string[]>([]);
  const [savingCat,   setSavingCat]   = useState(false);
  const [savingImgs,  setSavingImgs]  = useState(false);

  // Load preview whenever the modal opens for a different item
  useEffect(() => {
    if (!open || !item) return;
    setCategoryId(item.ebay_category_id ?? "");
    try {
      setImageUrls(item.image_urls ? JSON.parse(item.image_urls) : []);
    } catch { setImageUrls([]); }
    setImageInput("");
    setPreview(null);
    setLoading(true);
    api.previewListing(item.id)
      .then(setPreview)
      .catch(e => showToast(e instanceof ApiError ? e.message : "Failed to load preview.", "danger"))
      .finally(() => setLoading(false));
  }, [open, item?.id]); // eslint-disable-line

  async function handleSaveCategory() {
    if (!item || !categoryId.trim()) return;
    setSavingCat(true);
    try {
      await api.setCategoryId(item.id, categoryId.trim());
      onItemUpdated({ id: item.id, ebay_category_id: categoryId.trim() });
      // Refresh preview
      const p = await api.previewListing(item.id);
      setPreview(p);
      showToast("Category saved.", "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    } finally { setSavingCat(false); }
  }

  function addImage() {
    const url = imageInput.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      showToast("Enter a valid http/https image URL.", "danger"); return;
    }
    if (imageUrls.includes(url)) { showToast("URL already added.", "info"); return; }
    if (imageUrls.length >= 24)  { showToast("eBay allows max 24 images.", "danger"); return; }
    setImageUrls(prev => [...prev, url]);
    setImageInput("");
  }

  function removeImage(url: string) {
    setImageUrls(prev => prev.filter(u => u !== url));
  }

  async function handleSaveImages() {
    if (!item) return;
    setSavingImgs(true);
    try {
      await api.setImageUrls(item.id, imageUrls);
      onItemUpdated({ id: item.id, image_urls: JSON.stringify(imageUrls) });
      const p = await api.previewListing(item.id);
      setPreview(p);
      showToast(`${imageUrls.length} image(s) saved.`, "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    } finally { setSavingImgs(false); }
  }

  async function handlePublish() {
    if (!item) return;
    setPublishing(true);
    try {
      const result = await api.publishListing(item.id, {
        categoryId: categoryId.trim() || undefined,
        imageUrls:  imageUrls.length > 0 ? imageUrls : undefined,
      });
      onPublished(item.id, result);
      showToast(
        result.listingId
          ? `Published! Listing ID: ${result.listingId}${result.price ? ` · $${result.price.toFixed(2)}` : ""}`
          : "Published to eBay.",
        "success"
      );
      onClose();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Publish failed.", "danger");
    } finally { setPublishing(false); }
  }

  if (!item) return null;
  const canPublish = preview?.canPublish ?? false;
  const issues     = preview?.qualityIssues ?? [];

  return (
    <Modal open={open} onClose={onClose} title="Preview listing"
      description={item.ai_title ?? item.title} className="max-w-2xl">
      <div className="space-y-5">

        {/* Loading spinner */}
        {loadingPreview && (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
          </div>
        )}

        {/* Preview data */}
        {preview && !loadingPreview && (
          <>
            {/* Quality issues / VeRO */}
            {issues.length > 0 && (
              <div className="rounded-xl px-4 py-3 space-y-1.5"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)" }}>
                <div className="flex items-center gap-2">
                  <AlertTriangle size={13} className="text-danger shrink-0" />
                  <span className="text-xs font-semibold text-danger">
                    {canPublish ? "Warnings" : `${issues.length} issue${issues.length !== 1 ? "s" : ""} blocking publish`}
                  </span>
                </div>
                <ul className="space-y-0.5 pl-5 list-disc">
                  {issues.map((iss, i) => (
                    <li key={i} className="text-xs text-danger/80">{iss}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Listing summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl px-4 py-3 space-y-0.5"
                style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)" }}>
                <p className="text-xs text-ink-4 uppercase tracking-wider">List price</p>
                <p className="text-xl font-bold text-cyan font-mono">${preview.price.toFixed(2)}</p>
                <p className="text-xs text-ink-5">
                  Cost ${preview.supplierCost.toFixed(2)} · Fee ${preview.ebayFeeEstimate.toFixed(2)} · Margin {Math.round(preview.profitMargin * 100)}%
                </p>
              </div>
              <div className="rounded-xl px-4 py-3 space-y-0.5"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <p className="text-xs text-ink-4 uppercase tracking-wider">eBay title</p>
                <p className="text-sm font-semibold text-ink leading-snug line-clamp-2">{preview.ebayTitle}</p>
                <CharCounter value={preview.ebayTitle.length} max={80} warn={70} />
              </div>
            </div>

            {/* Images section */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ImageIcon size={12} className="text-cyan shrink-0" />
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-4">
                  Images ({imageUrls.length}/24)
                </span>
                <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.07)" }} />
                {imageUrls.length > 0 && (
                  <button type="button" onClick={handleSaveImages} disabled={savingImgs}
                    className="text-xs text-cyan hover:underline disabled:opacity-50">
                    {savingImgs ? "Saving…" : "Save images"}
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <input type="url" value={imageInput} onChange={e => setImageInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addImage()}
                  placeholder="https://example.com/product.jpg"
                  className="input flex-1 text-sm" />
                <Button variant="secondary" size="sm" onClick={addImage}>
                  <Plus size={12} />Add
                </Button>
              </div>
              {imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {imageUrls.map(url => (
                    <div key={url} className="relative group">
                      <img src={url} alt="" className="h-14 w-14 rounded-lg object-cover border"
                        style={{ borderColor: "rgba(255,255,255,0.12)" }}
                        onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      <button type="button" onClick={() => removeImage(url)}
                        className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-danger text-white
                          text-xs font-bold hidden group-hover:flex items-center justify-center leading-none">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Category section */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Tag size={12} className="text-cyan shrink-0" />
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-4">eBay Category ID</span>
                <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.07)" }} />
              </div>
              <div className="flex gap-2">
                <input type="text" value={categoryId}
                  onChange={e => setCategoryId(e.target.value)}
                  placeholder="e.g. 15032 — find via eBay Taxonomy API"
                  className="input flex-1 text-sm font-mono" />
                <Button variant="secondary" size="sm" onClick={handleSaveCategory}
                  disabled={!categoryId.trim() || savingCat}>
                  {savingCat ? <RefreshCw size={12} className="animate-spin" /> : "Save"}
                </Button>
              </div>
              <p className="text-xs text-ink-5">
                Find the ID by browsing a similar eBay listing and noting the category number, or use the{" "}
                <a href="https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html"
                  target="_blank" rel="noopener noreferrer"
                  className="text-cyan hover:underline">eBay Taxonomy API</a>.
              </p>
            </div>

            {/* Description preview */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-4">Description</span>
              <div className="max-h-32 overflow-y-auto rounded-xl px-4 py-3 font-mono text-xs text-ink-3"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <pre className="whitespace-pre-wrap break-words">{preview.description}</pre>
              </div>
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t pt-4"
          style={{ borderColor: "rgba(255,255,255,0.07)" }}>
          <div className="text-xs text-ink-5">
            {preview && !canPublish
              ? <span className="text-danger font-medium">Fix issues above before publishing</span>
              : preview && canPublish
              ? <span className="text-success font-medium">Ready to publish</span>
              : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handlePublish}
              disabled={publishing || !canPublish || loadingPreview}
              title={!canPublish ? "Fix quality issues before publishing" : "Publish this listing to eBay"}>
              {publishing
                ? <><RefreshCw size={12} className="animate-spin" />Publishing…</>
                : <><Send size={12} />Publish to eBay</>}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── AI Content Modal ──────────────────────────────────────────────────────────

function AiContentModal({
  open, onClose, item, onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  item: ScoutedProduct | null;
  onUpdated: (updated: Partial<ScoutedProduct> & { id: number }) => void;
}) {
  const { showToast } = useToast();
  const [metaTitle,    setMetaTitle]    = useState("");
  const [metaDesc,     setMetaDesc]     = useState("");
  const [savingMeta,   setSavingMeta]   = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (item) { setMetaTitle(item.meta_title ?? ""); setMetaDesc(item.meta_description ?? ""); }
  }, [item?.id, item?.meta_title, item?.meta_description]); // eslint-disable-line

  const handleRegenerate = useCallback(async () => {
    if (!item) return;
    setRegenerating(true);
    try {
      const r = await api.generateAiListing(item.id);
      setMetaTitle(r.metaTitle); setMetaDesc(r.metaDescription);
      onUpdated({ id: item.id, ai_title: r.aiTitle, ai_description: r.aiDescription,
        meta_title: r.metaTitle, meta_description: r.metaDescription,
        meta_generated_at: r.metaGeneratedAt, meta_generation_source: r.metaGenerationSource });
      showToast("AI content regenerated.", "success");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Regeneration failed.", "danger"); }
    finally { setRegenerating(false); }
  }, [item, onUpdated, showToast]);

  const handleSaveMeta = useCallback(async () => {
    if (!item) return;
    if (metaTitle.length > 60)  { showToast("Meta title must be 60 chars or fewer.", "danger"); return; }
    if (metaDesc.length > 160)  { showToast("Meta description must be 160 chars or fewer.", "danger"); return; }
    setSavingMeta(true);
    try {
      await api.saveSeoFields(item.id, { metaTitle: metaTitle.trim(), metaDescription: metaDesc.trim() });
      onUpdated({ id: item.id, meta_title: metaTitle.trim(), meta_description: metaDesc.trim() });
      showToast("SEO fields saved.", "success");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Save failed.", "danger"); }
    finally { setSavingMeta(false); }
  }, [item, metaTitle, metaDesc, onUpdated, showToast]);

  if (!item) return null;
  const seoFieldsDirty = metaTitle !== (item.meta_title ?? "") || metaDesc !== (item.meta_description ?? "");

  return (
    <Modal open={open} onClose={onClose} title="AI-generated listing content"
      description={item.title} className="max-w-2xl">
      <div className="space-y-5">
        {/* eBay listing fields (read-only) */}
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
            <div className="rounded-xl px-4 py-3 font-mono text-sm text-ink"
              style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)" }}>
              {item.ai_title ?? <span className="text-ink-5 italic">Not generated yet</span>}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-3">HTML Description</label>
            <div className="max-h-40 overflow-y-auto rounded-xl px-4 py-3 font-mono text-xs text-ink-3"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
              <pre className="whitespace-pre-wrap break-words">
                {item.ai_description ?? <span className="text-ink-5 italic">Not generated yet</span>}
              </pre>
            </div>
          </div>
        </div>
        {/* SEO meta fields (editable) */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Search size={11} className="text-cyan shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-4">SEO / Search &amp; Social</span>
            <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.07)" }} />
            <button type="button" onClick={handleRegenerate} disabled={regenerating}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-cyan
                transition-colors hover:bg-cyan/10 disabled:opacity-50"
              style={{ border: "1px solid rgba(6,182,212,0.25)" }}>
              {regenerating
                ? <><RefreshCw size={10} className="animate-spin" />Regenerating...</>
                : <><Sparkles size={10} />Regenerate</>}
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-ink-3">
                Meta Title <span className="ml-1.5 text-ink-5 font-normal">— for Google &amp; link previews</span>
              </label>
              <CharCounter value={metaTitle.length} max={60} warn={50} />
            </div>
            <input type="text" value={metaTitle} onChange={e => setMetaTitle(e.target.value)}
              maxLength={60} placeholder="e.g. Blue Widget Pro - Lightweight, Waterproof"
              className="input text-sm" spellCheck />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-ink-3">
                Meta Description <span className="ml-1.5 text-ink-5 font-normal">— plain text, no HTML</span>
              </label>
              <CharCounter value={metaDesc.length} max={160} warn={140} />
            </div>
            <textarea value={metaDesc} onChange={e => setMetaDesc(e.target.value)}
              maxLength={160} rows={3}
              placeholder="e.g. Shop the Blue Widget Pro — featherlight and fully waterproof."
              className="input resize-none text-sm leading-relaxed" spellCheck />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-3">Google result preview</label>
            <GooglePreview title={metaTitle} description={metaDesc} />
          </div>
          {item.meta_generated_at && (
            <p className="text-xs text-ink-5">
              Generated {new Date(item.meta_generated_at.replace(" ", "T") + "Z").toLocaleString(undefined,
                { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              {item.meta_generation_source && (
                <span className="ml-1.5 font-mono" style={{ color: "rgba(6,182,212,0.7)" }}>
                  via {item.meta_generation_source}
                </span>
              )}
            </p>
          )}
        </div>
        {/* Footer */}
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
                {savingMeta ? <><RefreshCw size={12} className="animate-spin" />Saving...</> : "Save SEO"}
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
  const [items,          setItems]          = useState<ScoutedProduct[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [pulling,        setPulling]        = useState(false);
  const [actingId,       setActingId]       = useState<number | null>(null);
  const [clearing,       setClearing]       = useState(false);
  const [regenAll,       setRegenAll]       = useState(false);
  const [generatingIds,  setGeneratingIds]  = useState<Set<number>>(new Set());
  const [publishingIds,  setPublishingIds]  = useState<Set<number>>(new Set());
  // AI content modal
  const [aiModalItem,    setAiModalItem]    = useState<ScoutedProduct | null>(null);
  const [aiModalOpen,    setAiModalOpen]    = useState(false);
  // Listing preview modal
  const [previewItem,    setPreviewItem]    = useState<ScoutedProduct | null>(null);
  const [previewOpen,    setPreviewOpen]    = useState(false);

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
      showToast(
        s.result === "success"
          ? `Pulled ${s.fetched} items — ${s.stored} new.`
          : `Scout error: ${s.errorMessage ?? "Unknown error"}`,
        s.result === "success" ? "success" : "danger"
      );
      load();
    } catch (e) {
      showToast(`Scout pull failed: ${e instanceof ApiError ? e.message : "Failed."}`, "danger");
    } finally { setPulling(false); }
  }

  async function handleApprove(id: number) {
    setActingId(id);
    try {
      const result = await api.approveScouted(id);
      setItems(p => p.map(i => i.id === id
        ? { ...i, status: "approved" as const,
            listing_status: (result as { autoListTriggered?: boolean }).autoListTriggered
              ? "queued" as const : i.listing_status }
        : i));
      showToast(
        (result as { autoListTriggered?: boolean }).autoListTriggered
          ? "Approved — listing pipeline started."
          : "Approved.",
        "success"
      );
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

  async function handleRegenAllSeo() {
    setRegenAll(true);
    try {
      const r = await api.regenerateSeoAll({ missingOnly: true });
      showToast(r.message, "success");
      // Poll will pick up the updated SEO fields once processing completes
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "SEO regeneration failed.", "danger");
    } finally { setRegenAll(false); }
  }

  async function handleGenerateAi(id: number) {
    setGeneratingIds(prev => new Set(prev).add(id));
    try {
      const r = await api.generateAiListing(id);
      const patch = {
        ai_title: r.aiTitle, ai_description: r.aiDescription,
        meta_title: r.metaTitle, meta_description: r.metaDescription,
        meta_generated_at: r.metaGeneratedAt, meta_generation_source: r.metaGenerationSource,
      };
      setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
      setAiModalItem(prev => prev?.id === id ? { ...prev, ...patch } : prev);
      showToast("AI content generated.", "success");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Generation failed.", "danger");
    } finally {
      setGeneratingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  // Quick publish from table row (skips the preview modal, uses stored data)
  async function handleQuickPublish(id: number) {
    setPublishingIds(prev => new Set(prev).add(id));
    try {
      const result = await api.publishListing(id);
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, listing_status: "published" as const, ebay_listing_id: result.listingId ?? null }
        : i));
      showToast(result.listingId ? `Published! ID: ${result.listingId}` : "Published.", "success");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Publish failed.";
      setItems(prev => prev.map(i => i.id === id
        ? { ...i, listing_status: "failed" as const, listing_error: msg }
        : i));
      showToast(msg, "danger");
    } finally {
      setPublishingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  function handleItemUpdated(updated: Partial<ScoutedProduct> & { id: number }) {
    setItems(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i));
    setAiModalItem(prev => prev?.id === updated.id ? { ...prev, ...updated } : prev);
    setPreviewItem(prev => prev?.id === updated.id ? { ...prev, ...updated } : prev);
  }

  function handlePublished(id: number, result: { listingId?: string; price?: number }) {
    setItems(prev => prev.map(i => i.id === id
      ? { ...i, listing_status: "published" as const, ebay_listing_id: result.listingId ?? null }
      : i));
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
              <>
                <Button variant="ghost" size="sm" onClick={handleRegenAllSeo} disabled={regenAll}
                  title="Regenerate SEO meta fields for all items missing them">
                  <RefreshCw size={13} className={cn(regenAll && "animate-spin")} />
                  {regenAll ? "Regenerating…" : "Regen SEO"}
                </Button>
                <Button variant="danger" size="sm" onClick={handleClearAll} disabled={clearing}>
                  <Trash2 size={13} />{clearing ? "Clearing..." : "Clear all"}
                </Button>
              </>
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
                    <th>Listing</th>
                    <th>Date</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const st        = sCfg[item.status];
                    const ls        = lCfg[item.listing_status ?? "none"];
                    const isPending = item.status === "pending_review";
                    const isApproved = item.status === "approved";
                    const isPublished = item.listing_status === "published";
                    const isQueued    = item.listing_status === "queued";
                    const isGenerating = generatingIds.has(item.id);
                    const isPublishing = publishingIds.has(item.id);

                    return (
                      <tr key={item.id} className={cn(!isPending && !isApproved && "opacity-50")}>
                        {/* Item name + badges */}
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
                              {item.ai_title && (
                                <button type="button"
                                  onClick={() => { setAiModalItem(item); setAiModalOpen(true); }}
                                  className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-cyan hover:underline"
                                  style={{ background: "rgba(6,182,212,0.08)" }}
                                  title="View AI-generated content">
                                  <Sparkles size={10} />
                                  {item.meta_title ? "SEO ready" : "AI ready"}
                                </button>
                              )}
                              {/* Listing error tooltip */}
                              {item.listing_error && (
                                <span className="mt-1 inline-flex items-center gap-1 text-xs text-danger"
                                  title={item.listing_error}>
                                  <AlertTriangle size={10} />
                                  {item.listing_error.slice(0, 60)}{item.listing_error.length > 60 ? "…" : ""}
                                </span>
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

                        {/* Price */}
                        <td className="font-mono font-semibold text-ink">
                          {item.scraped_price !== null ? `$${item.scraped_price.toFixed(2)}` : "—"}
                        </td>

                        {/* Supplier match */}
                        <td className="text-ink-4">
                          {item.matched_supplier || <span className="text-ink-5">No match</span>}
                        </td>

                        {/* Est. margin */}
                        <td>
                          {item.estimated_margin !== null ? (
                            <span className={cn("font-mono font-semibold",
                              item.estimated_margin >= 0 ? "text-success" : "text-danger")}>
                              {item.estimated_margin >= 0 ? "+" : ""}${item.estimated_margin.toFixed(2)}
                            </span>
                          ) : <span className="text-ink-5">—</span>}
                        </td>

                        {/* Approval status */}
                        <td><StatusBadge label={st.label} tone={st.tone} /></td>

                        {/* Listing pipeline status */}
                        <td>
                          {isPublished && item.ebay_listing_id ? (
                            <a href={`https://www.ebay.com/itm/${item.ebay_listing_id}`}
                              target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-success hover:underline">
                              <ExternalLink size={10} />Live
                            </a>
                          ) : (
                            <StatusBadge label={ls.label} tone={ls.tone} />
                          )}
                        </td>

                        {/* Date */}
                        <td className="text-xs text-ink-5">{fmt(item.scouted_at || item.created_at)}</td>

                        {/* Actions */}
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            {/* Generate with AI */}
                            <Button variant="ghost" size="sm"
                              onClick={() => handleGenerateAi(item.id)} disabled={isGenerating}
                              title="Generate eBay listing with AI">
                              {isGenerating
                                ? <RefreshCw size={13} className="animate-spin" />
                                : <Sparkles size={13} className="text-cyan" />}
                              {isGenerating ? "Generating..." : "AI"}
                            </Button>

                            {/* Preview + Publish (approved items only) */}
                            {isApproved && !isPublished && (
                              <>
                                <Button variant="ghost" size="sm"
                                  onClick={() => { setPreviewItem(item); setPreviewOpen(true); }}
                                  title="Preview listing before publishing">
                                  <Eye size={13} className="text-ink-3" />Preview
                                </Button>
                                {isQueued && (
                                  <Button variant="secondary" size="sm"
                                    onClick={() => handleQuickPublish(item.id)}
                                    disabled={isPublishing}
                                    title="Publish to eBay now">
                                    {isPublishing
                                      ? <RefreshCw size={13} className="animate-spin" />
                                      : <Send size={13} className="text-cyan" />}
                                    {isPublishing ? "Publishing…" : "Publish"}
                                  </Button>
                                )}
                              </>
                            )}

                            {/* Approve / Discard */}
                            {isPending && (
                              <>
                                <Button variant="secondary" size="sm"
                                  onClick={() => handleApprove(item.id)}
                                  disabled={actingId === item.id}>
                                  <Check size={13} />Approve
                                </Button>
                                <Button variant="ghost" size="sm"
                                  onClick={() => handleDiscard(item.id)}
                                  disabled={actingId === item.id}>
                                  <X size={13} className="text-danger" />
                                </Button>
                              </>
                            )}

                            {/* Delete */}
                            <Button variant="ghost" size="sm"
                              onClick={() => handleDelete(item.id)} disabled={actingId === item.id}
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

      {/* AI content modal */}
      <AiContentModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        item={aiModalItem}
        onUpdated={handleItemUpdated}
      />

      {/* Listing preview + publish modal */}
      <ListingPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        item={previewItem}
        onPublished={handlePublished}
        onItemUpdated={handleItemUpdated}
      />
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  Sparkles, Plus, Trash2, RefreshCw, Eye, EyeOff,
  CheckCircle2, XCircle, HelpCircle, Power, PowerOff, Pencil,
} from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, AiProvider, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

// ── Types ─────────────────────────────────────────────────────────────────────

type ProviderType = AiProvider["providerType"];

// ── Status display config ─────────────────────────────────────────────────────

const statusCfg: Record<
  AiProvider["status"],
  { label: string; tone: StatusTone; Icon: typeof CheckCircle2 }
> = {
  connected: { label: "Connected", tone: "success", Icon: CheckCircle2 },
  failed:    { label: "Failed",    tone: "danger",  Icon: XCircle },
  untested:  { label: "Untested",  tone: "neutral", Icon: HelpCircle },
};

const typeBadge: Record<ProviderType, { label: string; tone: StatusTone }> = {
  openai_compatible: { label: "OpenAI-compat", tone: "cyan"    },
  gemini:            { label: "Gemini",         tone: "purple"  },
  cohere:            { label: "Cohere",         tone: "warning" },
};

// ── Provider type defaults (pre-fills modal) ──────────────────────────────────

const typeDefaults: Record<ProviderType, { baseUrl: string; model: string }> = {
  openai_compatible: { baseUrl: "https://api.openai.com/v1",               model: "gpt-4o-mini"          },
  gemini:            { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.6-flash"     },
  cohere:            { baseUrl: "https://api.cohere.com/v1",                model: "command-r"            },
};

// ── Common providers reference ────────────────────────────────────────────────

const commonProviders = [
  { name: "OpenAI",      type: "OpenAI-compat",  baseUrl: "https://api.openai.com/v1",                model: "gpt-4o-mini",       keyUrl: "https://platform.openai.com/api-keys" },
  { name: "Groq",        type: "OpenAI-compat",  baseUrl: "https://api.groq.com/openai/v1",           model: "llama3-8b-8192",    keyUrl: "https://console.groq.com/keys" },
  { name: "OpenRouter",  type: "OpenAI-compat",  baseUrl: "https://openrouter.ai/api/v1",             model: "openai/gpt-4o-mini",keyUrl: "https://openrouter.ai/keys" },
  { name: "Google AI",   type: "Gemini",         baseUrl: "https://generativelanguage.googleapis.com",model: "gemini-3.6-flash",  keyUrl: "https://aistudio.google.com/app/apikey" },
  { name: "Mistral",     type: "OpenAI-compat",  baseUrl: "https://api.mistral.ai/v1",                model: "mistral-small",     keyUrl: "https://console.mistral.ai/api-keys" },
  { name: "Together AI", type: "OpenAI-compat",  baseUrl: "https://api.together.xyz/v1",              model: "meta-llama/Llama-3-8b-chat-hf", keyUrl: "https://api.together.ai/settings/api-keys" },
  { name: "Cohere",      type: "Cohere",         baseUrl: "https://api.cohere.com/v1",                model: "command-r",         keyUrl: "https://dashboard.cohere.com/api-keys" },
  { name: "Ollama",      type: "OpenAI-compat",  baseUrl: "http://localhost:11434/v1",                model: "llama3",            keyUrl: "— (local, no key needed)" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(ts: string) {
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────

interface ModalState {
  mode: "add" | "edit";
  provider?: AiProvider;
}

function AddEditModal({
  open,
  state,
  onClose,
  onSaved,
}: {
  open: boolean;
  state: ModalState;
  onClose: () => void;
  onSaved: (p: AiProvider) => void;
}) {
  const { showToast } = useToast();

  const [name,         setName]         = useState("");
  const [providerType, setProviderType] = useState<ProviderType>("openai_compatible");
  const [baseUrl,      setBaseUrl]      = useState("");
  const [model,        setModel]        = useState("");
  const [apiKey,       setApiKey]       = useState("");
  const [showKey,      setShowKey]      = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  // Populate when modal opens
  useEffect(() => {
    if (!open) return;
    setShowKey(false);
    setError(null);
    setLoading(false);
    if (state.mode === "edit" && state.provider) {
      const p = state.provider;
      setName(p.name);
      setProviderType(p.providerType);
      setBaseUrl(p.baseUrl);
      setModel(p.model);
      setApiKey(""); // never pre-fill key; empty = keep existing
    } else {
      setName("");
      setProviderType("openai_compatible");
      setBaseUrl(typeDefaults.openai_compatible.baseUrl);
      setModel(typeDefaults.openai_compatible.model);
      setApiKey("");
    }
  }, [open]); // eslint-disable-line

  function handleTypeChange(t: ProviderType) {
    setProviderType(t);
    setBaseUrl(typeDefaults[t].baseUrl);
    setModel(typeDefaults[t].model);
  }

  async function handleSave() {
    if (!name.trim())    { setError("Name is required.");      return; }
    if (!baseUrl.trim()) { setError("Base URL is required.");  return; }
    if (!model.trim())   { setError("Model is required.");     return; }
    if (state.mode === "add" && !apiKey.trim()) {
      setError("API Key is required."); return;
    }

    setLoading(true);
    setError(null);
    try {
      let provider: AiProvider;
      let reason: string | undefined;
      if (state.mode === "add") {
        const r = await api.addAiProvider({
          name: name.trim(),
          providerType,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
        });
        provider = r.provider;
        reason = r.reason;
      } else {
        const patch: Parameters<typeof api.updateAiProvider>[1] = {
          name: name.trim(),
          providerType,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
        };
        if (apiKey.trim()) patch.apiKey = apiKey.trim();
        const r = await api.updateAiProvider(state.provider!.id, patch);
        provider = r.provider;
        reason = r.reason;
      }

      const statusMsg =
        provider.status === "connected"
          ? "Connected successfully."
          : provider.status === "failed"
            ? reason
              ? `Saved — connection test failed: ${reason}`
              : "Saved — connection test failed. Check your credentials."
            : "Saved.";
      showToast(statusMsg, provider.status === "connected" ? "success" : "danger");
      onSaved(provider);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setLoading(false);
    }
  }

  const typeOptions: { value: ProviderType; label: string }[] = [
    { value: "openai_compatible", label: "OpenAI-compatible" },
    { value: "gemini",            label: "Google Gemini"     },
    { value: "cohere",            label: "Cohere"            },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={state.mode === "add" ? "Add AI provider" : "Edit AI provider"}
      description="Connects to the provider API to generate eBay listing titles and descriptions."
      className="max-w-lg"
    >
      <div className="space-y-4">

        {/* Provider type selector */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">Provider type</label>
          <div className="flex gap-2">
            {typeOptions.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleTypeChange(opt.value)}
                className={cn(
                  "flex-1 rounded-xl border px-3 py-2 text-xs font-medium transition-all duration-150",
                  providerType === opt.value
                    ? "border-cyan bg-cyan/10 text-cyan"
                    : "border-[rgba(255,255,255,0.08)] bg-surface-2 text-ink-3 hover:bg-surface-3 hover:text-ink-2"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Groq – production"
            className="input"
          />
        </div>

        {/* Base URL */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">
            Base URL
            <span className="ml-1 text-ink-5">(editable — override for Groq, OpenRouter, etc.)</span>
          </label>
          <input
            type="text"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="input font-mono text-sm"
          />
        </div>

        {/* Model */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">Model</label>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            className="input font-mono text-sm"
          />
        </div>

        {/* API Key */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">
            API Key
            {state.mode === "edit" && (
              <span className="ml-1 text-ink-5">(leave blank to keep existing)</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={state.mode === "edit" ? "••••••••  (unchanged)" : "sk-…"}
              className="input pr-10"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
              tabIndex={-1}
              aria-label={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-danger"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
            <XCircle size={14} className="shrink-0" />{error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading
              ? <><RefreshCw size={13} className="animate-spin" />Saving...</>
              : <><Sparkles size={13} />{state.mode === "add" ? "Add & test" : "Save & test"}</>}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AiProvidersPage() {
  const { showToast } = useToast();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalState, setModalState] = useState<ModalState>({ mode: "add" });

  useEffect(() => {
    api.listAiProviders()
      .then(({ providers }) => setProviders(providers ?? []))
      .catch(e => showToast(e instanceof ApiError ? e.message : "Failed to load.", "danger"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  function openAdd() {
    setModalState({ mode: "add" });
    setModalOpen(true);
  }

  function openEdit(p: AiProvider) {
    setModalState({ mode: "edit", provider: p });
    setModalOpen(true);
  }

  function onSaved(p: AiProvider) {
    setProviders(prev => {
      const idx = prev.findIndex(x => x.id === p.id);
      return idx >= 0 ? prev.map(x => x.id === p.id ? p : x) : [...prev, p];
    });
  }

  async function handleTest(p: AiProvider) {
    setTestingId(p.id);
    try {
      const { provider, reason } = await api.testAiProvider(p.id);
      setProviders(prev => prev.map(x => x.id === p.id ? provider : x));
      if (provider.status === "connected") {
        showToast(`${p.name} — connected.`, "success");
      } else {
        showToast(
          reason ? `${p.name} — test failed: ${reason}` : `${p.name} — test failed.`,
          "danger"
        );
      }
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Test failed.", "danger");
    } finally {
      setTestingId(null);
    }
  }

  async function handleToggle(p: AiProvider) {
    setTogglingId(p.id);
    try {
      const { provider } = await api.updateAiProvider(p.id, { enabled: !p.enabled });
      setProviders(prev => prev.map(x => x.id === p.id ? provider : x));
      showToast(provider.enabled ? `${p.name} enabled.` : `${p.name} disabled.`, "info");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(p: AiProvider) {
    if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteAiProvider(p.id);
      setProviders(prev => prev.filter(x => x.id !== p.id));
      showToast(`${p.name} deleted.`, "info");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    }
  }

  return (
    <div>
      <PageHeader
        title="AI Providers"
        description="Configure AI providers to generate SEO-optimised eBay listings"
        action={
          <Button onClick={openAdd}>
            <Plus size={14} />Add provider
          </Button>
        }
      />

      <div className="space-y-4 p-6">

        {/* Explainer banner */}
        <div
          className="flex items-start gap-3 rounded-lg px-4 py-3"
          style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.18)" }}
        >
          <Sparkles size={14} className="mt-0.5 shrink-0 text-cyan" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-cyan">First enabled provider is used for generation</p>
            <p className="text-xs leading-relaxed text-cyan/70">
              When you click <strong>Generate with AI</strong> on a scouted item, Core uses the
              first <strong>enabled</strong> provider (ordered by creation date) to produce an
              SEO-optimised eBay title and HTML description. Add multiple providers and toggle them
              to control which one is active.
            </p>
          </div>
        </div>

        {/* Providers table */}
        <Card>
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
            </div>
          ) : providers.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2">
                <Sparkles size={22} className="text-ink-5" />
              </div>
              <div>
                <p className="font-semibold text-ink">No AI providers yet</p>
                <p className="mt-1 text-sm text-ink-4">
                  Add a provider to generate SEO-optimised eBay titles and descriptions automatically.
                </p>
              </div>
              <Button onClick={openAdd}>
                <Plus size={14} />Add provider
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Base URL</th>
                    <th>Model</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th>Last tested</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map(p => {
                    const sc = statusCfg[p.status];
                    const tb = typeBadge[p.providerType];
                    return (
                      <tr key={p.id} className={cn(!p.enabled && "opacity-50")}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <div className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
                              p.status === "connected" ? "bg-success-bg"
                                : p.status === "failed" ? "bg-danger-bg" : "bg-surface-3"
                            )}>
                              <sc.Icon size={14} className={cn(
                                p.status === "connected" ? "text-success"
                                  : p.status === "failed" ? "text-danger" : "text-ink-5"
                              )} />
                            </div>
                            <span className="font-semibold text-ink">{p.name}</span>
                          </div>
                        </td>
                        <td>
                          <StatusBadge label={tb.label} tone={tb.tone} />
                        </td>
                        <td>
                          <span
                            className="block max-w-[200px] truncate font-mono text-xs text-ink-4"
                            title={p.baseUrl}
                          >
                            {p.baseUrl}
                          </span>
                        </td>
                        <td>
                          <span className="font-mono text-xs text-ink-3">{p.model}</span>
                        </td>
                        <td>
                          <span className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            p.hasKey
                              ? "bg-success-bg text-success"
                              : "bg-surface-2 text-ink-5"
                          )}>
                            {p.hasKey ? "Set" : "None"}
                          </span>
                        </td>
                        <td>
                          <StatusBadge
                            label={sc.label}
                            tone={sc.tone}
                            pulse={p.status === "connected"}
                          />
                        </td>
                        <td className="text-xs text-ink-4">
                          {p.lastTestedAt ? fmt(p.lastTestedAt) : "Never"}
                        </td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleTest(p)}
                              disabled={testingId === p.id}
                              title="Test connection"
                            >
                              <RefreshCw size={13} className={testingId === p.id ? "animate-spin" : ""} />
                              Test
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => openEdit(p)}
                              title="Edit"
                            >
                              <Pencil size={13} />
                              Edit
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleToggle(p)}
                              disabled={togglingId === p.id}
                              title={p.enabled ? "Disable" : "Enable"}
                            >
                              {p.enabled
                                ? <Power size={13} className="text-cyan" />
                                : <PowerOff size={13} className="text-ink-5" />}
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleDelete(p)}
                              title="Delete"
                            >
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

        {/* Common providers reference */}
        <Card>
          <CardHeader>
            <CardTitle>Common providers reference</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-ink-4">
              Popular providers compatible with Core — all have free tiers or trials.
              Click the "Get key" link to open the provider's API key page.
            </p>
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Type</th>
                    <th>Base URL</th>
                    <th>Suggested model</th>
                    <th>Get a key</th>
                  </tr>
                </thead>
                <tbody>
                  {commonProviders.map(cp => (
                    <tr key={cp.name}>
                      <td className="font-semibold text-ink">{cp.name}</td>
                      <td className="text-xs text-ink-4">{cp.type}</td>
                      <td>
                        <span className="font-mono text-xs text-ink-4 block max-w-[220px] truncate" title={cp.baseUrl}>
                          {cp.baseUrl}
                        </span>
                      </td>
                      <td className="font-mono text-xs text-ink-3">{cp.model}</td>
                      <td>
                        {cp.keyUrl.startsWith("http") ? (
                          <a
                            href={cp.keyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-cyan hover:underline"
                          >
                            Get key ↗
                          </a>
                        ) : (
                          <span className="text-xs text-ink-5">{cp.keyUrl}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

      </div>

      <AddEditModal
        open={modalOpen}
        state={modalState}
        onClose={() => setModalOpen(false)}
        onSaved={onSaved}
      />
    </div>
  );
}

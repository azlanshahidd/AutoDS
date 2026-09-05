import { FormEvent, useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Button } from "./ui/Button";
import { api, setStoredToken, getStoredToken } from "../lib/api";

export const hasStoredToken = () => Boolean(getStoredToken());

export function AuthGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password.trim()) { setError("Enter your dashboard password."); return; }
    setLoading(true); setError(null);
    try {
      const { token } = await api.login(password.trim());
      setStoredToken(token);
      onAuthenticated();
    } catch {
      setError("Incorrect password. Try again.");
    } finally { setLoading(false); }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-base px-4">
      {/* Background glow blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/4 top-1/4 h-96 w-96 rounded-full blur-[120px]"
          style={{ background: "rgba(79,110,247,0.08)" }} />
        <div className="absolute right-1/4 bottom-1/4 h-64 w-64 rounded-full blur-[100px]"
          style={{ background: "rgba(0,200,255,0.05)" }} />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="card p-7">
          {/* Logo */}
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl"
              style={{ background: "linear-gradient(135deg,#3a56e0,#5b6ef5)", boxShadow: "0 0 24px rgba(79,110,247,0.5)" }}>
              <svg width="24" height="24" viewBox="0 0 18 18" fill="none">
                <path d="M3 9h12M9 3v12" stroke="#0B1120" strokeWidth="2.5" strokeLinecap="round"/>
                <circle cx="9" cy="9" r="3" fill="#0B1120"/>
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-ink">CoreDash</h1>
              <p className="mt-0.5 text-xs text-ink-4">Enter your dashboard password</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-ink-4">
                Password
              </label>
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoFocus
                  autoComplete="current-password"
                  className="input pr-10"
                />
                <button type="button" onClick={() => setShow(s => !s)} tabIndex={-1}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-5 hover:text-ink-3">
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {error && (
                <p className="mt-2 text-sm text-danger">{error}</p>
              )}
            </div>

            <Button type="submit" className="w-full" size="md" disabled={loading}>
              <LogIn size={15} />
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-ink-5">
            Session is kept in your browser tab only.
            Change your password in Settings.
          </p>
        </div>
      </div>
    </div>
  );
}

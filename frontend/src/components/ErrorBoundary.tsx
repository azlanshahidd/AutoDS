import React, { Component, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface S { error: Error | null; }
export class ErrorBoundary extends Component<{ children: ReactNode }, S> {
  state: S = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(e: Error, i: React.ErrorInfo) { console.error("[ErrorBoundary]", e, i); }
  render() {
    if (this.state.error) return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-base p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-danger-bg">
          <AlertTriangle size={28} className="text-danger" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-ink">Something went wrong</h2>
          <p className="mt-1 text-sm text-ink-4">An unexpected error occurred.</p>
        </div>
        <div className="max-w-lg rounded-xl bg-surface-2 px-5 py-4 text-left font-mono text-xs text-danger" style={{border:"1px solid rgba(239,68,68,0.2)"}}>
          {this.state.error.message}
        </div>
        <button onClick={() => this.setState({ error: null })}
          className="flex items-center gap-2 rounded-xl bg-cyan px-5 py-2.5 text-sm font-semibold text-white shadow-glow-sm hover:bg-cyan-l">
          <RefreshCw size={14} />Try again
        </button>
      </div>
    );
    return this.props.children;
  }
}

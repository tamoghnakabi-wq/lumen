import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Without this, one thrown render error replaces the entire app with a blank
 * page and no way back. Catch it, show something honest, and offer a reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[lumen] render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Something broke on this screen</h1>
        <p className="max-w-sm text-sm leading-relaxed text-muted">
          That is our fault, not yours. Reloading usually clears it — your posts and messages are safe.
        </p>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              this.setState({ error: null });
              window.location.assign("/");
            }}
          >
            Back to feed
          </button>
        </div>
      </div>
    );
  }
}

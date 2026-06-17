import { Component, type ReactNode } from "react";

/**
 * Catches render-time throws from its children (e.g. the markdown renderer on some
 * pathological reply) and shows a plain-text fallback instead of letting the error
 * unmount the whole React tree — which, for this always-on-top window, means a dead
 * unclickable window. A render bug in one chat message must never brick the app.
 *
 * Re-key the boundary (e.g. by message content) so new content remounts it and
 * re-attempts a normal render after a transient failure.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.warn("ErrorBoundary contained a render error", err);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

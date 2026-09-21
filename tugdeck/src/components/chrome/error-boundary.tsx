/**
 * ErrorBoundary — catches React render errors and displays them with TugBanner.
 *
 * Without this, a single component error silently kills the entire React tree,
 * leaving the user with a blank screen and no indication of what went wrong.
 *
 * Uses TugBanner (error variant) for consistent token-driven styling. The class
 * component must remain — React requires class components for getDerivedStateFromError.
 */

import React from "react";
import { TugBanner } from "@/components/tugways/tug-banner";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { reportClientFault } from "@/lib/dom-forensics";

interface ErrorBoundaryState {
  error: Error | null;
  /** React's owner walk for the failing fiber, kept for the banner. */
  componentStack: string | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    // The component stack is the ONLY thing that names the failing surface.
    // A minified `error.stack` is thirty frames of React's own deletion walk
    // and says nothing about WHICH subtree died — the 2026-09-21
    // `NotFoundError` from `removeChild` took a source read to place because
    // this was going to `console.error` alone, where nothing captures it.
    // Setting it here is a second render on an already-failed tree, which is
    // the one place that cost does not matter.
    this.setState({ componentStack: info.componentStack ?? null });
    // And to disk, because the user's next act is Reload. The DOM-level
    // forensics for this same fault (parent, child, where the child
    // actually went) were already posted from `dom-forensics`; this record
    // is what ties them to a React subtree.
    reportClientFault({
      kind: "react-error-boundary",
      message: error.message,
      stack: error.stack ?? "",
      componentStack: info.componentStack ?? "",
      at: new Date().toISOString(),
      breadcrumbs: (
        window as unknown as { __domForensics?: { breadcrumbs: () => unknown[] } }
      ).__domForensics?.breadcrumbs() ?? [],
    });
  }

  render() {
    if (this.state.error) {
      return (
        <TugBanner
          variant="error"
          visible={true}
          tone="danger"
          message={this.state.error.message}
          footer={
            <TugPushButton
              emphasis="outlined"
              role="danger"
              onClick={() => window.location.reload()}
            >
              Reload
            </TugPushButton>
          }
        >
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {this.state.error.stack}
            {this.state.componentStack === null
              ? null
              : `\n\nComponent stack:${this.state.componentStack}`}
          </pre>
        </TugBanner>
      );
    }
    return this.props.children;
  }
}

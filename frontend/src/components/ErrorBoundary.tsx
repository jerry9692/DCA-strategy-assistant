import React, { Component, type ErrorInfo, type ReactNode } from "react";

function ErrorFallback({ onReset }: { onReset: () => void }) {
  return (
    <main className="app-shell">
      <section className="fatal-error">
        <p className="eyebrow">DCA Strategy Assistant v0.3</p>
        <h1>界面渲染遇到问题</h1>
        <p className="muted">当前数据没有丢失，可以先恢复界面再重试。</p>
        <button type="button" onClick={onReset}>
          恢复界面
        </button>
      </section>
    </main>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI render failed", error, info);
  }

  reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onReset={this.reset} />;
    }
    return this.props.children;
  }
}

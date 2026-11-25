import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="error-box" role="alert">
      {this.props.label}{" "}
      <button className="button subtle compact" onClick={() => this.setState({ failed: false })}>Повторить</button>
    </div>;
  }
}

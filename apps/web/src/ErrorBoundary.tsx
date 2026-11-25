import { Component, lazy, type ComponentType, type ReactNode } from "react";

class ChunkLoadError extends Error {}

export function lazyView<T extends ComponentType<any>>(load: () => Promise<{default: T}>) {
  return lazy(async () => {
    try {
      return await load();
    } catch (cause) {
      // React.lazy remembers rejected imports. Reloading gets the current HTML
      // and asset URLs, including after a deployment removes the old chunk.
      throw new ChunkLoadError("Не удалось загрузить часть приложения.", {cause});
    }
  });
}

type Failure = "chunk" | "render" | null;
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { failure: Failure }> {
  state: { failure: Failure } = { failure: null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: error instanceof ChunkLoadError ? "chunk" : "render" };
  }
  render() {
    const {failure} = this.state;
    if (!failure) return this.props.children;
    return <div className="error-box" role="alert">
      {this.props.label}{" "}
      {failure === "chunk"
        ? <button className="button subtle compact" onClick={() => window.location.reload()}>Перезагрузить страницу</button>
        : <button className="button subtle compact" onClick={() => this.setState({ failure: null })}>Повторить</button>}
    </div>;
  }
}

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>Let’s reconnect.</h1>
        <p>
          The interface encountered a problem. No new actions will be approved.
        </p>
        <button onClick={() => location.reload()}>Reload Nerve</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);

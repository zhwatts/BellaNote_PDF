import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { RootErrorBoundary } from "./RootErrorBoundary.tsx";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

/* Reduce light/dark flash before React hydrates theme */
try {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("bella-note-theme") === "dark" ? "dark" : "light",
  );
} catch {
  document.documentElement.setAttribute("data-theme", "light");
}

const el = document.getElementById("root");
if (!el) {
  throw new Error("Missing #root element");
}

createRoot(el).render(
  <RootErrorBoundary>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </RootErrorBoundary>,
);

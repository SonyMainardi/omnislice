import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { installGlobalLogging } from "./app/log";
import "./styles.css";

installGlobalLogging(import.meta.env.VITE_APP_VERSION ?? "dev");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

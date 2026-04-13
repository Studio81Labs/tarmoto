import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PocSensor from "./PocSensor";
import "./global.css";
import "./poc.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PocSensor />
  </StrictMode>,
);

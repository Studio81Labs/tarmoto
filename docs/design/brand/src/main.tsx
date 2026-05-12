import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import BrandIdentity from "./BrandIdentity";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandIdentity />
  </StrictMode>,
);

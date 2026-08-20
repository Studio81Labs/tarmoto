import { Suspense } from "react";
import { PlanStep } from "./PlanStep";

/**
 * `/welcome/plan` — the skippable plan selection step a rider sees straight
 * after registration (#1173). `useSearchParams()` inside `PlanStep` needs a
 * Suspense boundary or the statically-prerendered build bails out with the
 * missing-Suspense CSR error, same as the billing settings page.
 */
export default function WelcomePlanPage() {
  return (
    <Suspense fallback={null}>
      <PlanStep />
    </Suspense>
  );
}

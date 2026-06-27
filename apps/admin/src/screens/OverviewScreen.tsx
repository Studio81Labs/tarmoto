import { PageHeader, MetricTile, Alert } from "@tarmoto/ui";
import { useAdminMetrics } from "../data/useAdminMetrics.js";

export function OverviewScreen() {
  const { data, isPending, error } = useAdminMetrics();

  return (
    <section>
      <PageHeader title="Overview" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load metrics."
          className="mb-4"
        />
      ) : null}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricTile
          label="Users"
          value={isPending ? "—" : (data?.users ?? 0)}
        />
        <MetricTile
          label="Active rides"
          value={isPending ? "—" : (data?.activeRides ?? 0)}
        />
        <MetricTile
          label="Feature flags"
          value={isPending ? "—" : (data?.featureFlags ?? 0)}
        />
        <MetricTile
          label="Closures"
          value={isPending ? "—" : (data?.closures ?? 0)}
        />
      </div>
    </section>
  );
}

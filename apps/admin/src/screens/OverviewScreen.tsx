import { MetricTile, Alert } from "@tarmoto/ui";
import { PageHeader } from "../components/PageHeader.js";
import { useAdminMetrics } from "../data/useAdminMetrics.js";

const adminIntegerFormatter = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 0,
});

function formatAdminInteger(value: number): string {
  return adminIntegerFormatter.format(value);
}

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
          value={isPending ? "—" : formatAdminInteger(data?.users ?? 0)}
        />
        <MetricTile
          label="Active rides"
          value={isPending ? "—" : formatAdminInteger(data?.activeRides ?? 0)}
        />
        <MetricTile
          label="Global flag overrides"
          value={isPending ? "—" : formatAdminInteger(data?.featureFlags ?? 0)}
        />
        <MetricTile
          label="Closures"
          value={isPending ? "—" : formatAdminInteger(data?.closures ?? 0)}
        />
        <MetricTile
          label="Hidden content"
          value={isPending ? "—" : formatAdminInteger(data?.hiddenContent ?? 0)}
        />
      </div>
    </section>
  );
}

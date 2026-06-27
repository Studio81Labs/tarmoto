import { useAdminMetrics } from "../data/useAdminMetrics.js";

interface MetricCardProps {
  label: string;
  value: number | string;
}

function MetricCard({ label, value }: MetricCardProps) {
  return (
    <div className="metric-card">
      <span className="metric-card__value">{value}</span>
      <span className="metric-card__label">{label}</span>
    </div>
  );
}

export function OverviewScreen() {
  const { data, isPending, error } = useAdminMetrics();

  return (
    <section>
      <h2>Overview</h2>
      {error ? <p className="error">Failed to load metrics.</p> : null}
      <div className="metric-grid">
        <MetricCard
          label="Users"
          value={isPending ? "—" : (data?.users ?? 0)}
        />
        <MetricCard
          label="Active rides"
          value={isPending ? "—" : (data?.activeRides ?? 0)}
        />
        <MetricCard
          label="Feature flags"
          value={isPending ? "—" : (data?.featureFlags ?? 0)}
        />
        <MetricCard
          label="Closures"
          value={isPending ? "—" : (data?.closures ?? 0)}
        />
      </div>
    </section>
  );
}

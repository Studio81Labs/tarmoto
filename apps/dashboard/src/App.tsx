import { Routes, Route, Navigate } from 'react-router-dom';
import { DashboardLayout } from '@/layouts/DashboardLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { useAuthStore } from '@/stores/authStore';

// Auth pages
import { LoginPage } from '@/pages/auth/LoginPage';
import { RegisterPage } from '@/pages/auth/RegisterPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';

// Dashboard pages
import { HomePage } from '@/pages/HomePage';
import { TripPlannerPage } from '@/pages/trips/TripPlannerPage';
import { TripListPage } from '@/pages/trips/TripListPage';
import { TripDetailPage } from '@/pages/trips/TripDetailPage';
import { ExplorerPage } from '@/pages/explorer/ExplorerPage';
import { RideListPage } from '@/pages/rides/RideListPage';
import { RideDetailPage } from '@/pages/rides/RideDetailPage';
import { StatsPage } from '@/pages/rides/StatsPage';
import { RoadMapPage } from '@/pages/rides/RoadMapPage';
import { CommunityFeedPage } from '@/pages/community/CommunityFeedPage';
import { ProfilePage } from '@/pages/community/ProfilePage';
import { RouteCollectionsPage } from '@/pages/community/RouteCollectionsPage';
import { AccountPage } from '@/pages/settings/AccountPage';
import { SubscriptionPage } from '@/pages/settings/SubscriptionPage';
import { PrivacyPage } from '@/pages/settings/PrivacyPage';
import { BikesPage } from '@/pages/settings/BikesPage';
import { NotificationsPage } from '@/pages/settings/NotificationsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      {/* ── Auth routes ── */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Route>

      {/* ── Dashboard routes (protected) ── */}
      <Route
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        {/* Home */}
        <Route path="/" element={<HomePage />} />

        {/* Trip planner */}
        <Route path="/trips" element={<TripListPage />} />
        <Route path="/trips/new" element={<TripPlannerPage />} />
        <Route path="/trips/:tripId" element={<TripDetailPage />} />
        <Route path="/trips/:tripId/edit" element={<TripPlannerPage />} />

        {/* Road quality explorer */}
        <Route path="/explore" element={<ExplorerPage />} />

        {/* Ride history & analytics */}
        <Route path="/rides" element={<RideListPage />} />
        <Route path="/rides/:rideId" element={<RideDetailPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/road-map" element={<RoadMapPage />} />

        {/* Community */}
        <Route path="/community" element={<CommunityFeedPage />} />
        <Route path="/community/collections" element={<RouteCollectionsPage />} />
        <Route path="/riders/:riderId" element={<ProfilePage />} />

        {/* Account & settings */}
        <Route path="/settings" element={<AccountPage />} />
        <Route path="/settings/subscription" element={<SubscriptionPage />} />
        <Route path="/settings/privacy" element={<PrivacyPage />} />
        <Route path="/settings/bikes" element={<BikesPage />} />
        <Route path="/settings/notifications" element={<NotificationsPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

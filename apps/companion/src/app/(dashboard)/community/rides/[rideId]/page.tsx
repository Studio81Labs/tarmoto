// Community ride detail. Reuses the ride-history detail view so the layout is
// identical whether the ride is yours or another rider's; the only difference
// is the route — `/community/rides/:id` keeps the Community nav item active and
// makes the back link point at the feed (the view reads `usePathname`). Access
// to non-owned rides is gated server-side to publicly-shared rides.
export { default } from "../../../rides/[rideId]/page";

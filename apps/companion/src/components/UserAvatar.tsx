import clsx from "clsx";
// Import the initials helper from the shared package directly (not the app's
// `@/lib/rider-profile`, which carries data-fetching deps that tests mock) so
// this presentational avatar stays decoupled from the rider data layer.
import { initialsFromName } from "@tarmoto/shared";

/**
 * Deterministic warm/cool palette so back-to-back rider rows feel distinct
 * without relying on real avatar uploads. The hash is intentionally trivial —
 * collisions are fine, the goal is visual variety not identity. Lifted from the
 * achievements leaderboard so every initials avatar (feed, leaderboard, …)
 * colours the same rider identically.
 */
const AVATAR_PALETTE = [
  "bg-[#E05A3C]",
  "bg-[#F0A03C]",
  "bg-[#E8D66A]",
  "bg-[#C7D36A]",
  "bg-[#6FD38A]",
];

function avatarColorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1)
    h = (h * 31 + name.charCodeAt(i)) | 0;
  return (
    AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length] ?? AVATAR_PALETTE[0]!
  );
}

/**
 * Shared user avatar: renders the rider's uploaded photo when `avatarUrl` is
 * set, otherwise a coloured circle with their initials. Used for EVERY
 * person/rider avatar in the app so initials (always `initialsFromName`, up to
 * two letters) and colours stay consistent everywhere.
 *
 * Colour of the initials fallback is derived from the name, so the same rider
 * is always the same colour. Pass `accent` to override the palette with the
 * brand accent — used for self/hero contexts (the current user's own profile,
 * the "You" leaderboard row) rather than the per-rider palette that gives a
 * long list visual variety.
 *
 * Sizing is inline so a single component serves every call site (18px owner
 * chips, 22px feed rows, 88px profile hero, …); `fontSize` defaults to a
 * proportion of the box but can be set explicitly. `className` is applied to
 * both the image and the initials variant, so a caller can add a border (e.g.
 * the bordered hero avatars) without the two variants drifting apart.
 */
export function UserAvatar({
  name,
  avatarUrl,
  size = 26,
  fontSize,
  accent = false,
  alt,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: number;
  fontSize?: number;
  accent?: boolean;
  /** Alt text for the image variant; defaults to `name`. */
  alt?: string;
  className?: string;
}) {
  if (avatarUrl) {
    return (
      // Browser-native <img>: avatar URLs come from arbitrary providers
      // (OAuth, uploads) so Next's image optimiser/domain allow-list doesn't
      // help here — same call the profile pages already make.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={alt ?? name}
        style={{ height: size, width: size }}
        className={clsx("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        height: size,
        width: size,
        fontSize: fontSize ?? Math.max(9, Math.round(size * 0.42)),
      }}
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full font-extrabold leading-none text-ink",
        accent ? "bg-accent" : avatarColorFor(name),
        className,
      )}
    >
      {initialsFromName(name)}
    </span>
  );
}

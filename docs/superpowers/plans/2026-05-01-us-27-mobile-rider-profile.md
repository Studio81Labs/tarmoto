# US-27: Mobile rider profile + follow flow — Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute task-by-task with checkpoints.

**Goal:** Replace the mobile `ProfileScreen` stub with two-mode profile UI (own / other rider), add follow/unfollow optimistic UI, follower/following sub-screens, avatar upload, and tap-to-profile navigation from existing rider-name surfaces.

**Architecture:** Reuse existing axios API client + Zustand auth store. Add a single new backend endpoint `GET /users/:userId/profile` returning a denormalised public profile DTO (display data + follower/following counts + viewer's `is_following` flag). Mobile screen fetches profile, badges, and (own profile only) emits PATCH /users/me through existing endpoints. Optimistic follow toggle mirrors the companion's pattern in `apps/companion/src/lib/rider-profile.ts`.

**Tech Stack:** NestJS 11 + TypeORM (backend), React Native 0.85 + react-navigation native stack (mobile), Zustand store, axios, react-native-image-picker, Jest + React Native Testing Library.

---

## File structure

### Backend (new + modified)

- `apps/backend/src/modules/users/dto/public-profile.dto.ts` — **new** `PublicProfileDto`.
- `apps/backend/src/modules/users/users.service.ts` — **modify** to add `getPublicProfile(viewerId, userId)`.
- `apps/backend/src/modules/users/users.controller.ts` — **modify** to add `GET /users/:userId/profile` route.
- `apps/backend/src/modules/users/users.module.ts` — **modify** to register `UserFollow` repo (already may be) and `User` repo for the new method.
- `apps/backend/src/modules/users/users.controller.spec.ts` — **modify** to cover the new endpoint.
- `apps/backend/src/modules/users/users.service.spec.ts` — **modify** to cover `getPublicProfile`.

### Mobile (new + modified)

- `apps/mobile/src/types/index.ts` — **modify** `User` (add `avatar_url`, `bio`, `home_region` optional fields) and add `PublicProfile`, `FollowerListItem` types.
- `apps/mobile/src/services/api.ts` — **modify** to add `getPublicProfile`, `followUser`, `unfollowUser`, `listFollowers`, `listFollowing`, `listUserBadges`, `uploadAvatar`. Also expand `updateProfile`'s typing.
- `apps/mobile/src/services/photoCapture.ts` — **reuse** as-is (already exports `capturePhoto`).
- `apps/mobile/src/navigation/RootNavigator.tsx` — **modify** to add `ViewProfile`, `Followers`, `Following` routes to `ProfileStackParamList` and register their screens.
- `apps/mobile/src/screens/ProfileScreen.tsx` — **rewrite** to render the authenticated rider's own profile + actions.
- `apps/mobile/src/screens/EditProfileModal.tsx` — **new** modal/screen for editing display name, bio, home region.
- `apps/mobile/src/screens/ViewProfileScreen.tsx` — **new** read-only profile of another rider with follow/unfollow toggle.
- `apps/mobile/src/screens/FollowersScreen.tsx` — **new** scrollable followers list.
- `apps/mobile/src/screens/FollowingScreen.tsx` — **new** scrollable following list.
- `apps/mobile/src/components/Avatar.tsx` — **new** small avatar+initials fallback component (reused across screens).
- `apps/mobile/src/screens/TripDetailScreen.tsx` — **modify** to make member rows tap to `ViewProfile`.
- `apps/mobile/src/screens/__tests__/ProfileScreen.test.tsx` — **new**.
- `apps/mobile/src/screens/__tests__/ViewProfileScreen.test.tsx` — **new**.
- `apps/mobile/src/screens/__tests__/FollowersScreen.test.tsx` — **new**.
- `apps/mobile/src/components/__tests__/Avatar.test.tsx` — **new**.

### BadgesController guard adjustment

`GET /users/:userId/badges` is currently `@UseGuards(AuthGuard)` so the mobile call works (mobile is always authenticated). Leave as-is.

---

## Backend contract

### New DTO `PublicProfileDto`

```ts
export class PublicProfileDto {
  id!: string;
  display_name!: string;
  avatar_url!: string | null;
  bio!: string | null;
  home_region!: string | null;
  created_at!: string; // ISO 8601 — used as joined date
  follower_count!: number;
  following_count!: number;
  /** Viewer's follow state, or null when viewing own profile. */
  is_following!: boolean | null;
  /** True when viewerId === target id. */
  is_self!: boolean;
}
```

### Endpoint

`GET /users/:userId/profile` — auth required (uses viewer to compute `is_following`/`is_self`). Returns `PublicProfileDto`. 404 if target user missing or `deleted_at != null`.

### Service method `UsersService.getPublicProfile(viewerId, userId)`

- Loads `User` by id; reject with `NotFoundException` if missing/deleted.
- Counts `UserFollow` rows where `following_id = userId` (followers).
- Counts `UserFollow` rows where `follower_id = userId` (following).
- If `viewerId !== userId`: query `UserFollow` for `(follower_id=viewerId, following_id=userId)` to set `is_following`. If equal, `is_following = null`.
- Maps to `PublicProfileDto`.

This keeps a single round trip and avoids two extra count queries on the mobile.

---

## Tasks

### Task 1: Backend — add `PublicProfileDto`

**Files:**

- Create: `apps/backend/src/modules/users/dto/public-profile.dto.ts`

```ts
import { ApiProperty } from "@nestjs/swagger";

export class PublicProfileDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  display_name!: string;

  @ApiProperty({ nullable: true })
  avatar_url!: string | null;

  @ApiProperty({ nullable: true })
  bio!: string | null;

  @ApiProperty({ nullable: true })
  home_region!: string | null;

  @ApiProperty()
  created_at!: string;

  @ApiProperty()
  follower_count!: number;

  @ApiProperty()
  following_count!: number;

  @ApiProperty({
    nullable: true,
    description: "Viewer's follow state, or null when viewing own profile.",
  })
  is_following!: boolean | null;

  @ApiProperty()
  is_self!: boolean;
}
```

Commit: `feat(backend): add PublicProfileDto for rider profile endpoint (us-27)`

---

### Task 2: Backend — `UsersService.getPublicProfile`

**Files:**

- Modify: `apps/backend/src/modules/users/users.service.ts`
- Modify: `apps/backend/src/modules/users/users.module.ts` (register `UserFollow` repo)

Steps:

1. Import `UserFollow` entity + `Repository` + `InjectRepository` for it.
2. Inject `userFollowRepo: Repository<UserFollow>` into the constructor.
3. Add `getPublicProfile(viewerId: string, userId: string): Promise<PublicProfileDto>`:

```ts
async getPublicProfile(
  viewerId: string,
  userId: string,
): Promise<PublicProfileDto> {
  const user = await this.userRepo.findOne({ where: { id: userId } });
  if (!user || user.deleted_at != null) {
    throw new NotFoundException('User not found');
  }

  const [followerCount, followingCount, isFollowingRow] = await Promise.all([
    this.userFollowRepo.count({ where: { following_id: userId } }),
    this.userFollowRepo.count({ where: { follower_id: userId } }),
    viewerId === userId
      ? Promise.resolve(null)
      : this.userFollowRepo.findOne({
          where: { follower_id: viewerId, following_id: userId },
          select: ['follower_id'],
        }),
  ]);

  return {
    id: user.id,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    bio: user.bio,
    home_region: user.home_region,
    created_at: user.created_at.toISOString(),
    follower_count: followerCount,
    following_count: followingCount,
    is_following:
      viewerId === userId ? null : isFollowingRow != null,
    is_self: viewerId === userId,
  };
}
```

4. In `users.module.ts`, add `UserFollow` to the `TypeOrmModule.forFeature([...])` array.

Commit: `feat(backend): add UsersService.getPublicProfile (us-27)`

---

### Task 3: Backend — controller route `GET /users/:userId/profile`

**Files:**

- Modify: `apps/backend/src/modules/users/users.controller.ts`

Add route immediately after `Get('me')`:

```ts
@Get(':userId/profile')
@ApiOperation({ summary: 'Get a rider\'s public profile' })
@ApiResponse({ status: 200, type: PublicProfileDto })
@ApiResponse({ status: 404, description: 'User not found' })
async getPublicProfile(
  @Req() req: express.Request,
  @Param('userId', ParseUUIDPipe) userId: string,
): Promise<PublicProfileDto> {
  return this.usersService.getPublicProfile(req.user!.userId, userId);
}
```

Import `PublicProfileDto`.

Commit: `feat(backend): GET /users/:userId/profile public profile endpoint (us-27)`

---

### Task 4: Backend — service + controller specs

**Files:**

- Modify: `apps/backend/src/modules/users/users.service.spec.ts`
- Modify: `apps/backend/src/modules/users/users.controller.spec.ts`

In service spec, add:

- `getPublicProfile` returns full DTO with counts + `is_following=true` when viewer follows
- returns `is_following=false` when viewer doesn't follow
- returns `is_following=null, is_self=true` when viewer === target
- throws `NotFoundException` for missing/deleted target

In controller spec, add coverage for the new route — passes through req.user.userId and userId param.

Use the existing mocked-repo pattern in those spec files (TypeORM `Repository` mocks with `count`, `findOne`).

Commit: `test(backend): cover public profile endpoint (us-27)`

---

### Task 5: Mobile — extend types

**Files:**

- Modify: `apps/mobile/src/types/index.ts`

Add to `User` interface (currently has only id/email/display_name/phone/home_location/work_location/preferences/created_at):

```ts
avatar_url?: string | null;
bio?: string | null;
home_region?: string | null;
```

Add new types after `User`:

```ts
export interface PublicProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  home_region: string | null;
  created_at: string;
  follower_count: number;
  following_count: number;
  is_following: boolean | null;
  is_self: boolean;
}

export interface FollowerListItem {
  user_id: string;
  display_name: string;
  followed_at: string;
}

export interface UserBadge {
  key: string;
  name: string;
  description: string;
  category: string;
  tier: string | null;
  earned_at: string | null;
  progress: {
    current: number;
    bronze: number;
    silver: number;
    gold: number;
  };
}
```

Commit: `feat(mobile): add PublicProfile + follower types (us-27)`

---

### Task 6: Mobile — extend API service

**Files:**

- Modify: `apps/mobile/src/services/api.ts`

Add imports for new types. Add methods after `updateProfile`:

```ts
async getPublicProfile(userId: string): Promise<PublicProfile> {
  const { data } = await this.client.get<PublicProfile>(
    `/users/${userId}/profile`,
  );
  return data;
}

async followUser(userId: string): Promise<void> {
  await this.client.post(`/users/${userId}/follow`);
}

async unfollowUser(userId: string): Promise<void> {
  await this.client.delete(`/users/${userId}/follow`);
}

async listFollowers(userId: string): Promise<FollowerListItem[]> {
  const { data } = await this.client.get<FollowerListItem[]>(
    `/users/${userId}/followers`,
  );
  return data;
}

async listFollowing(userId: string): Promise<FollowerListItem[]> {
  const { data } = await this.client.get<FollowerListItem[]>(
    `/users/${userId}/following`,
  );
  return data;
}

async listUserBadges(userId: string): Promise<UserBadge[]> {
  const { data } = await this.client.get<UserBadge[]>(
    `/users/${userId}/badges`,
  );
  return data;
}

async uploadAvatar(photo: { uri: string; mimeType?: string; fileName?: string }): Promise<User> {
  const form = new FormData();
  form.append('file', {
    uri: photo.uri,
    type: photo.mimeType ?? 'image/jpeg',
    name: photo.fileName ?? `avatar-${Date.now()}.jpg`,
  } as unknown as Blob);
  const { data } = await this.client.post<User>('/users/me/avatar', form, {
    headers: {
      'Content-Type': undefined as unknown as string,
    },
  });
  return data;
}
```

Commit: `feat(mobile): api methods for public profile + follow + avatar upload (us-27)`

---

### Task 7: Mobile — `Avatar` component

**Files:**

- Create: `apps/mobile/src/components/Avatar.tsx`
- Create: `apps/mobile/src/components/__tests__/Avatar.test.tsx`

```tsx
import React from "react";
import { Image, StyleSheet, Text, View, ViewStyle } from "react-native";
import { borderRadius, colors, fontSize, fontWeight } from "@/theme";

interface AvatarProps {
  uri?: string | null;
  name: string;
  size?: number;
  style?: ViewStyle;
}

export function initialsFromName(name: string | null | undefined): string {
  if (!name) return "?";
  const letters = name
    .split(/\s+/)
    .map((word) => word[0])
    .filter((ch): ch is string => typeof ch === "string" && ch.length > 0)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "?";
}

export default function Avatar({ uri, name, size = 64, style }: AvatarProps) {
  const dim = { width: size, height: size, borderRadius: size / 2 };
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, dim, style]}
        accessibilityLabel={`${name} avatar`}
      />
    );
  }
  return (
    <View style={[styles.fallback, dim, style]}>
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>
        {initialsFromName(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: colors.bgCard,
  },
  fallback: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: borderRadius.pill,
  },
  initials: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
});
```

Test (`Avatar.test.tsx`) — covers:

- renders image when `uri` provided
- renders initials fallback when no `uri`
- handles empty/whitespace name → "?"

Commit: `feat(mobile): Avatar component with initials fallback (us-27)`

---

### Task 8: Mobile — extend `ProfileStackParamList` + register screens

**Files:**

- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`

1. Update type:

```ts
export type ProfileStackParamList = {
  Profile: undefined;
  Settings: undefined;
  EditProfile: undefined;
  ViewProfile: { userId: string };
  Followers: { userId: string; displayName: string };
  Following: { userId: string; displayName: string };
  LinkAccount: { email?: string } | undefined;
  OfflineRegions: undefined;
  EmergencyContacts: undefined;
};
```

2. Import the four new screens.
3. Register them in `ProfileNavigator`:

```tsx
<ProfileStack.Screen
  name="EditProfile"
  component={EditProfileModal}
  options={{ title: 'Edit profile', presentation: 'modal' }}
/>
<ProfileStack.Screen
  name="ViewProfile"
  component={ViewProfileScreen}
  options={{ title: 'Rider' }}
/>
<ProfileStack.Screen
  name="Followers"
  component={FollowersScreen}
  options={{ title: 'Followers' }}
/>
<ProfileStack.Screen
  name="Following"
  component={FollowingScreen}
  options={{ title: 'Following' }}
/>
```

Commit: `feat(mobile): register profile stack routes for view/edit/followers/following (us-27)`

---

### Task 9: Mobile — `ProfileScreen` (own profile)

**Files:**

- Rewrite: `apps/mobile/src/screens/ProfileScreen.tsx`

Behavior:

- Reads current user from `useAuthStore`. If null → render placeholder asking to sign in (matches LinkAccount flow elsewhere).
- On focus, fetches `api.getPublicProfile(user.id)` (so follower/following counts come from the same endpoint as view-profile) and `api.listUserBadges(user.id)`.
- Renders header: `<Avatar>` (tap to upload — opens `capturePhoto`), display name, bio, home region, joined date (using a `formatJoinedLabel` helper inlined or reused from a small util).
- Stats row: follower_count (tap → `Followers` screen), following_count (tap → `Following` screen), badges_earned_count.
- Action rows: Edit profile → `EditProfile` modal; Settings → existing Settings; Sign out → clears tokens via `api.logout()` and `useAuthStore.setUser(null)`.
- Pull-to-refresh re-fetches profile + badges.
- Avatar tap path: call `capturePhoto('library')`, on `captured`, optimistically set local avatar URI, call `api.uploadAvatar({ uri, mimeType, fileName })`, on success update `useAuthStore.setUser(...)` with returned user; on error revert + show inline error.

Loading / error / ready phases mirror RideDetailScreen pattern.

(Code is extensive — implementation will live in the file directly.)

Commit: `feat(mobile): ProfileScreen own-profile rewrite with avatar upload (us-27)`

---

### Task 10: Mobile — `EditProfileModal`

**Files:**

- Create: `apps/mobile/src/screens/EditProfileModal.tsx`

Form fields:

- display_name (TextInput, required, MaxLength 100)
- bio (TextInput multiline, MaxLength 500)
- home_region (TextInput, MaxLength 120)

On Save: `api.updateProfile({ display_name, bio, home_region })`, update auth store, navigate back.
On Cancel: navigate back without saving.
Inline validation: empty display_name → error "Display name is required."

Disable Save while pending; show ActivityIndicator inside the button.

Commit: `feat(mobile): EditProfileModal for own profile editing (us-27)`

---

### Task 11: Mobile — `ViewProfileScreen` (other rider)

**Files:**

- Create: `apps/mobile/src/screens/ViewProfileScreen.tsx`

Reads `userId` route param. Loads `api.getPublicProfile(userId)` and `api.listUserBadges(userId)` in parallel.

Header: avatar, display name, joined date, home region, bio, follower/following counts (tappable → Followers/Following), follow/unfollow button (hidden when `is_self === true`).

**Optimistic follow** (mirrors companion):

- On press: optimistically toggle `is_following` and bump/decrement `follower_count`.
- Call `api.followUser(userId)` or `api.unfollowUser(userId)`.
- On error: revert state and surface inline error message.
- 409 (already following) on follow and 404 (not following) on unfollow are treated as success — request raced with optimistic state.

Badges section: show earned badges (filter `earned_at != null`), grid of name + tier.

If `is_self === true` (rider tapped their own card from elsewhere), redirect to the Profile tab (or just render the same data without the follow button).

Loading / error states mirror RideDetailScreen.

Commit: `feat(mobile): ViewProfileScreen with optimistic follow toggle (us-27)`

---

### Task 12: Mobile — `FollowersScreen` + `FollowingScreen`

**Files:**

- Create: `apps/mobile/src/screens/FollowersScreen.tsx`
- Create: `apps/mobile/src/screens/FollowingScreen.tsx`

Each: read `userId, displayName` from route. Header `displayName + 'Followers'`/`'Following'`. Loads list via `api.listFollowers(userId)` or `listFollowing(userId)`.

`FlatList<FollowerListItem>` with rows: `<Avatar>` + display name + `Following since <date>`. Tap row → `navigation.push('ViewProfile', { userId })`.

Empty state: "No followers yet." / "Not following anyone yet."

Pull-to-refresh.

These two screens are nearly identical — share helpers but keep two screen files for clarity.

Commit: `feat(mobile): Followers + Following list screens (us-27)`

---

### Task 13: Mobile — wire up TripMember tap → ViewProfile

**Files:**

- Modify: `apps/mobile/src/screens/TripDetailScreen.tsx`

Find the trip-member rendering. Wrap each member row (where `display_name` shows) in a `TouchableOpacity` calling:

```tsx
const profileNav =
  useNavigation<NativeStackNavigationProp<ProfileStackParamList>>();

<TouchableOpacity
  onPress={() =>
    profileNav.getParent()?.navigate("ProfileTab", {
      screen: "ViewProfile",
      params: { userId: member.user_id },
    })
  }
  accessibilityRole="button"
  accessibilityLabel={`Open ${member.display_name}'s profile`}
>
  ...existing row content...
</TouchableOpacity>;
```

Cross-tab navigation pattern is already used elsewhere in the repo (HomeScreen → RideTab for commute) so the typing should already work. If not, fall back to `useNavigation<any>()` with a typed cast and a comment.

Commit: `feat(mobile): tap trip member to open rider profile (us-27)`

---

### Task 14: Mobile — tests

**Files:**

- Create: `apps/mobile/src/screens/__tests__/ProfileScreen.test.tsx`
- Create: `apps/mobile/src/screens/__tests__/ViewProfileScreen.test.tsx`
- Create: `apps/mobile/src/screens/__tests__/FollowersScreen.test.tsx`

Test outline (each follows the EmergencyContactsScreen pattern: mock `@/services/api`, mock `@react-native-vector-icons`, mock `useAuthStore`):

`ProfileScreen.test.tsx`

- renders user display name from auth store and counts from `getPublicProfile`
- pull-to-refresh re-fetches profile
- tap "Edit profile" navigates to `EditProfile`
- tap "Sign out" clears auth store

`ViewProfileScreen.test.tsx`

- renders profile data from `getPublicProfile`
- tap "Follow" optimistically flips button + bumps follower count, then resolves
- tap "Unfollow" optimistically flips button + decrements count, then resolves
- API failure on follow reverts the optimistic state and surfaces error

`FollowersScreen.test.tsx`

- renders followers list
- tapping a row navigates to ViewProfile with that user's id
- empty state when zero followers

Commit: `test(mobile): cover ProfileScreen, ViewProfileScreen, FollowersScreen (us-27)`

---

### Task 15: Validate

```bash
pnpm --filter @tarmoto/backend lint
pnpm --filter @tarmoto/backend typecheck   # if exists, else 'tsc --noEmit'
pnpm --filter @tarmoto/backend test users followers
pnpm --filter @tarmoto/mobile lint
pnpm --filter @tarmoto/mobile typecheck    # if exists
pnpm --filter @tarmoto/mobile test ProfileScreen ViewProfileScreen FollowersScreen Avatar
```

Inspect final diff for: dead code, regressions in unrelated screens, missing `index.ts` re-exports if any module file uses one.

Commit any spec / lint fixes.

---

### Task 16: Update OpenAPI + spec docs

If the repo runs an OpenAPI generation step, run it and commit the regen. Otherwise note that as future work in PR description.

If `docs/specs/` references US-27, update status. If `docs/database/` is unaffected (no schema change), skip.

Commit: `docs(openapi): regen for public profile endpoint (us-27)` (if regen produced changes).

---

## Self-review

- AC: own profile (avatar upload, edit display name/bio/home region, sign out) — covered by Tasks 9 & 10. ✓
- AC: other-rider profile (avatar, display name, joined date, home region, badges, follow/unfollow toggle, follower/following counts) — covered by Task 11. **Recent shared rides + route collections deferred** (no per-user rides endpoint, route collections are localStorage in companion). Will note as follow-up in PR description.
- AC: tap rider name in feed/leaderboard/community ride card opens profile — only `TripDetailScreen` rider names currently exist in mobile (no feed/leaderboard/community screens yet). Wired Task 13.
- AC: follow toggle calls existing endpoints with optimistic UI — Task 11. ✓
- AC: Following/Followers lists open as scrollable sub-screens — Task 12. ✓
- AC: avatar upload uses `/users/me/avatar` — Task 9. ✓
- AC: tests cover follow/unfollow optimistic update and profile data binding — Task 14. ✓

Out-of-scope but worth flagging in PR description:

- Adding `user_id` to `RoadReview` DTO and wrapping review-author names with the same nav pattern.
- A backend `/users/:userId/shared-rides` endpoint to power the "Recent shared rides" section.

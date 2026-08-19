#!/usr/bin/env bash
# ported from Studio81Labs/nexcue@2e0ee3e8
set -euo pipefail

# Fails a release unless the v* tag being built is v<version>+<build>, with
# <version> matching apps/mobile/package.json at the tagged commit and
# <build> a positive integer.
#
# Why this exists. scripts/ci/resolve-app-version.sh accepts any `v*` ref
# verbatim and strips the leading "v". That value becomes TARMOTO_APP_VERSION
# for the backend and ingest deploys, their Sentry releases, and the identity
# every release surface reports. Meanwhile the mobile app builds from its own
# package.json version, entirely independently — nothing compares the two. A
# single `v*` tag fans out to every surface, so a mistyped tag produces a
# *successful* release in which every recorded identity names a version no
# built artifact shares. Nothing fails; crash reports simply stop correlating
# with builds, and that is discovered later, from the wrong end.
#
# Tags are immutable, so this cannot be corrected after the fact by deleting
# and recutting — which is why the check runs before any surface deploys
# rather than as a post-release verification.
#
# ## The tag carries the build number — same rule as the siblings
#
# The store build number is REQUIRED in the tag (`v1.2.3+10`): a resubmission
# of the same marketing version — bug found after upload, before store
# approval — needs a new build under the same X.Y.Z, and with a bare vX.Y.Z
# tag form that resubmission has no valid tag at all, because tags are
# immutable and vX.Y.Z is already taken. With the build in the tag, every
# store submission gets its own immutable tag, and the release identity
# matches exactly one set of store artifacts.
#
# ## Sibling divergence in the SOURCE, not the rule
#
# The Flutter siblings compare the whole tag against pubspec.yaml because
# their pubspec holds both halves (`version: 1.2.3+10`). This repo is bare
# React Native: package.json holds only the marketing version, and the native
# build numbers are placeholders that mobile-release.yml stamps FROM THE TAG
# (fastlane increment_build_number / versionCode) — so the tag itself is the
# build number's source of truth here, and only its shape is checked.
# Monotonicity across releases is runbook territory, exactly as it is for the
# siblings (their highest-released-build floor).
#
# `+` is safe everywhere this value travels: it becomes a Sentry release name
# and two Coolify environment variables, never a Docker tag.
#
# Usage:  check-release-tag.sh [manifest-path]
# Reads GITHUB_REF_TYPE and GITHUB_REF_NAME from the environment.

MANIFEST="${1:-apps/mobile/package.json}"

manifest_version() {
  # python3 rather than a JSON-ish grep: "version" also appears in dependency
  # specifiers, and a regex over JSON is how a wrong line gets compared.
  python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
version = doc.get("version")
print(version if isinstance(version, str) else "")
' "$1"
}

# Every deploy workflow also runs on pushes to main and on workflow_dispatch.
# Neither carries a tag, so there is nothing to compare and nothing to gate —
# this must succeed rather than skip, so callers can depend on it with a plain
# `needs:` without GitHub propagating a skip to every deploy job.
if [ "${GITHUB_REF_TYPE:-}" != "tag" ]; then
  echo "Not a tag ref (GITHUB_REF_TYPE='${GITHUB_REF_TYPE:-}') — nothing to gate."
  exit 0
fi

TAG="${GITHUB_REF_NAME:-}"

case "$TAG" in
  v*) ;;
  *)
    echo "Tag '${TAG}' is not a v* release tag — nothing to gate."
    exit 0
    ;;
esac

if [ ! -f "$MANIFEST" ]; then
  echo "::error::Cannot verify release tag ${TAG}: no manifest at ${MANIFEST}"
  exit 1
fi

EXPECTED="$(manifest_version "$MANIFEST")"

if [ -z "$EXPECTED" ]; then
  echo "::error::Cannot verify release tag ${TAG}: no \"version\" in ${MANIFEST}"
  exit 1
fi

TAGGED="${TAG#v}"
ACTUAL_VERSION="${TAGGED%%+*}"
ACTUAL_BUILD="${TAGGED#*+}"

if [ "$TAGGED" = "$ACTUAL_VERSION" ]; then
  echo "::error::Release tag ${TAG} carries no build number"
  echo ""
  echo "The tag form is v<version>+<build> (e.g. v${EXPECTED}+10). The build is"
  echo "required so a store resubmission of the same version can get its own"
  echo "immutable tag — a bare v${EXPECTED} would be spent on the first attempt."
  exit 1
fi

case "$ACTUAL_BUILD" in
  # A positive integer with no leading zero — versionCode and CFBundleVersion
  # both take it verbatim, and Play's versionCode must strictly increase.
  # The empty pattern catches a trailing `+` with nothing after it.
  "" | 0* | *[!0-9]*)
    echo "::error::Release tag ${TAG} has a malformed build number ('${ACTUAL_BUILD}')"
    echo ""
    echo "The build must be a positive integer: v${EXPECTED}+10, not v${EXPECTED}+${ACTUAL_BUILD}."
    exit 1
    ;;
esac

if [ "$ACTUAL_VERSION" = "$EXPECTED" ]; then
  echo "Release tag ${TAG} matches ${MANIFEST} (${EXPECTED}) with build ${ACTUAL_BUILD}."
  exit 0
fi

echo "::error::Release tag ${TAG} does not match the app version it names (${EXPECTED})"
echo ""
echo "  tag       ${TAG}  ->  version '${ACTUAL_VERSION}'"
echo "  ${MANIFEST}  ->  version '${EXPECTED}'"
echo ""
echo "Tags are immutable — do NOT delete and recut this one."
echo "Either cut the tag that matches the mobile app version:"
echo ""
echo "    v${EXPECTED}+${ACTUAL_BUILD}"
echo ""
echo "or bump apps/mobile/package.json first and tag the resulting commit."
exit 1

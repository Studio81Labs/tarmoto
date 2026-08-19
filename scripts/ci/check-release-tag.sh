#!/usr/bin/env bash
# ported from Studio81Labs/nexcue@2e0ee3e8
set -euo pipefail

# Fails a release unless the v* tag being built matches the app version in
# apps/mobile/package.json at the tagged commit.
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
# ## Sibling divergence, on purpose
#
# The Flutter siblings compare the FULL Dart version including build metadata
# (`v1.0.0+3` against pubspec `1.0.0+3`), because their store build number
# lives in the pubspec. This repo is bare React Native: build numbers live in
# the native projects (CFBundleVersion / versionCode), and package.json holds
# only the marketing version — so the tag form here is `v<version>` exactly.
# If store build numbers ever move into package.json, adopt the siblings'
# `+<build>` tag form and tighten this comparison with it.
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

ACTUAL="${TAG#v}"

if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "Release tag ${TAG} matches ${MANIFEST} (${EXPECTED})."
  exit 0
fi

echo "::error::Release tag ${TAG} does not match the app version it names (${EXPECTED})"
echo ""
echo "  tag       ${TAG}  ->  version '${ACTUAL}'"
echo "  ${MANIFEST}  ->  version '${EXPECTED}'"
echo ""
echo "Tags are immutable — do NOT delete and recut this one."
echo "Either cut the tag that matches the mobile app version:"
echo ""
echo "    v${EXPECTED}"
echo ""
echo "or bump apps/mobile/package.json first and tag the resulting commit."
exit 1

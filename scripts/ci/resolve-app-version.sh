#!/usr/bin/env bash
set -euo pipefail

# Resolve the app version stamped into the backend on deploy (mirrors the
# tabletap/nexcue convention). A `v*` tag build uses the tag (minus the `v`);
# otherwise `git describe` against the latest v-tag, falling back to the short
# SHA, then "0.0.0". Requires a full-history checkout (fetch-depth: 0) for
# `git describe` to see tags.

if [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [[ "${GITHUB_REF_NAME:-}" == v* ]]; then
  printf "%s\n" "${GITHUB_REF_NAME#v}"
  exit 0
fi

version="$(git describe --tags --match 'v[0-9]*' --always 2>/dev/null || true)"
if [ -z "$version" ] && [ -n "${GITHUB_SHA:-}" ]; then
  version="${GITHUB_SHA:0:7}"
fi

version="${version:-0.0.0}"
printf "%s\n" "${version#v}"

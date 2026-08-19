#!/usr/bin/env bash
# ported from Studio81Labs/nexcue@2e0ee3e8
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/resolve-app-version.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  if [ "$actual" != "$expected" ]; then
    fail "${message}: expected '${expected}', got '${actual}'"
  fi
}

assert_matches() {
  local actual="$1"
  local pattern="$2"
  local message="$3"
  if [[ ! "$actual" =~ $pattern ]]; then
    fail "${message}: '${actual}' did not match ${pattern}"
  fi
}

setup_repo() {
  local repo="$1"
  git -C "$repo" init --quiet
  git -C "$repo" config user.email "ci@example.com"
  git -C "$repo" config user.name "CI"
  printf "one\n" > "${repo}/file.txt"
  git -C "$repo" add file.txt
  git -C "$repo" commit --quiet -m "initial"
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

tag_output="$(
  GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v1.2.3 "$SCRIPT"
)"
assert_eq "$tag_output" "1.2.3" "tag refs strip leading v"

tagged_repo="${tmpdir}/tagged"
mkdir "$tagged_repo"
setup_repo "$tagged_repo"
git -C "$tagged_repo" tag v1.2.3
printf "two\n" >> "${tagged_repo}/file.txt"
git -C "$tagged_repo" commit --quiet -am "second"
printf "three\n" >> "${tagged_repo}/file.txt"
git -C "$tagged_repo" commit --quiet -am "third"

describe_output="$(
  cd "$tagged_repo"
  GITHUB_REF_TYPE=branch GITHUB_REF_NAME=main "$SCRIPT"
)"
# No leading `v`: the script strips it on every path, so that APP_VERSION and
# the pubspec version are the same string (AGENTS.md § Releasing). This
# expectation was written before 073b552c added the strip and has been stale
# ever since — undetected, because until ci-scripts.yml nothing ran this file.
assert_matches "$describe_output" '^1\.2\.3-2-g[0-9a-f]+$' "branch refs use git describe"

untagged_repo="${tmpdir}/untagged"
mkdir "$untagged_repo"
setup_repo "$untagged_repo"

sha_output="$(
  cd "$untagged_repo"
  GITHUB_REF_TYPE=branch GITHUB_REF_NAME=main "$SCRIPT"
)"
assert_matches "$sha_output" '^[0-9a-f]{7,}$' "untagged repos fall back to abbreviated sha"

echo "resolve-app-version tests passed"

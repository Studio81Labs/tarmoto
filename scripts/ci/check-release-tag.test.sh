#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/check-release-tag.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Writes a package.json fixture and echoes its path. The surrounding keys are
# real — "version" also appears inside a dependency object below, which is
# exactly the value a JSON-ish grep would have compared and the parser must
# never see as the app version.
make_manifest() {
  local name="$1"
  local version_json="$2" # e.g. '"version": "0.1.0",' or '' to omit
  local path="${tmpdir}/${name}.json"
  {
    printf '{\n'
    printf '  "name": "@tarmoto/mobile",\n'
    if [ -n "$version_json" ]; then
      printf '  %s\n' "$version_json"
    fi
    printf '  "private": true,\n'
    printf '  "dependencies": {\n'
    printf '    "some-native-module": {\n'
    printf '      "version": "9.9.9"\n'
    printf '    }\n'
    printf '  }\n'
    printf '}\n'
  } > "$path"
  printf '%s\n' "$path"
}

# Runs the script and reports exit status + combined output.
run() {
  local ref_type="$1" ref_name="$2" manifest="$3"
  local out status
  set +e
  out="$(GITHUB_REF_TYPE="$ref_type" GITHUB_REF_NAME="$ref_name" "$SCRIPT" "$manifest" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$out"
  return $status
}

assert_passes() {
  local message="$1" ref_type="$2" ref_name="$3" manifest="$4"
  if ! run "$ref_type" "$ref_name" "$manifest" > /dev/null; then
    fail "${message}: expected exit 0, got non-zero"
  fi
}

assert_fails() {
  local message="$1" ref_type="$2" ref_name="$3" manifest="$4"
  if run "$ref_type" "$ref_name" "$manifest" > /dev/null; then
    fail "${message}: expected non-zero exit, got 0"
  fi
}

assert_output_contains() {
  local message="$1" needle="$2" ref_type="$3" ref_name="$4" manifest="$5"
  local out
  out="$(run "$ref_type" "$ref_name" "$manifest" || true)"
  case "$out" in
    *"$needle"*) ;;
    *) fail "${message}: output did not contain '${needle}'. Got: ${out}" ;;
  esac
}

matching="$(make_manifest matching '"version": "1.2.4",')"

# --- the tag matches -------------------------------------------------------

assert_passes "exact match passes" tag "v1.2.4" "$matching"

# --- the tag does not match ------------------------------------------------

assert_fails "marketing version differs" tag "v1.2.5" "$matching"
assert_fails "patch transposed" tag "v1.4.2" "$matching"
# Deliberate sibling divergence: this repo's tags carry NO build metadata
# (build numbers live in the native projects, not package.json), so a
# Flutter-style +build tag must be refused rather than loosely accepted.
assert_fails "a +build tag is refused (build numbers are native here)" tag "v1.2.4+12" "$matching"

# The error must name BOTH values — an error reporting only one leaves the
# operator unable to tell which side is wrong, and tags are immutable.
assert_output_contains "error names the tag version" "1.2.5" tag "v1.2.5" "$matching"
assert_output_contains "error names the manifest version" "1.2.4" tag "v1.2.5" "$matching"
assert_output_contains "error offers the correct tag" "v1.2.4" tag "v1.2.5" "$matching"

# --- nothing to gate -------------------------------------------------------
#
# These must PASS, not skip. Every caller depends on this job with a plain
# `needs:`, and GitHub propagates a skipped dependency to its dependents — a
# skip here would silently cancel every deploy on a push to main.

assert_passes "a branch push is not gated" branch "main" "$matching"
assert_passes "an empty ref type is not gated" "" "" "$matching"
assert_passes "a non-v tag is not gated" tag "release-2026-08-19" "$matching"

# A BRANCH whose name happens to start with v. This is the case that makes the
# ref-type guard load-bearing rather than redundant with the v* guard below it:
# the deploy workflows accept workflow_dispatch from any ref, so a dispatch
# from a branch like `v2-rewrite` would otherwise be read as a release tag,
# compared against the manifest, and refused.
assert_passes "a branch whose name starts with v is not gated" branch "v2-rewrite" "$matching"

# A mismatched manifest must still pass when the ref is not a tag — proves the
# early exit is reached rather than the comparison happening to agree.
mismatched="$(make_manifest mismatched '"version": "9.9.9",')"
assert_passes "a branch push is not gated even when versions differ" branch "main" "$mismatched"

# --- the manifest cannot be read -------------------------------------------
#
# Fail closed. A gate that passes when it cannot find the file it compares
# against is worse than no gate, because it reports having checked.

assert_fails "a missing manifest fails closed" tag "v1.2.4" "${tmpdir}/does-not-exist.json"
assert_output_contains "a missing manifest is reported clearly" "no manifest at" \
  tag "v1.2.4" "${tmpdir}/does-not-exist.json"

no_version="$(make_manifest no-version '')"
assert_fails "a manifest with no version fails closed" tag "v1.2.4" "$no_version"
assert_output_contains "an absent version is reported clearly" 'no "version"' \
  tag "v1.2.4" "$no_version"

# "version" present but only nested inside a dependency object — not the app
# version, and the parser must not surface it as one.
assert_fails "a nested version is not the app version" tag "v9.9.9" "$no_version"

# A non-string version (someone writes a number) must fail closed, not compare
# a stringified float.
non_string="${tmpdir}/non-string.json"
printf '{ "name": "@tarmoto/mobile", "version": 1.2 }\n' > "$non_string"
assert_fails "a non-string version fails closed" tag "v1.2" "$non_string"

# Malformed JSON must fail closed too (python exits non-zero under pipefail).
malformed="${tmpdir}/malformed.json"
printf '{ "name": "@tarmoto/mobile", "version": "1.2.4"' > "$malformed"
assert_fails "malformed JSON fails closed" tag "v1.2.4" "$malformed"

echo "check-release-tag tests passed"

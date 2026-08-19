#!/usr/bin/env python3
# ported from Studio81Labs/nexcue@2e0ee3e8
"""Compare a marketing version against the highest one already released.

Prints exactly one of: none, lower, equal, higher.

Why this is not a shell one-liner:

  * `sort -V` is a GNU extension. Apple's sort has grown it, but which release
    of macOS you get it on is not something a runbook should depend on, and the
    natural pipeline ends in `tail` — so where it is missing the assignment
    still succeeds with an empty string, the comparison reads false, and the
    App Store confirmation is silently skipped. Fail-open, inside a guard.
  * A lexical comparison puts 1.2.10 below 1.2.9.

Reads candidate versions on stdin, one per line, in `v<version>` form. The
caller supplies the set: `highest-released-build.sh --versions` unions git tags
with the pubspec version of every Mobile Release run, because a version built
from an untagged `workflow_dispatch` run and shipped to the App Store is
invisible to `git tag` alone.

Parsing matches `v<digits>[.<digits>...]` and ignores anything after, so
`v1.2.4+12`, `v1.2.4`, and `v1.2.4-rc1` all contribute 1.2.4. Lines that do not
start with a version (`vnext`) are skipped rather than failing the run: they
carry no version claim, and refusing them would block tagging on unrelated
history.

Comparison is per-component and length-aware, so 1.2 < 1.2.1.
"""

from __future__ import annotations

import re
import sys

_TAG = re.compile(r"v(\d+(?:\.\d+)*)")


def parse_version(text: str) -> tuple[int, ...]:
    """Parse a bare X.Y.Z into a comparable tuple. Raises on anything else."""
    if not re.fullmatch(r"\d+(?:\.\d+)*", text):
        raise ValueError(f"not a version: {text!r}")
    return tuple(int(part) for part in text.split("."))


def tag_versions(lines) -> set[tuple[int, ...]]:
    """Every version claimed by a `v*` line. Unversioned lines contribute none."""
    found = set()
    for line in lines:
        match = _TAG.match(line.strip())
        if match:
            found.add(parse_version(match.group(1)))
    return found


def compare(current: tuple[int, ...], tagged: set[tuple[int, ...]]) -> str:
    if not tagged:
        return "none"
    top = max(tagged)
    if current < top:
        return "lower"
    if current == top:
        return "equal"
    return "higher"


def _self_test() -> int:
    cases = [
        # (current, tags, expected)
        ("1.2.4", ["v1.2.4+12", "v1.2.3+9"], "equal"),
        ("1.2.5", ["v1.2.4+12"], "higher"),
        ("1.2.3", ["v1.2.4+12"], "lower"),
        # The regression this guard exists for: v1.2.5 tagged, pubspec back at
        # 1.2.4. An equality test reads false here and waves it through.
        ("1.2.4", ["v1.2.4+12", "v1.2.5+13"], "lower"),
        # Lexically "1.2.10" < "1.2.9"; numerically it is not. These need at
        # least TWO tags to be worth anything: with one tag, `max` returns it
        # whatever the ordering, so a lexical max would pass unnoticed.
        ("1.2.10", ["v1.2.9+30", "v1.2.10+31"], "equal"),
        ("1.2.11", ["v1.2.9+30", "v1.2.10+31"], "higher"),
        ("1.2.9", ["v1.2.9+30", "v1.2.10+31"], "lower"),
        ("1.10.0", ["v1.9.0+1", "v1.10.0+2"], "equal"),
        # Length-aware: a longer version with the same prefix is greater.
        ("1.2", ["v1.2.1+1"], "lower"),
        ("1.2.1", ["v1.2+1"], "higher"),
        # Beyond three components too — the parser accepts any length, so
        # padding-or-truncating to X.Y.Z must not creep in.
        ("1.2.3.4", ["v1.2.3.5+1"], "lower"),
        ("1.2.3.5", ["v1.2.3.4+1"], "higher"),
        # No versioned tags at all — a first release must not be blocked.
        ("1.0.0", [], "none"),
        ("1.0.0", ["vnext", "nightly"], "none"),
        # Non-version tags alongside real ones are ignored, not fatal.
        ("1.2.4", ["vnext", "v1.2.4+12"], "equal"),
        # Suffixed and bare tags both contribute their version.
        ("1.2.4", ["v1.2.4"], "equal"),
        ("1.2.4", ["v1.2.4-rc1"], "equal"),
        # The max is over all tags, not the last line.
        ("1.2.4", ["v1.2.9+40", "v1.2.4+12", "v1.1.0+2"], "lower"),
    ]
    failures = 0
    for current, tags, expected in cases:
        actual = compare(parse_version(current), tag_versions(tags))
        if actual != expected:
            failures += 1
            print(f"FAIL {current} vs {tags}: expected {expected}, got {actual}")
    # `int()` already rejects most of these, so the shape guard only earns its
    # place on what int() ACCEPTS: signs and surrounding whitespace, which
    # would otherwise yield a negative or silently-trimmed component.
    bad_inputs = ["", "1.2.x", "v1.2.3", "1.2.3+12", "1..2",
                  "1.2.-3", "1.2.+3", " 1.2.3", "1.2.3 ", "1.2.3\n"]
    for bad in bad_inputs:
        try:
            parse_version(bad)
        except ValueError:
            continue
        failures += 1
        print(f"FAIL parse_version({bad!r}) should have raised")
    print(f"{len(cases) + len(bad_inputs)} cases, {failures} failure(s)")
    return 1 if failures else 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return _self_test()
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <marketing-version>", file=sys.stderr)
        print(f"       {sys.argv[0]} --self-test", file=sys.stderr)
        return 2
    try:
        current = parse_version(sys.argv[1])
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(compare(current, tag_versions(sys.stdin)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

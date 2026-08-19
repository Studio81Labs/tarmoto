#!/usr/bin/env python3
# ported from Studio81Labs/nexcue@2e0ee3e8
"""Print the display name of every workflow that runs on a push to `main`.

This is the pre-tag release gate's source of truth (see
`docs/process/runbook.md` § Releasing to production). The gate must check every
such workflow, and the failure mode of getting it wrong is silent: a workflow
absent from the list is simply never verified, so a red run on it does not stop
a production tag.

It exists as a script rather than a snippet in the runbook because both cheaper
forms were tried and both were wrong. A hand-kept list omitted `OpenAPI Check`
and `Flutter Pin Check` — nine workflows, seven listed. Replacing it with
`grep 'branches: \\[main\\]'` matched only the inline spelling, so the equally
valid block form would have been dropped silently the first time anyone used
it. Both failures look like a working gate until the omitted workflow is the
one that breaks.

Trigger forms handled, all valid GitHub Actions and all meaning "runs on main":

    on: push                      # shorthand — `on` is a string
    on: [push, pull_request]      # shorthand — `on` is a list
    on:
      push:                       # mapping, no branch/tag filter => every branch
    on:
      push:
        branches: [main]          # inline sequence
    on:
      push:
        branches:                 # block sequence
          - main

`on` is read as both the string key and boolean `True`: YAML 1.1 parses the
bare key `on` as a boolean, so a parser asking only for `"on"` finds nothing at
all and reports that no workflow runs on main.

Branch filters are matched with GitHub's filter-pattern semantics, not string
equality and not shell glob: `["**"]`, `["m*"]`, `["ma?in"]` and
`["main", "!main-*"]` all behave as GitHub does. Note `?` and `+` are
quantifiers on the preceding character there, not wildcards, and `\` escapes a
special character for a literal match. An unparseable pattern is treated as
matching, on the same principle as below.

A `branches-ignore` filter that excludes main is honoured, and a `push` narrowed
to `tags:` is excluded — that fires on tag pushes only, never on a branch,
which is how `mobile-release.yml` is written. Anything else ambiguous is
treated as matching: over-reporting costs an operator one lookup, while
under-reporting costs a release.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover
    print(
        "::error::PyYAML is required. Run `pip install pyyaml`, or see "
        "flutter-pin-check.yml for the install-if-missing pattern CI uses.",
        file=sys.stderr,
    )
    sys.exit(1)

def _repo_root() -> Path:
    """The repository root, working even when this file is piped in on stdin.

    The release gate runs the parser as
    `git show "$SHA:scripts/ci/…" | python3 - --ref "$SHA"` so that BOTH the
    parser and the workflows come from the commit being released. Under that
    invocation `__file__` is `<stdin>`, so locating the root by walking up from
    it does not work.
    """
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        return Path(completed.stdout.strip())
    except (OSError, subprocess.CalledProcessError):
        return Path(__file__).resolve().parent.parent.parent


ROOT = _repo_root()
WORKFLOW_DIR = ROOT / ".github/workflows"
BRANCH = "main"


def _glob_to_regex(pattern: str) -> str:
    """GitHub's filter-pattern syntax, as a regex.

    Not traditional glob. Per GitHub's filter-pattern cheat sheet, `?` and `+`
    are QUANTIFIERS on the preceding character — `?` is zero or one of it, `+`
    is one or more — where a shell glob would read `?` as "any one character".
    `ma?in` therefore matches `main` and `min`, and NOT `mazin`.

    `*` matches zero or more characters but not `/`; `**` crosses `/`;
    `[...]` is a character class.
    """
    out: list[str] = []
    atoms: list[int] = []  # index in `out` where each quantifiable atom starts
    i = 0
    while i < len(pattern):
        char = pattern[i]
        # `\` escapes the following character. GitHub: "If a name contains any
        # of these characters and you want a literal match, you need to escape
        # each of these special characters with `\`" — the set being
        # `*`, `**`, `+`, `?`, `!`. It is consumed as ONE atom so a following
        # quantifier applies to the literal, not to the backslash: without
        # this, `\+` became `(?:\\)+` — one or more literal BACKSLASHES — and
        # a tag filter escaping the `+` in a build-qualified tag matched
        # nothing. A trailing lone backslash is a literal backslash.
        if char == "\\" and i + 1 < len(pattern):
            atoms.append(len(out))
            out.append(re.escape(pattern[i + 1]))
            i += 2
            continue
        if char in "?+":
            # Quantify the previous atom, not a fresh wildcard.
            if atoms:
                start = atoms[-1]
                atom = "".join(out[start:])
                del out[start:]
                out.append(f"(?:{atom}){char}")
                atoms[-1] = len(out) - 1
            i += 1
            continue

        atoms.append(len(out))
        if char == "*":
            if pattern.startswith("**", i):
                # `**/` matches ZERO OR MORE leading directories, so `**/main`
                # matches the root `main`. Translating to a bare `.*` would
                # leave `.*/main`, which requires a slash and misses it.
                if pattern.startswith("**/", i):
                    out.append("(?:.*/)?")
                    i += 3
                else:
                    out.append(".*")
                    i += 2
                continue
            out.append("[^/]*")
        elif char == "[":
            close = pattern.find("]", i)
            if close == -1:
                out.append(re.escape(char))
            else:
                body = pattern[i + 1 : close]
                out.append(f"[{body}]")
                i = close + 1
                continue
        else:
            out.append(re.escape(char))
        i += 1
    return "".join(out)


def _matches(pattern: object, name: str) -> bool:
    if not isinstance(pattern, str):
        return False
    try:
        return re.fullmatch(_glob_to_regex(pattern), name) is not None
    except re.error:
        # Unparseable pattern: treat as matching. Over-reporting costs the
        # operator a lookup; under-reporting drops a workflow from the gate.
        return True


def _as_list(value: object) -> list[object] | None:
    """A filter may be written as a scalar: `branches: main` is one pattern."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [value]
    return None


def _selected(patterns: object, name: str, *, default: bool) -> bool:
    """Apply a GitHub branch filter, honouring `!` negation in order."""
    items = _as_list(patterns)
    if items is None:
        return default
    result = default
    for pattern in items:
        if isinstance(pattern, str) and pattern.startswith("!"):
            if _matches(pattern[1:], name):
                result = False
        elif _matches(pattern, name):
            result = True
    return result


def _display_name(document: object, label: str) -> str:
    """The name GitHub shows, which is what `gh run list` reports and filters on.

    GitHub: "If you omit `name`, GitHub displays the workflow file path
    relative to the root of the repository." Not the stem and not the bare
    filename — both would make the gate look for a run name that never appears,
    so step 3 reads the workflow as missing and step 7's fan-out never matches,
    blocking every release until someone adds a `name:`.
    """
    name = document.get("name") if isinstance(document, dict) else None
    return str(name) if name else label


def _duplicate_names(pairs: list[tuple[str, str]]) -> dict[str, list[str]]:
    """Display names claimed by more than one selected workflow.

    GitHub does not require `name:` to be unique across workflow files, but the
    release gate matches runs to expectations BY display name — `gh run list`
    reports the name, not the file. Two workflows sharing one are therefore
    indistinguishable to the gate: with the names deduplicated on both sides,
    one can be entirely absent while the other succeeds and the check passes.
    Refuse rather than guess; renaming one is a one-line fix.
    """
    by_name: dict[str, list[str]] = {}
    for name, label in pairs:
        by_name.setdefault(name, []).append(label)
    return {name: labels for name, labels in by_name.items() if len(labels) > 1}


def _triggers(document: object) -> object:
    """The `on:` value, whichever way YAML decided to key it."""
    if not isinstance(document, dict):
        return None
    if "on" in document:
        return document["on"]
    return document.get(True)


def _runs_on_main(triggers: object) -> bool:
    # `on: push`
    if isinstance(triggers, str):
        return triggers == "push"
    # `on: [push, ...]`
    if isinstance(triggers, list):
        return "push" in triggers
    if not isinstance(triggers, dict):
        return False

    if "push" not in triggers:
        return False
    push = triggers["push"]

    # `push:` with no filters — every branch, so including main.
    if not isinstance(push, dict):
        return True

    # An `-ignore` filter that does NOT match is a positive answer, not a
    # fall-through: `branches-ignore: [develop]` means every branch except
    # develop, so main runs. Returning here rather than falling through is what
    # makes that hold when a tag filter is ALSO present — the fall-through
    # below rejects on the mere existence of one.
    ignored = push.get("branches-ignore")
    if ignored is not None:
        return not _selected(ignored, BRANCH, default=False)

    branches = push.get("branches")
    if branches is not None:
        return _selected(branches, BRANCH, default=False)

    # Neither branch filter is present. That is unrestricted ONLY if the
    # trigger is not already narrowed to tags: `push: {tags: ["v*"]}` fires on
    # tag pushes and never on a branch, which is how mobile-release.yml is
    # written.
    return "tags" not in push and "tags-ignore" not in push


def _runs_on_tag(triggers: object, tag: str) -> bool:
    """Does a push of `tag` run this workflow?

    Mirrors `_runs_on_main` with branches and tags swapped. Step 7 of the
    release gate needs this to derive the tag fan-out instead of typing it —
    the same rule step 3 already follows, and for the same reason: a typed list
    is silently wrong the day a surface is added or removed.
    """
    # `on: push` / `on: [push, ...]` — unfiltered, so tag pushes included.
    if isinstance(triggers, str):
        return triggers == "push"
    if isinstance(triggers, list):
        return "push" in triggers
    if not isinstance(triggers, dict):
        return False

    if "push" not in triggers:
        return False
    push = triggers["push"]

    # `push:` with no filters — every ref, tags included.
    if not isinstance(push, dict):
        return True

    # Mirror of the branch side: a `tags-ignore` that does not match means this
    # tag runs, even when a `branches:` filter is also present.
    ignored = push.get("tags-ignore")
    if ignored is not None:
        return not _selected(ignored, tag, default=False)

    tags = push.get("tags")
    if tags is not None:
        return _selected(tags, tag, default=False)

    # Neither tag filter is present. Unrestricted ONLY if the trigger is not
    # already narrowed to branches: `push: {branches: [main]}` never fires on a
    # tag push.
    return "branches" not in push and "branches-ignore" not in push


# GitHub's filter-pattern semantics, pinned. `?` and `+` quantify the preceding
# character rather than matching one — the difference that made `ma?in` fail to
# match `main` here while Actions matched it. Run with --self-test.
_PATTERN_CASES: tuple[tuple[str, str, bool], ...] = (
    ("main", "main", True),
    ("ma?in", "main", True),      # a? = zero or one 'a'
    ("ma?in", "min", True),
    ("ma?in", "mazin", False),    # ? is NOT "any character"
    # `\` escapes a special character for a literal match. The escaped
    # character is one atom, so a quantifier after it applies to the literal.
    (r"feature\*", "feature*", True),
    (r"feature\*", "feature", False),
    (r"feature\*", "featureX", False),
    (r"v\+", "v+", True),
    (r"v\+", "v", False),
    (r"v\+", "vv", False),
    (r"a\?b", "a?b", True),
    (r"a\?b", "ab", False),
    (r"v[0-9]+.[0-9]+.[0-9]+\+[0-9]+", "v1.2.4+12", True),
    (r"v[0-9]+.[0-9]+.[0-9]+\+[0-9]+", "v1.2.4-12", False),
    (r"feature\*+", "feature**", True),   # escaped atom, then a quantifier
    (r"feature\*+", "feature", False),
    (r"\!main", "!main", True),           # literal `!`, not a negation
    ("main\\", "main\\", True),            # trailing lone backslash
    ("ma?n", "main", False),      # the case an earlier test got backwards
    ("m*", "main", True),
    ("*", "main", True),
    ("**", "main", True),
    ("feature/*", "feature/x", True),
    ("feature/*", "feature/a/b", False),   # * stops at /
    ("feature/**", "feature/a/b", True),   # ** crosses it
    ("v2*", "v2.0", True),
    ("v[12].[0-9]+.[0-9]+", "v1.10.1", True),
    ("v[12].[0-9]+.[0-9]+", "v3.0.0", False),
    ("mai+n", "main", True),
    ("mai+n", "maiin", True),
    # `**/` spans zero directories as well as many.
    ("**/main", "main", True),
    ("**/main", "releases/main", True),
    ("**/main", "a/b/main", True),
    ("**/main", "mainline", False),
    ("releases/**", "releases/1.0", True),
)

_SELECT_CASES: tuple[tuple[tuple[str, ...], bool], ...] = (
    (("main",), True),
    (("**",), True),
    (("develop",), False),
    (("main", "!main"), False),      # later pattern wins
    (("!main", "main"), True),       # ...in both directions
    (("**", "!main"), False),
)

# A filter may be a scalar rather than a sequence: `branches: main`.
_SCALAR_CASES: tuple[tuple[str, bool], ...] = (
    ("main", True),
    ("m*", True),
    ("develop", False),
)


_TAG_TRIGGER_CASES: tuple[tuple[object, str, bool], ...] = (
    ({"push": {"tags": ["v*"]}}, "v1.2.4+12", True),
    ({"push": {"tags": ["v*"]}}, "nightly", False),
    # Narrowed to branches — a tag push never runs it. This is the shape of
    # every CI workflow here, and it is the distinction a typed fan-out list
    # cannot express.
    ({"push": {"branches": ["main"]}}, "v1.0.0", False),
    ({"push": {"branches-ignore": ["wip"]}}, "v1.0.0", False),
    # Unfiltered push fires on tags too.
    ("push", "v1.0.0", True),
    (["push"], "v1.0.0", True),
    ({"push": None}, "v1.0.0", True),
    ({"push": {}}, "v1.0.0", True),
    # tags-ignore, and negation order inside tags.
    ({"push": {"tags-ignore": ["v*-rc*"]}}, "v1.0.0", True),
    ({"push": {"tags-ignore": ["v*"]}}, "v1.0.0", False),
    ({"push": {"tags": ["v*", "!v0.*"]}}, "v1.2.0", True),
    ({"push": {"tags": ["v*", "!v0.*"]}}, "v0.9.0", False),
    # BOTH dimensions filtered. Every case above varies one dimension with the
    # other absent, which is why a fall-through that rejects on the mere
    # presence of a branch filter survived them all.
    ({"push": {"tags": ["v*"], "branches": ["main"]}}, "v1.0.0", True),
    ({"push": {"tags": ["x*"], "branches": ["main"]}}, "v1.0.0", False),
    ({"push": {"tags-ignore": ["nightly"], "branches": ["main"]}}, "v1.0.0", True),
    ({"push": {"tags-ignore": ["v*"], "branches": ["main"]}}, "v1.0.0", False),
    ({"push": {"tags-ignore": ["nightly"], "branches-ignore": ["dev"]}}, "v1.0.0", True),
    ({"push": {"tags": ["v*"], "branches-ignore": ["dev"]}}, "v1.0.0", True),
    # Not a push trigger at all. The list form needs a NEGATIVE case: with
    # only `["push"]` present, `return True` passes every assertion.
    ({"workflow_dispatch": None}, "v1.0.0", False),
    ({"pull_request": {"branches": ["main"]}}, "v1.0.0", False),
    (["pull_request"], "v1.0.0", False),
    (["workflow_dispatch", "schedule"], "v1.0.0", False),
    ("workflow_dispatch", "v1.0.0", False),
    (None, "v1.0.0", False),
)

# The branch predicate had no direct cases at all — only `_matches` and
# `_selected` did — so a mutation to `_runs_on_main` itself went unnoticed.
_MAIN_TRIGGER_CASES: tuple[tuple[object, bool], ...] = (
    ({"push": {"branches": ["main"]}}, True),
    ({"push": {"branches": ["release/*"]}}, False),
    ({"push": {"branches-ignore": ["main"]}}, False),
    ({"push": {"branches-ignore": ["wip/*"]}}, True),
    # Narrowed to tags — fires on tag pushes only, which is mobile-release.yml.
    ({"push": {"tags": ["v*"]}}, False),
    ({"push": {"tags-ignore": ["v*"]}}, False),
    # BOTH dimensions filtered — the mirror gap.
    ({"push": {"branches-ignore": ["develop"], "tags": ["v*"]}}, True),
    ({"push": {"branches-ignore": ["main"], "tags": ["v*"]}}, False),
    ({"push": {"branches": ["main"], "tags": ["v*"]}}, True),
    ({"push": {"branches": ["release/*"], "tags": ["v*"]}}, False),
    ({"push": {"branches-ignore": ["develop"], "tags-ignore": ["x"]}}, True),
    ({"push": {"branches": ["main"], "tags-ignore": ["x"]}}, True),
    ({"push": None}, True),
    ({"push": {}}, True),
    ("push", True),
    (["push"], True),
    (["pull_request"], False),
    ("workflow_dispatch", False),
    ({"pull_request": {"branches": ["main"]}}, False),
    (None, False),
)


_DISPLAY_NAME_CASES: tuple[tuple[object, str, str], ...] = (
    ({"name": "Backend CI"}, ".github/workflows/backend-ci.yml", "Backend CI"),
    # Omitted / empty / null `name:` all fall back to the repo-relative PATH.
    ({}, ".github/workflows/backend-ci.yml", ".github/workflows/backend-ci.yml"),
    ({"name": None}, ".github/workflows/a.yml", ".github/workflows/a.yml"),
    ({"name": ""}, ".github/workflows/a.yml", ".github/workflows/a.yml"),
    (None, ".github/workflows/a.yml", ".github/workflows/a.yml"),
    ("not-a-mapping", ".github/workflows/a.yml", ".github/workflows/a.yml"),
    # Neither the stem nor the bare filename is correct.
    ({}, ".github/workflows/deploy.yaml", ".github/workflows/deploy.yaml"),
    ({"name": 123}, ".github/workflows/a.yml", "123"),
)


_DUPLICATE_CASES: tuple[tuple[tuple[tuple[str, str], ...], tuple[str, ...]], ...] = (
    ((("A", "a.yml"), ("B", "b.yml")), ()),
    ((("A", "a.yml"), ("A", "b.yml")), ("A",)),
    ((("A", "a.yml"), ("A", "b.yml"), ("A", "c.yml")), ("A",)),
    ((("A", "a.yml"), ("B", "b.yml"), ("A", "c.yml"), ("B", "d.yml")), ("A", "B")),
    ((), ()),
    ((("A", "a.yml"),), ()),
)


def _self_test() -> int:
    failures = 0
    for pattern, name, expected in _PATTERN_CASES:
        actual = _matches(pattern, name)
        if actual != expected:
            failures += 1
            print(f"FAIL {pattern!r} vs {name!r}: {actual} != {expected}")
    for patterns, expected in _SELECT_CASES:
        actual = _selected(list(patterns), BRANCH, default=False)
        if actual != expected:
            failures += 1
            print(f"FAIL {list(patterns)!r}: {actual} != {expected}")
    for scalar, expected in _SCALAR_CASES:
        actual = _selected(scalar, BRANCH, default=False)
        if actual != expected:
            failures += 1
            print(f"FAIL scalar {scalar!r}: {actual} != {expected}")
    for triggers, tag, expected in _TAG_TRIGGER_CASES:
        actual = _runs_on_tag(triggers, tag)
        if actual != expected:
            failures += 1
            print(f"FAIL tag {triggers!r} vs {tag!r}: {actual} != {expected}")
    # Label SHAPE is a filesystem behaviour, so it is checked against the real
    # tree rather than a fixture — the cases below receive labels directly and
    # cannot see `_sources` handing back a bare filename. Skipping is reported
    # rather than silent: an absent check must not read as a passing one.
    if WORKFLOW_DIR.is_dir():
        stray = [label for label, _ in _sources(None)
                 if not label.startswith(".github/workflows/")]
        if stray:
            failures += 1
            print(f"FAIL labels are not repo-relative: {stray[:3]}")
    else:
        print(f"NOTE label shape unchecked: {WORKFLOW_DIR} not present")

    for document, label, expected in _DISPLAY_NAME_CASES:
        actual = _display_name(document, label)
        if actual != expected:
            failures += 1
            print(f"FAIL display_name {document!r}, {label!r}: "
                  f"{actual!r} != {expected!r}")
    for pairs, expected in _DUPLICATE_CASES:
        actual = sorted(_duplicate_names(list(pairs)))
        if actual != sorted(expected):
            failures += 1
            print(f"FAIL duplicates {pairs!r}: {actual} != {sorted(expected)}")
    for triggers, expected in _MAIN_TRIGGER_CASES:
        actual = _runs_on_main(triggers)
        if actual != expected:
            failures += 1
            print(f"FAIL main {triggers!r}: {actual} != {expected}")
    total = (len(_PATTERN_CASES) + len(_SELECT_CASES) + len(_SCALAR_CASES)
             + len(_TAG_TRIGGER_CASES) + len(_MAIN_TRIGGER_CASES)
             + len(_DUPLICATE_CASES) + len(_DISPLAY_NAME_CASES))
    print(f"{total - failures}/{total} pattern cases pass")
    return 1 if failures else 0


def _git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def _sources(ref: str | None) -> list[tuple[str, str]]:
    """(display path, contents) for each workflow file, from `ref` or the tree."""
    if ref is None:
        # Repo-relative, matching the `--ref` branch below. Not cosmetic: an
        # unnamed workflow falls back to this string, and GitHub's fallback is
        # the path relative to the repository root — so a bare filename here
        # would make the two invocations disagree about the same workflow.
        return [
            (str(path.relative_to(ROOT)), path.read_text())
            for path in sorted(WORKFLOW_DIR.glob("*.y*ml"))
        ]

    listing = _git("ls-tree", "--name-only", "-r", ref, ".github/workflows/")
    paths = [
        line
        for line in listing.splitlines()
        if line.endswith((".yml", ".yaml"))
    ]
    return [(path, _git("show", f"{ref}:{path}")) for path in sorted(paths)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ref",
        help=(
            "Read the workflows from this commit instead of the working tree. "
            "The release gate passes the SHA being tagged: `git fetch` updates "
            "origin/main but not the checkout, so a stale or feature-branch "
            "worktree would otherwise derive the wrong set of workflows."
        ),
    )
    parser.add_argument(
        "--tag",
        help=(
            "List the workflows a push of this TAG runs, instead of those a "
            "push to main runs. Step 7 of the release gate derives the tag "
            "fan-out this way rather than typing the four names."
        ),
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Check the filter-pattern matcher against GitHub's documented cases.",
    )
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    if args.ref is None and not WORKFLOW_DIR.is_dir():
        print(f"::error::{WORKFLOW_DIR} not found", file=sys.stderr)
        return 1

    try:
        sources = _sources(args.ref)
    except RuntimeError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1

    selected_pairs: list[tuple[str, str]] = []
    for label, text in sources:
        try:
            document = yaml.safe_load(text)
        except yaml.YAMLError as error:
            # Refuse rather than skip: an unparseable workflow is exactly the
            # case where quietly returning a short list is most dangerous.
            print(f"::error::{label} is not valid YAML: {error}", file=sys.stderr)
            return 1
        selected = (
            _runs_on_tag(_triggers(document), args.tag)
            if args.tag is not None
            else _runs_on_main(_triggers(document))
        )
        if selected:
            selected_pairs.append((_display_name(document, label), label))

    if not selected_pairs:
        target = f"tag {args.tag}" if args.tag is not None else "main"
        print(f"::error::no workflows found running on {target} — refusing",
              file=sys.stderr)
        return 1

    duplicates = _duplicate_names(selected_pairs)
    if duplicates:
        for name, labels in sorted(duplicates.items()):
            print(f"::error::display name {name!r} is used by {', '.join(labels)}"
                  " — the release gate matches runs by name and cannot tell them"
                  " apart; rename one", file=sys.stderr)
        return 1

    print("\n".join(name for name, _ in selected_pairs))
    return 0


if __name__ == "__main__":
    sys.exit(main())

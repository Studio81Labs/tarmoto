#!/usr/bin/env python3
"""Guard Podfile.lock against the React Native dependency set — on Linux.

The React Native analog of the siblings' `check-podfile-lock.py` (their
Flutter plugin-set check): the macOS preview job proves the pod RESOLUTION
compiles, but it runs only on pushes to main — so the drift that merges
green is exactly the drift a pull request never exercises. #1250 was this
class: a dependency refresh bumped react-native without a `pod install`,
the stranded Podfile.lock merged green, and every fresh runner failed for
a week. #1257's new native module was only caught because the dispatch
rehearsal was run by hand.

What this asserts, from `package.json` + `node_modules` + `ios/Podfile.lock`,
with no CocoaPods and no macOS:

  1. PRESENCE — every direct dependency shipping a root-level `*.podspec`
     (the convention React Native autolinking discovers, and the shape
     `use_react_native!` installs for react-native itself) has that pod in
     the lock. Catches "added a native dependency, never ran pod install".
  2. CURRENCY — where the podspec versions itself from `package.json`
     (`package['version']`, the RN library convention; 25 of 29 podspecs in
     this tree), the locked version must equal the installed package
     version. Catches the stranded-lock class (#1250/#1234) BEFORE merge.
     Podspecs that version differently are presence-checked only — a guard
     that guesses cries wolf, and a check that cries wolf gets disabled.
  3. ORPHANS — every `EXTERNAL SOURCES` entry whose `:path:` points into
     `node_modules/<dep>` must point at a dependency that still exists.
     Catches "removed a native dependency, never ran pod install".

The fix for every finding is the same and the error says so:

    cd apps/mobile/ios && bundle exec pod install   # then commit Podfile.lock

Usage:  check-rn-pods.py [--mobile-dir apps/mobile] | --self-test
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

PODS_ENTRY = re.compile(r'^  - "?([^"\s(]+)"? \(([^)]+)\)"?:?$')
EXTERNAL_PATH = re.compile(r'^\s+:path:\s+"?([^"\n]+)"?\s*$')
VERSION_FROM_PACKAGE = re.compile(r"package\s*\[\s*['\"]version['\"]")


def parse_lock(lock_text: str) -> tuple[dict[str, str], dict[str, str]]:
    """Return (top-level PODS name -> version, EXTERNAL SOURCES pod -> :path)."""
    pods: dict[str, str] = {}
    external: dict[str, str] = {}
    section = None
    current_external: str | None = None
    for line in lock_text.splitlines():
        if line and not line.startswith(" "):
            section = line.rstrip(":")
            current_external = None
            continue
        if section == "PODS":
            m = PODS_ENTRY.match(line)
            if m:
                # Subspecs list as Parent/Child; the parent entry is what the
                # dependency set maps to.
                name = m.group(1)
                if "/" not in name:
                    pods[name] = m.group(2)
        elif section == "EXTERNAL SOURCES":
            if re.match(r"^  \S", line):
                current_external = line.strip().rstrip(":")
            elif current_external:
                m = EXTERNAL_PATH.match(line)
                if m:
                    external[current_external] = m.group(1)
    return pods, external


def dep_of_external_path(path: str) -> str | None:
    """`../node_modules/@scope/pkg/...` -> `@scope/pkg`; None if not node_modules."""
    parts = path.replace("\\", "/").split("/")
    try:
        i = parts.index("node_modules")
    except ValueError:
        return None
    rest = parts[i + 1 :]
    if not rest:
        return None
    if rest[0].startswith("@"):
        return "/".join(rest[:2]) if len(rest) >= 2 else None
    return rest[0]


def check(mobile_dir: Path) -> list[str]:
    errors: list[str] = []
    manifest = json.loads((mobile_dir / "package.json").read_text())
    deps: dict[str, str] = manifest.get("dependencies", {})
    lock_path = mobile_dir / "ios" / "Podfile.lock"
    pods, external = parse_lock(lock_path.read_text())

    fix = "cd apps/mobile/ios && bundle exec pod install  # then commit Podfile.lock"

    for dep in sorted(deps):
        root = mobile_dir / "node_modules" / dep
        if not root.is_dir():
            # Not installed locally — presence in the lock can't be judged.
            continue
        pkg_version = None
        pkg_json = root / "package.json"
        if pkg_json.is_file():
            pkg_version = json.loads(pkg_json.read_text()).get("version")
        for spec in sorted(root.glob("*.podspec")):
            pod = spec.stem
            if pod not in pods:
                errors.append(
                    f"{dep} ships {spec.name} but pod '{pod}' is not in "
                    f"Podfile.lock — a native dependency was added or renamed "
                    f"without a pod install. Fix: {fix}"
                )
                continue
            if pkg_version and VERSION_FROM_PACKAGE.search(
                spec.read_text(errors="ignore")
            ):
                locked = pods[pod]
                if locked != pkg_version:
                    errors.append(
                        f"Podfile.lock has {pod} ({locked}) but {dep} is "
                        f"{pkg_version} — the lock is stale (the #1250 class: "
                        f"a JS-side bump without a pod install). Fix: {fix}"
                    )

    for pod, path in sorted(external.items()):
        dep = dep_of_external_path(path)
        if dep is None:
            continue
        if dep not in deps:
            errors.append(
                f"Podfile.lock's EXTERNAL SOURCES still points {pod} at "
                f"node_modules/{dep}, which is no longer a dependency — a "
                f"native dependency was removed without a pod install. Fix: {fix}"
            )

    return errors


# ── self-test ────────────────────────────────────────────────────────────

LOCK_TEMPLATE = """PODS:
  - GoodPod (1.2.3):
    - OtherPod
  - GoodPod/Sub (1.2.3)
  - NoPkgVersionPod (9.9.9)
  - OtherPod (2.0.0)

DEPENDENCIES:
  - GoodPod (from `../node_modules/good-lib`)
  - NoPkgVersionPod (from `../node_modules/odd-lib`)
  - OtherPod (from `../node_modules/@scope/other-lib`)

EXTERNAL SOURCES:
  GoodPod:
    :path: "../node_modules/good-lib"
  NoPkgVersionPod:
    :path: "../node_modules/odd-lib"
  OtherPod:
    :path: "../node_modules/@scope/other-lib"

SPEC CHECKSUMS:
  GoodPod: abc

COCOAPODS: 1.16.2
"""


def _write_dep(nm: Path, dep: str, pod: str, version: str, from_pkg: bool) -> None:
    root = nm / dep
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(json.dumps({"name": dep, "version": version}))
    body = (
        "Pod::Spec.new do |s|\n"
        + (
            "  package = JSON.parse(File.read('package.json'))\n"
            "  s.version = package['version']\n"
            if from_pkg
            else "  s.version = '9.9.9'\n"
        )
        + "end\n"
    )
    (root / f"{pod}.podspec").write_text(body)


def _fixture(
    tmp: Path,
    deps: dict[str, str],
    lock: str = LOCK_TEMPLATE,
) -> Path:
    mobile = tmp / "mobile"
    (mobile / "ios").mkdir(parents=True)
    (mobile / "package.json").write_text(json.dumps({"dependencies": deps}))
    (mobile / "ios" / "Podfile.lock").write_text(lock)
    return mobile


def self_test() -> int:
    cases_run = 0

    def expect(label: str, errors: list[str], *needles: str) -> None:
        nonlocal cases_run
        cases_run += 1
        if not needles:
            assert errors == [], f"{label}: expected clean, got {errors}"
        else:
            assert len(errors) == len(needles), (
                f"{label}: expected {len(needles)} finding(s), got {errors}"
            )
            for needle in needles:
                assert any(needle in e for e in errors), (
                    f"{label}: no finding mentions '{needle}': {errors}"
                )

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)

        # 1. Everything agrees — clean.
        m = _fixture(
            tmp / "ok",
            {"good-lib": "^1.0.0", "odd-lib": "^3.0.0", "@scope/other-lib": "^2.0.0"},
        )
        nm = m / "node_modules"
        _write_dep(nm, "good-lib", "GoodPod", "1.2.3", from_pkg=True)
        _write_dep(nm, "odd-lib", "NoPkgVersionPod", "3.1.4", from_pkg=False)
        _write_dep(nm, "@scope/other-lib", "OtherPod", "2.0.0", from_pkg=True)
        expect("clean tree", check(m))

        # 2. New native dependency, no pod install — missing pod.
        _write_dep(nm, "new-lib", "BrandNewPod", "0.1.0", from_pkg=True)
        manifest = json.loads((m / "package.json").read_text())
        manifest["dependencies"]["new-lib"] = "^0.1.0"
        (m / "package.json").write_text(json.dumps(manifest))
        expect("missing pod", check(m), "BrandNewPod")

        # 3. Stale lock — the #1250 class (bump without pod install).
        m2 = _fixture(
            tmp / "stale",
            {"good-lib": "^1.0.0", "odd-lib": "^3.0.0", "@scope/other-lib": "^2.0.0"},
        )
        nm2 = m2 / "node_modules"
        _write_dep(nm2, "good-lib", "GoodPod", "1.3.0", from_pkg=True)
        _write_dep(nm2, "odd-lib", "NoPkgVersionPod", "3.1.4", from_pkg=False)
        _write_dep(nm2, "@scope/other-lib", "OtherPod", "2.0.0", from_pkg=True)
        expect("stale version", check(m2), "GoodPod (1.2.3)")

        # 4. A podspec that does NOT version from package.json is
        #    presence-checked only — no false positive on 9.9.9 vs 3.1.4.
        m3 = _fixture(tmp / "oddver", {"odd-lib": "^3.0.0"})
        _write_dep(m3 / "node_modules", "odd-lib", "NoPkgVersionPod", "3.1.4", from_pkg=False)
        lock = LOCK_TEMPLATE.replace(
            'GoodPod:\n    :path: "../node_modules/good-lib"\n  ', ""
        ).replace(
            'OtherPod:\n    :path: "../node_modules/@scope/other-lib"\n', ""
        )
        (m3 / "ios" / "Podfile.lock").write_text(lock)
        expect("non-package-versioned pod skipped", check(m3))

        # 5. Removed dependency, lock still points at it — orphan.
        m4 = _fixture(tmp / "orphan", {"good-lib": "^1.0.0", "odd-lib": "^3.0.0"})
        nm4 = m4 / "node_modules"
        _write_dep(nm4, "good-lib", "GoodPod", "1.2.3", from_pkg=True)
        _write_dep(nm4, "odd-lib", "NoPkgVersionPod", "3.1.4", from_pkg=False)
        expect("orphaned scoped dep", check(m4), "@scope/other-lib")

        # 6. Scoped dependency resolves through the two-segment path.
        m5 = _fixture(tmp / "scoped", {"@scope/other-lib": "^2.0.0"})
        _write_dep(m5 / "node_modules", "@scope/other-lib", "OtherPod", "2.0.0", from_pkg=True)
        lock = LOCK_TEMPLATE.replace(
            'GoodPod:\n    :path: "../node_modules/good-lib"\n  ', ""
        ).replace(
            'NoPkgVersionPod:\n    :path: "../node_modules/odd-lib"\n  ', ""
        )
        (m5 / "ios" / "Podfile.lock").write_text(lock)
        expect("scoped dep clean", check(m5))

        # 7. A dependency that is not installed locally is skipped, not failed
        #    (partial installs must not fake findings).
        m6 = _fixture(tmp / "uninstalled", {"good-lib": "^1.0.0", "ghost-lib": "^1.0.0"})
        _write_dep(m6 / "node_modules", "good-lib", "GoodPod", "1.2.3", from_pkg=True)
        lock = LOCK_TEMPLATE.replace(
            'NoPkgVersionPod:\n    :path: "../node_modules/odd-lib"\n  ', ""
        ).replace('OtherPod:\n    :path: "../node_modules/@scope/other-lib"\n', "")
        (m6 / "ios" / "Podfile.lock").write_text(lock)
        expect("uninstalled dep skipped", check(m6))

    print(f"check-rn-pods self-test passed ({cases_run} cases).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mobile-dir", default="apps/mobile", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    errors = check(args.mobile_dir)
    if errors:
        for e in errors:
            print(f"::error::{e}")
        return 1
    print("Podfile.lock matches the native dependency set.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

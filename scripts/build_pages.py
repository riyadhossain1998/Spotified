"""Assemble the static GitHub Pages site into _site/.

Used by both .github/workflows/pages.yml and humans:

    python scripts/build_pages.py && python -m http.server -d _site 8080

The demo deliberately has no copies of the CSS or the D3 view in docs/. It
reuses app/static/ verbatim, so the deployed demo can never drift from the code
the real app runs. This script is the only thing that knows how the two halves
are stitched together.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
STATIC = ROOT / "app" / "static"

# Assets the demo actually loads. Listing them rather than copying all of
# app/static keeps the published site from carrying dead weight, and means a
# future server-only module is not silently exposed.
CSS = ["base.css", "graph.css", "playlists.css"]
JS = [
    "analytics.js",
    "format.js",
    "graph/artistNetworkView.js",
    "graph/chrome.js",
    "graph/detailPanel.js",
    "pages/demoPage.js",
]

# Must stay in step with the `payload` docs/index.html hands to initDemoPage.
DEMO_PAYLOAD = "demo-graph.json"

# The picker's source of truth, written by scripts/build_graphs.py.
GRAPH_MANIFEST = Path("graphs") / "index.json"


def build(output: Path) -> int:
    if not (DOCS / "index.html").exists():
        print(f"Missing {DOCS / 'index.html'}", file=sys.stderr)
        return 1

    # The demo has no Spotify token and so cannot rebuild from tracks the way
    # the live page does. Checking here turns a missing payload into a build
    # failure rather than a 404 in front of a visitor.
    payload = DOCS / DEMO_PAYLOAD
    if not payload.exists():
        print(
            f"Missing {payload}. Generate it first:\n"
            f"  python scripts/make_demo_graph.py <legacy.json> docs/{DEMO_PAYLOAD}",
            file=sys.stderr,
        )
        return 1

    # The manifest is checked but not required. A missing one is a degraded
    # site, not a broken one -- initDemoPage falls back to DEMO_PAYLOAD and the
    # picker hides itself -- so failing the build here would block a deploy over
    # something a visitor would not notice.
    manifest = DOCS / GRAPH_MANIFEST
    if not manifest.exists():
        print(
            f"Warning: no {manifest}, publishing the single-graph demo only.\n"
            "  Generate it with: python scripts/build_graphs.py",
            file=sys.stderr,
        )
    else:
        missing = [
            entry["file"]
            for entry in json.loads(manifest.read_text(encoding="utf-8"))
            if not (manifest.parent / entry["file"]).exists()
        ]
        # A manifest listing a file that is not there is the one failure the
        # visitor *does* see: the tile renders, the click 404s. Cheap to catch.
        if missing:
            print(
                f"Manifest lists missing payload(s): {', '.join(missing)}",
                file=sys.stderr,
            )
            return 1

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    # Everything hand-written for the demo.
    for item in DOCS.iterdir():
        target = output / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)

    # Shared assets, copied from the single source of truth.
    copied = 0
    for relative in CSS:
        destination = output / "static" / "css" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATIC / "css" / relative, destination)
        copied += 1

    for relative in JS:
        destination = output / "static" / "js" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATIC / "js" / relative, destination)
        copied += 1

    # Jekyll would otherwise ignore files and folders beginning with _.
    (output / ".nojekyll").touch()

    total = sum(f.stat().st_size for f in output.rglob("*") if f.is_file())
    print(f"Built {output} — {copied} shared assets, {total / 1024:.0f} KB total")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=ROOT / "_site", help="output directory"
    )
    args = parser.parse_args()
    return build(args.output)


if __name__ == "__main__":
    raise SystemExit(main())

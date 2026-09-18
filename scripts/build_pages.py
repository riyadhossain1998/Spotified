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

# Must stay in step with the `payloads` map docs/index.html hands to
# initDemoPage.
PAYLOADS = {
    "artist": "demo-graph.json",
    "genre": "demo-graph-genre.json",
}


def build(output: Path) -> int:
    if not (DOCS / "index.html").exists():
        print(f"Missing {DOCS / 'index.html'}", file=sys.stderr)
        return 1

    # One payload per mode, because the demo has no Spotify token and so cannot
    # rebuild from tracks the way the live page does. Both are required: the
    # mode switch fetches the genre file on click, so a missing one is a 404 in
    # front of a visitor rather than a failure here.
    for mode in ("artist", "genre"):
        payload = DOCS / PAYLOADS[mode]
        if not payload.exists():
            print(
                f"Missing {payload}. Generate it first:\n"
                f"  python scripts/make_demo_graph.py --mode {mode} "
                f"<legacy.json> docs/{PAYLOADS[mode]}",
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

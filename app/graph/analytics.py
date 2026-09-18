"""Aggregate statistics over a built graph.

Pandas earns its place here rather than in the pair-building loop. Pair
generation is a dict accumulation that plain Python does faster than a
DataFrame round trip; ranking, grouping and bucketing hundreds of rows is
exactly what a DataFrame is for.

Output feeds the graph page header, and the release-year / popularity
histograms are the data behind the planned popularity bar chart.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pandas as pd

if TYPE_CHECKING:
    from app.graph.models import Graph

TOP_N = 10

POPULARITY_BINS = [0, 20, 40, 60, 80, 100]
POPULARITY_LABELS = ["0-20", "20-40", "40-60", "60-80", "80-100"]


def summarise(graph: "Graph") -> dict[str, Any]:
    """Compute headline numbers plus a few leaderboards."""
    nodes_df = pd.DataFrame([n.to_dict() for n in graph.nodes])
    links_df = pd.DataFrame([l.to_dict() for l in graph.links])
    tracks_df = pd.DataFrame([t.to_dict() for t in graph.tracks.values()])

    stats: dict[str, Any] = {
        "track_count": int(len(tracks_df)),
        "artist_count": int(len(nodes_df)),
        "connection_count": int(len(links_df)),
        "collaboration_track_count": 0,
        "solo_artist_count": 0,
        "total_duration_ms": 0,
        "explicit_ratio": 0.0,
        "top_collaborators": [],
        "top_pairs": [],
        "popularity_histogram": [],
        "release_year_histogram": [],
    }

    if not tracks_df.empty:
        stats["total_duration_ms"] = int(tracks_df["duration_ms"].fillna(0).sum())
        stats["explicit_ratio"] = round(float(tracks_df["explicit"].mean()), 3)
        # A track is a collaboration when more than one artist is credited.
        stats["collaboration_track_count"] = int(
            (tracks_df["artist_ids"].apply(len) > 1).sum()
        )
        stats["popularity_histogram"] = _histogram(
            tracks_df["popularity"], POPULARITY_BINS, POPULARITY_LABELS
        )
        stats["release_year_histogram"] = _year_histogram(tracks_df)

    if not nodes_df.empty:
        stats["solo_artist_count"] = int((nodes_df["degree"] == 0).sum())
        stats["top_collaborators"] = (
            nodes_df.sort_values(
                ["collab_count", "track_count"], ascending=[False, False]
            )
            .head(TOP_N)[["id", "label", "track_count", "degree", "collab_count"]]
            .to_dict("records")
        )

    if not links_df.empty:
        label_by_id = dict(zip(nodes_df["id"], nodes_df["label"]))
        top_pairs = links_df.sort_values("collab_count", ascending=False).head(TOP_N)
        stats["top_pairs"] = [
            {
                "source": row["source"],
                "target": row["target"],
                "source_label": label_by_id.get(row["source"], row["source"]),
                "target_label": label_by_id.get(row["target"], row["target"]),
                "collab_count": int(row["collab_count"]),
            }
            for _, row in top_pairs.iterrows()
        ]

    return stats


def _histogram(series: pd.Series, bins: list[int], labels: list[str]) -> list[dict]:
    """Bucket a numeric column into labelled bins."""
    bucketed = pd.cut(
        series.fillna(0), bins=bins, labels=labels, include_lowest=True, right=False
    )
    counts = bucketed.value_counts().reindex(labels, fill_value=0)
    return [{"bucket": str(label), "count": int(count)} for label, count in counts.items()]


def _year_histogram(tracks_df: pd.DataFrame) -> list[dict]:
    years = pd.to_numeric(tracks_df["release_year"], errors="coerce").dropna()
    if years.empty:
        return []
    counts = years.astype(int).value_counts().sort_index()
    return [{"year": int(year), "count": int(count)} for year, count in counts.items()]

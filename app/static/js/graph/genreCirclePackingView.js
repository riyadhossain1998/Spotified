/**
 * Zoomable Circle Packing for genres -- placeholder.
 *
 * Deliberately exposes the same surface as ArtistNetworkView (render,
 * setHideUnconnected, highlightSearch, focusNode, clearSelection, destroy) so
 * graphPage.js can swap views by mode with no branching beyond the lookup.
 *
 * When implementing:
 *   - Data comes from GenreNetworkBuilder.build_hierarchy() on the Python
 *     side, which already emits the genre -> artist -> track nesting that
 *     d3.hierarchy() expects.
 *   - d3.pack().size([w, h]).padding(3) over
 *     d3.hierarchy(data).sum(d => d.value).sort((a, b) => b.value - a.value)
 *   - Click-to-zoom: keep a `focus` node, interpolate [x, y, r] on click, and
 *     only render labels for children of the current focus.
 *   - Leaf clicks should reuse DetailPanel.showNode/showLink so the panel
 *     stays view-agnostic.
 */

export class GenreCirclePackingView {
  constructor(container) {
    this.container = container;
  }

  render() {
    throw new Error("GenreCirclePackingView is not implemented yet.");
  }

  setHideUnconnected() {}
  highlightSearch() {}
  focusNode() {}
  clearSelection() {}
  destroy() {}
}

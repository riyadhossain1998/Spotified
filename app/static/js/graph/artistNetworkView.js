/**
 * Force-directed artist network (D3 v7).
 *
 * Owns rendering and interaction only. It never fetches and never formats
 * panel markup -- it reports selections through callbacks and lets the page
 * decide what to do. That separation is what lets the planned circle-packing
 * view drop in behind the same interface.
 *
 * Visual encoding:
 *   node radius      -> sqrt(tracks on playlist)   (area reads as quantity)
 *   green ring       -> the playlist's main artist
 *   link thickness   -> sqrt(shared tracks)
 *   link length      -> inverse of shared tracks   (closer == more collabs)
 */

/**
 * Drawn when an artist has no image. `.node__ring` is a transparent stroke, so
 * without this a node missing its picture is not a faint circle -- it is
 * nothing at all, just a floating label with links running to a blank spot.
 */
const NODE_PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>" +
  "<rect width='64' height='64' fill='%232a2a2a'/>" +
  "<text x='32' y='42' font-size='30' text-anchor='middle' fill='%23888'>?</text>" +
  "</svg>";

const NODE_RADIUS_RANGE = [11, 34];
const LINK_WIDTH_RANGE = [1, 6];
const LABEL_VISIBILITY_ZOOM = 0.55; // below this, labels are noise

export class ArtistNetworkView {
  constructor(container, { onSelectNode, onSelectLink, onClearSelection } = {}) {
    this.container = container;
    this.onSelectNode = onSelectNode || (() => {});
    this.onSelectLink = onSelectLink || (() => {});
    this.onClearSelection = onClearSelection || (() => {});

    this.nodes = [];
    this.links = [];
    this.selection = null;      // { type: "node" | "link", id }
    this.hideUnconnected = false;
    this.simulation = null;

    this._buildScaffold();

    // Re-centre the forces when the window changes size.
    this._onResize = this._debounce(() => this._handleResize(), 200);
    window.addEventListener("resize", this._onResize);
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------

  _buildScaffold() {
    const { width, height } = this._size();

    this.svg = d3
      .select(this.container)
      .append("svg")
      .attr("viewBox", [0, 0, width, height])
      .attr("preserveAspectRatio", "xMidYMid meet");

    // Clicking empty canvas clears the selection.
    this.svg.on("click", (event) => {
      if (event.target === this.svg.node()) this.clearSelection();
    });

    // Single zoom/pan layer: transforming one <g> is far cheaper than
    // rescaling every element on each wheel event.
    this.viewport = this.svg.append("g").attr("class", "viewport");
    this.linkLayer = this.viewport.append("g").attr("class", "links");
    this.nodeLayer = this.viewport.append("g").attr("class", "nodes");

    this.zoom = d3
      .zoom()
      .scaleExtent([0.15, 6])
      .on("zoom", (event) => {
        this.viewport.attr("transform", event.transform);
        this._applyLabelVisibility(event.transform.k);
      });

    this.svg.call(this.zoom);
  }

  _size() {
    const rect = this.container.getBoundingClientRect();
    return {
      width: Math.max(rect.width || 960, 320),
      height: Math.max(rect.height || 600, 320),
    };
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  render(graph) {
    // Deep-copy: d3.forceLink replaces link.source/target with node object
    // references. Mutating the cached payload would corrupt it for re-renders
    // and for the detail panel's id-based lookups.
    this.rawNodes = graph.nodes.map((n) => ({ ...n }));
    this.rawLinks = graph.links.map((l) => ({ ...l }));
    this.tracks = graph.tracks;

    this._buildAdjacency();
    this._buildScales();
    this._draw();
  }

  _buildAdjacency() {
    // nodeId -> Set(neighbour ids), used for selection dimming.
    this.neighbours = new Map();
    this.rawNodes.forEach((n) => this.neighbours.set(n.id, new Set()));

    this.rawLinks.forEach((link) => {
      this.neighbours.get(link.source)?.add(link.target);
      this.neighbours.get(link.target)?.add(link.source);
    });
  }

  _buildScales() {
    const trackCounts = this.rawNodes.map((n) => n.track_count || 1);
    const collabCounts = this.rawLinks.map((l) => l.collab_count || 1);

    // sqrt so radius maps to perceived area rather than length.
    this.radius = d3
      .scaleSqrt()
      .domain([1, d3.max(trackCounts) || 1])
      .range(NODE_RADIUS_RANGE)
      .clamp(true);

    this.linkWidth = d3
      .scaleSqrt()
      .domain([1, d3.max(collabCounts) || 1])
      .range(LINK_WIDTH_RANGE)
      .clamp(true);
  }

  _visibleData() {
    const nodes = this.hideUnconnected
      ? this.rawNodes.filter((n) => (n.degree || 0) > 0)
      : this.rawNodes;

    const visibleIds = new Set(nodes.map((n) => n.id));
    const links = this.rawLinks.filter(
      (l) => visibleIds.has(this._endpointId(l.source)) && visibleIds.has(this._endpointId(l.target))
    );

    // Fresh copies each time: d3 mutates these in place.
    return { nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) };
  }

  /** Links arrive with string endpoints but d3 swaps in node objects. */
  _endpointId(endpoint) {
    return typeof endpoint === "object" ? endpoint.id : endpoint;
  }

  _draw() {
    const { width, height } = this._size();
    const { nodes, links } = this._visibleData();

    this.nodes = nodes;
    this.links = links;

    this.simulation?.stop();

    // --- links -------------------------------------------------------
    this.linkSelection = this.linkLayer
      .selectAll("line")
      .data(links, (d) => d.id)
      .join("line")
      .attr("class", "link")
      .attr("stroke-width", (d) => this.linkWidth(d.collab_count || 1))
      .on("click", (event, d) => {
        event.stopPropagation();
        this.selectLink(d);
      });

    this.linkSelection.append("title").text((d) => `${d.collab_count} shared track(s)`);

    // --- nodes -------------------------------------------------------
    this.nodeSelection = this.nodeLayer
      .selectAll("g.node")
      .data(nodes, (d) => d.id)
      .join((enter) => this._enterNode(enter))
      .classed("is-primary", (d) => d.is_primary);

    // --- simulation --------------------------------------------------
    this.simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          // More shared tracks pulls artists closer, bottoming out at 55px so
          // heavy collaborators never sit on top of each other.
          .distance((d) => 55 + 150 / (1 + (d.collab_count || 1)))
          .strength((d) => Math.min(0.9, 0.2 + 0.1 * (d.collab_count || 1)))
      )
      // Repulsion scales with radius so large hub nodes clear room for their
      // labels instead of being swamped by small neighbours.
      .force(
        "charge",
        d3.forceManyBody().strength((d) => -14 * this.radius(d.track_count || 1))
      )
      .force("center", d3.forceCenter(width / 2, height / 2))
      // Weak positional springs keep isolated nodes from drifting off-canvas.
      .force("x", d3.forceX(width / 2).strength(0.035))
      .force("y", d3.forceY(height / 2).strength(0.035))
      .force(
        "collide",
        d3
          .forceCollide()
          .radius((d) => this.radius(d.track_count || 1) + 6)
          .iterations(2)
      )
      .on("tick", () => this._tick());

    this._applyLabelVisibility(d3.zoomTransform(this.svg.node()).k);
    this._applySelectionStyles();
  }

  _enterNode(enter) {
    const group = enter
      .append("g")
      .attr("class", "node")
      .on("click", (event, d) => {
        event.stopPropagation();
        this.selectNode(d);
      })
      .call(this._dragBehaviour());

    group
      .append("image")
      .attr("href", (d) => d.image_url || NODE_PLACEHOLDER_IMAGE)
      .attr("x", (d) => -this.radius(d.track_count || 1))
      .attr("y", (d) => -this.radius(d.track_count || 1))
      .attr("width", (d) => this.radius(d.track_count || 1) * 2)
      .attr("height", (d) => this.radius(d.track_count || 1) * 2)
      .attr("preserveAspectRatio", "xMidYMid slice");

    group
      .append("circle")
      .attr("class", "node__ring")
      .attr("r", (d) => this.radius(d.track_count || 1) + 1.5);

    group
      .append("text")
      .attr("class", "node__label")
      .attr("y", (d) => this.radius(d.track_count || 1) + 13)
      .text((d) => this._truncate(d.label, 22));

    group.append("title").text((d) => `${d.label} — ${d.track_count} track(s)`);

    return group;
  }

  _tick() {
    this.linkSelection
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    this.nodeSelection.attr("transform", (d) => `translate(${d.x},${d.y})`);
  }

  _dragBehaviour() {
    const simulation = () => this.simulation;

    return d3
      .drag()
      .on("start", (event, d) => {
        if (!event.active) simulation().alphaTarget(0.25).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation().alphaTarget(0);
        // Nodes stay pinned where dropped: users arrange a layout while
        // exploring and expect it to hold.
        d.fx = event.x;
        d.fy = event.y;
      });
  }

  // ------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------

  selectNode(node) {
    this.selection = { type: "node", id: node.id };
    this._applySelectionStyles();
    this.onSelectNode(node);
  }

  selectLink(link) {
    this.selection = { type: "link", id: link.id };
    this._applySelectionStyles();

    // Hand back plain ids; the caller works against the original payload.
    this.onSelectLink({
      ...link,
      source: this._endpointId(link.source),
      target: this._endpointId(link.target),
    });
  }

  clearSelection() {
    this.selection = null;
    this._applySelectionStyles();
    this.onClearSelection();
  }

  /**
   * Dim everything not part of the selection.
   * Node selected  -> keep the node, its neighbours, and edges touching it.
   * Link selected  -> keep just its two endpoints and the edge itself.
   */
  _applySelectionStyles() {
    if (!this.nodeSelection) return;

    if (!this.selection) {
      this.nodeSelection.classed("is-dimmed", false).classed("is-selected", false);
      this.linkSelection.classed("is-dimmed", false).classed("is-selected", false);
      return;
    }

    const { type, id } = this.selection;
    let keepNodes;
    let isSelectedLink;

    if (type === "node") {
      keepNodes = new Set([id, ...(this.neighbours.get(id) || [])]);
      isSelectedLink = (l) =>
        this._endpointId(l.source) === id || this._endpointId(l.target) === id;
    } else {
      const link = this.links.find((l) => l.id === id);
      keepNodes = new Set(
        link ? [this._endpointId(link.source), this._endpointId(link.target)] : []
      );
      isSelectedLink = (l) => l.id === id;
    }

    this.nodeSelection
      .classed("is-dimmed", (d) => !keepNodes.has(d.id))
      .classed("is-selected", (d) => type === "node" && d.id === id);

    this.linkSelection
      .classed("is-selected", isSelectedLink)
      .classed("is-dimmed", (l) => !isSelectedLink(l));
  }

  // ------------------------------------------------------------------
  // External controls
  // ------------------------------------------------------------------

  setHideUnconnected(hide) {
    if (this.hideUnconnected === hide) return;
    this.hideUnconnected = hide;
    this._draw();
  }

  /** Ring-highlight every node whose name matches, without dimming. */
  highlightSearch(term) {
    if (!this.nodeSelection) return;
    const needle = term.trim().toLowerCase();
    this.nodeSelection.classed(
      "is-match",
      (d) => needle.length > 0 && d.label.toLowerCase().includes(needle)
    );
  }

  /** Centre the viewport on a node and select it. */
  focusNode(nodeId) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const { width, height } = this._size();
    const scale = 1.6;

    this.svg
      .transition()
      .duration(600)
      .call(
        this.zoom.transform,
        d3.zoomIdentity
          .translate(width / 2, height / 2)
          .scale(scale)
          .translate(-node.x, -node.y)
      );

    this.selectNode(node);
  }

  resetZoom() {
    this.svg.transition().duration(400).call(this.zoom.transform, d3.zoomIdentity);
  }

  _applyLabelVisibility(zoomScale) {
    if (!this.nodeSelection) return;
    // Hide labels when zoomed out, but always keep big nodes readable.
    this.nodeSelection.selectAll("text.node__label").style("display", (d) => {
      if (zoomScale >= LABEL_VISIBILITY_ZOOM) return null;
      return this.radius(d.track_count || 1) > 22 ? null : "none";
    });
  }

  _handleResize() {
    if (!this.simulation) return;
    const { width, height } = this._size();
    this.svg.attr("viewBox", [0, 0, width, height]);
    this.simulation
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("x", d3.forceX(width / 2).strength(0.035))
      .force("y", d3.forceY(height / 2).strength(0.035))
      .alpha(0.12)
      .restart();
  }

  destroy() {
    window.removeEventListener("resize", this._onResize);
    this.simulation?.stop();
    this.svg?.remove();
  }

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------

  _truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  _debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }
}

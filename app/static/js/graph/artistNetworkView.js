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
// Lightest edge first: more shared tracks pulls two nodes closer and holds
// them there harder. Both are scaled against the graph's own heaviest edge
// rather than an absolute track count, because what counts as heavy depends on
// the mode -- an artist pair shares two or three songs where two genres share a
// hundred, and constants tuned for the former bottom out and pin every genre on
// top of the next.
const LINK_DISTANCE_RANGE = [140, 70];
const LINK_STRENGTH_RANGE = [0.2, 0.75];
const LABEL_VISIBILITY_ZOOM = 0.55; // below this, labels are noise
// How far the auto-fit may magnify a layout smaller than its canvas. Past
// roughly this the artwork in a node starts to show its seams -- Spotify's
// smallest artist image is 64px, and a 34px node scaled beyond ~1.75 is asking
// for more pixels than that.
const MAX_FIT_ZOOM = 1.75;

/**
 * How a node's face tiles divide the circle, in fractions of its bounding
 * square. A genre node stands for many artists, so it is drawn as a mosaic of
 * its biggest contributors rather than a single arbitrary face.
 *
 * Four is the ceiling because the circle is at most 68px across: a fifth tile
 * would be too small to recognise anyone in, which is the only reason to show
 * a face at all. The three-tile case gives the first artist the full-height
 * left half, since the list arrives sorted by contribution.
 */
const MOSAIC_LAYOUTS = {
  1: [{ x: 0, y: 0, w: 1, h: 1 }],
  2: [
    { x: 0, y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ],
  3: [
    { x: 0, y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
  4: [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
};

const MOSAIC_SIZE = 4;

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
    this.userHasZoomed = false;
    // Height at the bottom of the canvas that something else is sitting on --
    // the mobile detail sheet. The SVG still extends under it, so only the
    // framing needs to know, not the layout.
    this.bottomInset = 0;

    this._buildScaffold();

    // Re-centre the forces when the window changes size.
    this._onResize = this._debounce(() => this.resize(), 200);
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
        // sourceEvent is absent for programmatic transforms, which is how the
        // auto-fit below tells "the user has framed this themselves" from its
        // own work -- and never overrides the former.
        if (event.sourceEvent) this.userHasZoomed = true;
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

  /**
   * The canvas height that is not behind the detail sheet. Framing works
   * against this rather than the full height, or a graph centred "in the
   * canvas" sits with its lower half hidden. Floored at a third of the canvas
   * so an unusually tall sheet cannot squeeze the graph into a sliver.
   */
  _visibleHeight() {
    const { height } = this._size();
    return Math.max(height - this.bottomInset, height / 3);
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

    const heaviestLink = d3.max(collabCounts) || 1;

    this.linkWidth = d3
      .scaleSqrt()
      .domain([1, heaviestLink])
      .range(LINK_WIDTH_RANGE)
      .clamp(true);

    this.linkDistance = d3
      .scaleSqrt()
      .domain([1, heaviestLink])
      .range(LINK_DISTANCE_RANGE)
      .clamp(true);

    this.linkStrength = d3
      .scaleSqrt()
      .domain([1, heaviestLink])
      .range(LINK_STRENGTH_RANGE)
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
    this._fitted = false;

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
          .distance((d) => this.linkDistance(d.collab_count || 1))
          .strength((d) => this.linkStrength(d.collab_count || 1))
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
      .on("tick", () => this._tick())
      // The layout's final size is not knowable up front -- it depends on how
      // the forces resolve -- so the fit waits for the simulation to settle
      // rather than guessing at render time. Instantly, because the nodes have
      // just stopped moving: a half-second zoom-out on top of that reads as a
      // second, unexplained animation.
      //
      // Once per layout, not per settle: resize() nudges the simulation awake
      // again, and a fit firing after that would undo the framing fullscreen
      // had just put on the main artist. Someone who has already zoomed or
      // panned has framed it themselves, which beats any fit.
      .on("end", () => {
        if (this._fitted || this.userHasZoomed) return;
        this._fitted = true;
        this.fitToContents({ duration: 0 });
      });

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

    // The tiles go in their own <g> so the circular clip applies to the mosaic
    // as a whole. Clipping the images individually -- which is what the old
    // single-image rule did -- would turn a four-face node into four circles.
    group
      .append("g")
      .attr("class", "node__mosaic")
      .each((d, i, groups) => this._drawMosaic(d3.select(groups[i]), d));

    group
      .append("circle")
      .attr("class", "node__ring")
      .attr("r", (d) => this.radius(d.track_count || 1) + 1.5);

    group
      .append("text")
      .attr("class", "node__label")
      .attr("y", (d) => this.radius(d.track_count || 1) + 13)
      .text((d) => this._truncate(d.label, 22));

    group.append("title").text((d) => this._nodeTooltip(d));

    return group;
  }

  /**
   * The faces to tile into one node, biggest contributor first.
   *
   * Artist nodes carry no members and fall through to their own picture, so
   * this is the single code path for both modes. A genre whose members are all
   * missing pictures still gets the placeholder rather than an empty circle.
   */
  _faces(node) {
    const images = (node.members || [])
      .map((m) => m.image_url)
      .filter(Boolean)
      .slice(0, MOSAIC_SIZE);

    if (images.length > 1) return images;
    return [images[0] || node.image_url || NODE_PLACEHOLDER_IMAGE];
  }

  _drawMosaic(mosaic, node) {
    const r = this.radius(node.track_count || 1);
    const faces = this._faces(node);
    const tiles = MOSAIC_LAYOUTS[faces.length].map((tile, i) => ({
      ...tile,
      href: faces[i],
    }));

    mosaic
      .selectAll("image")
      .data(tiles)
      .join("image")
      .attr("href", (t) => t.href)
      .attr("x", (t) => -r + t.x * 2 * r)
      .attr("y", (t) => -r + t.y * 2 * r)
      .attr("width", (t) => t.w * 2 * r)
      .attr("height", (t) => t.h * 2 * r)
      // "slice" fills the tile and crops the overflow. Faces are square-ish
      // and centred, so cropping the edges beats letterboxing a portrait into
      // a half-width slot.
      .attr("preserveAspectRatio", "xMidYMid slice");
  }

  _nodeTooltip(node) {
    const tracks = `${node.track_count} track(s)`;
    const members = (node.members || []).length;
    // Only genre nodes have members, and there the artist count is the thing
    // the track count does not already say.
    return members
      ? `${node.label} — ${tracks}, ${members} artist(s)`
      : `${node.label} — ${tracks}`;
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

  /** Centre the viewport on a node, leaving the selection untouched. */
  centreOn(nodeId, { scale = 1.6, duration = 600 } = {}) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return false;

    const { width } = this._size();
    const visible = this._visibleHeight();

    this.svg
      .transition()
      .duration(duration)
      .call(
        this.zoom.transform,
        d3.zoomIdentity
          .translate(width / 2, visible / 2)
          .scale(scale)
          .translate(-node.x, -node.y)
      );

    return true;
  }

  /** Centre the viewport on a node and select it. */
  focusNode(nodeId) {
    if (!this.centreOn(nodeId)) return;
    this.selectNode(this.nodes.find((n) => n.id === nodeId));
  }

  /**
   * The artist the playlist is built around: the one the builder flagged, or
   * failing that whoever appears on the most tracks. Used as the natural
   * landing point when there is no selection to centre on.
   */
  get primaryNodeId() {
    if (!this.nodes.length) return null;
    const primary =
      this.nodes.find((n) => n.is_primary) ||
      this.nodes.reduce((best, n) =>
        (n.track_count || 0) > (best.track_count || 0) ? n : best
      );
    return primary?.id ?? null;
  }

  /**
   * Zoom so the whole network is on screen.
   *
   * Mostly this zooms out -- a 375px phone canvas cannot hold a layout the
   * forces resolved for 960. It is allowed to zoom in as far as MAX_FIT_ZOOM
   * because genre mode exists: the forces are tuned for the ~90 nodes an
   * artist graph carries, so the ~10 a genre graph carries settle into a
   * cluster far smaller than the canvas and would otherwise sit marooned in
   * the middle of it. The cap is what keeps that from running the other way
   * into a handful of enormous nodes.
   */
  fitToContents({ duration = 400, padding = 28 } = {}) {
    if (!this.nodes.length) return;

    const margin = (d) => this.radius(d.track_count || 1) + padding;
    const minX = d3.min(this.nodes, (d) => d.x - margin(d));
    const maxX = d3.max(this.nodes, (d) => d.x + margin(d));
    const minY = d3.min(this.nodes, (d) => d.y - margin(d));
    const maxY = d3.max(this.nodes, (d) => d.y + margin(d));

    const { width } = this._size();
    const visible = this._visibleHeight();
    const scale = Math.min(
      MAX_FIT_ZOOM,
      width / (maxX - minX),
      visible / (maxY - minY)
    );

    const target = d3.zoomIdentity
      .translate(width / 2, visible / 2)
      .scale(scale)
      .translate(-(minX + maxX) / 2, -(minY + maxY) / 2);

    const selection = duration ? this.svg.transition().duration(duration) : this.svg;
    selection.call(this.zoom.transform, target);
  }

  _applyLabelVisibility(zoomScale) {
    if (!this.nodeSelection) return;
    // Hide labels when zoomed out, but always keep big nodes readable.
    this.nodeSelection.selectAll("text.node__label").style("display", (d) => {
      if (zoomScale >= LABEL_VISIBILITY_ZOOM) return null;
      return this.radius(d.track_count || 1) > 22 ? null : "none";
    });
  }

  /**
   * Re-centre the forces on the container's current size. Public because the
   * canvas also changes size without the window doing so -- entering
   * fullscreen, or the detail panel giving its column back.
   */
  resize() {
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

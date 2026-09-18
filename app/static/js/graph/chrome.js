/**
 * Page chrome around the graph: the fullscreen toggle and the legend.
 *
 * Both exist because of the phone. A laptop has room for a toolbar, a legend
 * and a 380px panel alongside the canvas; a 390px screen does not, and sharing
 * the height between them is what makes the nodes read as unusably small.
 *
 * Kept out of ArtistNetworkView on purpose -- the view owns the SVG and knows
 * nothing about the page it sits on, which is what lets the planned
 * circle-packing view drop in behind the same interface.
 */

const NARROW_SCREEN = "(max-width: 700px)";
const FULLSCREEN_CLASS = "is-fullscreen";

/**
 * @param {ArtistNetworkView} view
 * @param {{canvas?: Element, legend?: HTMLDetailsElement}} [elements]
 * @returns {{destroy: () => void}}
 */
export function initGraphChrome(view, { canvas, legend } = {}) {
  const narrow = window.matchMedia(NARROW_SCREEN);
  const teardown = [];

  const canvasEl = canvas || document.getElementById("graph-canvas");
  const legendEl = legend || document.getElementById("graph-legend");
  const panelEl = document.getElementById("detail-panel");

  // --------------------------------------------------------- sheet inset
  //
  // On a phone the detail panel floats over the bottom of the canvas rather
  // than taking a column beside it, so part of the SVG is never visible. The
  // view cannot work that out for itself -- it only knows its own element --
  // and measuring beats hard-coding a height the CSS is free to change.
  const measureInset = () => {
    if (!canvasEl || !panelEl || getComputedStyle(panelEl).position !== "absolute") {
      return 0;
    }
    const canvasBox = canvasEl.getBoundingClientRect();
    const panelBox = panelEl.getBoundingClientRect();
    // A dismissed panel measures zero everywhere, which would otherwise read
    // as a sheet covering the entire canvas.
    if (panelBox.height === 0) return 0;
    return Math.max(0, canvasBox.bottom - panelBox.top);
  };

  const syncInset = () => {
    view.bottomInset = measureInset();
  };
  syncInset();
  narrow.addEventListener("change", syncInset);
  teardown.push(() => narrow.removeEventListener("change", syncInset));

  // ------------------------------------------------------------- legend
  //
  // The graph page does not scroll -- it is sized to the viewport -- so there
  // is no "further down the page" to reveal the legend at. A disclosure gives
  // the same result: one tappable line instead of four wrapped ones, opened on
  // demand. <details> means the open/closed state is the browser's to manage.
  if (legendEl?.tagName === "DETAILS") {
    const syncLegend = () => {
      legendEl.open = !narrow.matches;
    };
    syncLegend();
    narrow.addEventListener("change", syncLegend);
    teardown.push(() => narrow.removeEventListener("change", syncLegend));
  }

  // --------------------------------------------------------- fullscreen
  const button = document.createElement("button");
  button.type = "button";
  button.className = "graph-canvas__control";
  button.textContent = "Fullscreen";
  button.setAttribute("aria-pressed", "false");
  canvasEl?.appendChild(button);

  function setFullscreen(on) {
    document.body.classList.toggle(FULLSCREEN_CLASS, on);
    button.textContent = on ? "Exit fullscreen" : "Fullscreen";
    button.setAttribute("aria-pressed", String(on));

    // The canvas just changed size without the window resizing, so the view's
    // own resize listener will never fire. Next frame, so the measurement
    // happens after the browser has laid the new geometry out.
    requestAnimationFrame(() => {
      view.resize();
      syncInset();
      // Entering, land on the artist the playlist is built around: a full
      // screen of an un-centred force layout is mostly empty space. Leaving,
      // re-fit rather than reset -- the canvas is back to phone-sized, where
      // an unzoomed layout does not fit.
      if (on) view.centreOn(view.primaryNodeId);
      else view.fitToContents({ duration: 300 });
    });
  }

  const onToggle = () => setFullscreen(!document.body.classList.contains(FULLSCREEN_CLASS));
  button.addEventListener("click", onToggle);
  teardown.push(() => button.remove());

  const onKeydown = (event) => {
    if (event.key === "Escape" && document.body.classList.contains(FULLSCREEN_CLASS)) {
      setFullscreen(false);
    }
  };
  document.addEventListener("keydown", onKeydown);
  teardown.push(() => document.removeEventListener("keydown", onKeydown));

  return {
    destroy() {
      document.body.classList.remove(FULLSCREEN_CLASS);
      teardown.forEach((fn) => fn());
    },
  };
}

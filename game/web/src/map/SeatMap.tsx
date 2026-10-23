// d3 seat map (port of site/app.js). d3 stays imperative inside effects; React owns the surrounding UI.
// Coordinates in the topojson are already projected (Equal Earth, scale 200, y down) -> d3.geoPath() with no projection.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as d3 from 'd3';
import './SeatMap.css';
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { DEFAULT_MAP_ID } from '@hp/shared';
import type { SeatId } from '@hp/shared';
import { coarseTopoUrl, detailTopoUrl, loadTopo, manifestFor } from './mapData';
import { selectMapId, useStore } from '../state/store';

const DETAIL_K = 4;
const NEUTRAL = '#d3d0c6';

/** Number colour on a badge: white on dark party colours, near-black on light ones. */
export function badgeInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1b1b1b' : '#fff';
}

export interface SeatMapProps {
  /** seat -> colour (won/leading seats). Missing = neutral grey. */
  fills?: Record<SeatId, string>;
  /** seats shown in "leading" style (lighter fill, dashed outline). Seats in fills but not here are "won". */
  leading?: ReadonlySet<SeatId>;
  /** polled seats without a result: subtle hatch pattern. */
  dimmed?: ReadonlySet<SeatId>;
  /** 'committed' = fills are the player's own committed-voter shades (not a result): no won/leading outline styles. */
  fillStyle?: 'result' | 'committed';
  /** seats drawn blurred out (e.g. not polled in the current phase). */
  blurred?: ReadonlySet<SeatId>;
  /** faint text drawn at a seat's centre (e.g. its polling phase); shown once the seat is big enough on screen. */
  labels?: Record<SeatId, string>;
  /** party-coloured circle with a number at a seat's centre (e.g. own reputation); constant screen size, hidden while the seat is tiny. */
  badges?: Record<SeatId, { text: string; colour: string }>;
  selectedSeat?: SeatId | null;
  onSeatClick?: (seat: SeatId) => void;
  /** Change `key` to fire a flash on `seat` (e.g. a rally just happened). */
  pulse?: { seat: SeatId; colour?: string; key: number } | null;
  names?: Record<SeatId, string>;
  /** Which map to draw (maps/<id>/); default = the current game's map. */
  mapId?: string;
  /** Optional seat centres in projected space (map package x,y); falls back to the polygon centroid. */
  centres?: Record<SeatId, [number, number]>;
}
export interface SeatMapHandle { zoomToSeat(seat: SeatId): void; reset(): void }

type SeatFeature = Feature<Geometry, { seat: SeatId }>;
type PulseArg = NonNullable<SeatMapProps['pulse']>;

interface Api {
  update(): void; pulse(p: PulseArg): void; zoomToSeat(s: SeatId): void; reset(): void; zoomBy(f: number): void;
}

const toFeatures = (topo: Topology): SeatFeature[] => {
  const obj = topo.objects.seats as GeometryCollection;
  const fc = feature(topo, obj) as FeatureCollection<Geometry, { seat?: number } | null>;
  return fc.features.map(f => {
    const seat = f.properties?.seat ?? Number(f.id);
    return { ...f, properties: { seat } } as SeatFeature;
  });
};

export const SeatMap = forwardRef<SeatMapHandle, SeatMapProps>(function SeatMap(props, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // the map of the current game (store), never a hard-coded one; `props.mapId` overrides it
  const storeMapId = useStore(selectMapId);
  const mapId = props.mapId ?? storeMapId ?? DEFAULT_MAP_ID;

  useImperativeHandle(ref, () => ({
    zoomToSeat: s => api.current?.zoomToSeat(s),
    reset: () => api.current?.reset(),
  }));

  // ---- mount: build the map once
  useEffect(() => {
    let dead = false;
    setLoading(true); setFailed(false);
    const svgEl = svgRef.current!, tip = tipRef.current!;
    const svg = d3.select(svgEl);
    const defs = svg.append('defs');
    const hatch = defs.append('pattern').attr('id', 'hp-hatch').attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6);
    hatch.append('rect').attr('width', 6).attr('height', 6).attr('fill', NEUTRAL);
    hatch.append('path').attr('d', 'M-1,1 l2,-2 M0,6 l6,-6 M5,7 l2,-2').attr('stroke', '#7d7a6c').attr('stroke-width', 1);
    const gZoom = svg.append('g');
    const blur = defs.append('filter').attr('id', 'hp-blur').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
    const blurStd = blur.append('feGaussianBlur').attr('stdDeviation', 2);
    const gSeats = gZoom.append('g');
    const gLabels = gZoom.append('g').attr('class', 'seat-labels');
    const gBadges = gZoom.append('g').attr('class', 'seat-badges');
    const gHits = gZoom.append('g');
    const gFx = gZoom.append('g').attr('class', 'fx');
    const hl = gZoom.append('path').attr('class', 'hl').style('display', 'none');
    const sel = gZoom.append('path').attr('class', 'sel').style('display', 'none');
    type PSel = d3.Selection<SVGPathElement, unknown, null, undefined>;
    const showPath = (p: PSel, d: string | null) => p.attr('d', d).style('display', null);
    const hidePath = (p: PSel) => p.attr('d', null).style('display', 'none');

    const path = d3.geoPath();
    let features: SeatFeature[] = [];
    const featById = new Map<SeatId, SeatFeature>();
    let detail = false, detailLoading = false;
    let W = 0, H = 0, kNow = 1, dragStart: [number, number] | null = null;
    let baseT = d3.zoomIdentity;
    let bounds: [[number, number], [number, number]] = [[0, 0], [1, 1]];
    const zoom = d3.zoom<SVGSVGElement, unknown>();

    const nameOf = (id: SeatId) => propsRef.current.names?.[id] ?? `Seat ${id}`;

    function style() {
      const p = propsRef.current;
      const fills = p.fills ?? {};
      const committed = p.fillStyle === 'committed';
      gSeats.selectAll<SVGPathElement, SeatFeature>('path.seat')
        .style('fill', d => fills[d.properties.seat] ?? (p.dimmed?.has(d.properties.seat) ? 'url(#hp-hatch)' : NEUTRAL))
        .classed('leading', d => !committed && !!fills[d.properties.seat] && !!p.leading?.has(d.properties.seat))
        .classed('won', d => !committed && !!fills[d.properties.seat] && !p.leading?.has(d.properties.seat))
        .classed('committed', d => committed && !!fills[d.properties.seat])
        .classed('selected', d => d.properties.seat === p.selectedSeat)
        .classed('blurred', d => !!p.blurred?.has(d.properties.seat));
      const sf = p.selectedSeat != null ? featById.get(p.selectedSeat) : undefined;
      if (sf) showPath(sel as PSel, path(sf)); else hidePath(sel as PSel);
    }

    // faint per-seat labels; font size is constant on screen, hidden while the seat is too small to hold one
    type Lab = { id: SeatId; text: string; x: number; y: number; size: number };
    let labs: Lab[] = [];
    function placeLabels() {
      gLabels.selectAll<SVGTextElement, Lab>('text')
        .attr('font-size', 13 / kNow)
        .attr('y', d => d.y - (propsRef.current.badges ? 18 / kNow : 0)) // make room for the badge
        .style('display', d => (d.size * kNow >= 24 ? null : 'none'));
    }
    function drawLabels() {
      const labels = propsRef.current.labels ?? {};
      labs = [];
      for (const id of Object.keys(labels).map(Number)) {
        const f = featById.get(id), c = f && centre(id); if (!f || !c) continue;
        const b = path.bounds(f);
        labs.push({ id, text: labels[id], x: c[0], y: c[1], size: Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]) });
      }
      gLabels.selectAll<SVGTextElement, Lab>('text').data(labs, d => d.id).join('text')
        .attr('class', 'seat-label').attr('x', d => d.x).attr('y', d => d.y).text(d => d.text);
      placeLabels();
    }

    // badges: circle + number, constant on-screen size, hidden while the seat is too small to hold one
    type Bad = { id: SeatId; text: string; colour: string; x: number; y: number; size: number };
    const BADGE_R = 11;
    function placeBadges() {
      gBadges.selectAll<SVGGElement, Bad>('g.seat-badge')
        .attr('transform', d => `translate(${d.x},${d.y}) scale(${1 / kNow})`)
        .style('display', d => (d.size * kNow >= 24 ? null : 'none'));
    }
    function drawBadges() {
      const badges = propsRef.current.badges ?? {};
      const bads: Bad[] = [];
      for (const id of Object.keys(badges).map(Number)) {
        const f = featById.get(id), c = f && centre(id); if (!f || !c) continue;
        const b = path.bounds(f);
        bads.push({ id, ...badges[id], x: c[0], y: c[1], size: Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]) });
      }
      const g = gBadges.selectAll<SVGGElement, Bad>('g.seat-badge').data(bads, d => d.id).join(enter => {
        const e = enter.append('g').attr('class', 'seat-badge');
        e.append('circle').attr('r', BADGE_R);
        e.append('text').attr('dy', '0.35em');
        return e;
      });
      g.select('circle').attr('fill', d => d.colour);
      g.select('text').attr('fill', d => badgeInk(d.colour)).text(d => d.text);
      placeBadges();
    }

    function onMove(e: MouseEvent) {
      tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = (e.clientY + 16) + 'px';
    }
    function onEnter(e: MouseEvent, id: SeatId) {
      const f = featById.get(id); if (!f) return;
      showPath(hl as PSel, path(f)); tip.textContent = nameOf(id); tip.style.display = 'block'; onMove(e);
    }
    function onLeave() { hidePath(hl as PSel); tip.style.display = 'none'; }
    const click = (id: SeatId) => propsRef.current.onSeatClick?.(id);

    function draw() {
      featById.clear(); features.forEach(f => featById.set(f.properties.seat, f));
      gSeats.selectAll<SVGPathElement, SeatFeature>('path.seat').data(features, d => d.properties.seat).join(
        enter => enter.append('path').attr('class', 'seat')
          .on('mouseenter', (e: MouseEvent, d) => onEnter(e, d.properties.seat)).on('mousemove', onMove).on('mouseleave', onLeave)
          .on('click', (_e, d) => click(d.properties.seat)),
        update => update, exit => exit.remove(),
      ).attr('d', path);
      style(); drawLabels(); drawBadges();
    }

    function buildHits() {
      const small: { id: SeatId; cx: number; cy: number }[] = [];
      features.forEach(f => {
        const b = path.bounds(f), w = (b[1][0] - b[0][0]) * baseT.k, h = (b[1][1] - b[0][1]) * baseT.k;
        if (Math.max(w, h) < 9) small.push({ id: f.properties.seat, cx: (b[0][0] + b[1][0]) / 2, cy: (b[0][1] + b[1][1]) / 2 });
      });
      gHits.selectAll<SVGCircleElement, { id: SeatId; cx: number; cy: number }>('circle').data(small, d => d.id).join('circle')
        .attr('class', 'hit').attr('cx', d => d.cx).attr('cy', d => d.cy).attr('r', 7 / kNow)
        .on('mouseenter', (e: MouseEvent, d) => onEnter(e, d.id)).on('mousemove', onMove).on('mouseleave', onLeave)
        .on('click', (_e, d) => click(d.id));
    }

    function fit() {
      W = svgEl.clientWidth || 800; H = svgEl.clientHeight || 500;
      const k = 0.96 * Math.min(W / (bounds[1][0] - bounds[0][0]), H / (bounds[1][1] - bounds[0][1]));
      const tx = (W - k * (bounds[0][0] + bounds[1][0])) / 2, ty = (H - k * (bounds[0][1] + bounds[1][1])) / 2;
      baseT = d3.zoomIdentity.translate(tx, ty).scale(k);
      zoom.scaleExtent([k, k * 600]).translateExtent([[bounds[0][0] - 50, bounds[0][1] - 50], [bounds[1][0] + 50, bounds[1][1] + 50]]);
    }

    async function loadDetail() {
      detailLoading = true;
      try {
        const topo = await loadTopo(detailTopoUrl(mapId));
        if (dead) return;
        features = toFeatures(topo); detail = true; draw(); buildHits();
      } catch (err) { console.warn('detail layer unavailable', err); }
      detailLoading = false;
    }

    function zoomed(e: d3.D3ZoomEvent<SVGSVGElement, unknown>) {
      const t = e.transform; kNow = t.k;
      gZoom.attr('transform', t.toString());
      const se = e.sourceEvent as MouseEvent | null;
      if (dragStart && se && (se.type === 'mousemove' || se.type === 'pointermove') &&
          Math.hypot(se.clientX - dragStart[0], se.clientY - dragStart[1]) > 3) svg.classed('dragging', true);
      gHits.selectAll('circle').attr('r', 7 / t.k);
      blurStd.attr('stdDeviation', 2.5 / t.k);
      placeLabels(); placeBadges();
      hatch.attr('patternTransform', `scale(${1 / t.k})`);
      if (t.k / baseT.k > DETAIL_K && !detail && !detailLoading) void loadDetail();
    }
    const endDrag = () => { dragStart = null; svg.classed('dragging', false); };

    zoom.on('zoom', zoomed);
    zoom.on('start.drag', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      const se = e.sourceEvent as MouseEvent | null;
      dragStart = se && (se.type === 'mousedown' || se.type === 'pointerdown') ? [se.clientX, se.clientY] : null;
    });
    zoom.on('end.drag', endDrag);
    svg.on('mouseleave.hl', onLeave);
    svg.on('mouseover.hl', e => { if (e.target === svgEl) onLeave(); });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);

    const ro = new ResizeObserver(() => {
      if (!features.length) return;
      const wasBase = Math.abs(kNow - baseT.k) < 1e-9;
      fit();
      if (wasBase) svg.call(zoom.transform, baseT);
    });

    const centre = (id: SeatId): [number, number] | null => {
      const c = propsRef.current.centres?.[id]; if (c) return c;
      const f = featById.get(id); return f ? path.centroid(f) : null;
    };

    api.current = {
      update: () => { style(); drawLabels(); drawBadges(); },
      pulse: p => {
        const c = centre(p.seat); if (!c) return;
        const col = p.colour ?? '#e0476a';
        gFx.append('circle').attr('cx', c[0]).attr('cy', c[1]).attr('class', 'pulse').attr('r', 3 / kNow).attr('fill', col).attr('fill-opacity', 0.55)
          .attr('stroke', col).attr('stroke-width', 2)
          .transition().duration(1400).ease(d3.easeCubicOut).attr('r', 34 / kNow).attr('fill-opacity', 0).attr('stroke-opacity', 0).remove();
        const seatSel = gSeats.selectAll<SVGPathElement, SeatFeature>('path.seat').filter(d => d.properties.seat === p.seat);
        seatSel.classed('flash', true);
        setTimeout(() => seatSel.classed('flash', false), 900);
      },
      zoomToSeat: id => {
        const f = featById.get(id); if (!f) return;
        const b = path.bounds(f), dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1];
        const k = Math.min(zoom.scaleExtent()[1], Math.max(baseT.k * 1.5, 0.5 / Math.max(dx / W, dy / H, 1e-6)), baseT.k * 40);
        const t = d3.zoomIdentity.translate(W / 2 - k * (b[0][0] + b[1][0]) / 2, H / 2 - k * (b[0][1] + b[1][1]) / 2).scale(k);
        svg.transition().duration(800).call(zoom.transform, t);
      },
      reset: () => { svg.transition().duration(600).call(zoom.transform, baseT); },
      zoomBy: f => { svg.transition().duration(250).call(zoom.scaleBy, f); },
    };

    (async () => {
      try {
        const coarse = await loadTopo(coarseTopoUrl(mapId));
        if (dead) return;
        features = toFeatures(coarse);
        bounds = path.bounds({ type: 'FeatureCollection', features } as FeatureCollection) as [[number, number], [number, number]];
        draw(); fit();
        svg.call(zoom).on('dblclick.zoom', null).call(zoom.transform, baseT);
        buildHits();
        ro.observe(svgEl);
        setLoading(false);
      } catch (err) { console.error(err); setFailed(true); setLoading(false); }
    })();

    return () => {
      dead = true; ro.disconnect(); api.current = null;
      window.removeEventListener('mouseup', endDrag); window.removeEventListener('blur', endDrag);
      svg.on('.zoom', null).on('.hl', null).selectAll('*').remove();
      tip.style.display = 'none';
    };
  }, [mapId]);

  // ---- prop updates: restyle only, never re-render paths
  const { fills, leading, dimmed, blurred, labels, badges, selectedSeat, names, fillStyle } = props;
  useEffect(() => { api.current?.update(); }, [fills, leading, dimmed, blurred, labels, badges, selectedSeat, names, fillStyle]);
  const pulseKey = props.pulse?.key;
  useEffect(() => { if (propsRef.current.pulse) api.current?.pulse(propsRef.current.pulse); }, [pulseKey]);

  return (
    <div className="map-wrap">
      <svg ref={svgRef} className="map" role="img" aria-label={`${manifestFor(mapId)?.name ?? 'Map'} divided into parliament seats`} />
      <div className="tip" ref={tipRef} />
      <div className="map-zoom">
        <button title="Zoom in" onClick={() => api.current?.zoomBy(1.8)}>+</button>
        <button title="Zoom out" onClick={() => api.current?.zoomBy(1 / 1.8)}>&minus;</button>
        <button title="Reset view" onClick={() => api.current?.reset()}>&#8962;</button>
      </div>
      {loading && <div className="map-loading">Loading map…</div>}
      {failed && <div className="map-loading">Could not load the map data.</div>}
    </div>
  );
});

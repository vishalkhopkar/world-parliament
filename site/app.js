(async function () {
  const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2', '#edc948', '#9c755f'];
  const DETAIL_K = 4;
  const svg = d3.select('#map');
  const gZoom = svg.append('g');
  const gSeats = gZoom.append('g');
  const gHits = gZoom.append('g');
  const hl = gZoom.append('path').attr('id', 'hl').attr('hidden', true);
  const sel = gZoom.append('path').attr('id', 'sel').attr('hidden', true);
  const tip = document.getElementById('tip');
  const panel = document.getElementById('panel');
  const panelBody = document.getElementById('panel-body');

  const [meta, coarse] = await Promise.all([
    fetch('data/seats.json').then(r => r.json()),
    fetch('data/world.topo.json').then(r => r.json())
  ]);
  const byId = new Map(meta.map(s => [s.id, s]));
  let detail = null, detailLoading = false;
  const path = d3.geoPath();
  const toFeatures = topo => topojson.feature(topo, topo.objects.seats).features;
  let features = toFeatures(coarse);
  const featById = new Map();

  function draw() {
    featById.clear(); features.forEach(f => featById.set(f.properties.seat, f));
    gSeats.selectAll('path.seat').data(features, d => d.properties.seat).join(
      enter => enter.append('path').attr('class', 'seat')
        .attr('fill', d => PALETTE[(byId.get(d.properties.seat) || {}).color || 0])
        .on('mouseenter', onEnter).on('mousemove', onMove).on('mouseleave', onLeave).on('click', onClick),
      update => update, exit => exit.remove()
    ).attr('d', path);
  }
  draw();

  const bounds = path.bounds({ type: 'FeatureCollection', features });
  let W, H, baseT, kNow = 1;
  const zoom = d3.zoom().on('zoom', zoomed);
  function fit() {
    W = innerWidth; H = innerHeight;
    const k = 0.96 * Math.min(W / (bounds[1][0] - bounds[0][0]), H / (bounds[1][1] - bounds[0][1]));
    const tx = (W - k * (bounds[0][0] + bounds[1][0])) / 2, ty = (H - k * (bounds[0][1] + bounds[1][1])) / 2;
    baseT = d3.zoomIdentity.translate(tx, ty).scale(k);
    zoom.scaleExtent([k, k * 600]).translateExtent([[bounds[0][0] - 50, bounds[0][1] - 50], [bounds[1][0] + 50, bounds[1][1] + 50]]);
  }
  fit(); svg.call(zoom).call(zoom.transform, baseT);
  svg.on('dblclick.zoom', null);
  addEventListener('resize', fit);

  // tiny seats (islands, microstates) get an enlarged invisible hit target
  function buildHits() {
    const small = [];
    features.forEach(f => {
      const b = path.bounds(f), w = (b[1][0] - b[0][0]) * baseT.k, h = (b[1][1] - b[0][1]) * baseT.k;
      if (Math.max(w, h) < 9) small.push({ id: f.properties.seat, cx: (b[0][0] + b[1][0]) / 2, cy: (b[0][1] + b[1][1]) / 2 });
    });
    gHits.selectAll('circle').data(small, d => d.id).join('circle').attr('class', 'hit').attr('cx', d => d.cx).attr('cy', d => d.cy)
      .attr('r', 7 / kNow)
      .on('mouseenter', (e, d) => onEnter(e, featById.get(d.id))).on('mousemove', onMove).on('mouseleave', onLeave)
      .on('click', (e, d) => onClick(e, featById.get(d.id)));
  }
  function zoomed(e) {
    const t = e.transform; kNow = t.k;
    gZoom.attr('transform', t);
    gHits.selectAll('circle').attr('r', 7 / t.k);
    if (t.k / baseT.k > DETAIL_K && !detail && !detailLoading) loadDetail();
  }
  async function loadDetail() {
    detailLoading = true;
    try {
      detail = await fetch('data/detail.topo.json').then(r => r.json());
      features = toFeatures(detail); draw(); buildHits();
      if (selected) sel.attr('d', path(featById.get(selected)));
    } catch (err) { console.warn('detail layer unavailable', err); }
    detailLoading = false;
  }
  buildHits();

  let selected = null;
  function nameOf(f) { const s = byId.get(f.properties.seat); return s ? s.name : 'Seat ' + f.properties.seat; }
  function onEnter(e, f) { hl.attr('d', path(f)).attr('hidden', null); tip.textContent = nameOf(f); tip.hidden = false; onMove(e); }
  function onMove(e) { tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 16) + 'px'; }
  function onLeave() { hl.attr('hidden', true); tip.hidden = true; }
  function onClick(e, f) { select(f.properties.seat); }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function select(id, zoomTo) {
    const s = byId.get(id); if (!s) return;
    selected = id; history.replaceState(null, '', '#seat=' + id);
    const f = featById.get(id); if (f) sel.attr('d', path(f)).attr('hidden', null);
    const approxSet = new Set(s.approx || []);
    let h = '<h2>' + esc(s.name) + '</h2><div class="sub">Seat ' + s.id + ' · ' + esc(s.continent) + ' · pop. ' + (s.pop / 1e6).toFixed(2) + ' M</div>';
    h += '<h3>Includes</h3><ul>';
    for (const c of s.countries) {
      const flag = c.iso2 ? '<img src="https://flagcdn.com/w40/' + c.iso2 + '.png" alt="" onerror="this.remove()">' : '';
      h += '<li class="c">' + esc(c.name) + ' ' + flag;
      if (c.whole) h += ' <span class="whole">(entire country)</span>';
      else {
        h += '<ul>';
        for (const a of c.adm1) {
          if (a.whole) h += '<li class="a1">' + esc(a.name) + '</li>';
          else {
            h += '<li class="a1">' + esc(a.name) + ':<ul>';
            for (const d of a.adm2) {
              const ap = approxSet.has(d);
              h += '<li class="a2' + (ap ? ' approx' : '') + '">' + esc(d) + (ap ? ' ~' : '') + '</li>';
            }
            h += '</ul></li>';
          }
        }
        h += '</ul>';
      }
      h += '</li>';
    }
    h += '</ul>';
    if (approxSet.size) h += '<div class="note"><span class="approx">~</span> boundary approximated (newer district drawn using its parent district).</div>';
    panelBody.innerHTML = h; panel.hidden = false; panel.scrollTop = 0;
    if (zoomTo && f) {
      const b = path.bounds(f), dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1];
      const k = Math.min(zoom.scaleExtent()[1], 0.6 / Math.max(dx / W, dy / H));
      const t = d3.zoomIdentity.translate(W / 2 + 80 - k * (b[0][0] + b[1][0]) / 2, H / 2 - k * (b[0][1] + b[1][1]) / 2).scale(k);
      svg.transition().duration(900).call(zoom.transform, t);
    }
  }
  document.getElementById('close').onclick = () => { panel.hidden = true; sel.attr('hidden', true); selected = null; history.replaceState(null, '', location.pathname); };
  addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('close').click(); });

  document.getElementById('zin').onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.8);
  document.getElementById('zout').onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.8);
  document.getElementById('zreset').onclick = () => svg.transition().duration(600).call(zoom.transform, baseT);

  const dl = document.getElementById('seat-list'), searchIdx = new Map();
  meta.forEach(s => {
    searchIdx.set(s.name.toLowerCase(), s.id);
    const o = document.createElement('option'); o.value = s.name; dl.appendChild(o);
    s.countries.forEach(c => {
      const k = c.name.toLowerCase();
      if (!searchIdx.has(k)) { searchIdx.set(k, s.id); const o2 = document.createElement('option'); o2.value = c.name; dl.appendChild(o2); }
    });
  });
  document.getElementById('search').addEventListener('change', e => {
    const id = searchIdx.get(e.target.value.trim().toLowerCase());
    if (id) select(id, true);
  });

  const m = /seat=(\d+)/.exec(location.hash);
  if (m) select(+m[1], true);
  document.getElementById('loading').classList.add('done');
})();

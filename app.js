/* Jeju trip map: universal app. Data files come from build/pack_full.py (data/*.bin, places.json). */
(async function boot(){
  'use strict';
  const say = t => { const el = document.getElementById('loadingText'); if (el) el.textContent = t; };
  try {
    let got = 0;
    const get = async (p, json) => {
      const r = await fetch(p, {cache: 'no-cache'});
      if (!r.ok) throw new Error(p + ' ' + r.status);
      const v = json ? await r.json() : new Uint8Array(await r.arrayBuffer());
      say('지도 자료를 여는 중… ' + (++got) + '/6');
      return v;
    };
    const meta = await get('data/meta.json', true);
    const [terrain, roads, bld, cover, places] = await Promise.all([get('data/terrain.bin'), get('data/roads.bin'), get('data/bld.bin'),
      get('data/cover.bin'), get('data/places.json', true)]);
    window.__bootData = performance.now();
    say('도로와 건물을 놓는 중…');
    await new Promise(r => setTimeout(r, 30));
    const T = Object.assign({}, meta.terrain, {grid: new Uint16Array(terrain.buffer)});
    let o = 0;
    const R = meta.roads.map(n => { const s = roads.slice(o, o + n); o += n; return s; });
    startApp(T, {roads: R, bld, cover, nb: meta.nb}, places, meta);
  } catch (e) {
    const f = document.getElementById('fatal');
    f.hidden = false;
    f.textContent = '지도 자료를 불러오지 못했습니다. 인터넷에 연결된 상태에서 다시 열어 주세요. (' + e.message + ')';
    console.error(e);
  }
})();

function startApp(T, OSM, PLACES, META){
'use strict';
const THREE = window.THREE;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= data ================= */
const DAY_COLORS = ['#b3402b', '#0f5c60', '#7b3f66', '#9a6510', '#2f4a7c', '#5f6f2a', '#6b4a36'];
const dayColor = d => DAY_COLORS[d % DAY_COLORS.length];

const GEO = [
  ['한라산 1,947m',33.3617,126.5292],['제주시',33.4996,126.5312],['서귀포시',33.2530,126.5600],
  ['성산',33.4370,126.9100],['우도',33.5050,126.9540],['구좌',33.5200,126.8500],['조천',33.5350,126.6350],
  ['애월',33.4630,126.3300],['한림',33.4110,126.2650],['한경',33.3400,126.1800],['대정',33.2260,126.2520],
  ['중문',33.2530,126.4250],['남원',33.2800,126.7200],['표선',33.3260,126.8300],['가파도',33.1690,126.2720],
  ['마라도',33.1170,126.2670]
];

const store = {
  get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
};
// optional playback paths on a stop: [[lat, lon(, alt m)], ...]
const ptList = (a, n) => Array.isArray(a) ? a.filter(p => Array.isArray(p) && p.length >= n && p.slice(0, n).every(v => typeof v === 'number' && isFinite(v)))
  .slice(0, 4000).map(p => p.slice(0, n)) : [];
const airOf = o => o && ptList(o.path, 3).length > 1 ? {path: ptList(o.path, 3), taxi: ptList(o.taxi, 2)} : null;
// Saved trips outlive app updates: every stored trip carries the schema version it was written with, older versions are
// migrated step by step here, and fields this version does not know are kept so an update never drops them.
const APP_VERSION = '2026.11.27-8', SCHEMA = 2;
let bootSec = '', dataSec = '';
const MIGRATE = {
  1: o => { o.air = o.air !== false; return o; }      // v1 (before 2026-11-27): no airport flights yet -> on by default
};
function migrateTrip(o){
  let v = Number.isInteger(o.v) ? o.v : 1;
  if (v > SCHEMA) return o;                          // written by a newer app: read what we understand, keep the rest
  for (; v < SCHEMA; v++) if (MIGRATE[v]) o = MIGRATE[v](o) || o;
  return o;
}
const extra = (o, known) => {
  const r = {};
  if (o && typeof o === 'object') for (const k in o) if (!known.includes(k) && k.length < 40) { try { if (JSON.stringify(o[k]).length <= 4000) r[k] = o[k]; } catch (e) {} }
  return r;
};
// how a stop is reached from the one before ('' = car): also the vehicle that moves in the playback
const BY = ['bus', 'walk', 'bike', 'ferry', 'plane'];
const STOP_KEYS = ['id', 'name', 'lat', 'lon', 'time', 'stay', 'memo', 'dep', 'coast', 'by', 'stroll', 'walk', 'airIn', 'airOut', 'done', 'doneAt'];
// every stop carries a short id that stays with it when it moves; photos (kept outside the trip) point at it
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
let idsAdded = false;
function sanitizeTrip(o){
  if (!o || !Array.isArray(o.days)) return null;
  o = migrateTrip(o);
  idsAdded = false;
  const seen = new Set(), sid = v => {
    let id = typeof v === 'string' && /^[a-z0-9]{4,16}$/.test(v) && !seen.has(v) ? v : '';
    if (!id) { do id = newId(); while (seen.has(id)); idsAdded = true; }
    seen.add(id); return id;
  };
  const days = o.days.slice(0, 30).map(d => Object.assign(extra(d, ['title', 'note', 'stops']), {
    title: String((d && d.title) || '').slice(0, 60), note: String((d && d.note) || '').slice(0, 200),
    stops: (Array.isArray(d && d.stops) ? d.stops : []).filter(s => s && isFinite(+s.lat) && isFinite(+s.lon)).slice(0, 40).map(s => Object.assign(extra(s, STOP_KEYS), {
      id: sid(s.id),
      name: String(s.name || '이름 없는 장소').slice(0, 60),
      // minutes spent at the stop (null: a default by the kind of place), for the arrival estimates
      stay: typeof s.stay === 'number' && Number.isInteger(s.stay) && s.stay >= 0 && s.stay <= 720 ? s.stay : null,
      // checked off on the day itself ('오늘'), with the time it was checked
      done: s.done === true, doneAt: s.done === true && /^\d{2}:\d{2}$/.test(s.doneAt) ? s.doneAt : '',
      lat: clamp(+s.lat, T.lat1, T.lat0), lon: clamp(+s.lon, T.lon0, T.lon1),
      time: /^\d{2}:\d{2}$/.test(s.time) ? s.time : '', memo: String(s.memo || '').slice(0, 200),
      // how this stop is reached from the one before: '' car (default), 'bus', 'walk', 'bike', 'ferry', 'plane'; coast = car along the coast
      dep: /^\d{2}:\d{2}$/.test(s.dep) ? s.dep : '', coast: s.coast === true, by: BY.includes(s.by) ? s.by : '',
      stroll: s.stroll === true,
      walk: s.walk && ptList(s.walk.path, 2).length > 1 ? {label: String(s.walk.label || '걷기').slice(0, 30), path: ptList(s.walk.path, 2)} : null,
      airIn: airOf(s.airIn), airOut: airOf(s.airOut)}))}));
  if (!days.length) days.push({title: '', note: '', stops: []});
  return Object.assign(extra(o, ['v', 'title', 'startDate', 'air', 'days']), {v: Math.max(SCHEMA, Number.isInteger(o.v) ? o.v : 0),
    title: String(o.title || '나의 제주 여행').slice(0, 60), startDate: /^\d{4}-\d{2}-\d{2}$/.test(o.startDate) ? o.startDate : '',
    air: o.air !== false, days});    // air: playback starts with a flight into Jeju and ends with one out
}
const emptyTrip = () => ({v: SCHEMA, title: '나의 제주 여행', startDate: '', air: true, days: [{title: '', note: '', stops: []}]});
// The trip lives only in this browser. The key never changes between app versions (the format is versioned inside),
// and a stored trip this version cannot read is set aside under RESCUE_KEY before anything could overwrite it.
// PREV_KEY keeps the trip as it was when this session started, a way back if an update ever mishandles it.
const TRIP_KEY = 'jejumap.trip.v1', RESCUE_KEY = 'jejumap.trip.rescue', PREV_KEY = 'jejumap.trip.prev';
let rescued = false;
function loadTrip(){
  const raw = store.get(TRIP_KEY);
  if (!raw) return emptyTrip();
  try { const t = sanitizeTrip(JSON.parse(raw)); if (t) { store.set(PREV_KEY, raw); return t; } } catch (e) {}
  if (store.get(RESCUE_KEY) !== raw) store.set(RESCUE_KEY, raw);
  rescued = true;
  return emptyTrip();
}
let trip = loadTrip();
// a trip saved before stops had ids gets them now, and keeps them (photos are filed under them)
if (idsAdded && !rescued && store.get(TRIP_KEY)) store.set(TRIP_KEY, JSON.stringify(trip));
// ask the browser not to evict our storage under pressure (granted for installed web apps on Android; harmless elsewhere)
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}

const state = {
  day: trip.days.length > 1 ? -1 : 0, sel: null, pick: null, today: false, todayDay: -1,
  exag: clamp(parseFloat(store.get('jejumap.exag')) || 1.6, 1, 4),
  geo: store.get('jejumap.geo') !== '0', roads: store.get('jejumap.roads') !== '0', bld: store.get('jejumap.bld') !== '0'
};

/* ================= terrain grid ================= */
const GW = T.w, GH = T.h, NV = GW * GH;
const LATC = (T.lat0 + T.lat1) / 2, LONC = (T.lon0 + T.lon1) / 2;
const KLAT = 110.95, KLON = 111.32 * Math.cos(LATC * Math.PI / 180);
const WX = (T.lon1 - T.lon0) * KLON, WZ = (T.lat0 - T.lat1) * KLAT;   // km
const toX = lon => (lon - LONC) * KLON, toZ = lat => (LATC - lat) * KLAT;
const toLon = x => x / KLON + LONC, toLat = z => LATC - z / KLAT;
const SEA_DEPTH = 110, SLAB = 1.3, CELL = WX / (GW - 1);
const b64bytes = s => { const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; };

const elev = new Float32Array(NV);   // metres; land > 0, sea = synthetic shelf < 0
(function decode(){
  const raw = T.grid, sd = new Float32Array(NV);
  for (let k = 0; k < NV; k++) elev[k] = raw[k] - T.offset;
  // zero-height cells that the open sea cannot reach are data noise on land, not water
  const open = new Uint8Array(NV), stack = [];
  const visit = k => { if (!open[k] && elev[k] <= 0) { open[k] = 1; stack.push(k); } };
  for (let i = 0; i < GW; i++) { visit(i); visit(NV - GW + i); }
  for (let j = 0; j < GH; j++) { visit(j * GW); visit(j * GW + GW - 1); }
  while (stack.length) {
    const k = stack.pop(), i = k % GW;
    if (i > 0) visit(k - 1); if (i < GW - 1) visit(k + 1);
    if (k >= GW) visit(k - GW); if (k < NV - GW) visit(k + GW);
  }
  for (let k = 0; k < NV; k++) { if (elev[k] <= 0 && !open[k]) elev[k] = 1; sd[k] = elev[k] > 0 ? 0 : 1e6; }
  // chamfer distance (in cells) from the coast, for a smooth shallow shelf
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i; let v = sd[k];
    if (i > 0) v = Math.min(v, sd[k - 1] + 1);
    if (j > 0) { v = Math.min(v, sd[k - GW] + 1); if (i > 0) v = Math.min(v, sd[k - GW - 1] + 1.414); if (i < GW - 1) v = Math.min(v, sd[k - GW + 1] + 1.414); }
    sd[k] = v;
  }
  for (let j = GH - 1; j >= 0; j--) for (let i = GW - 1; i >= 0; i--) {
    const k = j * GW + i; let v = sd[k];
    if (i < GW - 1) v = Math.min(v, sd[k + 1] + 1);
    if (j < GH - 1) { v = Math.min(v, sd[k + GW] + 1); if (i < GW - 1) v = Math.min(v, sd[k + GW + 1] + 1.414); if (i > 0) v = Math.min(v, sd[k + GW - 1] + 1.414); }
    sd[k] = v;
  }
  for (let k = 0; k < NV; k++) if (elev[k] <= 0) elev[k] = -SEA_DEPTH * (1 - Math.exp(-sd[k] * CELL / 1.25));
})();

const yv = new Float32Array(NV);     // vertex heights in km (exaggerated)
function fillHeights(){ const e = state.exag * 0.001; for (let k = 0; k < NV; k++) yv[k] = elev[k] * e; }
// true height (m) of the terrain surface, using the same two triangles per cell as the mesh; sea = 0
function groundM(x, z){
  const fx = (x + WX / 2) / WX * (GW - 1), fz = (z + WZ / 2) / WZ * (GH - 1);
  if (fx < 0 || fz < 0 || fx > GW - 1 || fz > GH - 1) return 0;
  const i = Math.min(GW - 2, fx | 0), j = Math.min(GH - 2, fz | 0), a = fx - i, b = fz - j, k = j * GW + i;
  const h10 = elev[k + 1], h01 = elev[k + GW];
  const v = a + b <= 1 ? elev[k] + (h10 - elev[k]) * a + (h01 - elev[k]) * b
                       : elev[k + GW + 1] + (h01 - elev[k + GW + 1]) * (1 - a) + (h10 - elev[k + GW + 1]) * (1 - b);
  return v > 0 ? v : 0;
}
const groundY = (x, z) => groundM(x, z) * state.exag * 0.001;   // exaggerated, km
fillHeights();

/* ================= three.js scene ================= */
const canvas = $('scene'), stage = $('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
} catch (err) {
  const f = $('fatal'); f.hidden = false;
  f.textContent = '이 브라우저에서는 WebGL을 쓸 수 없어 3D 지도를 그리지 못했습니다. 최신 Chrome, Edge, Safari에서 열어 주세요.';
  renderPanelSafe();
  return;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene();
const FOV = 32, TANV = Math.tan(FOV / 2 * Math.PI / 180);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a917f, 0.5));
const sun = new THREE.DirectionalLight(0xfff1d8, 0.7);
sun.position.set(-70, 85, 30);    // from the south-west, so walls facing the default (southern) viewpoint are lit
scene.add(sun);
const fill = new THREE.DirectionalLight(0xdfe9ff, 0.2);
fill.position.set(60, 35, -50); scene.add(fill);

const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
const LOOK = {
  land: [[0,'#ece5d3'],[40,'#e2e2c8'],[150,'#cfd9b6'],[400,'#b5c8a1'],[750,'#9db68f'],[1050,'#99a781'],[1350,'#aba286'],[1650,'#c7bca3'],[1950,'#e9e4d8']],
  sea: ['#c3e2db', '#3d8b90'], water: '#4b9ea2', waterOp: 0.62, slab: '#2c6a6e',
  roads: ['#f3cf73', '#ffffff', '#fbf8ef', '#f2ecdf', '#e3d4b6'],
  wall: '#e6d6bd', roofs: ['#c8704c', '#b9603f', '#d08a63', '#c8704c', '#8fa7ad', '#c8704c', '#dcc0a2'],
  tree: ['#5f8a55', '#6f9a5c', '#4f7a4c'], orchard: '#7aa04e'
};

const terrainGeo = new THREE.BufferGeometry();
const tPos = new Float32Array(NV * 3), tCol = new Float32Array(NV * 3);
(function buildTerrain(){
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = (j * GW + i) * 3;
    tPos[k] = -WX / 2 + i / (GW - 1) * WX; tPos[k + 1] = yv[j * GW + i]; tPos[k + 2] = -WZ / 2 + j / (GH - 1) * WZ;
  }
  const idx = new Uint32Array((GW - 1) * (GH - 1) * 6); let n = 0;
  for (let j = 0; j < GH - 1; j++) for (let i = 0; i < GW - 1; i++) {
    const a = j * GW + i, b = a + 1, c = a + GW, d = c + 1;
    idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
  }
  const ramp = LOOK.land.map(([m, hex]) => [m, lin(hex)]), s0 = lin(LOOK.sea[0]), s1 = lin(LOOK.sea[1]), c = new THREE.Color();
  for (let k = 0; k < NV; k++) {
    const e = elev[k];
    if (e > 0) {
      let i = 1; while (i < ramp.length - 1 && ramp[i][0] < e) i++;
      const a = ramp[i - 1], b = ramp[i];
      c.copy(a[1]).lerp(b[1], clamp((e - a[0]) / (b[0] - a[0]), 0, 1));
    } else c.copy(s0).lerp(s1, clamp(-e / SEA_DEPTH, 0, 1));
    tCol[k * 3] = c.r; tCol[k * 3 + 1] = c.g; tCol[k * 3 + 2] = c.b;
  }
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
  terrainGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  terrainGeo.computeVertexNormals();
})();
scene.add(new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.93, metalness: 0})));

const water = new THREE.Mesh(new THREE.PlaneGeometry(WX, WZ),
  new THREE.MeshStandardMaterial({color: lin(LOOK.water), opacity: LOOK.waterOp, transparent: true, roughness: 0.3, metalness: 0.05, depthWrite: false}));
water.rotation.x = -Math.PI / 2; water.renderOrder = 1; scene.add(water);
const slabMat = new THREE.MeshStandardMaterial({color: lin(LOOK.slab), roughness: 0.8, side: THREE.DoubleSide});
const slab = new THREE.Mesh(new THREE.BoxGeometry(WX, SLAB, WZ),
  [slabMat, slabMat, new THREE.MeshBasicMaterial({visible: false}), slabMat, slabMat, slabMat]);
slab.position.y = -SLAB / 2; scene.add(slab);
(function tableShadow(){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 20, 64, 64, 64);
  r.addColorStop(0, 'rgba(70,45,10,.34)'); r.addColorStop(1, 'rgba(70,45,10,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(WX * 1.5, WZ * 1.7),
    new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false}));
  m.rotation.x = -Math.PI / 2; m.position.y = -SLAB - 0.02; scene.add(m);
})();
function applyExag(){
  fillHeights();
  for (let k = 0; k < NV; k++) tPos[k * 3 + 1] = yv[k];
  terrainGeo.attributes.position.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  terrainGeo.attributes.normal.needsUpdate = true;
}

/* ================= roads, buildings, trees (OpenStreetMap) ================= */
// Heights are stored unexaggerated; the vertex shaders apply the exaggeration, so the slider costs nothing here.
const uExag = {value: state.exag}, uLift = {value: 0}, uBld = {value: 1};
const LONK = (T.lon1 - T.lon0) / 65535, LATK = (T.lat0 - T.lat1) / 65535;
// classes: arterial, tertiary, local street, access road/track, footpath (the last two exist only around the stops)
const ROAD_W = [0.014, 0.009, 0.005, 0.004, 0.002];      // real widths, km
const ROAD_PX = [1.0, 0.7, 0.5, 0.4, 0.35];              // minimum half-width on screen (px)
const ROAD_FAR = [1e9, 170, 45, 14, 6];                  // hidden beyond this camera distance (km)
const roadLayers = [];
function eachRoad(cls, fn){            // fn(qx[], qy[]) per polyline, in the packed 16-bit grid
  const dv = new DataView(OSM.roads[cls].buffer), qx = [], qy = [];
  for (let o = 0; o < dv.byteLength;) {
    const n = dv.getUint16(o, true); o += 2;
    qx.length = qy.length = 0;
    for (let i = 0; i < n; i++, o += 4) { qx.push(dv.getUint16(o, true)); qy.push(dv.getUint16(o + 2, true)); }
    fn(qx, qy);
  }
}
function buildRoads(){
  if (!OSM) return;
  OSM.roads.forEach((_, cls) => {
    const pos = [], side = [], idx = [], px = [], pz = [];
    eachRoad(cls, (qx, qy) => {
      px.length = pz.length = 0;
      for (let i = 0; i < qx.length; i++) {
        const x = toX(T.lon0 + qx[i] * LONK), z = toZ(T.lat0 - qy[i] * LATK);
        if (i) {   // extra points so the ribbon follows the ground between OSM nodes
          const lx = px[px.length - 1], lz = pz[pz.length - 1], m = Math.ceil(Math.hypot(x - lx, z - lz) / 0.07);
          for (let q = 1; q < m; q++) { px.push(lx + (x - lx) * q / m); pz.push(lz + (z - lz) * q / m); }
        }
        px.push(x); pz.push(z);
      }
      const base = pos.length / 3, m = px.length;
      for (let i = 0; i < m; i++) {
        const p = Math.max(0, i - 1), q = Math.min(m - 1, i + 1);
        let dx = px[q] - px[p], dz = pz[q] - pz[p]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const y = groundM(px[i], pz[i]) * 0.001;
        pos.push(px[i], y, pz[i], px[i], y, pz[i]);
        side.push(-dz, dx, dz, -dx);
        if (i) { const a = base + (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(side), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const uHalf = {value: 0.01};
    const mat = new THREE.MeshBasicMaterial({color: lin(LOOK.roads[cls]), polygonOffset: true, polygonOffsetFactor: -3 - (4 - cls), polygonOffsetUnits: -3 - (4 - cls)});
    mat.onBeforeCompile = sh => {
      sh.uniforms.uExag = uExag; sh.uniforms.uLift = uLift; sh.uniforms.uHalf = uHalf;
      sh.vertexShader = 'attribute vec2 aSide;\nuniform float uExag;\nuniform float uLift;\nuniform float uHalf;\n' +
        sh.vertexShader.replace('#include <begin_vertex>',
          'vec3 transformed = vec3(position.x + aSide.x * uHalf, position.y * uExag + uLift, position.z + aSide.y * uHalf);');
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    roadLayers[cls] = {mesh, uHalf};
  });
}

/* ---- road graph: routes are computed here, in the page, from the same OSM roads that are drawn ---- */
const SPEED = [55, 45, 28, 14];          // rough driving speeds (km/h) by road class
let G = null;
function buildGraph(){
  if (!OSM) return;
  const ids = new Map(), nx = [], nz = [], ea = [], eb = [], el = [], ew = [];
  for (let cls = 0; cls < 4; cls++) eachRoad(cls, (qx, qy) => {
    let prev = -1;
    for (let i = 0; i < qx.length; i++) {
      const key = qx[i] * 65536 + qy[i];
      let id = ids.get(key);
      if (id === undefined) { id = nx.length; ids.set(key, id); nx.push(toX(T.lon0 + qx[i] * LONK)); nz.push(toZ(T.lat0 - qy[i] * LATK)); }
      if (prev >= 0 && prev !== id) { const L = Math.hypot(nx[id] - nx[prev], nz[id] - nz[prev]); ea.push(prev); eb.push(id); el.push(L); ew.push(L / SPEED[cls]); }
      prev = id;
    }
  });
  const n = nx.length, m = ea.length, off = new Uint32Array(n + 2);
  for (let e = 0; e < m; e++) { off[ea[e] + 2]++; off[eb[e] + 2]++; }
  for (let i = 2; i < n + 2; i++) off[i] += off[i - 1];
  const to = new Uint32Array(m * 2), wt = new Float32Array(m * 2), ln = new Float32Array(m * 2);
  for (let e = 0; e < m; e++) {
    let p = off[ea[e] + 1]++; to[p] = eb[e]; wt[p] = ew[e]; ln[p] = el[e];
    p = off[eb[e] + 1]++; to[p] = ea[e]; wt[p] = ew[e]; ln[p] = el[e];
  }
  // connected components, so a stop never snaps to an isolated scrap of road
  const comp = new Int32Array(n).fill(-1), size = [];
  for (let s = 0; s < n; s++) if (comp[s] < 0) {
    const c = size.length, st = [s]; let cnt = 0; comp[s] = c;
    while (st.length) { const u = st.pop(); cnt++; for (let p = off[u]; p < off[u + 1]; p++) if (comp[to[p]] < 0) { comp[to[p]] = c; st.push(to[p]); } }
    size.push(cnt);
  }
  const GC = 0.4, cells = new Map();
  for (let i = 0; i < n; i++) {
    if (size[comp[i]] < 150) continue;
    const k = Math.floor(nx[i] / GC) * 4096 + Math.floor(nz[i] / GC);
    let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i);
  }
  G = {n, x: nx, z: nz, off, to, wt, ln, comp, cells, GC, g: new Float64Array(n), prev: new Int32Array(n)};
}
function snapNode(x, z){
  const cx = Math.floor(x / G.GC), cz = Math.floor(z / G.GC); let best = -1, bd = 1.2 * 1.2;
  for (let r = 0; r <= 3; r++) {
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
      if (Math.max(Math.abs(i - cx), Math.abs(j - cz)) !== r) continue;
      const a = G.cells.get(i * 4096 + j); if (!a) continue;
      for (const id of a) { const d = (G.x[id] - x) ** 2 + (G.z[id] - z) ** 2; if (d < bd) { bd = d; best = id; } }
    }
    if (best >= 0 && bd < (r * G.GC) ** 2) break;
  }
  return best;
}
// distance (km) from each road node to the open sea, for legs that should keep to the coast
function coastDist(){
  if (G.cd) return G.cd;
  const d = new Float32Array(NV);
  for (let k = 0; k < NV; k++) d[k] = elev[k] > 0 ? 1e6 : 0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + 1);
    if (j > 0) { v = Math.min(v, d[k - GW] + 1); if (i > 0) v = Math.min(v, d[k - GW - 1] + 1.414); if (i < GW - 1) v = Math.min(v, d[k - GW + 1] + 1.414); }
    d[k] = v;
  }
  for (let j = GH - 1; j >= 0; j--) for (let i = GW - 1; i >= 0; i--) {
    const k = j * GW + i; let v = d[k];
    if (i < GW - 1) v = Math.min(v, d[k + 1] + 1);
    if (j < GH - 1) { v = Math.min(v, d[k + GW] + 1); if (i < GW - 1) v = Math.min(v, d[k + GW + 1] + 1.414); if (i > 0) v = Math.min(v, d[k + GW - 1] + 1.414); }
    d[k] = v;
  }
  const cd = new Float32Array(G.n);
  for (let n = 0; n < G.n; n++) {
    const i = clamp(Math.round((G.x[n] + WX / 2) / WX * (GW - 1)), 0, GW - 1), j = clamp(Math.round((G.z[n] + WZ / 2) / WZ * (GH - 1)), 0, GH - 1);
    cd[n] = d[j * GW + i] * CELL;
  }
  return G.cd = cd;
}
const COAST_FREE = 0.35, COAST_K = 4;   // roads within 350 m of the sea cost their normal time; farther ones cost more
function astar(s, t, coast){
  const {x, z, off, to, wt, g, prev} = G, hn = [s], hf = [0], cd = coast ? coastDist() : null;
  g.fill(Infinity); prev.fill(-1); g[s] = 0;
  const tx = x[t], tz = z[t], h = v => Math.hypot(x[v] - tx, z[v] - tz) / 60;
  while (hn.length) {
    const u = hn[0], fu = hf[0], ln = hn.pop(), lf = hf.pop();     // pop the heap minimum
    if (hn.length) {
      let i = 0; const N = hn.length;
      for (;;) { let c = i * 2 + 1; if (c >= N) break; if (c + 1 < N && hf[c + 1] < hf[c]) c++; if (hf[c] >= lf) break; hn[i] = hn[c]; hf[i] = hf[c]; i = c; }
      hn[i] = ln; hf[i] = lf;
    }
    if (u === t) break;
    if (fu > g[u] + h(u) + 1e-9) continue;
    for (let p = off[u]; p < off[u + 1]; p++) {
      const v = to[p], ng = g[u] + (cd ? wt[p] * (1 + COAST_K * Math.max(0, (cd[u] + cd[v]) / 2 - COAST_FREE)) : wt[p]);
      if (ng < g[v]) {
        g[v] = ng; prev[v] = u;
        let i = hn.length; const f = ng + h(v); hn.push(v); hf.push(f);
        while (i > 0) { const q = (i - 1) >> 1; if (hf[q] <= f) break; hn[i] = hn[q]; hf[i] = hf[q]; i = q; }
        hn[i] = v; hf[i] = f;
      }
    }
  }
  if (g[t] === Infinity) return null;
  const path = []; for (let v = t; v >= 0; v = prev[v]) path.push(v);
  return path.reverse();
}
const hav = (a, b) => {
  const R = 6371, p = Math.PI / 180, dl = (b.lat - a.lat) * p, dn = (b.lon - a.lon) * p;
  const q = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};
const legCache = new Map();
// one leg of the day: along the roads when both ends reach the network, otherwise a straight hop (a ferry if it is over water).
// b.coast asks for a route that keeps to the coastal roads.
function routeLeg(a, b, noCache){         // noCache: a one-off start (the phone's position), not worth keeping
  const coast = !!b.coast;
  const key = a.lat.toFixed(5) + ',' + a.lon.toFixed(5) + '|' + b.lat.toFixed(5) + ',' + b.lon.toFixed(5) + (coast ? '|coast' : '');
  let leg = noCache ? null : legCache.get(key);
  if (leg) return leg;
  const ax = toX(a.lon), az = toZ(a.lat), bx = toX(b.lon), bz = toZ(b.lat);
  if (G) {
    const sa = snapNode(ax, az), sb = snapNode(bx, bz);
    if (sa >= 0 && sb >= 0 && G.comp[sa] === G.comp[sb]) {
      const path = sa === sb ? [sa] : astar(sa, sb, coast);
      if (path) {
        const walk = Math.hypot(G.x[sa] - ax, G.z[sa] - az) + Math.hypot(G.x[sb] - bx, G.z[sb] - bz);
        let km = walk, hours = walk / 15;
        for (let i = 1; i < path.length; i++) for (let p = G.off[path[i - 1]]; p < G.off[path[i - 1] + 1]; p++) if (G.to[p] === path[i]) { km += G.ln[p]; hours += G.wt[p]; break; }
        leg = {kind: 'road', coast, km, min: hours * 60 * 1.15, pts: [[ax, az], ...path.map(i => [G.x[i], G.z[i]]), [bx, bz]]};
      }
    }
  }
  if (!leg) {
    let sea = 0;
    for (let i = 1; i < 20; i++) if (groundM(ax + (bx - ax) * i / 20, az + (bz - az) * i / 20) === 0) sea++;
    leg = {kind: sea > 7 ? 'ferry' : 'direct', km: hav(a, b), min: null, pts: [[ax, az], [bx, bz]]};
  }
  if (!noCache) legCache.set(key, leg);
  return leg;
}
// a boat or a plane picked for a leg leaves the roads: it goes straight across (the plane flies an arc in the playback)
function legOf(a, b){
  if (b.by !== 'ferry' && b.by !== 'plane') return routeLeg(a, b);
  return {kind: b.by === 'ferry' ? 'ferry' : 'air', km: hav(a, b), min: null, pts: [[toX(a.lon), toZ(a.lat)], [toX(b.lon), toZ(b.lat)]]};
}
// Driving minutes and km from one road node to several others at once: one Dijkstra that stops when every target is
// settled (the day's reordering needs all pairs; n searches instead of n² A*).
function roadFrom(s, targets){
  const {off, to, wt, ln, n} = G;
  if (!G.dg) { G.dg = new Float64Array(n); G.dk = new Float64Array(n); }
  const g = G.dg, km = G.dk, want = new Set(targets), hn = [s], hg = [0];
  g.fill(Infinity); g[s] = 0; km[s] = 0; want.delete(s);
  while (hn.length && want.size) {
    const u = hn[0], gu = hg[0], ln0 = hn.pop(), lg = hg.pop();
    if (hn.length) {
      let i = 0; const N = hn.length;
      for (;;) { let c = i * 2 + 1; if (c >= N) break; if (c + 1 < N && hg[c + 1] < hg[c]) c++; if (hg[c] >= lg) break; hn[i] = hn[c]; hg[i] = hg[c]; i = c; }
      hn[i] = ln0; hg[i] = lg;
    }
    if (gu > g[u]) continue;
    want.delete(u);
    for (let p = off[u]; p < off[u + 1]; p++) {
      const v = to[p], ng = gu + wt[p];
      if (ng < g[v]) {
        g[v] = ng; km[v] = km[u] + ln[p];
        let i = hn.length; hn.push(v); hg.push(ng);
        while (i > 0) { const q = (i - 1) >> 1; if (hg[q] <= ng) break; hn[i] = hn[q]; hg[i] = hg[q]; i = q; }
        hn[i] = v; hg[i] = ng;
      }
    }
  }
  return targets.map(t => ({h: g[t], km: km[t]}));
}

/* ---- Jeju International Airport: arrival from the northern sea onto runway 07, departure back over the sea ---- */
// The same geometry the first prototype used (build/extras.py): a curving 3 km final on a 3° glide path, touchdown,
// rollout, taxi to the terminal; for the departure, taxi out, take-off roll, climb and a left turn to the north.
const AIR = (() => {
  const W_END = [33.49990, 126.46849], E_END = [33.51488, 126.49761], TERM = [33.50637, 126.49225];
  let ux = (E_END[1] - W_END[1]) * KLON, uz = -(E_END[0] - W_END[0]) * KLAT; const rl = Math.hypot(ux, uz); ux /= rl; uz /= rl;
  const along = (p, d) => [p[0] - uz * d / KLAT, p[1] + ux * d / KLON];
  const bez = (p0, p1, p2, p3, n) => {
    const o = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = (1 - t) ** 3, b = 3 * t * (1 - t) ** 2, c = 3 * t * t * (1 - t), d = t ** 3;
      o.push([0, 1, 2].map(j => a * p0[j] + b * p1[j] + c * p2[j] + d * p3[j]));
    }
    return o;
  };
  const GLIDE = Math.tan(3 * Math.PI / 180), fin = along(W_END, -3.0);
  const arr = bez([33.600, 126.470, 900], [33.585, 126.395, 700], [...along(fin, -3.5), 300], [...fin, 3000 * GLIDE], 26);
  arr.push([...along(W_END, -1.5), 1850 * GLIDE], [...along(W_END, 0), 15], [...along(W_END, 0.35), 0], [...along(W_END, 1.6), 0]);
  const entry = along(W_END, 0.25), climb = along(E_END, 1.8);
  const dep = [[...entry, 0], [...along(W_END, 1.0), 0], [...along(W_END, 2.0), 0], [...along(W_END, 3.18), 90], [...climb, 260]];
  dep.push(...bez([...climb, 260], [...along(climb, 2.5), 420], [33.585, 126.545, 800], [33.600, 126.540, 1000], 22).slice(1));
  return {lat: TERM[0], lon: TERM[1], name: '제주국제공항',
    airIn: {path: arr, taxi: [along(W_END, 1.6), along(W_END, 1.95), TERM]},
    airOut: {taxi: [TERM, along(W_END, 1.2), entry], path: dep}};
})();
// With trip.air on, the trip's first stop is reached from the airport and the last one leads back to it. A stop within
// 1.2 km of the terminal is the airport itself, so no drive is added.
let airPlan = null;
function planAir(){
  airPlan = null;
  if (!trip.air) return;
  const ds = trip.days.map((x, d) => x.stops.length ? d : -1).filter(d => d >= 0);
  if (!ds.length) return;
  const d0 = ds[0], d1 = ds[ds.length - 1], first = trip.days[d0].stops[0], last = trip.days[d1].stops[trip.days[d1].stops.length - 1];
  const inOn = !first.airIn, outOn = !last.airOut;          // a stop that brings its own flight path keeps it
  airPlan = {d0, d1, inOn, outOn,
    inLeg: inOn && hav(AIR, first) > 1.2 ? routeLeg(AIR, first) : null,
    outLeg: outOn && hav(AIR, last) > 1.2 ? routeLeg(last, AIR) : null};
}

/* ---- strolls: a walking loop on the paths around a stop ('걸어서 둘러보기') ---- */
// Footpaths, tracks, service and local roads within 750 m make a small graph. The walk goes out to the spot that is
// farthest away (or highest, for a peak) within about 1 km of walking, then comes back another way where it can.
let PIDX = null;
function pathIndex(){        // 1 km cells -> polylines of road classes 1-4 that have a point inside
  if (PIDX) return PIDX;
  PIDX = new Map();
  for (let cls = 1; cls < 5; cls++) {
    const dv = new DataView(OSM.roads[cls].buffer);
    for (let o = 0; o < dv.byteLength;) {
      const n = dv.getUint16(o, true), start = o; o += 2;
      let lastK = -1;
      for (let i = 0; i < n; i++, o += 4) {
        const x = toX(T.lon0 + dv.getUint16(o, true) * LONK), z = toZ(T.lat0 - dv.getUint16(o + 2, true) * LATK);
        const k = Math.floor(x + WX / 2) + Math.floor(z + WZ / 2) * 1000;
        if (k === lastK) continue;
        lastK = k;
        let a = PIDX.get(k); if (!a) PIDX.set(k, a = []);
        if (a[a.length - 1] !== start * 8 + cls) a.push(start * 8 + cls);
      }
    }
  }
  return PIDX;
}
const strollCache = new Map();
function strollOf(s){
  const key = s.lat.toFixed(5) + ',' + s.lon.toFixed(5);
  if (!strollCache.has(key)) { let r = null; try { r = makeStroll(s); } catch (e) { console.warn('stroll', e); } strollCache.set(key, r); }
  return strollCache.get(key);
}
const walkOf = s => s.walk || (s.stroll ? strollOf(s) : null);
function makeStroll(s){
  if (!OSM) return null;
  const sx = toX(s.lon), sz = toZ(s.lat), R = 0.75, R2 = (R * 1.25) ** 2, COST = [0, 2.2, 1.4, 1.0, 0.75];
  const idx = pathIndex(), ids = new Map(), nx = [], nz = [], adj = [], seen = new Set();
  const node = (qx, qy) => {
    const k = qx * 65536 + qy; let id = ids.get(k);
    if (id === undefined) { id = nx.length; ids.set(k, id); nx.push(toX(T.lon0 + qx * LONK)); nz.push(toZ(T.lat0 - qy * LATK)); adj.push([]); }
    return id;
  };
  const ci = Math.floor(sx + WX / 2), cj = Math.floor(sz + WZ / 2);
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const e of idx.get(i + j * 1000) || []) {
    if (seen.has(e)) continue;
    seen.add(e);
    const cls = e % 8, dv = new DataView(OSM.roads[cls].buffer), o0 = Math.floor(e / 8), n = dv.getUint16(o0, true);
    let pq = -1, pr = -1, pin = false;
    for (let q = 0, o = o0 + 2; q < n; q++, o += 4) {
      const qx = dv.getUint16(o, true), qy = dv.getUint16(o + 2, true);
      const x = toX(T.lon0 + qx * LONK), z = toZ(T.lat0 - qy * LATK), inside = (x - sx) ** 2 + (z - sz) ** 2 < R2;
      if (q && inside && pin) {
        const a = node(pq, pr), b = node(qx, qy);
        if (a !== b) { const L = Math.hypot(nx[b] - nx[a], nz[b] - nz[a]); adj[a].push(b, L, L * COST[cls]); adj[b].push(a, L, L * COST[cls]); }
      }
      pq = qx; pr = qy; pin = inside;
    }
  }
  if (!nx.length) return null;
  let st = -1, sd = 0.3 * 0.3;
  for (let i = 0; i < nx.length; i++) { const d = (nx[i] - sx) ** 2 + (nz[i] - sz) ** 2; if (d < sd && adj[i].length) { sd = d; st = i; } }
  if (st < 0) return null;
  const N = nx.length;
  const dijkstra = (from, used) => {
    const cost = new Float64Array(N).fill(Infinity), len = new Float64Array(N), prev = new Int32Array(N).fill(-1), hn = [from], hc = [0];
    cost[from] = 0;
    while (hn.length) {
      let bi = 0; for (let i = 1; i < hc.length; i++) if (hc[i] < hc[bi]) bi = i;     // small graphs: a linear scan is enough
      const u = hn[bi], cu = hc[bi]; hn[bi] = hn[hn.length - 1]; hc[bi] = hc[hc.length - 1]; hn.pop(); hc.pop();
      if (cu > cost[u]) continue;
      const A = adj[u];
      for (let p = 0; p < A.length; p += 3) {
        const v = A[p], c = cu + A[p + 2] * (used && used.has(Math.min(u, v) * N + Math.max(u, v)) ? 6 : 1);
        if (c < cost[v]) { cost[v] = c; len[v] = len[u] + A[p + 1]; prev[v] = u; hn.push(v); hc.push(c); }
      }
    }
    return {cost, len, prev};
  };
  const out = dijkstra(st, null), g0 = groundM(nx[st], nz[st]);
  let tgt = -1, bs = -1;
  for (let i = 0; i < N; i++) {
    if (!(out.len[i] >= 0.2 && out.len[i] <= 1.0)) continue;
    const score = Math.hypot(nx[i] - sx, nz[i] - sz) + Math.max(0, groundM(nx[i], nz[i]) - g0) * 0.004;
    if (score > bs) { bs = score; tgt = i; }
  }
  if (tgt < 0) return null;
  const pathTo = (prev, a) => { const p = []; for (let v = a; v >= 0; v = prev[v]) p.push(v); return p; };
  const go = pathTo(out.prev, tgt).reverse(), used = new Set();
  for (let i = 1; i < go.length; i++) used.add(Math.min(go[i - 1], go[i]) * N + Math.max(go[i - 1], go[i]));
  const back = pathTo(dijkstra(tgt, used).prev, st).reverse();
  if (back[0] !== tgt) return null;
  const ring = go.concat(back.slice(1)), path = [[s.lat, s.lon]];
  for (const v of ring) path.push([+toLat(nz[v]).toFixed(6), +toLon(nx[v]).toFixed(6)]);
  path.push([s.lat, s.lon]);
  let km = 0;
  for (let i = 1; i < path.length; i++) km += Math.hypot((path[i][1] - path[i - 1][1]) * KLON, (path[i][0] - path[i - 1][0]) * KLAT);
  return {label: '걸어서 둘러보기', path, km};
}

/* ---- buildings: real OSM footprints, kept only around the stops ---- */
const TILE = 2.5, B_SHOW = 28, BLD_BUDGET = 1200000;    // vertices kept on the GPU before hidden tiles are freed
let B = null, destRoof = new Map();
const bldMat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.85, metalness: 0});
bldMat.onBeforeCompile = sh => {
  sh.uniforms.uExag = uExag; sh.uniforms.uBld = uBld;
  sh.vertexShader = 'attribute float aBase;\nuniform float uExag;\nuniform float uBld;\n' + sh.vertexShader.replace('#include <begin_vertex>',
    'vec3 transformed = vec3(position.x, aBase * uExag + position.y * uBld, position.z);');
};
const bldGroup = new THREE.Group(); scene.add(bldGroup);
function parseBuildings(){
  if (!OSM || !OSM.nb) return;
  const dv = new DataView(OSM.bld.buffer), n = OSM.nb;
  B = {dv, x: new Float32Array(n), z: new Float32Array(n), off: new Uint32Array(n), n: new Uint8Array(n),
       h: new Uint8Array(n), kind: new Uint8Array(n), tiles: new Map(), built: 0, verts: 0};
  for (let i = 0, o = 0; i < n; i++) {
    B.x[i] = dv.getFloat32(o, true); B.z[i] = dv.getFloat32(o + 4, true);
    B.n[i] = dv.getUint8(o + 8); B.h[i] = dv.getUint8(o + 9); B.kind[i] = dv.getUint8(o + 10);
    B.off[i] = o + 11; o += 11 + B.n[i] * 4;
    const tx = Math.floor((B.x[i] + WX / 2) / TILE), tz = Math.floor((B.z[i] + WZ / 2) / TILE), key = tx + tz * 1000;
    let t = B.tiles.get(key);
    if (!t) B.tiles.set(key, t = {ids: [], mesh: null, cx: (tx + 0.5) * TILE - WX / 2, cz: (tz + 0.5) * TILE - WZ / 2});
    t.ids.push(i);
  }
}
function buildTile(t){
  const wall = lin(LOOK.wall), roofs = LOOK.roofs.map(lin);
  const pos = [], nor = [], col = [], base = [], idx = [], xs = [], zs = [], ring = [];
  let g0 = 0;
  const vert = (x, y, z, nx, ny, nz, c) => { pos.push(x, y, z); nor.push(nx, ny, nz); col.push(c.r, c.g, c.b); base.push(g0); };
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz, rx, ry, rz, c) => {   // normal is flipped to agree with (rx,ry,rz)
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const v = pos.length / 3, flip = nx * rx + ny * ry + nz * rz < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    vert(ax, ay, az, nx, ny, nz, c); vert(bx, by, bz, nx, ny, nz, c); vert(cx, cy, cz, nx, ny, nz, c);
    if (flip) idx.push(v, v + 2, v + 1); else idx.push(v, v + 1, v + 2);
  };
  for (const i of t.ids) {
    const n = B.n[i], cx = B.x[i], cz = B.z[i], o = B.off[i], dest = destRoof.get(i);
    const roof = dest || roofs[B.kind[i] % roofs.length], wc = dest ? lin('#f6eedd') : wall;
    let gmin = 1e9, gsum = 0;
    xs.length = zs.length = ring.length = 0;
    for (let k = 0; k < n; k++) {
      const x = cx + B.dv.getInt16(o + k * 4, true) / 20000, z = cz + B.dv.getInt16(o + k * 4 + 2, true) / 20000, g = groundM(x, z);
      xs.push(x); zs.push(z); gsum += g; if (g < gmin) gmin = g;
    }
    g0 = gsum / n * 0.001;
    const yb = (gmin * 0.001 - g0) * 3 - 0.003, yt = B.h[i] * 0.001;
    for (let k = 0; k < n; k++) {             // walls (footprints are stored with outward normal = (dz, -dx))
      const j = (k + 1) % n, dx = xs[j] - xs[k], dz = zs[j] - zs[k], L = Math.hypot(dx, dz) || 1, v = pos.length / 3;
      vert(xs[k], yb, zs[k], dz / L, 0, -dx / L, wc); vert(xs[j], yb, zs[j], dz / L, 0, -dx / L, wc);
      vert(xs[j], yt, zs[j], dz / L, 0, -dx / L, wc); vert(xs[k], yt, zs[k], dz / L, 0, -dx / L, wc);
      idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
    const e0 = Math.hypot(xs[1] - xs[0], zs[1] - zs[0]), e1 = n === 4 ? Math.hypot(xs[2] - xs[1], zs[2] - zs[1]) : 0;
    if (n === 4 && B.h[i] <= 9 && e0 * e1 < 0.0006 && Math.min(e0, e1) > 0.004) {
      // small four-corner house: gable roof with the ridge along the long side
      const s = e0 >= e1 ? 0 : 1, P = k => (k + s) % 4, rh = Math.min(0.0035, Math.min(e0, e1) * 0.38);
      const a = P(0), b = P(1), c = P(2), d = P(3);
      const m1x = (xs[b] + xs[c]) / 2, m1z = (zs[b] + zs[c]) / 2, m3x = (xs[d] + xs[a]) / 2, m3z = (zs[d] + zs[a]) / 2, yr = yt + rh;
      tri(xs[a], yt, zs[a], xs[b], yt, zs[b], m1x, yr, m1z, 0, 1, 0, roof); tri(xs[a], yt, zs[a], m1x, yr, m1z, m3x, yr, m3z, 0, 1, 0, roof);
      tri(xs[c], yt, zs[c], xs[d], yt, zs[d], m3x, yr, m3z, 0, 1, 0, roof); tri(xs[c], yt, zs[c], m3x, yr, m3z, m1x, yr, m1z, 0, 1, 0, roof);
      tri(xs[b], yt, zs[b], xs[c], yt, zs[c], m1x, yr, m1z, zs[c] - zs[b], 0, xs[b] - xs[c], wc);
      tri(xs[d], yt, zs[d], xs[a], yt, zs[a], m3x, yr, m3z, zs[a] - zs[d], 0, xs[d] - xs[a], wc);
    } else {
      const v0 = pos.length / 3;
      for (let k = 0; k < n; k++) vert(xs[k], yt, zs[k], 0, 1, 0, roof);
      let tris;
      if (n <= 4) tris = n === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
      else { for (let k = 0; k < n; k++) ring.push(new THREE.Vector2(xs[k], zs[k])); tris = THREE.ShapeUtils.triangulateShape(ring, []); }
      for (const [a, b, c] of tris) {
        const up = (xs[b] - xs[a]) * (zs[c] - zs[a]) - (zs[b] - zs[a]) * (xs[c] - xs[a]) < 0;
        idx.push(v0 + a, v0 + (up ? b : c), v0 + (up ? c : b));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aBase', new THREE.BufferAttribute(new Float32Array(base), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  for (const k in g.attributes) g.attributes[k].onUpload(freeArray);
  g.index.onUpload(freeArray);
  t.mesh = new THREE.Mesh(g, bldMat);
  t.mesh.frustumCulled = false;
  t.verts = pos.length / 3;
  bldGroup.add(t.mesh); B.built++; B.verts += t.verts;
}
function dropBuildingTile(t){
  if (!t.mesh) return;
  bldGroup.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null;
  B.built--; B.verts -= t.verts;
}
function dropBuildingTiles(){
  if (!B) return;
  for (const t of B.tiles.values()) dropBuildingTile(t);
}
// the building that stands on each stop gets its day's colour on the roof
function markDestinations(){
  destRoof = new Map();
  if (!B) return;
  trip.days.forEach((day, d) => day.stops.forEach(s => {
    const x = toX(s.lon), z = toZ(s.lat); let best = -1, bd = 0.045 * 0.045;
    for (let i = 0; i < B.x.length; i++) { const q = (B.x[i] - x) ** 2 + (B.z[i] - z) ** 2; if (q < bd) { bd = q; best = i; } }
    if (best >= 0 && !destRoof.has(best)) destRoof.set(best, lin(dayColor(d)));
  }));
  dropBuildingTiles();
}

/* ---- trees: grown per 2.5 km tile, island-wide, from the OSM woods / orchards / parks (cover.bin) ---- */
// OSM maps only part of Hallasan's forest, so grid cells between 600 and 1400 m that no wood polygon covers get forest
// too (faded in and out over 90 m). Trees sit on a world-aligned jittered grid, so neighbouring tiles never double up.
// Each tile keeps its trees in shuffled order: far tiles draw only the first part, which is an even thinning.
const TREE_SHOW = 14, TREE_BUDGET = 320000;
const TK = [   // by cover kind: grid step (km), fill share, height (km), jitter, colour set, orchard shape
  {step: 0.024, p: 0.9, h0: 0.009, h1: 0.016, jit: 0.85, col: 0},              // wood
  {step: 0.024, p: 0.9, h0: 0.009, h1: 0.016, jit: 0.85, col: 0},              // forest
  {step: 0.05, p: 0.55, h0: 0.003, h1: 0.005, jit: 0.85, col: 2},              // scrub
  {step: 0.016, p: 0.95, h0: 0.0028, h1: 0.0036, jit: 0.25, col: 1, orch: 1},  // orchard
  {step: 0.04, p: 0.45, h0: 0.006, h1: 0.011, jit: 0.85, col: 0},              // park
  {step: 0.04, p: 0.3, h0: 0.004, h1: 0.008, jit: 0.85, col: 0}                // garden
];
const HALLA = {lo: 600, hi: 1400, fade: 90, p: 0.85};
const TREE_COLS = [LOOK.tree, [LOOK.orchard], ['#7f9a5e', '#8ea468'], ['#3f6b45', '#4a7a4c', '#55804f']].map(set => set.map(c => {
  const l = lin(c); return [Math.round(l.r * 255), Math.round(l.g * 255), Math.round(l.b * 255)];
}));
const tileOf = (v, W) => Math.floor((v + W / 2) / TILE);
const freeArray = function(){ this.array = null; };       // after upload to the GPU the JS copy is not needed
let CV = null;
function parseCover(){
  if (!OSM || !OSM.cover || !OSM.cover.length) return;
  const dv = new DataView(OSM.cover.buffer, OSM.cover.byteOffset, OSM.cover.byteLength), tiles = new Map();
  for (let o = 0; o < dv.byteLength;) {
    const kind = dv.getUint8(o), nr = dv.getUint16(o + 1, true); o += 3;
    const rings = []; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let r = 0; r < nr; r++) {
      const n = dv.getUint16(o, true), xz = new Float32Array(n * 2); o += 2;
      for (let i = 0; i < n; i++, o += 4) {
        const x = toX(T.lon0 + dv.getUint16(o, true) * LONK), z = toZ(T.lat0 - dv.getUint16(o + 2, true) * LATK);
        xz[i * 2] = x; xz[i * 2 + 1] = z;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      rings.push(xz);
    }
    if (!TK[kind]) continue;
    const p = {kind, rings, z0, z1};
    for (let tx = tileOf(x0, WX); tx <= tileOf(x1, WX); tx++) for (let tz = tileOf(z0, WZ); tz <= tileOf(z1, WZ); tz++) {
      const k = tx + tz * 1000; let a = tiles.get(k); if (!a) tiles.set(k, a = []); a.push(p);
    }
  }
  CV = {tiles};
}
const hash3 = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function growTrees(t){
  const x0 = t.tx * TILE - WX / 2, z0 = t.tz * TILE - WZ / 2, x1 = x0 + TILE, z1 = z0 + TILE;
  const polys = (CV && CV.tiles.get(t.key)) || [], out = [], xs = [];
  const cells = s => [Math.ceil(x0 / s - 0.5), Math.ceil(x1 / s - 0.5) - 1, Math.ceil(z0 / s - 0.5), Math.ceil(z1 / s - 0.5) - 1];
  const plant = (kind, k, ix, iz, s, fx, colSet) => {
    const r1 = hash3(ix, iz, kind * 7 + 1), r2 = hash3(ix, iz, kind * 7 + 2), r3 = hash3(ix, iz, kind * 7 + 3), r4 = hash3(ix, iz, kind * 7 + 4);
    if (r1 >= fx) return;
    const x = (ix + 0.5 + (r2 - 0.5) * k.jit) * s, z = (iz + 0.5 + (r3 - 0.5) * k.jit) * s, g = groundM(x, z);
    if (g <= 0.5) return;
    const h = k.h0 + r4 * (k.h1 - k.h0), c = colSet[Math.floor(r2 * 997) % colSet.length];
    out.push(x, g * 0.001, z, k.orch ? -h : h, c[0], c[1], c[2]);
  };
  // even-odd scanline fill of each cover kind's polygons on its own grid; wood/forest cells are remembered for Hallasan
  const byKind = new Map();
  for (const p of polys) { let a = byKind.get(p.kind); if (!a) byKind.set(p.kind, a = []); a.push(p); }
  const FS = TK[0].step, [fi0, fi1, fj0, fj1] = cells(FS), fw = fi1 - fi0 + 1, wood = new Uint8Array(fw * (fj1 - fj0 + 1));
  for (const [kind, ps] of byKind) {
    const k = TK[kind], s = k.step, [i0, i1, j0, j1] = cells(s), cov = new Uint8Array(i1 - i0 + 1);
    for (let iz = j0; iz <= j1; iz++) {
      const zc = (iz + 0.5) * s; cov.fill(0);
      for (const p of ps) {
        if (zc < p.z0 || zc > p.z1) continue;
        xs.length = 0;
        for (const r of p.rings) for (let a = 0, n = r.length / 2, b = n - 1; a < n; b = a++) {
          const za = r[a * 2 + 1], zb = r[b * 2 + 1];
          if ((za > zc) !== (zb > zc)) xs.push(r[a * 2] + (zc - za) * (r[b * 2] - r[a * 2]) / (zb - za));
        }
        xs.sort((a, b) => a - b);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const a = Math.max(i0, Math.ceil(xs[q] / s - 0.5)), b = Math.min(i1, Math.ceil(xs[q + 1] / s - 0.5) - 1);
          for (let i = a; i <= b; i++) cov[i - i0] = 1;
        }
      }
      for (let i = i0; i <= i1; i++) if (cov[i - i0]) {
        plant(kind, k, i, iz, s, k.p, TREE_COLS[k.col]);
        if (kind <= 1) wood[(iz - fj0) * fw + (i - fi0)] = 1;
      }
    }
  }
  // Hallasan's forest belt where OSM has no wood
  const hk = TK[0];
  for (let iz = fj0; iz <= fj1; iz++) for (let i = fi0; i <= fi1; i++) {
    if (wood[(iz - fj0) * fw + (i - fi0)]) continue;
    const g = groundM((i + 0.5) * FS, (iz + 0.5) * FS);
    if (g < HALLA.lo || g > HALLA.hi) continue;
    const f = Math.min(1, (g - HALLA.lo) / HALLA.fade, (HALLA.hi - g) / HALLA.fade);
    plant(9, hk, i, iz, FS, HALLA.p * f, TREE_COLS[3]);
  }
  // shuffle, so drawing the first n of them thins the tile evenly
  const n = out.length / 7, aT = new Float32Array(n * 4), col = new Uint8Array(n * 3), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(hash3(t.tx, t.tz, i) * (i + 1)), q = order[i]; order[i] = order[j]; order[j] = q; }
  let gmin = 1e9, gmax = -1e9;
  for (let i = 0; i < n; i++) {
    const o = order[i] * 7;
    aT[i * 4] = out[o]; aT[i * 4 + 1] = out[o + 1]; aT[i * 4 + 2] = out[o + 2]; aT[i * 4 + 3] = out[o + 3];
    col[i * 3] = out[o + 4]; col[i * 3 + 1] = out[o + 5]; col[i * 3 + 2] = out[o + 6];
    if (out[o + 1] < gmin) gmin = out[o + 1]; if (out[o + 1] > gmax) gmax = out[o + 1];
  }
  return {n, aT, col, gmin, gmax};
}
const treeGeo = new THREE.ConeGeometry(1, 1, 6, 1, true); treeGeo.translate(0, 0.5, 0);
const treeMat = new THREE.MeshLambertMaterial({vertexColors: true});
const uTreeK = {value: 1};
treeMat.onBeforeCompile = sh => {
  sh.uniforms.uExag = uExag; sh.uniforms.uTreeK = uTreeK;
  sh.vertexShader = 'attribute vec4 aT;\nuniform float uExag;\nuniform float uTreeK;\n' + sh.vertexShader.replace('#include <begin_vertex>',
    'float th = abs(aT.w), tr = th * (aT.w < 0.0 ? 0.75 : 0.4);\n' +
    'vec3 transformed = vec3(aT.x + position.x * tr, aT.y * uExag + position.y * th * uTreeK, aT.z + position.z * tr);');
};
const treeGroup = new THREE.Group(); scene.add(treeGroup);
const treeTiles = new Map();
let treeCount = 0;
function buildTreeTile(t){
  const a = growTrees(t);
  t.built = true; t.n = a.n;
  if (!a.n) return;
  const g = new THREE.InstancedBufferGeometry();
  // each tile owns its (tiny) cone buffers: disposing a geometry frees its attributes' GPU buffers, shared ones included
  g.setIndex(new THREE.BufferAttribute(treeGeo.index.array.slice(), 1));
  g.setAttribute('position', new THREE.BufferAttribute(treeGeo.attributes.position.array.slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(treeGeo.attributes.normal.array.slice(), 3));
  g.setAttribute('aT', new THREE.InstancedBufferAttribute(a.aT, 4).onUpload(freeArray));
  g.setAttribute('color', new THREE.InstancedBufferAttribute(a.col, 3, true).onUpload(freeArray));
  g.instanceCount = a.n;
  t.gmin = a.gmin; t.gmax = a.gmax;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(t.cx, 0, t.cz), TILE);     // y and radius follow the exaggeration
  t.mesh = new THREE.Mesh(g, treeMat);
  treeGroup.add(t.mesh); treeCount += a.n;
}
function dropTreeTile(t){
  if (t.mesh) { treeGroup.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; treeCount -= t.n; }
  t.built = false;
}
// called every rendered frame: road widths, and which building tiles exist / are shown
function updateOsm(){
  uExag.value = state.exag;
  uBld.value = 1 + (state.exag - 1) * 0.35;   // buildings are stretched far less than the terrain, or towns turn into towers
  uLift.value = 0.001 * state.exag + cam.dist * 0.0005;
  roadLayers.forEach((r, c) => {
    r.mesh.visible = state.roads && cam.dist < ROAD_FAR[c];
    r.uHalf.value = Math.max(ROAD_W[c] / 2, cam.dist * pxScale * ROAD_PX[c]);
  });
  updateTrees();
  if (!B) return;
  const on = state.bld && cam.dist < B_SHOW, R = clamp(cam.dist * 1.5, 4, 26) + TILE;
  let todo = null, best = 1e9, far = null, fd = 0;
  for (const t of B.tiles.values()) {
    const d = Math.hypot(t.cx - cam.tx, t.cz - cam.tz), want = on && d < R;
    if (t.mesh) { t.mesh.visible = want; if (!want && d > fd) { fd = d; far = t; } }
    else if (want && d < best) { best = d; todo = t; }
  }
  // memory: tiles left far behind are freed; past the vertex budget the farthest hidden tile goes first
  if (far && (fd > Math.max(R * 2, 14) || B.verts > BLD_BUDGET)) { dropBuildingTile(far); dirty = true; }
  if (todo) { buildTile(todo); dirty = true; }     // one tile per frame keeps the frame time flat
}
function updateTrees(){
  uTreeK.value = 1 + (state.exag - 1) * 0.35;
  const on = state.bld && cam.dist < TREE_SHOW, RT = clamp(cam.dist * 0.9, 2, 9) + TILE;
  treeGroup.visible = on;
  if (on) {    // tile records are made on demand around the view
    for (let tx = tileOf(cam.tx - RT, WX); tx <= tileOf(cam.tx + RT, WX); tx++) for (let tz = tileOf(cam.tz - RT, WZ); tz <= tileOf(cam.tz + RT, WZ); tz++) {
      const key = tx + tz * 1000;
      if (!treeTiles.has(key) && tx >= 0 && tz >= 0 && tx * TILE < WX && tz * TILE < WZ)
        treeTiles.set(key, {key, tx, tz, cx: (tx + 0.5) * TILE - WX / 2, cz: (tz + 0.5) * TILE - WZ / 2, built: false, mesh: null, n: 0});
    }
  }
  // full density close to the view, thinning with distance; the tree count drawn stays roughly flat at any zoom
  const r0 = Math.max(2.5, cam.dist * 0.35);
  let todo = null, best = 1e9, far = null, fd = 0;
  for (const t of treeTiles.values()) {
    const d = Math.hypot(t.cx - cam.tx, t.cz - cam.tz), want = on && d < RT;
    if (t.mesh) {
      t.mesh.visible = want;
      if (want) {
        const de = Math.max(0.1, d - TILE * 0.5), g = t.mesh.geometry, bs = g.boundingSphere;
        g.instanceCount = Math.max(1, Math.round(t.n * clamp((r0 / de) ** 2, 0.08, 1)));
        bs.center.y = (t.gmin + t.gmax) / 2 * state.exag; bs.radius = Math.hypot(TILE * 0.72, (t.gmax - t.gmin) / 2 * state.exag + 0.03);
      } else if (d > fd) { fd = d; far = t; }
    } else if (want && !t.built && d < best) { best = d; todo = t; }
    else if (t.built && !want && !t.mesh && d > RT * 2) t.built = false;      // empty tile: forget it once far away
  }
  if (far && (fd > RT * 2 + 4 || treeCount > TREE_BUDGET)) { dropTreeTile(far); dirty = true; }
  if (todo) { buildTreeTile(todo); dirty = true; }
}

/* ================= camera (map-style controls) ================= */
const DMIN = 0.4, DMAX = 460, PMIN = 0.02, PMAX = 1.36;
const cam = {tx: 0, ty: 0, tz: 0, dist: 130, az: 0, pol: 0.82};
const goal = Object.assign({}, cam);
let dirty = true, pxScale = 0.001, mapW = 800, mapH = 600, orbit = false;
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();

function applyCamera(){
  const sp = Math.sin(cam.pol), cp = Math.cos(cam.pol);
  camera.position.set(cam.tx + cam.dist * sp * Math.sin(cam.az), cam.ty + cam.dist * cp, cam.tz + cam.dist * sp * Math.cos(cam.az));
  const minY = groundY(camera.position.x, camera.position.z) + Math.min(0.25, cam.dist * 0.12);
  if (camera.position.y < minY) camera.position.y = minY;
  camera.near = Math.max(0.01, cam.dist * 0.02); camera.far = cam.dist * 8 + 500;
  camera.up.set(0, 1, 0);
  if (cam.pol < 0.05) camera.up.set(-Math.sin(cam.az), 0, -Math.cos(cam.az));  // keep heading stable when looking straight down
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
}
function clampGoal(){
  goal.tx = clamp(goal.tx, -WX / 2, WX / 2); goal.tz = clamp(goal.tz, -WZ / 2, WZ / 2);
  goal.dist = clamp(goal.dist, DMIN, DMAX); goal.pol = clamp(goal.pol, PMIN, PMAX);
}
function screenRay(cx, cy){
  const r = canvas.getBoundingClientRect();
  ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
function planeHit(cx, cy, y){
  const ray = screenRay(cx, cy);
  if (ray.direction.y > -0.03) return null;
  const t = (y - ray.origin.y) / ray.direction.y;
  return t > 0 && t < 900 ? ray.at(t, new THREE.Vector3()) : null;
}
function terrainHit(cx, cy){
  const ray = screenRay(cx, cy), o = ray.origin, d = ray.direction, step = Math.max(0.01, cam.dist * 0.004);
  const p = new THREE.Vector3(); let t = 0, prev = 0;
  for (let i = 0; i < 4000; i++) {
    t += step; p.copy(d).multiplyScalar(t).add(o);
    if (p.y < -0.5) return null;
    if (Math.abs(p.x) <= WX / 2 && Math.abs(p.z) <= WZ / 2 && p.y <= groundY(p.x, p.z)) {
      let lo = prev, hi = t;
      for (let b = 0; b < 12; b++) {
        const m = (lo + hi) / 2; p.copy(d).multiplyScalar(m).add(o);
        if (p.y <= groundY(p.x, p.z)) hi = m; else lo = m;
      }
      return p.copy(d).multiplyScalar(hi).add(o);
    }
    prev = t;
  }
  return null;
}
function fitBox(x0, x1, z0, z1, pad){
  const w = Math.max(x1 - x0, 1.5), d = Math.max(z1 - z0, 1.5);
  const sa = Math.abs(Math.sin(goal.az)), ca = Math.abs(Math.cos(goal.az));
  const sw = w * ca + d * sa, sd = (w * sa + d * ca) * Math.max(Math.cos(goal.pol), 0.35) + 1.5;
  goal.tx = (x0 + x1) / 2; goal.tz = (z0 + z1) / 2;
  // only the part of the map above the bottom sheet counts as visible, and the control rail on the right
  // (44 px + margins) is kept clear on both sides so the framing stays centred
  const wv = Math.max(120, mapW - 2 * 68);
  goal.dist = Math.max(sw / 2 / (TANV * wv / fullH), sd / 2 / (TANV * (mapH - inset) / fullH)) * (pad || 1.3);
  clampGoal();
}
function fitStops(stops){
  if (me.follow) setFollow(false);
  if (!stops.length) return fitIsland();
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const s of stops) { const x = toX(s.lon), z = toZ(s.lat); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  fitBox(x0, x1, z0, z1, 1.5);
}
function fitIsland(){ fitBox(toX(126.15), toX(126.98), toZ(33.57), toZ(33.19), 1.12); }
function wrapAz(){ const a = Math.atan2(Math.sin(cam.az), Math.cos(cam.az)); goal.az += a - cam.az; cam.az = a; }
function zoomAt(cx, cy, f){
  const nd = clamp(goal.dist * f, DMIN, DMAX), k = nd / goal.dist;
  const p = cx == null ? null : planeHit(cx, cy, cam.ty);
  if (p && !(play && !play.paused) && !orbit) { goal.tx = p.x + (goal.tx - p.x) * k; goal.tz = p.z + (goal.tz - p.z) * k; }
  goal.dist = nd; clampGoal();
}
// On a phone the bottom sheet covers the lower part of the map. The camera renders a window of a taller virtual
// frame, so the point it looks at sits in the middle of the uncovered part (inset = covered height in px).
let inset = 0, fullH = 600;
function resize(){
  mapW = Math.max(1, stage.clientWidth); mapH = Math.max(1, stage.clientHeight);
  inset = Math.round(clamp(mapInset(), 0, mapH * 0.45));
  fullH = mapH + inset;
  document.documentElement.style.setProperty('--inset', inset + 'px');
  renderer.setSize(mapW, mapH, false);
  camera.aspect = mapW / fullH;
  if (inset) camera.setViewOffset(mapW, fullH, 0, inset, mapW, mapH); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  pxScale = 2 * TANV / fullH;
  dirty = true;
}

/* ---- pointer / wheel / keyboard ---- */
const pointers = new Map();
let drag = null, pinch = null;
const vel = {x: 0, z: 0, t: 0};
const pinchState = () => {
  const [a, b] = [...pointers.values()];
  return {cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x)};
};
function userMoved(){ if (orbit) setOrbit(false); if (play && !play.paused) pausePlay(true); if (me.follow) setFollow(false); }
function panBy(ax, ay, bx, by){
  const a = planeHit(ax, ay, cam.ty), b = planeHit(bx, by, cam.ty);
  if (!a || !b) return;
  const dx = a.x - b.x, dz = a.z - b.z;
  if (Math.hypot(dx, dz) > cam.dist * 2) return;
  goal.tx = cam.tx = clamp(cam.tx + dx, -WX / 2, WX / 2);
  goal.tz = cam.tz = clamp(cam.tz + dz, -WZ / 2, WZ / 2);
  const now = performance.now(), dt = Math.max(1, now - vel.t) / 1000;
  vel.x = vel.x * 0.5 + dx / dt * 0.5; vel.z = vel.z * 0.5 + dz / dt * 0.5; vel.t = now;
}
canvas.addEventListener('pointerdown', e => {
  canvas.focus({preventScroll: true});
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (pointers.size === 1) {
    const rot = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey;
    drag = {mode: rot ? 'rotate' : 'pan', x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false};
    vel.x = vel.z = 0; vel.t = performance.now();
  } else if (pointers.size === 2) {
    if (drag) drag.moved = true;
    pinch = pinchState();
  }
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p || !drag) return;
  const px = p.x, py = p.y; p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1) {
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 6) drag.moved = true;
    if (!drag.moved) return;
    userMoved();
    if (drag.mode === 'pan') panBy(px, py, p.x, p.y);
    else {
      goal.az = cam.az = cam.az - (p.x - px) * 0.006;
      goal.pol = cam.pol = clamp(cam.pol - (p.y - py) * 0.005, PMIN, PMAX);
    }
  } else if (pointers.size === 2 && pinch) {
    const s = pinchState();
    userMoved();
    panBy(pinch.cx, pinch.cy, s.cx, s.cy);
    goal.dist = cam.dist = clamp(cam.dist * pinch.d / s.d, DMIN, DMAX);
    let da = s.ang - pinch.ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    goal.az = cam.az = cam.az + da;
    pinch = s;
  }
  applyCamera(); dirty = true;
});
function pointerEnd(e){
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) { pinch = null; if (drag) { drag.mode = 'pan'; drag.moved = true; } vel.x = vel.z = 0; return; }
  if (pointers.size) return;
  const d = drag; drag = null; pinch = null;
  if (!d || e.type === 'pointercancel') return;
  if (!d.moved && performance.now() - d.t0 < 500) return mapClick(e);
  if (d.mode === 'pan' && performance.now() - vel.t < 80 && !REDUCED) {
    goal.tx = cam.tx + vel.x * 0.18; goal.tz = cam.tz + vel.z * 0.18; clampGoal();
  }
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('wheel', e => {
  e.preventDefault();
  let dy = e.deltaY; if (e.deltaMode === 1) dy *= 32; else if (e.deltaMode === 2) dy *= 400;
  zoomAt(e.clientX, e.clientY, Math.exp(clamp(dy, -160, 160) * 0.0016));
}, {passive: false});

const keys = {};
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.pick) setPick(null); else if (play) stopPlay(); else if (orbit) setOrbit(false); return; }
  const ae = document.activeElement;
  if (ae !== canvas && ae !== document.body) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(Arrow(Up|Down|Left|Right)|Key[WASDQERF]|Equal|Minus|NumpadAdd|NumpadSubtract)$/.test(e.code)) { keys[e.code] = true; e.preventDefault(); }
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function keyMove(dt){
  let f = 0, r = 0, any = false;
  if (keys.ArrowUp || keys.KeyW) f += 1; if (keys.ArrowDown || keys.KeyS) f -= 1;
  if (keys.ArrowRight || keys.KeyD) r += 1; if (keys.ArrowLeft || keys.KeyA) r -= 1;
  if (f || r) {
    const sp = goal.dist * 0.9 * dt, s = Math.sin(goal.az), c = Math.cos(goal.az);
    goal.tx += (-s * f + c * r) * sp; goal.tz += (-c * f - s * r) * sp; any = true;
  }
  if (keys.KeyQ) { goal.az += 1.4 * dt; any = true; } if (keys.KeyE) { goal.az -= 1.4 * dt; any = true; }
  if (keys.KeyR) { goal.pol += 0.9 * dt; any = true; } if (keys.KeyF) { goal.pol -= 0.9 * dt; any = true; }
  if (keys.Equal || keys.NumpadAdd) { goal.dist *= Math.exp(-1.6 * dt); any = true; }
  if (keys.Minus || keys.NumpadSubtract) { goal.dist *= Math.exp(1.6 * dt); any = true; }
  if (any) { userMoved(); clampGoal(); }
}

/* ---- on-map controls ---- */
const svg = body => '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>';
const IC = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'), minus: svg('<path d="M5 12h14"/>'),
  compass: '<svg class="ic" id="compassIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l4 9H8z" fill="#b3402b" stroke="#b3402b"/><path d="M12 21l-4-9h8z"/></svg>',
  route: svg('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.8"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/>'),
  orbit: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>'),
  play: svg('<path d="M8 5l11 7-11 7z" fill="currentColor"/>'), pause: svg('<path d="M8 5v14M16 5v14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'), prev: svg('<path d="M14 6l-6 6 6 6"/>'), next: svg('<path d="M10 6l6 6-6 6"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'), down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  car: svg('<path d="M4 16v-3l2-5h12l2 5v3"/><path d="M3 16h18v2H3z"/><circle cx="7.5" cy="13" r=".6"/><circle cx="16.5" cy="13" r=".6"/>'),
  ferry: svg('<path d="M3 15h18l-2 4H5z"/><path d="M7 15V9h10v6M10 9V5h4v4"/>'),
  line: svg('<path d="M5 19L19 5"/>'),
  edit: svg('<path d="M4 20h4l11-11-4-4L4 16z"/><path d="M13 7l4 4"/>'),
  bus: svg('<rect x="5" y="3" width="14" height="15" rx="2"/><path d="M5 11h14M8 18v3M16 18v3"/><circle cx="8.5" cy="14.5" r=".6"/><circle cx="15.5" cy="14.5" r=".6"/>'),
  walk: svg('<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M12 15l-1-5 3-2 2 4 3 1M11 10l-3 2-1 3"/>'),
  coast: svg('<path d="M3 17c2 0 2-2 4.5-2S10 17 12 17s2.5-2 4.5-2 2.5 2 4.5 2"/><path d="M4 11h11l3 3"/><circle cx="7" cy="8" r="1.5"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  pin: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  target: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  trash: svg('<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>'),
  share: svg('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/>'),
  open: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 17v3h14v-3"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'),
  chev: svg('<path d="M6 9l6 6 6-6"/>'),
  bike: svg('<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16h5l5.5-7H9l-3.5 7M10.5 16L8.5 9.5M16 9l2.5 7M7 7.5h3.5M16 9l-.8-3H18"/>'),
  plane: svg('<path d="M10.5 3.5c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5V9l7 4v2l-7-2v4.5l2 1.5v1.5L12 20l-3.5 1.5V20l2-1.5V13l-7 2v-2l7-4z"/>'),
  addPin: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><path d="M12 7v6M9 10h6"/>'),
  locate: svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  nav: svg('<path d="M4 11l16-7-7 16-2-7z"/>'),
  sort: svg('<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h7"/><path d="M15 15l2 3-2 3"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  today: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><circle cx="12" cy="15" r="1.6" fill="currentColor"/>')
};
function mapButton(host, label, icon, fn, text){
  const b = document.createElement('button');
  b.type = 'button'; b.innerHTML = icon + (text ? '<span>' + text + '</span>' : '');
  if (text) b.className = 'btn'; else { b.title = label; b.setAttribute('aria-label', label); }
  b.addEventListener('click', fn); host.append(b);
  return b;
}
const btnLoc = mapButton($('locctl'), '내 위치', IC.locate, () => locTap());
mapButton($('zoomctl'), '확대', IC.plus, () => zoomAt(null, null, 0.6));
mapButton($('zoomctl'), '축소', IC.minus, () => zoomAt(null, null, 1 / 0.6));
mapButton($('zoomctl'), '북쪽을 위로', IC.compass, () => { setOrbit(false); wrapAz(); goal.az = 0; });
const compassIcon = $('compassIcon');
const btnFit = mapButton($('viewctl'), '동선 전체 보기', IC.route, () => {
  setOrbit(false); if (play) stopPlay();
  fitStops(state.day >= 0 ? trip.days[state.day].stops : trip.days.flatMap(x => x.stops));
});
const btn3d = mapButton($('viewctl'), '3D로 기울여 보기', IC.layers, () => { goal.pol = goal.pol > 0.3 ? PMIN : 0.95; });
const btnOrbit = mapButton($('viewctl'), '천천히 둘러보기', IC.orbit, () => setOrbit(!orbit));
const btnPlay = $('btnPlay');
btnPlay.addEventListener('click', () => { if (!play) startPlay(); else pausePlay(!play.paused); });
function setOrbit(on){
  orbit = on;
  if (on) {
    if (play) stopPlay();
    const s = state.sel && trip.days[state.sel.d] && trip.days[state.sel.d].stops[state.sel.i];
    if (s) { goal.tx = toX(s.lon); goal.tz = toZ(s.lat); goal.dist = Math.min(goal.dist, 2.2); }
    goal.pol = Math.max(goal.pol, 1.0);
  }
  btnOrbit.setAttribute('aria-label', on ? '둘러보기 멈추기' : '천천히 둘러보기');
  btnOrbit.setAttribute('aria-pressed', String(on));
  dirty = true;
}

/* ================= itinerary → scene objects ================= */
const labelsEl = $('labels');
const pinGroup = new THREE.Group(), routeGroup = new THREE.Group();
scene.add(routeGroup, pinGroup);
const stemGeo = new THREE.CylinderGeometry(1, 1, 1, 8); stemGeo.translate(0, 0.5, 0);
const dotGeo = new THREE.SphereGeometry(1, 12, 8);
const dotMat = new THREE.MeshBasicMaterial({color: 0x21302b});
// playback markers: small low-poly models, nose along +z, resting on y = 0. Only the one for the current
// segment is shown; `paint` takes the day's colour. MODEL_PX = on-screen pixels per model unit.
const paint = new THREE.MeshStandardMaterial({color: 0xb3402b, emissive: 0xb3402b, emissiveIntensity: 0.18, roughness: 0.45, metalness: 0.1});
const MODEL_PX = {car: 22, bus: 19, ferry: 20, walk: 30, plane: 19, bike: 26};
const MODELS = {};
const mover = new THREE.Group();
mover.rotation.order = 'YXZ'; mover.visible = false; scene.add(mover);
let moverMode = 'car';
(() => {
  const M = (color, o) => new THREE.MeshStandardMaterial(Object.assign({color, roughness: 0.6}, o));
  const glass = M(0x24302e, {roughness: 0.2, metalness: 0.3}), tyre = M(0x1d1f1e, {roughness: 0.9}), white = M(0xf6f1e7, {roughness: 0.5});
  const navy = M(0x223a56), grey = M(0x9aa3a6), skin = M(0xe2b48c), dark = M(0x2d3236);
  const lamp = new THREE.MeshBasicMaterial({color: 0xfff1c2}), tail = new THREE.MeshBasicMaterial({color: 0xe0482f});
  const add = (g, geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  const box = (g, w, h, d, mat, x, y, z) => add(g, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  // a light halo underneath keeps a model readable on the dark sea and on the cream land alike
  const halo = (g, sx, sz) => { const m = add(g, new THREE.CircleGeometry(1, 28), new THREE.MeshBasicMaterial({color: 0xfffaf0, transparent: true, opacity: 0.85, depthWrite: false}), 0, 0.01, 0); m.rotation.x = -Math.PI / 2; m.scale.set(sx, sz, 1); };
  const wheels = (g, xs, zs, r) => { const geo = new THREE.CylinderGeometry(r, r, 0.16, 14); geo.rotateZ(Math.PI / 2); for (const x of xs) for (const z of zs) add(g, geo, tyre, x, r, z); };
  const lights = (g, x, y, z) => { for (const sx of [-x, x]) { box(g, 0.2, 0.09, 0.04, lamp, sx, y, z); box(g, 0.2, 0.09, 0.04, tail, sx, y, -z); } };
  let g;
  // hire car
  g = MODELS.car = new THREE.Group();
  box(g, 1, 0.36, 2.2, paint, 0, 0.38, 0); box(g, 0.84, 0.34, 1.12, glass, 0, 0.73, -0.12); box(g, 0.86, 0.06, 1.0, paint, 0, 0.92, -0.14);
  wheels(g, [-0.47, 0.47], [-0.68, 0.7], 0.21); lights(g, 0.32, 0.44, 1.11); halo(g, 0.95, 1.6);
  // airport shuttle bus
  g = MODELS.bus = new THREE.Group();
  box(g, 1.05, 0.95, 3.4, paint, 0, 0.74, 0); box(g, 1.07, 0.34, 2.9, glass, 0, 0.98, -0.15); box(g, 0.96, 0.46, 0.04, glass, 0, 0.92, 1.71);
  box(g, 1.06, 0.07, 3.42, white, 0, 1.24, 0); wheels(g, [-0.5, 0.5], [-1.1, 1.05], 0.25); lights(g, 0.36, 0.44, 1.71); halo(g, 1.05, 2.3);
  // passenger ferry: pointed hull, white superstructure, funnel in the day colour
  g = MODELS.ferry = new THREE.Group();
  const hull = new THREE.Shape([[-0.7, 1.6], [0.7, 1.6], [0.7, -0.8], [0, -1.9], [-0.7, -0.8]].map(([x, y]) => new THREE.Vector2(x, y)));
  const hullGeo = new THREE.ExtrudeGeometry(hull, {depth: 0.5, bevelEnabled: false}); hullGeo.rotateX(-Math.PI / 2); hullGeo.translate(0, -0.12, 0);
  add(g, hullGeo, navy, 0, 0, 0);
  box(g, 1.2, 0.08, 2.9, white, 0, 0.4, -0.2);                                         // deck
  box(g, 1.02, 0.46, 1.7, white, 0, 0.66, -0.35); box(g, 1.04, 0.14, 1.5, glass, 0, 0.72, -0.35);
  box(g, 0.86, 0.32, 0.62, white, 0, 1.05, 0.05); box(g, 0.88, 0.1, 0.5, glass, 0, 1.08, 0.08);
  add(g, new THREE.CylinderGeometry(0.13, 0.15, 0.5, 12), paint, 0, 1.15, -0.8);
  halo(g, 1.15, 2.5);
  // walker: hip and shoulder pivots so the legs and arms can swing
  g = MODELS.walk = new THREE.Group();
  const limb = (w, l, mat, x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); const geo = new THREE.BoxGeometry(w, l, w); geo.translate(0, -l / 2, 0); p.add(new THREE.Mesh(geo, mat)); g.add(p); return p; };
  const legs = [limb(0.17, 0.52, dark, -0.11, 0.54), limb(0.17, 0.52, dark, 0.11, 0.54)];
  box(g, 0.44, 0.52, 0.26, paint, 0, 0.8, 0);                                           // jacket
  box(g, 0.32, 0.34, 0.14, dark, 0, 0.84, -0.19);                                       // backpack
  add(g, new THREE.SphereGeometry(0.16, 16, 12), skin, 0, 1.24, 0);
  box(g, 0.34, 0.08, 0.34, white, 0, 1.38, 0.02);                                       // cap
  const arms = [limb(0.12, 0.46, paint, -0.29, 1.03), limb(0.12, 0.46, paint, 0.29, 1.03)];
  g.userData.limbs = [legs[0], legs[1], arms[0], arms[1]];
  halo(g, 0.42, 0.42);
  // airliner: white fuselage, tail fin and cheat line in the day colour
  g = MODELS.plane = new THREE.Group();
  const fus = new THREE.CylinderGeometry(0.22, 0.22, 3.0, 16); fus.rotateX(Math.PI / 2); add(g, fus, white, 0, 0, 0);
  add(g, new THREE.SphereGeometry(0.22, 16, 12), white, 0, 0, 1.5).scale.set(1, 0.95, 1.7);
  const cone = new THREE.ConeGeometry(0.22, 0.8, 16); cone.rotateX(-Math.PI / 2); add(g, cone, white, 0, 0.04, -1.9);
  box(g, 0.455, 0.07, 2.6, paint, 0, -0.02, 0.1);                                       // cheat line
  box(g, 3.3, 0.05, 0.62, white, 0, -0.06, 0.15);                                       // wings
  box(g, 1.25, 0.04, 0.36, white, 0, 0.05, -1.95);                                      // tailplane
  box(g, 0.06, 0.72, 0.58, paint, 0, 0.42, -1.95);                                      // fin
  const eng = new THREE.CylinderGeometry(0.12, 0.12, 0.5, 12); eng.rotateX(Math.PI / 2);
  for (const x of [-0.78, 0.78]) add(g, eng, grey, x, -0.2, 0.32);
  // bicycle and rider: frame in the day colour, legs that follow the pedals (userData.pedal(crank angle))
  g = MODELS.bike = new THREE.Group();
  const wheel = new THREE.TorusGeometry(0.34, 0.045, 8, 22); wheel.rotateY(Math.PI / 2);
  for (const z of [-0.56, 0.56]) add(g, wheel, tyre, 0, 0.34, z);
  // a thin rod from (y1, z1) to (y2, z2) in the bike's side plane
  const rod = (mat, r, y1, z1, y2, z2, x) => { const m = add(g, new THREE.CylinderGeometry(r, r, Math.hypot(y2 - y1, z2 - z1), 6), mat, x || 0, (y1 + y2) / 2, (z1 + z2) / 2); m.rotation.x = Math.atan2(z2 - z1, y2 - y1); return m; };
  const RA = [0.34, -0.56], BB = [0.3, -0.04], SE = [0.8, -0.2], HD = [0.8, 0.4], FA = [0.34, 0.56];
  for (const [p, q] of [[RA, BB], [RA, SE], [BB, SE], [SE, HD], [BB, HD], [HD, FA]]) rod(paint, 0.035, p[0], p[1], q[0], q[1]);
  rod(dark, 0.025, 0.8, 0.4, 0.92, 0.36);                                               // stem
  box(g, 0.5, 0.045, 0.05, dark, 0, 0.92, 0.36);                                         // handlebar
  box(g, 0.15, 0.05, 0.28, dark, 0, 0.86, -0.22);                                        // saddle
  const lean = 0.55, hip = [0.9, -0.2], up = k => [hip[0] + k * Math.cos(lean), hip[1] + k * Math.sin(lean)];
  box(g, 0.38, 0.5, 0.24, paint, 0, up(0.27)[0], up(0.27)[1]).rotation.x = lean;      // jacket
  const head = up(0.66), sh = up(0.48);
  add(g, new THREE.SphereGeometry(0.15, 16, 12), skin, 0, head[0], head[1]);
  box(g, 0.32, 0.08, 0.32, white, 0, head[0] + 0.13, head[1] + 0.02).rotation.x = lean * 0.3;   // cap
  for (const x of [-0.17, 0.17]) rod(paint, 0.05, sh[0], sh[1], 0.92, 0.36, x);          // arms to the bar
  const bikeLegs = [-0.12, 0.12].map(x => { const p = new THREE.Group(); p.position.set(x, hip[0], hip[1]); const geo = new THREE.BoxGeometry(0.15, 1, 0.15); geo.translate(0, -0.5, 0); p.add(new THREE.Mesh(geo, dark)); g.add(p); return p; });
  g.userData.pedal = a => bikeLegs.forEach((p, k) => {
    const t = a + k * Math.PI, dy = BB[0] + Math.cos(t) * 0.16 - hip[0], dz = BB[1] + Math.sin(t) * 0.16 - hip[1];
    p.rotation.x = Math.atan2(-dz, -dy); p.scale.y = Math.hypot(dy, dz);              // hip to pedal
  });
  g.userData.legs = bikeLegs; g.userData.pedal(0.6);
  halo(g, 0.5, 1.0);
  for (const m of Object.values(MODELS)) { m.visible = false; mover.add(m); }
  MODELS.car.visible = true;
})();
function setMoverMode(m){
  moverMode = m;
  for (const k in MODELS) MODELS[k].visible = k === m;
}

let pins = [], routes = [], legs = [], geoLabels = [], routeDist = 0;

// tube along one or more polylines (dashes are simply several short polylines)
function buildTube(lines, r){
  const M = 6; let nv = 0, ni = 0;
  for (const pts of lines) { nv += pts.length * M; ni += (pts.length - 1) * M * 6; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  const t = new THREE.Vector3(), s = new THREE.Vector3(), u = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let vo = 0, q = 0;
  for (const pts of lines) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      t.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]);
      if (t.lengthSq() < 1e-10) t.set(1, 0, 0);
      t.normalize(); s.crossVectors(t, up);
      if (s.lengthSq() < 1e-8) s.set(1, 0, 0);
      s.normalize(); u.crossVectors(s, t);
      const p = pts[i];
      for (let j = 0; j < M; j++) {
        const a = j / M * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), k = (vo + i * M + j) * 3;
        const nx = ca * s.x + sa * u.x, ny = ca * s.y + sa * u.y, nz = ca * s.z + sa * u.z;
        nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
        pos[k] = p.x + nx * r; pos[k + 1] = p.y + r * 0.4 + ny * r; pos[k + 2] = p.z + nz * r;
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < M; j++) {
      const a = vo + i * M + j, b = vo + i * M + (j + 1) % M, c = a + M, d = b + M;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    vo += n * M;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function rebuildScene(){
  for (const p of pins) { p.el.remove(); p.stem.material.dispose(); }
  for (const r of routes) if (r) { r.mesh.geometry.dispose(); r.mat.dispose(); }
  pinGroup.clear(); routeGroup.clear();
  pins = []; routes = []; legs = [];
  planAir();
  // a leg as a draped polyline (for the airport drives, which are not legs between two stops)
  const legLine = leg => {
    const pts = [], cum = []; let len = 0;
    for (let k = 0; k < leg.pts.length - 1; k++) {
      const ax = leg.pts[k][0], az = leg.pts[k][1], bx = leg.pts[k + 1][0], bz = leg.pts[k + 1][1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1));
      for (let q = pts.length ? 1 : 0; q <= n; q++) {
        const x = ax + (bx - ax) * q / n, z = az + (bz - az) * q / n;
        if (pts.length) len += Math.hypot(x - pts[pts.length - 1].x, z - pts[pts.length - 1].z);
        pts.push(new THREE.Vector3(x, groundY(x, z), z)); cum.push(len);
      }
    }
    return {pts, cum, len, kind: leg.kind};
  };
  trip.days.forEach((day, d) => {
    const col = dayColor(d);
    day.stops.forEach((s, i) => {
      const x = toX(s.lon), z = toZ(s.lat), pos = new THREE.Vector3(x, groundY(x, z), z);
      const stem = new THREE.Mesh(stemGeo, new THREE.MeshBasicMaterial({color: col}));
      const dot = new THREE.Mesh(dotGeo, dotMat);
      stem.position.copy(pos); dot.position.copy(pos); pinGroup.add(stem, dot);
      const nm = h('span', {class: 'nm'}, s.name), ph = photosOf(s)[0];
      // a stop with photos shows the first one on its pin
      const img = ph ? h('img', {class: 'ph', src: ph.url, alt: '', decoding: 'async'}) : null;
      const el = h('button', {class: 'pin' + (img ? ' has-ph' : ''), type: 'button', tabIndex: -1, style: '--c:' + col,
        onclick: () => selectStop(d, i, true)}, h('span', {class: 'num'}, String(i + 1)), img, nm);
      labelsEl.append(el);
      pins.push({d, i, pos, stem, dot, el, w: nm.offsetWidth + 18 + (img ? 30 : 0), anchor: new THREE.Vector3()});
    });
    // the day's route: each leg densified so it can be draped on the terrain
    const L = [];
    for (let i = 0; i < day.stops.length - 1; i++) L.push(legOf(day.stops[i], day.stops[i + 1]));
    legs.push(L);
    // walks at a stop (a stroll, or a path the stop brought along) are drawn as a dotted line in the day colour
    const walks = day.stops.map(s => { const w = walkOf(s); return w ? pathLine(w.path, false) : null; });
    const xin = airPlan && airPlan.d0 === d && airPlan.inLeg ? legLine(airPlan.inLeg) : null;
    const xout = airPlan && airPlan.d1 === d && airPlan.outLeg ? legLine(airPlan.outLeg) : null;
    if (!L.length && !walks.some(Boolean) && !xin && !xout) { routes.push(null); return; }
    const pts = [], cum = [], stopAt = [0], parts = []; let len = 0;
    L.forEach(leg => {
      const from = pts.length ? pts.length - 1 : 0;
      for (let k = 0; k < leg.pts.length - 1; k++) {
        const ax = leg.pts[k][0], az = leg.pts[k][1], bx = leg.pts[k + 1][0], bz = leg.pts[k + 1][1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1));
        for (let q = pts.length ? 1 : 0; q <= n; q++) {
          const x = ax + (bx - ax) * q / n, z = az + (bz - az) * q / n;
          if (pts.length) len += Math.hypot(x - pts[pts.length - 1].x, z - pts[pts.length - 1].z);
          pts.push(new THREE.Vector3(x, groundY(x, z), z)); cum.push(len);
        }
      }
      parts.push({dashed: leg.kind !== 'road', from, to: pts.length - 1});
      stopAt.push(len);
    });
    const mat = new THREE.MeshStandardMaterial({color: col, emissive: col, emissiveIntensity: 0.18, roughness: 0.6});
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    routeGroup.add(mesh);
    routes.push({pts, cum, len, stopAt, parts, walks, xin, xout, mesh, mat});
  });
  routeDist = 0;
  markDestinations();
  applyFilter();
  dirty = true;
}
function updateRouteGeometry(){
  routeDist = cam.dist;
  const r = clamp(cam.dist * 0.0022, 0.0022, 0.42), on = r * 7, gap = r * 6;
  for (const rt of routes) {
    if (!rt) continue;
    const lines = [];
    for (const part of rt.parts) {
      if (!part.dashed) { if (part.to > part.from) lines.push(rt.pts.slice(part.from, part.to + 1)); continue; }
      // dashes for ferries and straight hops, sized with the line so they read at any zoom
      const s0 = rt.cum[part.from], s1 = rt.cum[part.to]; let k = part.from;
      const at = s => { while (k < part.to && rt.cum[k + 1] < s) k++; const seg = rt.cum[k + 1] - rt.cum[k]; return new THREE.Vector3().lerpVectors(rt.pts[k], rt.pts[Math.min(part.to, k + 1)], seg > 0 ? clamp((s - rt.cum[k]) / seg, 0, 1) : 0); };
      for (let s = s0 + gap / 2; s < s1; s += on + gap) { const e = Math.min(s1, s + on); lines.push([at(s), at((s + e) / 2), at(e)]); }
    }
    for (const x of [rt.xin, rt.xout]) if (x && x.pts.length > 1) {
      if (x.kind === 'road') { lines.push(x.pts); continue; }
      let k = 0;
      const at = s => { while (k < x.pts.length - 2 && x.cum[k + 1] < s) k++; const seg = x.cum[k + 1] - x.cum[k]; return new THREE.Vector3().lerpVectors(x.pts[k], x.pts[k + 1], seg > 0 ? clamp((s - x.cum[k]) / seg, 0, 1) : 0); };
      for (let s = gap / 2; s < x.len; s += on + gap) { const e = Math.min(x.len, s + on); lines.push([at(s), at((s + e) / 2), at(e)]); }
    }
    for (const w of rt.walks) {
      if (!w) continue;
      let k = 0;
      const at = s => { while (k < w.pts.length - 2 && w.cum[k + 1] < s) k++; const seg = w.cum[k + 1] - w.cum[k]; return new THREE.Vector3().lerpVectors(w.pts[k], w.pts[k + 1], seg > 0 ? clamp((s - w.cum[k]) / seg, 0, 1) : 0); };
      for (let s = r; s < w.len; s += r * 5) lines.push([at(s), at(Math.min(w.len, s + r * 2))]);
    }
    rt.mesh.geometry.dispose();
    rt.mesh.geometry = lines.length ? buildTube(lines, r) : new THREE.BufferGeometry();
  }
}
const isSel = p => !!state.sel && state.sel.d === p.d && state.sel.i === p.i ? 1 : 0;
function applyFilter(){
  for (const p of pins) {
    const dim = state.day >= 0 && p.d !== state.day;
    p.el.classList.toggle('dim', dim);
    p.el.classList.toggle('sel', !!isSel(p));
    p.stem.material.transparent = dim; p.stem.material.opacity = dim ? 0.35 : 1; p.stem.material.needsUpdate = true;
    p.dim = dim;
  }
  // pins that share a spot (a hotel that ends one day and starts the next) sit side by side
  const seen = [];
  for (const p of pins) {
    p.slot = 0;
    if (p.dim) continue;
    for (const q of seen) if (q.pos.distanceToSquared(p.pos) < 0.0004) p.slot = Math.max(p.slot, q.slot + 1);
    seen.push(p);
  }
  routes.forEach((r, d) => {
    if (!r) return;
    const dim = state.day >= 0 && d !== state.day;
    r.mat.transparent = dim; r.mat.opacity = dim ? 0.22 : 1; r.mat.depthWrite = !dim; r.mat.needsUpdate = true;
    r.mesh.renderOrder = dim ? 2 : 0;
  });
  dirty = true;
}
function buildGeoLabels(){
  geoLabels = GEO.map(([name, lat, lon]) => {
    const el = h('span', {class: 'geo'}, name); labelsEl.append(el);
    return {el, x: toX(lon), z: toZ(lat), w: el.offsetWidth, v: new THREE.Vector3()};
  });
}

/* ---- per-frame: scale pins, place labels, scale bar ---- */
const tmp = new THREE.Vector3();
const SCALE_STEPS = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
function updateOverlay(){
  const W = mapW, H = mapH, placed = [];
  const hit = (a, b, c, d) => { for (const r of placed) if (a < r[2] && c > r[0] && b < r[3] && d > r[1]) return true; return false; };
  for (const p of pins) {
    const dd = camera.position.distanceTo(p.pos), k = dd * pxScale;
    p.stem.scale.set(1.3 * k, 30 * k, 1.3 * k); p.dot.scale.setScalar(3.5 * k);
    p.anchor.set(p.pos.x, p.pos.y + 30 * k, p.pos.z);
    tmp.copy(p.anchor).project(camera);
    p.on = tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
    p.sx = (tmp.x * 0.5 + 0.5) * W + (p.slot || 0) * 30; p.sy = (-tmp.y * 0.5 + 0.5) * H;
    if (p.on) {
      p.el.style.display = '';
      p.el.style.transform = 'translate(' + p.sx.toFixed(1) + 'px,' + p.sy.toFixed(1) + 'px)';
      p.el.style.zIndex = p.dim ? '1' : isSel(p) ? '4000' : String(10 + (p.sy | 0));
      if (!p.dim) placed.push([p.sx - 15, p.sy - 15, p.sx + 15, p.sy + 15]);
    } else p.el.style.display = 'none';
  }
  const order = pins.filter(p => p.on && !p.dim);
  if (state.sel) order.sort((a, b) => (isSel(b) - isSel(a)));
  for (const p of pins) if (p.on && p.dim) p.el.classList.add('noname');
  for (const p of order) {
    const r = [p.sx + 15, p.sy - 14, p.sx + 15 + p.w, p.sy + 14];
    const clash = hit(r[0], r[1], r[2], r[3]) && !isSel(p);
    p.el.classList.toggle('noname', clash);
    if (!clash) placed.push(r);
  }
  for (const g of geoLabels) {
    g.v.set(g.x, groundY(g.x, g.z), g.z).project(camera);
    const sx = (g.v.x * 0.5 + 0.5) * W, sy = (-g.v.y * 0.5 + 0.5) * H;
    const ok = state.geo && g.v.z < 1 && g.v.z > -1 && Math.abs(g.v.x) < 1.1 && Math.abs(g.v.y) < 1.1 &&
               !hit(sx - g.w / 2 - 4, sy - 9, sx + g.w / 2 + 4, sy + 9);
    g.el.style.display = ok ? '' : 'none';
    if (ok) {
      g.el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,-50%)';
      placed.push([sx - g.w / 2 - 4, sy - 9, sx + g.w / 2 + 4, sy + 9]);
    }
  }
  if (mover.visible) mover.scale.setScalar(MODEL_PX[moverMode] * camera.position.distanceTo(mover.position) * pxScale);
  placeMe(W, H);
  compassIcon.style.transform = 'rotate(' + cam.az.toFixed(3) + 'rad)';
  btn3d.setAttribute('aria-pressed', String(cam.pol > 0.3));
  const kmPerPx = cam.dist * pxScale; let km = SCALE_STEPS[0];
  for (const s of SCALE_STEPS) if (s / kmPerPx <= 120) km = s;
  const sc = $('scale');
  sc.style.width = Math.max(40, km / kmPerPx).toFixed(0) + 'px';
  sc.textContent = km < 1 ? (km * 1000) + ' m' : km + ' km';
}

/* ================= playback ================= */
// A day plays as a chain of segments, each with its own vehicle: the plane into and out of Jeju, the airport
// shuttle bus, the hire car, the Marado ferry, and walks at stops that carry a walking path (Marado, Ilchulbong).
let play = null;
const SEG_SEC = {walk: 11, air: 6, taxi: 2, minRoad: 1.6};          // playback seconds per segment
const VIEW = {walk: {dist: 0.8, pol: 0.9}, bike: {dist: 1.2, pol: 0.92}, bus: {dist: 2.2, pol: 0.95}, plane: {dist: 16, pol: 1.0}, taxi: {dist: 4, pol: 0.95}};
const altY = (x, z, altM) => Math.max(groundY(x, z), altM * 0.001 * state.exag);
// lat/lon(/alt m) path -> polyline in scene units, densified every 20 m so it follows the terrain
function pathLine(path, air){
  const p = [];
  for (let i = 0; i < path.length; i++) {
    const x = toX(path[i][1]), z = toZ(path[i][0]), a = air ? path[i][2] : 0;
    if (i) {
      const px = toX(path[i - 1][1]), pz = toZ(path[i - 1][0]), pa = air ? path[i - 1][2] : 0;
      const n = Math.max(1, Math.ceil(Math.hypot(x - px, z - pz) / 0.02));
      for (let q = 1; q < n; q++) { const f = q / n, xx = px + (x - px) * f, zz = pz + (z - pz) * f; p.push(new THREE.Vector3(xx, altY(xx, zz, pa + (a - pa) * f), zz)); }
    }
    p.push(new THREE.Vector3(x, altY(x, z, a), z));
  }
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
  return {pts: p, cum, len: cum[cum.length - 1]};
}
// a flight between two stops: a straight track that climbs and comes down again, higher for a longer hop
function flightArc(a, b){
  const km = hav(a, b), top = clamp(km * 60, 200, 2500), n = Math.max(12, Math.ceil(km)), path = [];
  for (let q = 0; q <= n; q++) { const f = q / n; path.push([a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, top * Math.sin(Math.PI * f)]); }
  return pathLine(path, true);
}
// the airport paths are the same every time: drape them once per terrain exaggeration
const airCache = {};
function airLine(k, path, air){ const c = airCache[k]; if (c && c.exag === state.exag) return c.line; const line = pathLine(path, air); airCache[k] = {exag: state.exag, line}; return line; }
// One day as a chain of segments. Each knows the stop it leaves from (from) and the stop it arrives at (after).
function daySegments(d){
  const st = trip.days[d].stops, L = legs[d] || [], r = routes[d], segs = [], day = (d + 1) + '일차 · ', A = airPlan;
  const arrive = A && A.d0 === d && A.inOn, leave = A && A.d1 === d && A.outOn;
  if (!st.length || (!r && !arrive && !leave)) return segs;
  const roadLen = (r ? r.len + (r.xin ? r.xin.len : 0) + (r.xout ? r.xout.len : 0) : 0) || 1;
  const roadSpeed = roadLen / clamp(roadLen * 0.2, 6, 34);
  const add = (mode, line, label, from, after, sec, view) => {
    if (!(line.len > 0)) return;
    segs.push({pts: line.pts, cum: line.cum, len: line.len, mode, label, from, after, view: view || VIEW[mode] || null,
      speed: sec ? line.len / sec : Math.min(roadSpeed, line.len / SEG_SEC.minRoad)});
  };
  const first = st[0], last = st[st.length - 1], xmode = x => x.kind === 'ferry' ? 'ferry' : 'car';
  if (first.airIn) {
    add('plane', pathLine(first.airIn.path, true), day + '비행기로 제주 도착', -1, null, SEG_SEC.air);
    if (first.airIn.taxi.length > 1) add('plane', pathLine(first.airIn.taxi, false), day + '착륙 후 터미널로', -1, 0, SEG_SEC.taxi, VIEW.taxi);
  } else if (arrive) {
    add('plane', airLine('in', AIR.airIn.path, true), day + '비행기로 제주 도착', -1, null, SEG_SEC.air);
    add('plane', airLine('inTaxi', AIR.airIn.taxi, false), day + '착륙 후 터미널로', -1, r && r.xin ? null : 0, SEG_SEC.taxi, VIEW.taxi);
    if (r && r.xin) add(xmode(r.xin), r.xin, day + '제주공항 → ' + first.name, -1, 0, 0);
  }
  for (let i = 0; i < st.length; i++) {
    const w = r && r.walks[i];
    if (w) add('walk', w, day + st[i].name + ' ' + walkOf(st[i]).label, i, i, SEG_SEC.walk);
    if (i < st.length - 1 && L[i] && r) {
      const p = r.parts[i], by = st[i + 1].by, k = L[i].kind;
      const mode = k === 'ferry' ? 'ferry' : k === 'air' ? 'plane' : k !== 'road' ? 'car' : by === 'bus' || by === 'walk' || by === 'bike' ? by : 'car';
      let line = {pts: r.pts.slice(p.from, p.to + 1), cum: r.cum.slice(p.from, p.to + 1).map(c => c - r.cum[p.from])};
      line.len = line.cum[line.cum.length - 1];
      if (mode === 'plane') line = flightArc(st[i], st[i + 1]);     // the dashes stay on the ground, the plane flies above them
      add(mode, line, day + st[i].name + ' → ' + st[i + 1].name + ({bus: ' (버스)', ferry: ' (여객선)', walk: ' (걸어서)', bike: ' (자전거)', plane: ' (비행기)'}[mode] || ''), i, i + 1,
          mode === 'walk' ? clamp(line.len * 9, 4, SEG_SEC.walk) : mode === 'bike' ? clamp(line.len * 5, 3, 10) : mode === 'plane' ? clamp(2 + L[i].km * 0.08, 3, SEG_SEC.air) : 0,
          mode === 'plane' ? {dist: clamp(L[i].km * 0.9, 3, 16), pol: 1.0} : null);
    }
  }
  const li = st.length - 1;
  if (last.airOut) {
    if (last.airOut.taxi.length > 1) add('plane', pathLine(last.airOut.taxi, false), day + '활주로로 이동', li, null, SEG_SEC.taxi, VIEW.taxi);
    add('plane', pathLine(last.airOut.path, true), day + '제주 출발, 북쪽 바다로', null, null, SEG_SEC.air);
  } else if (leave) {
    if (r && r.xout) add(xmode(r.xout), r.xout, day + last.name + ' → 제주공항', li, null, 0);
    add('plane', airLine('outTaxi', AIR.airOut.taxi, false), day + '활주로로 이동', r && r.xout ? null : li, null, SEG_SEC.taxi, VIEW.taxi);
    add('plane', airLine('out', AIR.airOut.path, true), day + '제주 출발, 북쪽 바다로', null, null, SEG_SEC.air);
  }
  return segs;
}
const canPlayDay = d => daySegments(d).length > 0;
// The whole playback is one timeline (seconds): a short pause at each stop, then the segment's travel time. Scrubbing,
// jumping to a day and starting at a stop are all just setting the time.
// Between two days the mover rests at the day's last stop (DAY_REST), then the view glides over to the next day's
// first stop and waits there (DAY_FLY) before setting off, so the change of day can be followed.
const DAY_REST = 1.0, DAY_FLY = 1.6;
// A stop with photos holds the mover a little longer and shows them, one after another (at most PHOTO_MAX).
const PHOTO_SEC = 1.7, PHOTO_MAX = 4;
const photoSec = (d, i) => { const s = i != null && trip.days[d] && trip.days[d].stops[i]; const n = s ? photosOf(s).length : 0; return n ? 0.4 + Math.min(n, PHOTO_MAX) * PHOTO_SEC : 0; };
function buildTimeline(days){
  const segs = [], dayAt = [];
  let t = 0;
  for (const d of days) {
    const ds = daySegments(d);
    if (!ds.length) continue;
    if (segs.length) { const p = segs[segs.length - 1]; p.tail += DAY_REST; t += DAY_REST; }
    dayAt.push({d, t});
    let mark = 0;
    ds.forEach((s, k) => {
      s.d = d; s.mark = mark; s.tail = 0; s.dayStart = k === 0 && segs.length > 0;
      s.hold = k === 0 ? (segs.length ? DAY_FLY : 0.6) : ds[k - 1].after != null ? 0.8 : 0;
      // the stop this segment waits at before setting off: its photos fill the end of the wait
      const at = k === 0 ? (s.from >= 0 ? s.from : null) : ds[k - 1].after, ps = photoSec(d, at);
      s.photo = ps ? {d, i: at, sec: ps} : null; s.hold += ps;
      s.t0 = t; s.dur = s.len / s.speed; t += s.hold + s.dur;
      if (s.after != null) mark = s.after;
      segs.push(s);
    });
    // the day's last stop has no segment leaving it: its photos come after the arrival
    const last = ds[ds.length - 1], ps = last.after != null ? photoSec(d, last.after) : 0;
    last.tailPhoto = ps ? {d, i: last.after, sec: ps} : null;
    last.tail += ps; t += ps;
  }
  return {segs, dayAt, T: t};
}
function startPlay(opt){
  opt = opt || {};
  const all = trip.days.map((_, i) => i);
  let days = opt.days || (state.day >= 0 ? [state.day] : all);
  if (opt.stop && !days.includes(opt.stop.d)) days = [opt.stop.d];
  const tl = buildTimeline(days);
  if (!tl.segs.length) return toast('동선을 재생하려면 장소가 2곳 이상이거나, 공항 도착·출발이 켜져 있어야 합니다.');
  setOrbit(false);
  const prevSnap = play ? play.prevSnap : snap;
  play = Object.assign(tl, {t: 0, k: -1, markKey: '', s: 0, paused: false, view: null, anim: 0, prevSnap,
    baseDist: Math.min(goal.dist, 9), basePol: Math.max(goal.pol, 0.95)});
  goal.dist = play.baseDist; goal.pol = play.basePol;
  mover.visible = true; $('hud').hidden = false;
  // playback wants the map: the sheet folds to its grip and, on a phone, the masthead gives its place to the bar
  document.body.classList.add('playing');
  setSnap('mini');
  buildHudDays();
  let t = 0;
  if (opt.day != null) { const a = tl.dayAt.find(x => x.d === opt.day); if (a) t = a.t; }
  if (opt.stop) t = timeAtStop(opt.stop.d, opt.stop.i);
  setPlayTime(t);
  playUi();
}
// leaving stop i of day d: the first segment that sets off from it, or else the moment of arriving there
function timeAtStop(d, i){
  const segs = play.segs;
  let s = segs.find(x => x.d === d && x.from === i);
  if (s) return s.t0 + s.hold * 0.4;
  s = segs.find(x => x.d === d && x.after === i);
  return s ? s.t0 + s.hold + s.dur * 0.999 : 0;
}
function setPlayTime(t){
  const P = play, segs = P.segs;
  t = clamp(t, 0, P.T); P.t = t;
  let k = Math.max(0, P.k);
  while (k > 0 && segs[k].t0 > t) k--;
  while (k < segs.length - 1 && segs[k + 1].t0 <= t) k++;
  const seg = segs[k], u = t - seg.t0 - seg.hold;
  if (k !== P.k) { P.k = k; enterSeg(seg); }
  // the stop marker: the last stop reached (the day's first stop until then), the segment's own stop once it is there
  const arrived = u >= seg.dur, mark = arrived && seg.after != null ? seg.after : seg.mark, key = seg.d + '-' + mark;
  if (key !== P.markKey) { P.markKey = key; markStop(seg.d, mark); }
  P.glide = seg.dayStart && u < 0;          // crossing to a new day: the view eases over instead of snapping
  P.s = clamp(u / seg.dur, 0, 1) * seg.len;
  placeMover(seg, P.s, u > 0 && !arrived && !P.paused);
  playHud(seg, arrived && seg.tail > 0 ? 'rest' : P.glide ? 'fly' : '');
  let ph = null;
  if (seg.photo && u < 0 && u >= -seg.photo.sec) ph = {at: seg.photo, f: (u + seg.photo.sec) / seg.photo.sec};
  else if (seg.tailPhoto && arrived && u - seg.dur < seg.tailPhoto.sec) ph = {at: seg.tailPhoto, f: (u - seg.dur) / seg.tailPhoto.sec};
  playPhoto(ph);
}
// walks and flights get their own close / wide view; the road view comes back afterwards
function enterSeg(seg){
  setMoverMode(seg.mode);
  if (seg.view) {
    if (!play.view) { play.baseDist = goal.dist; play.basePol = goal.pol; }
    goal.dist = seg.view.dist; goal.pol = seg.view.pol;
  } else if (play.view) { goal.dist = play.baseDist; goal.pol = play.basePol; }
  play.view = seg.view;
  for (const l of MODELS.walk.userData.limbs) l.rotation.x = 0;
}
function pausePlay(p){ if (play) { play.paused = p; playUi(); } }
function stopPlay(){
  const back = play && play.prevSnap;
  play = null; scrub = null; mover.visible = false; $('hud').hidden = true;
  playPhoto(null);
  document.body.classList.remove('playing');
  if (snap === 'mini' && back && back !== 'mini' && !view && !state.pick) setSnap('peek');   // the list comes back as it was
  playUi(); updatePlaceCard(); dirty = true;
}
function playUi(){
  const on = !!play && !play.paused;
  btnPlay.innerHTML = (on ? IC.pause : IC.play) + '<span>' + (play ? (on ? '일시정지' : '이어서 재생') : '동선 재생') + '</span>';
  const scope = state.day >= 0 ? [state.day] : trip.days.map((_, i) => i);
  btnPlay.disabled = !play && !scope.some(canPlayDay);
  $('hudToggle').innerHTML = on ? IC.pause : IC.play;
  $('hudToggle').setAttribute('aria-label', on ? '일시정지' : '이어서 재생');
}
function markStop(d, i){
  state.sel = {d, i}; applyFilter();
  document.querySelectorAll('.card[aria-current]').forEach(el => el.removeAttribute('aria-current'));
  const row = document.querySelector('.card[data-k="' + d + '-' + i + '"]');
  if (row) row.setAttribute('aria-current', 'true');
  renderPeek();
}
const _behind = new THREE.Vector3(), _ahead = new THREE.Vector3();
// point at distance s (km) along a polyline
function routePoint(r, s, out){
  s = clamp(s, 0, r.len);
  let lo = 0, hi = r.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.cum[m] <= s) lo = m; else hi = m; }
  const seg = r.cum[hi] - r.cum[lo];
  return out.lerpVectors(r.pts[lo], r.pts[hi], seg > 0 ? clamp((s - r.cum[lo]) / seg, 0, 1) : 0);
}
function stepPlay(dt){
  play.anim += dt;
  const t = play.t + dt;
  if (t >= play.T) { setPlayTime(play.T); stopPlay(); toast('동선 재생이 끝났습니다.'); return; }
  setPlayTime(t);
}
function playHud(seg, phase){
  const f = play.T ? play.t / play.T : 0, tr = $('hudTrack'), st = trip.days[seg.d] && trip.days[seg.d].stops[seg.after];
  $('hudText').textContent = phase === 'rest' ? (seg.d + 1) + '일차 마무리' + (st ? ' · ' + st.name : '')
    : phase === 'fly' ? (seg.d + 1) + '일차 시작' + (fmtShort(seg.d) ? ' · ' + fmtShort(seg.d) : '') : seg.label;
  tr.style.setProperty('--f', f.toFixed(4));
  tr.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  tr.setAttribute('aria-valuetext', seg.label);
  for (const b of $('hudDays').children) b.setAttribute('aria-current', String(+b.dataset.d === seg.d));
  dirty = true;
}
function placeMover(seg, s, moving){
  const mode = seg.mode;
  routePoint(seg, s, mover.position);
  mover.position.y += mode === 'plane' ? 0.002 : mode === 'ferry' ? 0 : 0.004;
  // heading from a point a little behind to a little ahead, so the model turns smoothly through polyline corners
  const la = Math.max(mode === 'walk' ? 0.003 : 0.02, mover.scale.x * (mode === 'walk' ? 0.5 : 1.2));
  routePoint(seg, s - la, _behind); routePoint(seg, s + la, _ahead);
  const dx = _ahead.x - _behind.x, dz = _ahead.z - _behind.z, dh = Math.hypot(dx, dz);
  if (dh > 1e-6) {
    const slope = Math.atan2(_ahead.y - _behind.y, dh);
    const pitch = mode === 'walk' || mode === 'ferry' ? 0 : mode === 'plane' ? clamp(-slope, -0.35, 0.35) : -slope * 0.6;
    mover.rotation.set(pitch, Math.atan2(dx, dz), 0);
  }
  if (mode === 'walk') {
    const sw = moving ? Math.sin(play.anim * 11) * 0.55 : 0, l = MODELS.walk.userData.limbs;
    l[0].rotation.x = sw; l[1].rotation.x = -sw; l[2].rotation.x = -sw * 0.8; l[3].rotation.x = sw * 0.8;
  }
  if (mode === 'bike') MODELS.bike.userData.pedal(moving ? play.anim * 9 : 0.6);
  const c = dayColor(seg.d);
  paint.color.set(c); paint.emissive.set(c);
  goal.tx = mover.position.x; goal.tz = mover.position.z;
}
/* ---- the progress bar: drag or tap to move through the playback; day chips jump to a day ---- */
let scrub = null;
const hudTrack = $('hudTrack');
function scrubTo(cx){ const r = hudTrack.getBoundingClientRect(); setPlayTime(clamp((cx - r.left) / Math.max(1, r.width), 0, 1) * play.T); }
hudTrack.addEventListener('pointerdown', e => {
  if (!play || e.button > 0) return;
  e.preventDefault();
  scrub = {id: e.pointerId, resume: !play.paused};
  play.paused = true; playUi();
  try { hudTrack.setPointerCapture(e.pointerId); } catch (err) {}
  hudTrack.classList.add('scrubbing');
  scrubTo(e.clientX);
});
hudTrack.addEventListener('pointermove', e => { if (scrub && play && e.pointerId === scrub.id) scrubTo(e.clientX); });
const scrubEnd = e => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const resume = scrub.resume; scrub = null; hudTrack.classList.remove('scrubbing');
  if (play && resume && play.t < play.T) pausePlay(false);
};
hudTrack.addEventListener('pointerup', scrubEnd);
hudTrack.addEventListener('pointercancel', scrubEnd);
hudTrack.addEventListener('keydown', e => {
  if (!play) return;
  const step = {ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1}[e.key], P = play;
  let t = null;
  if (step) t = P.t + step * Math.max(1, P.T * 0.02);
  else if (e.key === 'Home') t = 0;
  else if (e.key === 'End') t = P.T * 0.999;
  else if (e.key === 'PageDown' || e.key === 'PageUp') {
    const cur = P.segs[P.k].d, i = P.dayAt.findIndex(a => a.d === cur), j = clamp(i + (e.key === 'PageDown' ? 1 : -1), 0, P.dayAt.length - 1);
    t = P.dayAt[j].t;
  }
  if (t == null) return;
  e.preventDefault(); setPlayTime(t);
});
function buildHudDays(){
  const box = $('hudDays'), ticks = $('hudTicks');
  box.textContent = ''; ticks.textContent = '';
  box.hidden = play.dayAt.length < 2;
  play.dayAt.forEach((a, k) => {
    box.append(h('button', {type: 'button', 'data-d': a.d, style: '--c:' + dayColor(a.d), 'aria-label': (a.d + 1) + '일차부터 보기',
      onclick: () => setPlayTime(a.t)}, (a.d + 1) + '일차'));
    if (k) ticks.append(h('span', {class: 'tick', style: 'left:' + (a.t / play.T * 100).toFixed(2) + '%'}));
  });
}

/* ================= trip journal UI ================= */
function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && !k.startsWith('aria-')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
// append children, skipping null/false and flattening arrays (Element.append would print "null")
function put(el, ...kids){ for (const c of kids.flat()) if (c != null && c !== false) el.append(c); return el; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
// Korean object particle: 을 after a final consonant, 를 after a vowel
const josa = (w, a, b) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 ? ((c - 0xac00) % 28 ? a : b) : a + '(' + b + ')'; };
let toastTimer = 0;
function toast(msg, act, fn, ms){
  const el = $('toast');
  $('toastText').textContent = msg;
  const b = $('toastAct'); b.hidden = !act; b.textContent = act || '';
  b.onclick = act ? () => { el.classList.remove('on'); fn(); } : null;
  el.classList.remove('dragging'); el.style.removeProperty('--tx'); el.style.removeProperty('--ty'); el.style.opacity = '';
  el.classList.add('on');
  el.dataset.ms = ms || (act ? 6000 : 3200);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), +el.dataset.ms);
}
// a toast can be swiped away, sideways or up; let go early and it settles back and stays a little longer
(() => {
  const el = $('toast');
  let d = null;
  el.addEventListener('pointerdown', e => {
    if (!el.classList.contains('on') || e.target.closest('button') || e.button > 0) return;
    d = {id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, w: el.offsetWidth};
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('dragging');
    clearTimeout(toastTimer);
  });
  el.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x0; d.dy = Math.min(0, e.clientY - d.y0);
    el.style.setProperty('--tx', d.dx + 'px'); el.style.setProperty('--ty', d.dy + 'px');
    el.style.opacity = String(clamp(1 - Math.max(Math.abs(d.dx) / d.w, -d.dy / 60) * 0.9, 0.1, 1));
  });
  const end = e => {
    if (!d || e.pointerId !== d.id) return;
    const g = d; d = null;
    el.classList.remove('dragging');
    if (Math.abs(g.dx) > Math.min(90, g.w * 0.3) || g.dy < -36) {        // away: keep moving the way it was pushed
      el.style.setProperty('--tx', (Math.abs(g.dx) > -g.dy ? Math.sign(g.dx) * (g.w + 40) : 0) + 'px');
      if (Math.abs(g.dx) <= -g.dy) el.style.setProperty('--ty', '-80px');
      el.style.opacity = '0'; el.classList.remove('on');
      setTimeout(() => { if (!el.classList.contains('on')) { el.style.removeProperty('--tx'); el.style.removeProperty('--ty'); el.style.opacity = ''; } }, 260);
    } else {
      el.style.removeProperty('--tx'); el.style.removeProperty('--ty'); el.style.opacity = '';
      toastTimer = setTimeout(() => el.classList.remove('on'), Math.max(2500, +el.dataset.ms / 2));
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
})();
const WD = '일월화수목금토';
function dayDate(d){
  if (!trip.startDate) return null;
  const [y, m, dd] = trip.startDate.split('-').map(Number);
  return new Date(y, m - 1, dd + d);
}
const fmtDate = d => { const t = dayDate(d); return t ? (t.getMonth() + 1) + '월 ' + t.getDate() + '일 ' + WD[t.getDay()] + '요일' : ''; };
const fmtShort = d => { const t = dayDate(d); return t ? (t.getMonth() + 1) + '.' + t.getDate() + ' ' + WD[t.getDay()] : ''; };
const fmtMin = m => { const t = Math.max(1, Math.round(m)), hh = Math.floor(t / 60), mm = t % 60; return hh ? hh + '시간' + (mm ? ' ' + mm + '분' : '') : mm + '분'; };
const fmtKm = km => km < 1 ? Math.round(km * 1000 / 10) * 10 + 'm' : km.toFixed(km < 10 ? 1 : 0) + 'km';
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);
const timeText = s => s.time + (s.dep && s.dep !== s.time ? '–' + s.dep : '');

/* ---- how each leg is travelled ---- */
const MODES = [{id: 'car', label: '자동차', icon: IC.car}, {id: 'coast', label: '해안도로', icon: IC.coast},
               {id: 'bus', label: '버스', icon: IC.bus}, {id: 'bike', label: '자전거', icon: IC.bike}, {id: 'walk', label: '도보', icon: IC.walk},
               {id: 'ferry', label: '배', icon: IC.ferry}, {id: 'plane', label: '비행기', icon: IC.plane}];
const modeOf = s => BY.includes(s.by) ? s.by : s.coast ? 'coast' : 'car';
// on the roads (directions apps, the way from the phone) a boat or plane leg counts as a drive
const roadMode = s => { const m = modeOf(s); return m === 'ferry' || m === 'plane' ? 'car' : m; };
function setMode(s, m){ s.by = BY.includes(m) ? m : ''; s.coast = m === 'coast'; }
// minutes by mode: driving time comes from the road graph; buses stop and wait; bikes do about 15 km/h, walkers 4.5 km/h
function legMin(l, b){
  if (l.kind !== 'road') return null;
  const m = roadMode(b);
  return m === 'walk' ? l.km / 4.5 * 60 : m === 'bike' ? l.km / 15 * 60 : m === 'bus' ? l.min * 1.4 + 5 : l.min;
}
// off the roads: a boat at about 25 km/h plus boarding, a plane at about 300 km/h plus boarding, a straight hop at 30 km/h
const crossMin = l => l.kind === 'ferry' ? l.km / 25 * 60 + 10 : l.kind === 'air' ? l.km / 300 * 60 + 30 : l.km / 30 * 60;
function legText(l, a, b){
  if (l.kind === 'ferry' || l.kind === 'air') {
    let t = (l.kind === 'air' ? '비행기 ' : '배편 ') + fmtKm(l.km);
    if (a.dep && b.time && toMin(b.time) > toMin(a.dep)) t += ' · ' + a.dep + ' 출발 → ' + b.time + ' 도착';
    else if (a.dep) t += ' · ' + a.dep + ' 출발';
    else t += ' · 약 ' + fmtMin(crossMin(l));
    return t;
  }
  if (l.kind === 'direct') return '직선 ' + fmtKm(l.km) + ' · 도로로 이어지지 않음';
  return MODES.find(x => x.id === roadMode(b)).label + ' ' + fmtKm(l.km) + ' · 약 ' + fmtMin(legMin(l, b));
}
const legIcon = (l, b) => l.kind === 'ferry' ? IC.ferry : l.kind === 'air' ? IC.plane : l.kind === 'direct' ? IC.line : MODES.find(x => x.id === roadMode(b)).icon;
// The ways a leg can be travelled, as a row of buttons. The road modes need a road between the two stops; a boat
// or a plane can always be picked. after(mode) runs once the choice is stored on b.
function modePicker(a, b, after, label){
  const base = routeLeg(a, b), road = base.kind === 'road';
  const cur = road || b.by === 'ferry' || b.by === 'plane' ? modeOf(b) : base.kind === 'ferry' ? 'ferry' : '';
  return h('div', {class: 'leg-pick', role: 'radiogroup', 'aria-label': label},
    (road ? MODES : MODES.filter(m => m.id === 'ferry' || m.id === 'plane')).map(m => h('button', {class: 'seg', type: 'button', role: 'radio',
      'aria-checked': String(cur === m.id), html: m.icon + '<span>' + m.label + '</span>', onclick: () => { setMode(b, m.id); after(m.id); }})),
    h('p', {class: 'leg-hint'}, road ? '동선 재생에서 고른 수단으로 움직입니다. 시간은 추정값입니다. 버스는 정류장과 기다림을 더하고, 자전거는 시속 15km, 도보는 시속 4.5km로 잡습니다. 배와 비행기는 두 장소를 곧게 잇습니다.'
      : '두 장소가 도로로 이어지지 않아 배나 비행기로만 고를 수 있습니다.'));
}
function dayTotal(d){
  const L = legs[d] || [], st = trip.days[d].stops;
  if (!L.length) return '';
  let km = 0, min = 0;
  L.forEach((l, i) => { km += l.km; min += legMin(l, st[i + 1]) || 0; });
  return '이동 ' + km.toFixed(0) + 'km' + (min ? ' · 약 ' + fmtMin(min) : '');
}

/* ---- offline place search (places.json: cats are in search-priority order) ---- */
const NORM = s => String(s).toLowerCase().replace(/[\s·.,()[\]{}'"\-]/g, '');
const CATS = PLACES.cats;
const PL = PLACES.p.map(r => ({name: r[0], cat: r[1], lat: r[2], lon: r[3], alt: r[4] || '', k: NORM(r[0]), ka: NORM(r[4] || '')}));
const SIGHT = new Set(['관광지', '폭포', '오름·봉우리', '해변', '해수욕장', '박물관', '미술관', '테마파크', '동물원', '아쿠아리움', '전망대', '유적', '동굴', '공원', '정원', '시장', '등대', '섬']);
function areaOf(lat, lon){
  let best = '', bd = 1e9;
  for (const g of GEO) { const q = (g[1] - lat) ** 2 + ((g[2] - lon) * 0.84) ** 2; if (q < bd) { bd = q; best = g[0]; } }
  return best.replace(/ [\d,]+m$/, '');
}
function searchPlaces(q){
  const k = NORM(q);
  if (!k) return [];
  const out = [];
  // whole-name and prefix matches share a tier ordered by category, so '천지연' finds the waterfall before a
  // restaurant of the same name; an exact name still wins over about 15 category steps ('용두암' over its bike stamp booth)
  for (const p of PL) {
    const s = p.k === k ? 0 : p.k.startsWith(k) ? 1 : p.k.includes(k) ? 2 : p.ka && p.ka.includes(k) ? 3 : -1;
    if (s >= 0) out.push([Math.max(0, s - 1) * 1000 + p.cat * 4 - (s === 0 ? 60 : 0) + Math.min(3, p.name.length / 12), p]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, 40).map(x => x[1]);
}
function nearbySights(){
  return PL.filter(p => SIGHT.has(CATS[p.cat])).map(p => [Math.hypot(toX(p.lon) - cam.tx, toZ(p.lat) - cam.tz), p])
    .sort((a, b) => a[0] - b[0]).slice(0, 12);
}
function nearestPlace(lat, lon, maxKm){
  let best = null, bd = maxKm;
  for (const p of PL) { const q = Math.hypot((p.lon - lon) * KLON, (p.lat - lat) * KLAT); if (q < bd) { bd = q; best = p; } }
  return best;
}
const inBox = (lat, lon) => lat >= T.lat1 && lat <= T.lat0 && lon >= T.lon0 && lon <= T.lon1;

/* ---- saving ---- */
function commit(keepPanel){
  if (!store.set(TRIP_KEY, JSON.stringify(trip))) toast('이 브라우저에 일정을 저장하지 못했습니다. 개인정보 보호 모드인지 확인해 주세요.');
  if (state.sel && !(trip.days[state.sel.d] && trip.days[state.sel.d].stops[state.sel.i])) state.sel = null;
  if (state.day >= trip.days.length) state.day = trip.days.length - 1;
  if (play) stopPlay();
  rebuildScene();
  if (keepPanel) { renderHead(false); renderChips(); renderPeek(); } else renderPanel();
}

/* ---- bottom sheet (phone) / left panel (desktop) ---- */
const sheet = $('sheet'), scroller = $('sheetScroll');
const isDesk = () => matchMedia('(min-width: 900px)').matches;
let snap = 'peek', peekPx = 280, view = null, legOpen = null;
// snaps, top to bottom: full, half, peek (day head, chips and the peek line), mini (only the mosaic band and the grip
// above the dock: the most map), hide (map picking)
const miniPx = () => $('dock').offsetHeight + 34;
function snapY(s){
  const H = sheet.offsetHeight, vis = s === 'full' ? H : s === 'half' ? Math.min(H, innerHeight * 0.62) : s === 'hide' ? 0 : s === 'mini' ? miniPx() : peekPx;
  return Math.max(0, H - vis);
}
function setSnap(s){
  const wasMini = snap === 'mini';
  snap = s;
  if (isDesk()) return;
  sheet.style.setProperty('--sy', snapY(s) + 'px');
  document.body.classList.toggle('sheet-full', s === 'full');     // the map controls would peek out above the sheet
  document.body.classList.toggle('sheet-mini', s === 'mini');
  $('grip').setAttribute('aria-expanded', String(s === 'half' || s === 'full'));
  $('grip').setAttribute('aria-label', s === 'mini' ? '일정 펼치기' : s === 'peek' ? '일정 목록 펼치기' : '일정 목록 접기');
  if ((s === 'peek' || s === 'mini') && !view) scroller.scrollTop = 0;
  if (!view) renderPeek();
  if (wasMini !== (s === 'mini')) resize();      // the map's centre follows the sheet's top
}
// the folded sheet shows the grip, the day head, the day chips and the peek line; the dock floats over its bottom
function measurePeek(){
  const pk = $('peek');
  if ($('vList').hidden) return;          // a sub view is open: keep the last measurement
  peekPx = Math.round(clamp(pk.offsetTop + pk.offsetHeight + 6 + $('dock').offsetHeight, 200, innerHeight * 0.5));
}
function mapInset(){ return isDesk() ? 0 : snap === 'mini' ? miniPx() : peekPx; }
// Dragging the sheet. With a finger the whole sheet takes part: until it is fully open, any up-or-down drag on it
// moves the sheet (sideways drags still scroll the day chips); fully open, the list scrolls, and pulling down from the
// top of the list folds the sheet again. Mouse and pen drag by the grip, the day head and the mosaic band.
// Taps on the grip or the band come in as clicks (so the keyboard works too); a drag swallows the click that follows.
let sdrag = null, dragEnded = 0;
const sheetMax = () => sheet.offsetHeight - miniPx();
function settleSheet(cur, v){        // nearest snap, or the next one in the direction of a fling
  sheet.classList.remove('dragging');
  dragEnded = performance.now();
  const order = ['full', 'half', 'peek', 'mini'], ys = order.map(snapY);
  let k = 0;
  ys.forEach((y, i) => { if (Math.abs(y - cur) < Math.abs(ys[k] - cur)) k = i; });
  if (v < -0.45) { const up = ys.map((y, i) => y < cur - 10 ? i : -1).filter(i => i >= 0); k = up.length ? up[up.length - 1] : 0; }
  else if (v > 0.45) { const i = ys.findIndex(y => y > cur + 10); k = i < 0 ? order.length - 1 : i; }
  setSnap(view && (order[k] === 'peek' || order[k] === 'mini') ? 'half' : order[k]);
}
function sheetDown(e){
  if (isDesk() || e.pointerType === 'touch' || e.button > 0 || e.target.closest('input,textarea,select')) return;
  sdrag = {y0: e.clientY, sy0: snapY(snap), y: e.clientY, t: performance.now(), v: 0, moved: false, id: e.pointerId, el: e.currentTarget};
}
function sheetMove(e){
  if (!sdrag || e.pointerId !== sdrag.id) return;
  const dy = e.clientY - sdrag.y0;
  if (!sdrag.moved) {
    if (Math.abs(dy) < 8) return;
    sdrag.moved = true; sheet.classList.add('dragging');
    try { sdrag.el.setPointerCapture(e.pointerId); } catch (err) {}
  }
  sheet.style.setProperty('--sy', clamp(sdrag.sy0 + dy, 0, sheetMax()) + 'px');
  const now = performance.now();
  sdrag.v = (e.clientY - sdrag.y) / Math.max(1, now - sdrag.t); sdrag.y = e.clientY; sdrag.t = now;
}
function sheetUp(e){
  if (!sdrag || e.pointerId !== sdrag.id) return;
  const d = sdrag; sdrag = null;
  if (d.moved) settleSheet(d.sy0 + e.clientY - d.y0, d.v);
}
// a tap on the grip steps open (mini -> peek -> half) and closes back to peek from above
const gripTap = () => { if (performance.now() - dragEnded > 350) setSnap(snap === 'mini' ? 'peek' : snap === 'peek' ? 'half' : view ? 'half' : 'peek'); };
for (const el of [$('grip'), $('dayhead'), sheet.querySelector('.mosaic')]) {
  el.addEventListener('pointerdown', sheetDown);
  el.addEventListener('pointermove', sheetMove);
  el.addEventListener('pointerup', sheetUp);
  el.addEventListener('pointercancel', sheetUp);
}
$('grip').addEventListener('click', gripTap);
sheet.querySelector('.mosaic').addEventListener('click', gripTap);
let tdrag = null;
sheet.addEventListener('touchstart', e => {
  if (isDesk() || state.pick || e.touches.length !== 1 || e.target.closest('input,textarea,select,.handle')) { tdrag = null; return; }
  const t = e.touches[0];
  tdrag = {id: t.identifier, x0: t.clientX, y0: t.clientY, y: t.clientY, t: performance.now(), v: 0, mode: '', moved: false, sy0: snapY(snap)};
}, {passive: true});
sheet.addEventListener('touchmove', e => {
  if (!tdrag) return;
  const t = [...e.changedTouches].find(x => x.identifier === tdrag.id);
  if (!t) return;
  const dx = t.clientX - tdrag.x0, dy = t.clientY - tdrag.y0;
  if (!tdrag.mode) {
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    tdrag.mode = Math.abs(dx) > Math.abs(dy) ? 'x'                                   // sideways: chips scroll natively
      : snap !== 'full' || (dy > 0 && scroller.scrollTop <= 0) ? 'sheet' : 'scroll';  // fully open: the list scrolls
  }
  if (tdrag.mode !== 'sheet') return;
  if (e.cancelable) e.preventDefault();
  if (!tdrag.moved) {
    if (Math.abs(dy) < 6) return;
    tdrag.moved = true; sheet.classList.add('dragging');
  }
  sheet.style.setProperty('--sy', clamp(tdrag.sy0 + dy, 0, sheetMax()) + 'px');
  const now = performance.now();
  tdrag.v = (t.clientY - tdrag.y) / Math.max(1, now - tdrag.t); tdrag.y = t.clientY; tdrag.t = now;
}, {passive: false});
const touchEnd = e => {
  if (!tdrag) return;
  const t = [...e.changedTouches].find(x => x.identifier === tdrag.id);
  if (!t) return;
  const d = tdrag; tdrag = null;
  if (d.mode === 'sheet' && d.moved) settleSheet(d.sy0 + t.clientY - d.y0, d.v);
};
sheet.addEventListener('touchend', touchEnd);
sheet.addEventListener('touchcancel', touchEnd);

/* ---- sub views inside the sheet: search, stop, day, trip ---- */
// build(v) may return an element to focus; focusing happens after the view is shown, still inside the tap,
// so iOS opens the keyboard
// Android's back button / gesture (and Safari's swipe back) should close a sub view or the map picker, not leave
// the app: one history entry stands for "something is open". navBack covers the gap while our own history.back()
// is in flight, so a view reopened in that moment gets its entry back.
let navArmed = false, navBack = false;
function navOpen(){ if (!navArmed && !navBack) { history.pushState({jejumap: 1}, ''); navArmed = true; } }
function navClose(){ if (navArmed && !navBack) { navBack = true; history.back(); } }
addEventListener('popstate', () => {
  if (navBack) { navBack = false; navArmed = false; if (view || state.pick || askCb || vw) navOpen(); return; }
  navArmed = false;
  if (askCb) { closeAsk(false, true); if (view || state.pick || vw) navOpen(); return; }     // back = 취소
  if (vw) { closeViewer(true); if (view || state.pick) navOpen(); return; }
  if (state.pick) { const p = state.pick; endPick(); if (p.mode === 'move') openStop(p.d, p.i); }
  else if (view) closeView();
});
/* ---- a small confirm dialog (삭제 / 취소) ---- */
// Focus starts on 취소, Tab stays inside, Esc / back / a tap outside cancel. It takes the history entry only when
// nothing else holds one, so closing it never closes the view underneath.
// alt = {label, fn}: a second choice (the dialog then stacks its buttons: yes, alt, 취소)
let askCb = null, askAlt = null, askNav = false, askReturn = null;
function ask(title, body, yes, cb, alt){
  askReturn = document.activeElement;
  $('askTitle').textContent = title; $('askBody').textContent = body; $('askYes').textContent = yes;
  $('askAlt').hidden = !alt; $('askAlt').textContent = alt ? alt.label : '';
  $('ask').classList.toggle('stack', !!alt);
  askCb = cb; askAlt = alt ? alt.fn : null; askNav = !navArmed; navOpen();
  $('ask').hidden = false; $('askNo').focus();
}
function closeAsk(ok, fromHistory){
  if (!askCb) return;
  const cb = askCb, alt = askAlt; askCb = askAlt = null; $('ask').hidden = true;
  if (!fromHistory && askNav) navClose();
  if (ok === 'alt') alt();
  else if (ok) cb();
  else if (askReturn && askReturn.isConnected) askReturn.focus({preventScroll: true});
}
$('askYes').addEventListener('click', () => closeAsk(true));
$('askAlt').addEventListener('click', () => closeAsk('alt'));
$('askNo').addEventListener('click', () => closeAsk(false));
$('ask').addEventListener('click', e => { if (e.target === $('ask')) closeAsk(false); });
$('ask').addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const bs = [...$('ask').querySelectorAll('button:not([hidden])')], k = bs.indexOf(document.activeElement);
  bs[(k + (e.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
});
function askRemove(d, i){
  const s = trip.days[d] && trip.days[d].stops[i];
  if (s) ask('이 장소를 삭제하시겠습니까?', (d + 1) + '일차 ' + (i + 1) + '번 · ' + s.name, '삭제', () => removeStop(d, i));
}
function openView(kind, build){
  navOpen();
  if (!view) view = {kind, prevSnap: snap}; else view.kind = kind;
  const v = $('vSub'); v.textContent = '';
  const focus = build(v);
  $('toast').classList.remove('on');
  $('vList').hidden = true; v.hidden = false; $('dock').hidden = true;
  scroller.scrollTop = 0;
  setSnap('full');
  if (focus) focus.focus({preventScroll: true});
}
function closeView(quiet){
  if (!view) return;
  const prev = view.prevSnap; view = null;
  if (!state.pick) navClose();
  $('vSub').hidden = true; $('vSub').textContent = ''; $('vList').hidden = false; $('dock').hidden = false;
  if (!quiet) { renderPanel(); setSnap(prev === 'full' ? 'half' : prev); }
}
const vhead = (title, back, badge) => h('div', {class: 'vhead'},
  h('button', {class: 'icon-btn', type: 'button', 'aria-label': '일정으로 돌아가기', html: IC.prev, onclick: back || (() => closeView())}), badge, h('h2', null, title));
const field = (label, input, hint) => h('div', {class: 'field'}, h('label', {for: input.id}, label), input, hint ? h('p', {class: 'hint'}, hint) : null);
let uid = 0;
const fid = () => 'f' + (++uid);

function addPlace(p, d, thenEdit){
  const day = trip.days[d];
  const used = new Set(trip.days.flatMap(x => x.stops.map(s => s.id)));
  let id; do id = newId(); while (used.has(id));
  day.stops.push({id, name: String(p.name).slice(0, 60), lat: +(+p.lat).toFixed(5), lon: +(+p.lon).toFixed(5), time: '', stay: null, memo: ''});
  const i = day.stops.length - 1;
  state.day = d; state.sel = {d, i};
  closeView(true); commit();
  // show the new leg (previous stop -> new stop) rather than diving onto the new pin
  if (i > 0) { setOrbit(false); fitStops([day.stops[i - 1], day.stops[i]]); } else flyTo(day.stops[i]);
  if (thenEdit) { openStop(d, i); return; }
  setSnap('peek');
  toast('‘' + p.name + '’' + josa(p.name, '을', '를') + ' ' + (d + 1) + '일차 ' + (i + 1) + '번째로 넣었습니다.');
}

// rep = {d, i}: find a new position for an existing stop instead of adding one (from the stop editor). Its time, memo
// and travel settings stay; the name and the position come from the chosen result.
function openSearch(d0, rep){
  let target = d0 != null ? d0 : state.day >= 0 ? state.day : trip.days.length - 1;
  const old = rep && trip.days[rep.d] && trip.days[rep.d].stops[rep.i];
  if (rep && !old) return;
  const choose = p => rep ? replaceStop(rep.d, rep.i, p) : addPlace(p, target);
  openView('search', v => {
    const inp = h('input', {class: 'in', id: fid(), type: 'search', placeholder: '장소 이름 (예: 성산일출봉, 동문시장)', 'aria-label': '장소 이름으로 찾기',
      enterKeyHint: 'search', autocomplete: 'off', spellcheck: false, value: rep && old.name !== '지도에서 고른 곳' ? old.name : ''});
    const days = h('div', {class: 'daypick', role: 'radiogroup', 'aria-label': '넣을 날'});
    const res = h('div', {'aria-live': 'polite'});
    const drawDays = () => {
      days.textContent = '';
      if (trip.days.length < 2 || rep) return;
      put(days, h('span', null, '넣을 날'), trip.days.map((_, d) => h('button', {class: 'chip', type: 'button', role: 'radio', style: '--c:' + dayColor(d),
        'aria-checked': String(d === target), onclick: () => { target = d; drawDays(); }}, (d + 1) + '일차')));
    };
    const item = (p, sub, q) => {
      const at = q ? p.name.indexOf(q) : -1;
      const nm = at < 0 ? esc(p.name) : esc(p.name.slice(0, at)) + '<mark>' + esc(q) + '</mark>' + esc(p.name.slice(at + q.length));
      return h('li', null, h('button', {class: 'res', type: 'button', onclick: () => choose(p)},
        h('span', {class: 'r-main'}, h('span', {class: 'r-name', html: nm}), h('span', {class: 'r-sub'}, sub)),
        h('span', {class: 'r-add', html: rep ? IC.target : IC.plus, 'aria-hidden': 'true'})));
    };
    // the two other ways in sit right under the box: pick on the map (offline) and address search (online, Esri)
    const netOut = h('div', {'aria-live': 'polite'});
    const addrBtn = h('button', {class: 'btn', type: 'button', html: IC.globe + '<span>주소로 찾기</span>', disabled: true,
      onclick: () => geocode(inp.value.trim(), netOut, item)});
    const draw = () => {
      const q = inp.value.trim();
      res.textContent = ''; netOut.textContent = ''; addrBtn.disabled = !q;
      if (!q) {
        res.append(h('p', {class: 'sec-label'}, '지금 지도 가까이 있는 명소'),
          h('ul', {class: 'results'}, nearbySights().map(([km, p]) => item(p, [CATS[p.cat], areaOf(p.lat, p.lon), fmtKm(km)].join(' · ')))));
        return;
      }
      const hits = searchPlaces(q);
      if (hits.length) res.append(h('p', {class: 'sec-label'}, '내장 목록에서 ' + hits.length + (hits.length >= 40 ? '곳 이상' : '곳')),
        h('ul', {class: 'results'}, hits.map(p => item(p, CATS[p.cat] + ' · ' + areaOf(p.lat, p.lon), q))));
      else res.append(h('p', {class: 'hint', style: 'margin-top:12px'}, '‘' + q + '’와 맞는 장소가 내장 목록에 없습니다. 주소로 찾거나 지도에서 직접 고르세요.'));
    };
    inp.addEventListener('input', draw);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = res.querySelector('.res'); if (b) b.click(); } });
    put(v, rep ? vhead('위치 다시 찾기', () => openStop(rep.d, rep.i), h('span', {class: 'n', style: '--c:' + dayColor(rep.d)}, String(rep.i + 1)))
        : vhead('장소 추가'),
      rep ? h('p', {class: 'hint', style: 'margin-bottom:10px'}, '‘' + old.name + '’의 새 위치를 고르세요. 시간, 메모, 이동수단은 그대로 둡니다.') : null,
      h('div', {class: 'searchbox'}, h('span', {html: IC.search, 'aria-hidden': 'true'}), inp), days,
      h('div', {class: 'row2', style: 'margin-top:10px'},
        h('button', {class: 'btn', type: 'button', html: IC.target + '<span>지도에서 고르기</span>',
          onclick: () => startPick(rep ? {mode: 'move', d: rep.d, i: rep.i} : {mode: 'add', d: target, name: inp.value.trim()})}), addrBtn),
      h('p', {class: 'hint', style: 'margin-top:6px'}, '주소로 찾기는 인터넷이 필요하고, 검색어가 Esri(ArcGIS) 주소 검색으로 전송됩니다.'),
      netOut, res);
    drawDays(); draw();
    return inp;
  });
}
async function geocode(q, out, item){
  out.textContent = '';
  if (navigator.onLine === false) { out.append(h('p', {class: 'hint'}, '인터넷에 연결되어 있지 않습니다. 내장 목록에서 찾거나 지도에서 직접 고르세요.')); return; }
  out.append(h('p', {class: 'hint'}, '찾는 중…'));
  const u = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' + new URLSearchParams({
    SingleLine: q, f: 'json', countryCode: 'KOR', maxLocations: '6', langCode: 'ko', outFields: 'Match_addr,PlaceName',
    searchExtent: [T.lon0, T.lat1, T.lon1, T.lat0].join(',')});
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(u, {signal: ctl.signal}); clearTimeout(tm);
    const c = ((await r.json()).candidates || []).filter(c => c.location && inBox(c.location.y, c.location.x));
    out.textContent = '';
    if (!c.length) { out.append(h('p', {class: 'hint'}, '제주 안에서 맞는 주소를 찾지 못했습니다. 도로명 주소나 건물 이름으로 다시 찾아 보세요.')); return; }
    out.append(h('ul', {class: 'results'}, c.map(c => {
      const a = c.attributes || {};
      return item({name: (a.PlaceName || q).slice(0, 60), lat: c.location.y, lon: c.location.x}, a.Match_addr || '주소 검색 결과');
    })));
  } catch (err) {
    out.textContent = '';
    out.append(h('p', {class: 'hint'}, '주소 검색에 연결하지 못했습니다. 잠시 뒤 다시 누르거나 지도에서 직접 고르세요.'));
  }
}

function openStop(d, i){
  const day = trip.days[d], s = day && day.stops[i];
  if (!s) return;
  state.sel = {d, i}; applyFilter();
  openView('stop', v => {
    const L = legs[d] || [], crossNext = L[i] && (L[i].kind === 'ferry' || L[i].kind === 'air') ? L[i].kind : '';
    const upd = (k, max) => e => { const val = e.target.value.trim().slice(0, max); if (k !== 'name' || val) s[k] = val; commit(true); };
    const move = to => { day.stops.splice(to, 0, day.stops.splice(i, 1)[0]); state.sel = {d, i: to}; commit(); openStop(d, to); };
    const toDay = h('select', {class: 'in', id: fid(), onchange: e => {
      const nd = +e.target.value; if (nd === d) return;
      day.stops.splice(i, 1); trip.days[nd].stops.push(s); state.day = nd; state.sel = {d: nd, i: trip.days[nd].stops.length - 1};
      commit(); openStop(nd, trip.days[nd].stops.length - 1); toast((nd + 1) + '일차 마지막으로 옮겼습니다.');
    }}, trip.days.map((_, k) => h('option', {value: k, selected: k === d}, (k + 1) + '일차' + (fmtShort(k) ? ' (' + fmtShort(k) + ')' : ''))));
    // the arrival estimate under the times, kept up to date as the time or the stay changes
    const etaP = h('p', {class: 'hint', style: 'margin:-8px 0 16px', 'aria-live': 'polite'});
    const etaText = () => {
      const p = dayPlan(d)[i];
      etaP.textContent = !p ? '' : i === 0 ? '이 날 첫 장소입니다. ' + (s.time ? s.time + '부터 다음 장소들의 도착 시각을 계산합니다.'
          : '시간이 없으면, 시간을 넣은 첫 장소에 맞춰 여기서 출발하는 것으로 계산합니다(시간을 넣은 장소가 없으면 9시부터).')
        : '예상 도착 ~' + clock(p.eta) + ' (앞 장소에서 머무는 시간과 이동 시간으로 계산)' + (p.late > 10 ? ' · 넣은 시간보다 약 ' + fmtMin(p.late) + ' 늦을 것 같습니다.' : '');
      etaP.classList.toggle('warn', !!p && p.late > 10);
    };
    // the way here from the stop before (and the vehicle the playback shows): redrawn in place when changed
    let modeBox = null;
    const pickMode = () => { const p = modePicker(day.stops[i - 1], s, () => { commit(true); const n = pickMode(); modeBox.replaceWith(n); modeBox = n; etaText(); }, '앞 장소에서 여기까지 이동수단'); p.style.setProperty('--c', dayColor(d)); return p; };
    if (i > 0) modeBox = pickMode();
    const STAYS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480];
    const stay = h('select', {class: 'in', id: fid(), onchange: e => { s.stay = e.target.value === '' ? null : +e.target.value; commit(true); etaText(); }},
      h('option', {value: '', selected: s.stay == null}, '기본 ' + fmtMin(defaultStay(s))),
      STAYS.map(m => h('option', {value: m, selected: s.stay === m}, fmtMin(m))),
      s.stay != null && !STAYS.includes(s.stay) ? h('option', {value: s.stay, selected: true}, fmtMin(s.stay)) : null);
    put(v, vhead((d + 1) + '일차 장소 고치기', null, h('span', {class: 'n', style: '--c:' + dayColor(d)}, String(i + 1))),
      field('이름', h('input', {class: 'in', id: fid(), value: s.name, maxLength: 60, onchange: upd('name', 60)})),
      h('div', {class: 'row2'},
        field('도착 시간', h('input', {class: 'in', id: fid(), type: 'time', value: s.time, onchange: e => { upd('time', 5)(e); etaText(); }})),
        field('머무는 시간', stay)),
      etaP,
      crossNext ? field(crossNext === 'air' ? '비행기 출발 시각' : '배 출발 시각', h('input', {class: 'in', id: fid(), type: 'time', value: s.dep || '', style: 'max-width:50%', onchange: e => { upd('dep', 5)(e); etaText(); }}),
        (crossNext === 'air' ? '다음 장소까지 비행기로 갑니다.' : '다음 장소까지 바다를 건너 배편으로 계산했습니다.') + ' 출발 시각을 넣으면 구간에 시간표가 나옵니다.') : null,
      field('메모', h('textarea', {class: 'in', id: fid(), maxLength: 200, placeholder: '예: 점심, 예약 12시, 입장료 확인', onchange: upd('memo', 200)}, s.memo)),
      i > 0 ? h('h3', {class: 'group-h'}, '여기까지 오는 방법') : null,
      i > 0 ? modeBox : null,
      h('label', {class: 'switch'}, h('span', null, h('b', null, '걸어서 둘러보기'), h('span', {class: 'hint'}, '이 장소 주변 산책로를 걷는 동선을 지도와 재생에 넣습니다.')),
        h('input', {type: 'checkbox', checked: !!s.stroll, onchange: e => {
          s.stroll = e.target.checked; commit(true);
          if (s.stroll && !s.walk) {
            const w = strollOf(s);
            toast(w ? '주변 길 ' + fmtKm(w.km) + '를 한 바퀴 걷는 동선을 넣었습니다.' : '이 장소 주변에는 지도에 걷는 길이 없어 둘러보기를 그리지 못했습니다.');
          }
        }})),
      h('h3', {class: 'group-h'}, '사진'),
      photoGroup(d, i),
      h('h3', {class: 'group-h'}, '순서와 날짜'),
      h('div', {class: 'group'},
        h('div', {class: 'row2'},
          h('button', {class: 'btn', type: 'button', html: IC.up + '<span>앞으로</span>', disabled: i === 0, onclick: () => move(i - 1)}),
          h('button', {class: 'btn', type: 'button', html: IC.down + '<span>뒤로</span>', disabled: i === day.stops.length - 1, onclick: () => move(i + 1)})),
        trip.days.length > 1 ? field('다른 날로 옮기기', toDay) : null),
      h('h3', {class: 'group-h'}, '위치'),
      h('div', {class: 'group'},
        h('p', {class: 'hint'}, areaOf(s.lat, s.lon) + ' · ' + s.lat.toFixed(5) + ', ' + s.lon.toFixed(5)),
        h('button', {class: 'btn', type: 'button', html: IC.search + '<span>장소·주소 검색으로 다시 찾기</span>', onclick: () => openSearch(d, {d, i})}),
        h('button', {class: 'btn', type: 'button', html: IC.target + '<span>지도에서 위치 다시 정하기</span>', onclick: () => startPick({mode: 'move', d, i})})),
      h('h3', {class: 'group-h'}, '길안내와 동선 재생'),
      h('div', {class: 'group'},
        h('button', {class: 'btn', type: 'button', html: IC.nav + '<span>내 위치에서 여기까지 길안내</span>', onclick: () => openNav(null, s, modeOf(s))}),
        i > 0 ? h('button', {class: 'btn', type: 'button', html: IC.nav + '<span>앞 장소에서 여기까지 길안내</span>', onclick: () => openNav(day.stops[i - 1], s, modeOf(s))}) : null,
        h('button', {class: 'btn', type: 'button', html: IC.play + '<span>여기부터 동선 재생</span>', onclick: () => { closeView(); startPlay({stop: {d, i}}); }})),
      h('button', {class: 'btn danger wide', type: 'button', style: 'margin-top:8px', html: IC.trash + '<span>이 장소 삭제</span>', onclick: () => askRemove(d, i)}));
    etaText();
  });
}
// a stop gets a new name and position from a search result; 되돌리기 puts the old ones back
function replaceStop(d, i, p){
  const s = trip.days[d] && trip.days[d].stops[i];
  if (!s) return;
  const was = {name: s.name, lat: s.lat, lon: s.lon, walk: s.walk};
  s.name = String(p.name).slice(0, 60); s.lat = +(+p.lat).toFixed(5); s.lon = +(+p.lon).toFixed(5);
  if (s.walk && hav(was, s) > 0.3) s.walk = null;          // a walking path the stop brought along belonged to the old spot
  state.sel = {d, i};
  closeView(true); commit(); openStop(d, i); flyTo(s);
  toast('위치를 ‘' + s.name + '’' + josa(s.name, '으로', '로') + ' 바꿨습니다.', '되돌리기', () => { Object.assign(s, was); commit(); openStop(d, i); flyTo(s); });
}
function removeStop(d, i){
  const fromView = !!view, s = trip.days[d].stops.splice(i, 1)[0];
  state.sel = null; closeView(true); commit();
  if (fromView) setSnap('half');
  toast('‘' + s.name + '’' + josa(s.name, '을', '를') + ' 삭제했습니다.', '되돌리기', () => { trip.days[d].stops.splice(i, 0, s); state.day = d; state.sel = {d, i}; commit(); });
}
function openDay(d){
  const day = trip.days[d];
  openView('day', v => {
    put(v, vhead((d + 1) + '일차' + (fmtShort(d) ? ' · ' + fmtShort(d) : '')),
      field('이 날의 제목', h('input', {class: 'in', id: fid(), value: day.title, maxLength: 60, placeholder: '예: 서귀포 남쪽 해안', onchange: e => { day.title = e.target.value.trim(); commit(true); }})),
      field('메모', h('textarea', {class: 'in', id: fid(), maxLength: 200, placeholder: '예: 비 오면 실내 일정으로', onchange: e => { day.note = e.target.value.trim(); commit(true); }}, day.note)),
      trip.startDate ? null : h('p', {class: 'hint', style: 'margin-bottom:16px'}, '여행 시작일을 넣으면 일차마다 날짜와 요일이 붙습니다. ', h('button', {class: 'link', type: 'button', onclick: openTrip}, '시작일 넣기')),
      h('div', {class: 'group'},
        day.stops.length > 2 ? h('button', {class: 'btn', type: 'button', html: IC.sort + '<span>동선 자동 정리</span>', onclick: () => openOrder(d)}) : null,
        h('button', {class: 'btn', type: 'button', html: IC.today + '<span>이 날을 오늘 일정으로 보기</span>', onclick: () => { closeView(true); setToday(true, d); }}),
        h('p', {class: 'hint'}, '오늘 일정으로 보면 다음 장소까지 거리와 도착 예상을 보여 주고, 장소마다 도착 체크를 할 수 있습니다. 여행 날짜에는 저절로 켜집니다.')),
      trip.days.length > 1 ? h('button', {class: 'btn danger wide', type: 'button', html: IC.trash + '<span>이 날 빼기</span>', onclick: () => {
        const gone = trip.days.splice(d, 1)[0]; state.day = Math.min(d, trip.days.length - 1); state.sel = null; closeView(true); commit();
        toast((d + 1) + '일차(장소 ' + gone.stops.length + '곳)를 뺐습니다.', '되돌리기', () => { trip.days.splice(d, 0, gone); state.day = d; commit(); });
      }}) : null);
  });
}
function addDay(){
  trip.days.push({title: '', note: '', stops: []});
  state.day = trip.days.length - 1; state.sel = null; commit();
  toast((trip.days.length) + '일차를 더했습니다.', '장소 추가', () => openSearch(trip.days.length - 1));
}
function replaceTrip(t, msg){
  trip = t; state.day = trip.days.length > 1 ? -1 : 0; state.sel = null; legOpen = null;
  closeView(true); commit(); setSnap('peek');
  fitStops(trip.days.flatMap(x => x.stops));
  if (msg) toast(msg);
}
const keepWarning = () => {
  const n = trip.days.reduce((s, x) => s + x.stops.length, 0);
  return !n || confirm('지금 일정(장소 ' + n + '곳)은 지워집니다. 남겨 두려면 먼저 ‘일정 파일 내보내기’를 하세요. 계속할까요?');
};
async function loadExample(){
  if (!keepWarning()) return;
  try {
    const r = await fetch('data/example_trip.json');
    const t = sanitizeTrip(await r.json());
    if (!t) throw new Error('format');
    replaceTrip(t, '예시 일정을 불러왔습니다. 마음대로 고쳐 써도 됩니다.');
  } catch (err) { toast('예시 일정을 불러오지 못했습니다.'); }
}
async function exportTrip(){
  const name = (trip.title || 'jeju-trip').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) + '.json';
  const blob = new Blob([JSON.stringify(trip, null, 1)], {type: 'application/json'});
  try {
    const file = new File([blob], name, {type: 'application/json'});
    if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: trip.title}); return; }
  } catch (err) { if (err && err.name === 'AbortError') return; }
  const a = h('a', {href: URL.createObjectURL(blob), download: name});
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importTrip(){
  const f = h('input', {type: 'file', accept: '.json,application/json', onchange: async () => {
    try {
      const t = sanitizeTrip(JSON.parse(await f.files[0].text()));
      if (!t) throw new Error('format');
      if (keepWarning()) replaceTrip(t, '‘' + t.title + '’ 일정을 불러왔습니다.');
    } catch (err) { toast('일정 파일을 읽지 못했습니다. 이 앱에서 내보낸 JSON 파일인지 확인해 주세요.'); }
  }});
  f.click();
}
function openTrip(){
  if (countStops(trip)) makeLink().catch(() => {});          // ready before 링크로 일정 보내기 is tapped
  openView('trip', v => {
    const exag = h('input', {type: 'range', min: 1, max: 4, step: 0.1, value: state.exag}), ev = h('span', null, '×' + state.exag.toFixed(1));
    exag.addEventListener('input', () => {
      state.exag = +exag.value; ev.textContent = '×' + state.exag.toFixed(1); store.set('jejumap.exag', String(state.exag));
      if (play) stopPlay(); applyExag(); rebuildScene();
    });
    const opt = (label, key, sk) => h('label', null, h('input', {type: 'checkbox', checked: state[key], onchange: e => {
      state[key] = e.target.checked; store.set(sk, state[key] ? '1' : '0'); dirty = true; }}), label);
    // 휴대폰 앱으로 쓰기 comes first while the page is open in a browser tab (or a new version waits); inside the app it sits lower
    const appTop = !standalone() || !!pwa.waiting;
    const appSec = [h('h3', {class: 'group-h'}, '휴대폰 앱으로 쓰기'),
      h('div', {class: 'group'},
        pwa.waiting ? h('button', {class: 'btn primary', type: 'button', onclick: applyUpdate}, '새 버전으로 다시 열기') : null,
        !standalone() && pwa.install ? h('button', {class: 'btn primary', type: 'button', html: IC.open + '<span>홈 화면에 앱 설치</span>', onclick: async () => {
          const ev = pwa.install; pwa.install = null; ev.prompt(); try { await ev.userChoice; } catch (e) {} openTrip(); }}) : null,
        standalone() ? h('p', {class: 'hint'}, '홈 화면 앱으로 열려 있습니다.')
          : h('p', {class: 'hint'}, IS_IOS ? '홈 화면에 추가하면 앱처럼 열립니다. Safari의 공유 버튼 → ‘홈 화면에 추가’를 누르세요. 아이폰의 홈 화면 앱은 Safari와 저장 공간이 따로라, 추가한 뒤 ‘링크로 일정 보내기’로 일정을 옮겨 주세요.'
            : '홈 화면에 추가하면 앱처럼 열립니다. Chrome은 오른쪽 위 ⋮ → ‘설치 및 바로가기 만들기’(또는 ‘앱 설치’) → ‘설치’, 삼성 인터넷은 ≡ → ‘현재 페이지 추가’ → ‘홈 화면’을 누르세요. 이 브라우저에서 설치한 앱은 지금 일정을 그대로 씁니다. 이미 설치했다면 홈 화면의 아이콘으로 여세요.'),
        h('p', {class: 'hint'}, navigator.serviceWorker && navigator.serviceWorker.controller
          ? '앱과 섬 전체 지도 자료가 이 기기에 저장되어 있어 인터넷 없이도 열립니다(주소 검색만 인터넷이 필요합니다). 앱의 새 버전이 나오면 알려 드리고, 새 버전으로 바뀌어도 일정은 그대로 남습니다.'
          : '처음 연 뒤 잠시 지나면 앱과 지도 자료(약 7MB)가 이 기기에 저장되어, 그다음부터는 인터넷 없이도 열립니다.'))];
    put(v, vhead('여행 정보'), appTop ? appSec : null,
      field('여행 이름', h('input', {class: 'in', id: fid(), value: trip.title, maxLength: 60, onchange: e => { trip.title = e.target.value.trim() || '나의 제주 여행'; commit(true); }})),
      field('시작일', h('input', {class: 'in', id: fid(), type: 'date', value: trip.startDate, onchange: e => { trip.startDate = e.target.value; commit(true); }}),
        '날짜를 넣으면 일차마다 날짜와 요일이 붙습니다.'),
      h('div', {class: 'field'}, h('span', {class: 'lbl'}, '일수'),
        h('div', {style: 'display:flex;align-items:center;gap:12px'}, h('b', null, trip.days.length + '일'),
          h('button', {class: 'btn sm', type: 'button', html: IC.plus + '<span>하루 더하기</span>', onclick: () => { addDay(); openTrip(); }}))),
      h('label', {class: 'switch', style: 'margin-bottom:16px'}, h('span', null, h('b', null, '비행기로 오가기'),
          h('span', {class: 'hint'}, '첫 장소 앞에 제주공항 도착을, 마지막 장소 뒤에 제주공항 출발을 넣습니다. 동선 재생은 비행기로 시작하고 끝납니다.')),
        h('input', {type: 'checkbox', checked: trip.air, onchange: e => { trip.air = e.target.checked; commit(true); }})),
      h('h3', {class: 'group-h'}, '일정 보내기·받기'),
      h('div', {class: 'group'},
        h('button', {class: 'btn primary', type: 'button', html: IC.link + '<span>링크로 일정 보내기</span>', onclick: shareTrip}),
        h('button', {class: 'btn', type: 'button', html: IC.open + '<span>받은 링크로 일정 열기</span>', onclick: openPaste}),
        h('p', {class: 'hint'}, '링크 하나에 일정이 모두 담겨, 카카오톡으로 보내면 받은 사람이 눌러서 바로 엽니다. 일정은 링크 안에만 들어 있고 어느 서버에도 올라가지 않습니다. 사진과 도착 체크는 보내지 않습니다.'),
        store.get(BEFORE_KEY) ? h('button', {class: 'btn', type: 'button', onclick: restoreBefore}, '링크 받기 전 일정 다시 열기') : null,
        h('button', {class: 'btn', type: 'button', html: IC.share + '<span>일정 파일 내보내기·공유</span>', onclick: exportTrip}),
        h('button', {class: 'btn', type: 'button', html: IC.open + '<span>일정 파일 가져오기</span>', onclick: importTrip}),
        h('p', {class: 'hint'}, '일정은 이 기기의 브라우저에만 저장되고, 앱이 새 버전으로 바뀌어도 그대로 남습니다.')),
      h('h3', {class: 'group-h'}, '사진'),
      photoStats(),
      h('h3', {class: 'group-h'}, '새로 시작'),
      h('div', {class: 'group'},
        h('button', {class: 'btn', type: 'button', onclick: loadExample}, '예시 일정 불러오기 (2박 3일)'),
        h('button', {class: 'btn danger', type: 'button', onclick: () => { if (keepWarning()) replaceTrip(emptyTrip(), '빈 일정으로 시작합니다.'); }}, '빈 일정으로 새로 만들기')),
      appTop ? null : appSec,
      h('h3', {class: 'group-h'}, '지도 설정'),
      h('div', {class: 'set'}, h('label', null, '지형 높이 과장', exag, ev), opt('도로 표시', 'roads', 'jejumap.roads'), opt('건물과 나무 표시', 'bld', 'jejumap.bld'), opt('지명 표시', 'geo', 'jejumap.geo'),
        h('p', {class: 'hint'}, '지도는 끌어서 옮기고, 두 손가락으로 확대·회전합니다. 컴퓨터에서는 우클릭이나 Shift를 누른 채 끌면 회전과 기울기, 키보드는 방향키·Q/E·R/F·+/−를 씁니다.'),
        h('p', {class: 'hint'}, '경로와 이동 시간은 지도에 담긴 도로망으로 계산한 추정값입니다. 일방통행과 실시간 교통은 반영하지 않습니다.')),
      h('p', {class: 'credit'}, '지형 Mapzen Terrain Tiles (SRTM·GMTED2010·ETOPO1 등) · 도로·건물·숲·장소 © OpenStreetMap contributors (ODbL) · 주소 검색 Esri ArcGIS',
        h('br'), '앱 버전 ' + APP_VERSION + (META && META.built ? ' · 자료 ' + META.built : '') +
          (bootSec ? ' · 이번 시작 ' + bootSec + '초(자료 ' + dataSec + '초)' : '')));
  });
}

/* ---- picking a spot on the map ---- */
// the stop being moved hides its own pin, so the crosshair is the only marker
function pinShown(d, i, on){
  const q = pins.find(x => x.d === d && x.i === i);
  if (q) { q.el.style.visibility = on ? '' : 'hidden'; q.stem.visible = q.dot.visible = on; dirty = true; }
}
function startPick(p){
  state.pick = p;
  navOpen();
  if (p.mode === 'move') pinShown(p.d, p.i, false);
  if (view) { view.prevSnap = 'peek'; closeView(true); }
  setSnap('hide'); $('dock').hidden = true;
  $('pickBar').hidden = false; $('cross').hidden = false;
  $('pickText').textContent = p.mode === 'move' ? '지도를 움직여 가운데 표시를 새 위치에 맞추세요.' : '지도를 움직여 가운데 표시를 넣을 곳에 맞추세요. 지도를 누르면 그곳으로 옮겨집니다.';
  if (p.mode === 'move') flyTo(trip.days[p.d].stops[p.i]);
  else if (goal.dist > 6) goal.dist = 3;
  setOrbit(false);
}
function endPick(quiet){
  const was = state.pick;
  state.pick = null;
  if (was && was.mode === 'move') pinShown(was.d, was.i, true);
  navClose();
  $('pickBar').hidden = true; $('cross').hidden = true; $('dock').hidden = false;
  if (!quiet) { renderPanel(); setSnap('peek'); }
}
const setPick = p => p ? startPick(p) : endPick();
function pickConfirm(){
  const p = state.pick;
  if (!p) return;
  if (groundM(cam.tx, cam.tz) <= 0 && elevAt(cam.tx, cam.tz) <= 0) return toast('바다 위입니다. 가운데 표시를 섬 위로 옮겨 주세요.');
  const lat = toLat(cam.tz), lon = toLon(cam.tx);
  endPick(true);
  if (p.mode === 'move') {
    const s = trip.days[p.d].stops[p.i];
    s.lat = +lat.toFixed(5); s.lon = +lon.toFixed(5);
    commit(); openStop(p.d, p.i); toast('위치를 옮겼습니다.');
    return;
  }
  const near = nearestPlace(lat, lon, 0.12);
  addPlace({name: p.name || (near ? near.name : '지도에서 고른 곳'), lat, lon}, p.d, true);
}
// land test that also accepts low coastal cells the DEM rounds to 0 m
function elevAt(x, z){
  const i = clamp(Math.round((x + WX / 2) / WX * (GW - 1)), 0, GW - 1), j = clamp(Math.round((z + WZ / 2) / WZ * (GH - 1)), 0, GH - 1);
  return elev[j * GW + i];
}
function mapClick(e){
  if (!state.pick) return;
  const p = terrainHit(e.clientX, e.clientY);
  if (!p) return toast('지도 위를 눌러 주세요.');
  goal.tx = p.x; goal.tz = p.z;
}

/* ---- selection ---- */
function flyTo(s){
  if (me.follow) setFollow(false);
  goal.tx = toX(s.lon); goal.tz = toZ(s.lat);
  if (goal.dist > 4 || orbit) goal.dist = 1.8;      // close enough to see the streets and buildings around the stop
}
function selectStop(d, i, fly){
  if (state.pick) return;
  state.sel = {d, i};
  const dayChanged = state.day >= 0 && state.day !== d;
  if (dayChanged) state.day = d;
  if (fly) { if (play) stopPlay(); flyTo(trip.days[d].stops[i]); if (!isDesk()) setSnap('peek'); }
  applyFilter();
  if (view) renderPeek(); else renderPanel(dayChanged);
}
function selectDay(d){
  state.day = d; state.sel = null; legOpen = null;
  if (play) stopPlay();
  setOrbit(false);
  fitStops(d >= 0 ? trip.days[d].stops : trip.days.flatMap(x => x.stops));
  applyFilter(); renderPanel(true);
}
function updatePlaceCard(){ renderPeek(); }

/* ---- rendering the journal ---- */
function renderHead(animate){
  const n = trip.days.length, d = state.day, a = dayDate(0), b = dayDate(n - 1);
  const t = d >= 0 ? dayDate(d) : a, stamp = $('stamp');
  if (t) {
    stamp.children[0].textContent = (t.getMonth() + 1) + '월';
    stamp.children[1].textContent = String(t.getDate()).padStart(2, '0');
    stamp.children[2].textContent = d >= 0 ? WD[t.getDay()] + '요일' : (b && n > 1 ? '~ ' + b.getDate() + '일' : WD[t.getDay()] + '요일');
  } else {                       // no dates yet: the stamp still marks the page, waiting for a date
    stamp.children[0].textContent = '날짜';
    stamp.children[1].textContent = d >= 0 && n > 1 ? String(d + 1).padStart(2, '0') : '–';
    stamp.children[2].textContent = d >= 0 && n > 1 ? '일차' : '미정';
  }
  if (animate && !REDUCED) { stamp.classList.remove('thunk'); void stamp.offsetWidth; stamp.classList.add('thunk'); }
  const cnt = trip.days.reduce((s, x) => s + x.stops.length, 0);
  const title = $('dayTitle'), tripHead = d < 0 || n === 1;      // a one-day trip is headed by the trip itself
  title.textContent = tripHead ? trip.title : (trip.days[d].title || (d + 1) + '일차');
  title.insertAdjacentHTML('beforeend', IC.edit);
  $('titleBtn').setAttribute('aria-label', tripHead ? '여행 이름과 날짜 고치기' : (d + 1) + '일차 제목과 메모 고치기');
  $('dayMeta').textContent = !tripHead ? [(d + 1) + '일차', fmtDate(d), dayTotal(d), dayEnd(d)].filter(Boolean).join(' · ')
    : n === 1 ? [a ? fmtDate(0) : '날짜 미정 · 제목을 눌러 정하기', dayTotal(0) || cnt + '곳', dayEnd(0)].filter(Boolean).join(' · ')
    : [a ? (a.getMonth() + 1) + '월 ' + a.getDate() + '일부터' : '', n + '일', cnt + '곳'].filter(Boolean).join(' · ');
  const note = d >= 0 ? trip.days[d].note : '';
  $('dayNote').hidden = !note; $('dayNote').textContent = note;
  $('mastSub').textContent = trip.title;
  document.title = trip.title + ' · 제주 여행 지도';
}
function renderChips(){
  const box = $('dayChips'), n = trip.days.length;
  box.textContent = '';
  const chip = (d, label, sub) => h('button', {class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(state.day === d),
    style: d >= 0 ? '--c:' + dayColor(d) : null, onclick: () => selectDay(d)}, h('b', null, label), sub ? h('small', null, sub) : null);
  updateDock();
  if (n > 1) box.append(chip(-1, '전체', n + '일'));
  const td = todayIndex();
  trip.days.forEach((x, d) => box.append(chip(d, (d + 1) + '일차', d === td ? '오늘' : fmtShort(d) || x.stops.length + '곳')));
  box.append(h('button', {class: 'chip add', type: 'button', 'aria-label': '하루 더하기', html: IC.plus, onclick: addDay}));
  const cur = box.querySelector('[aria-selected="true"]');
  if (cur) cur.scrollIntoView({block: 'nearest', inline: 'nearest'});
}
function renderPeek(){
  const pk = $('peek'), s = state.sel && trip.days[state.sel.d] && trip.days[state.sel.d].stops[state.sel.i];
  pk.textContent = ''; pk.classList.remove('today');
  if (!s && !play && todayOn() && state.day === state.todayDay) return renderTodayPeek(pk);
  if (s) {
    const {d, i} = state.sel, onDay = todayOn() && state.todayDay === d;
    pk.style.setProperty('--c', dayColor(d));
    put(pk, h('span', {class: 'n'}, String(i + 1)),
      h('span', {class: 'p-txt'}, h('span', {class: 'p-main'}, s.name), h('span', {class: 'p-sub'}, [(d + 1) + '일차', s.time, s.memo].filter(Boolean).join(' · '))),
      play ? null : onDay ? h('button', {class: 'icon-btn', type: 'button', html: IC.nav, 'aria-label': s.name + '까지 길안내', title: '길안내',
        onclick: () => openNav(null, s, modeOf(s))})
      : h('button', {class: 'icon-btn', type: 'button', html: IC.play, 'aria-label': s.name + '부터 동선 재생', title: '여기부터 동선 재생',
        onclick: () => startPlay({stop: {d, i}})}),
      h('button', {class: 'btn sm', type: 'button', html: IC.edit + '<span>고치기</span>', onclick: () => openStop(d, i)}));
    return;
  }
  const total = trip.days.reduce((a, x) => a + x.stops.length, 0), d = state.day;
  if (!total) {
    put(pk, h('span', {class: 'p-txt'}, h('span', {class: 'p-main'}, '아직 넣은 장소가 없습니다'), h('span', {class: 'p-sub'}, '‘장소 추가’로 첫 장소를 넣어 보세요')),
      h('button', {class: 'btn sm', type: 'button', onclick: loadExample}, '예시 보기'));
    return;
  }
  const st = d >= 0 ? trip.days[d].stops : [];
  const main = d >= 0 ? (st.length ? st.length + '곳 · ' + st[0].name + (st.length > 1 ? ' → ' + st[st.length - 1].name : '') : '이 날은 아직 장소가 없습니다')
    : trip.days.length + '일 동안 ' + total + '곳';
  const sub = d >= 0 ? (dayTotal(d) || '장소를 2곳 이상 넣으면 길이 그려집니다') : trip.days.map((x, k) => (k + 1) + '일차 ' + x.stops.length + '곳').join(' · ');
  put(pk, h('span', {class: 'p-txt'}, h('span', {class: 'p-main'}, main), h('span', {class: 'p-sub'}, sub)),
    isDesk() ? null : h('button', {class: 'btn sm', type: 'button', onclick: () => setSnap(snap === 'peek' ? 'half' : 'peek')}, snap === 'peek' ? '목록' : '접기'));
}
function legRow(d, i, l, a, b){
  const key = d + '-' + i, open = legOpen === key;
  const wrap = h('div', {class: 'leg'});
  wrap.append(h('button', {class: 'leg-btn', type: 'button', 'aria-expanded': String(open),
    html: legIcon(l, b) + '<span>' + esc(legText(l, a, b)) + '</span>' + IC.chev.replace('class="ic"', 'class="ic chev"'),
    'aria-label': (i + 1) + '번에서 ' + (i + 2) + '번까지 ' + legText(l, a, b) + ', 이동수단 바꾸기',
    onclick: () => { legOpen = open ? null : key; renderPanel(); }}));
  if (!open) return wrap;
  wrap.append(modePicker(a, b, () => { legOpen = null; commit(); }, (i + 1) + '번에서 ' + (i + 2) + '번까지 이동수단'));
  if (l.kind === 'ferry' || l.kind === 'air') {
    const id = fid(), air = l.kind === 'air';
    wrap.append(h('div', {class: 'leg-pick'}, h('label', {class: 'hint', for: id, style: 'align-self:center'}, air ? '비행기 출발 시각' : '배 출발 시각'),
      h('input', {class: 'in', id, type: 'time', value: a.dep || '', style: 'max-width:160px', onchange: e => { a.dep = e.target.value; legOpen = null; commit(); }}),
      h('p', {class: 'leg-hint'}, (air ? '비행기로 곧게 날아가는 것으로 그렸습니다.' : b.by === 'ferry' ? '배로 곧게 건너는 것으로 그렸습니다.' : '바다를 건너는 구간이라 배편으로 계산했습니다.')
        + ' 출발 시각을 넣으면 도착 시간과 함께 보여 줍니다.')));
  } else if (l.kind === 'direct') {
    wrap.append(h('p', {class: 'leg-hint', style: 'padding:4px 0 8px'}, '두 장소가 지도의 도로로 이어지지 않아 직선으로 그렸습니다. 위치를 큰길 가까이로 옮기면 도로 경로로 바뀝니다.'));
  } else wrap.append(h('button', {class: 'btn sm leg-nav', type: 'button', html: IC.nav + '<span>이 구간 길안내 <span class="nw">(카카오맵·네이버지도)</span></span>', onclick: () => openNav(a, b, modeOf(b))}));
  return wrap;
}
function daySection(d){
  const day = trip.days[d], L = legs[d] || [], all = state.day < 0;
  const sec = h('section', {class: 'day', style: '--c:' + dayColor(d)});
  if (all) sec.append(h('div', {class: 'day-h'}, h('h2', null, (d + 1) + '일차' + (day.title ? ' · ' + day.title : '')),
      h('div', {class: 'day-h-act'},
        canPlayDay(d) ? h('button', {class: 'icon-btn', type: 'button', html: IC.play, 'aria-label': (d + 1) + '일차부터 동선 재생', title: '이 날부터 동선 재생',
          onclick: () => startPlay({days: trip.days.map((_, k) => k), day: d})}) : null,
        h('button', {class: 'btn sm', type: 'button', onclick: () => openDay(d)}, '고치기'))),
    h('p', {class: 'day-h-meta'}, [fmtDate(d), dayTotal(d), dayEnd(d)].filter(Boolean).join(' · ') || (day.stops.length ? day.stops.length + '곳' : '아직 장소가 없습니다')));
  if (!day.stops.length) {
    if (!all) sec.append(h('div', {class: 'empty'}, h('p', null, '이 날은 아직 장소가 없습니다. 아래 ‘장소 추가’로 넣어 보세요.')));
    return sec;
  }
  const ol = h('ol', {class: 'stops'}), A = airPlan;
  // the airport ends of the trip (trip.air): a row above the first stop and one below the last
  const airRow = (arrive, leg) => {
    const drive = leg ? (leg.kind === 'road' ? '공항에서 차로 약 ' + fmtMin(leg.min) : leg.kind === 'ferry' ? '배편 ' + fmtKm(leg.km) : '직선 ' + fmtKm(leg.km)) : '';
    const text = arrive ? ['비행기로 제주공항 도착', drive] : [drive && drive.replace('공항에서', '공항까지'), '제주공항에서 비행기로 출발'];
    return h('div', {class: 'air-row ' + (arrive ? 'arr' : 'dep')},
      h('button', {class: 'leg-btn', type: 'button', html: IC.plane + '<span>' + esc(text.filter(Boolean).join(' · ')) + '</span>',
        'aria-label': text.filter(Boolean).join(', ') + '. 비행기 오가기 설정 열기', onclick: openTrip}));
  };
  if (A && A.d0 === d && A.inOn && !day.stops[0].airIn) sec.append(airRow(true, A.inLeg));
  const plan = dayPlan(d), todayHere = todayOn() && state.todayDay === d;
  day.stops.forEach((s, i) => {
    const cur = !!state.sel && state.sel.d === d && state.sel.i === i, pl = plan[i], np = photosOf(s).length;
    const li = h('li', {'data-i': i});
    // on the day itself the drag handle gives its place to an arrival check
    let lead;
    if (todayHere) lead = h('button', {class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(s.done), html: IC.check,
      'aria-label': s.name + ' 도착 체크', title: s.done ? '도착 체크 풀기' : '도착 체크', onclick: () => checkIn(d, i, !s.done)});
    else {
      lead = h('span', {class: 'handle', html: IC.grip, title: '끌어서 순서 바꾸기', 'aria-hidden': 'true'});
      lead.addEventListener('pointerdown', e => sortStart(e, d, li, lead));
    }
    const memo = [s.done && todayHere ? (s.doneAt ? s.doneAt + ' 도착' : '도착') : '', s.stroll ? '걸어서 둘러보기' : '', np ? '사진 ' + np + '장' : '', s.memo].filter(Boolean).join(' · ');
    const late = pl && pl.late > 10 && !(todayHere && s.done) ? h('span', {class: 's-late'}, '넣은 시간보다 약 ' + fmtMin(pl.late) + ' 늦게 도착할 것 같아요') : null;
    put(li, h('div', {class: 'card' + (todayHere && s.done ? ' done' : ''), 'data-k': d + '-' + i, 'aria-current': cur ? 'true' : null}, lead,
        h('button', {class: 'card-main', type: 'button', onclick: () => selectStop(d, i, true)},
          h('span', {class: 'n'}, String(i + 1)),
          h('span', {class: 's-main'}, h('span', {class: 's-name'}, s.name), memo ? h('span', {class: 's-memo'}, memo) : null, late),
          s.time ? h('span', {class: 's-time'}, timeText(s))
            : i > 0 && pl ? h('span', {class: 's-time eta', title: '예상 도착 시각'}, '~' + clock(pl.eta)) : null),
        h('button', {class: 'icon-btn', type: 'button', html: IC.edit, 'aria-label': s.name + ' 고치기', title: '고치기', onclick: () => openStop(d, i)}),
        h('button', {class: 'icon-btn del', type: 'button', html: IC.trash, 'aria-label': s.name + ' 삭제', title: '삭제', onclick: () => askRemove(d, i)})),
      L[i] ? legRow(d, i, L[i], s, day.stops[i + 1]) : null);
    ol.append(li);
  });
  sec.append(ol);
  const last = day.stops[day.stops.length - 1];
  if (A && A.d1 === d && A.outOn && !last.airOut) sec.append(airRow(false, A.outLeg));
  if (day.stops.length > 1) sec.append(h('div', {class: 'day-tools'},
    day.stops.length > 2 ? h('button', {class: 'btn sm', type: 'button', html: IC.sort + '<span>동선 자동 정리</span>', onclick: () => openOrder(d)}) : null,
    h('p', {class: 'hint'}, '~ 시각은 ' + (day.stops[0].time ? day.stops[0].time : '9시') + ' 출발에 이동 시간과 머무는 시간을 더한 예상 도착입니다.')));
  return sec;
}
function renderPanel(animate){
  if (view) return;
  renderHead(animate); renderChips(); renderPeek(); playUi();
  const list = $('list');
  list.textContent = '';
  const total = trip.days.reduce((s, x) => s + x.stops.length, 0);
  if (!total) {
    list.append(h('div', {class: 'empty'},
      h('p', null, '가고 싶은 곳을 넣으면 실제 도로를 따라 길이 그려지고, 동선 재생으로 하루를 미리 볼 수 있습니다.'),
      h('div', {class: 'row'}, h('button', {class: 'btn sm', type: 'button', onclick: () => openSearch()}, '장소 찾기'),
        h('button', {class: 'btn sm', type: 'button', onclick: loadExample}, '예시 일정 둘러보기'),
        h('button', {class: 'btn sm', type: 'button', onclick: openTrip}, '여행 날짜 정하기'))));
    return;
  }
  for (const d of (state.day >= 0 ? [state.day] : trip.days.map((_, i) => i))) list.append(daySection(d));
  const cur = list.querySelector('.card[aria-current="true"]');
  if (cur && (isDesk() || snap !== 'peek')) cur.scrollIntoView({block: 'nearest'});
}
function renderPanelSafe(){ try { legs = trip.days.map(() => []); renderPanel(false); } catch (e) {} }

/* ---- drag a stop by its handle to reorder the day ---- */
// The dragged row itself never moves in the DOM (that would drop its pointer capture); its neighbours hop over it.
let sort = null;
function sortStart(e, d, li, handle){
  if (e.button > 0 || sort) return;
  e.preventDefault();
  const ol = li.parentNode, top0 = li.getBoundingClientRect().top;
  ol.classList.add('sorting'); li.classList.add('lifted');            // legs fold away while sorting
  sort = {d, li, ol, id: e.pointerId, y0: e.clientY, st0: scroller.scrollTop, shift: 0, y: e.clientY,
          base: top0 - li.getBoundingClientRect().top};                 // keeps the row under the finger after the fold
  try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  addEventListener('pointermove', sortMove);
  addEventListener('pointerup', sortEnd);
  addEventListener('pointercancel', sortEnd);
  sort.timer = setInterval(sortScroll, 16);
  sortPlace();
}
function sortPlace(){
  const s = sort, next = s.li.nextElementSibling, prev = s.li.previousElementSibling;
  if (next) { const r = next.getBoundingClientRect(); if (s.y > r.top + r.height / 2) { s.ol.insertBefore(next, s.li); s.shift += r.height; } }
  if (prev) { const r = prev.getBoundingClientRect(); if (s.y < r.top + r.height / 2) { s.ol.insertBefore(prev, s.li.nextSibling); s.shift -= r.height; } }
  s.li.style.transform = 'translateY(' + (s.base + s.y - s.y0 + scroller.scrollTop - s.st0 - s.shift) + 'px)';
}
function sortMove(e){ if (sort && e.pointerId === sort.id) { sort.y = e.clientY; sortPlace(); } }
function sortScroll(){
  if (!sort) return;
  const r = scroller.getBoundingClientRect(), edge = sort.y < r.top + 48 ? -1 : sort.y > r.bottom - 120 ? 1 : 0;
  if (edge) { scroller.scrollTop += edge * 8; sortPlace(); }
}
function sortEnd(e){
  if (!sort || e.pointerId !== sort.id) return;
  const s = sort; sort = null; clearInterval(s.timer);
  removeEventListener('pointermove', sortMove); removeEventListener('pointerup', sortEnd); removeEventListener('pointercancel', sortEnd);
  s.li.style.transform = ''; s.li.classList.remove('lifted'); s.ol.classList.remove('sorting');
  const order = [...s.ol.children].map(x => +x.dataset.i), day = trip.days[s.d];
  if (order.every((v, k) => v === k)) { renderPanel(); return; }
  const sel = state.sel && state.sel.d === s.d ? day.stops[state.sel.i] : null;
  day.stops = order.map(k => day.stops[k]);
  if (sel) state.sel = {d: s.d, i: day.stops.indexOf(sel)};
  legOpen = null; commit();
  toast('순서를 바꿨습니다. 길을 다시 그렸습니다.');
}

/* ================= arrival estimates ================= */
// Each stop's arrival: the first stop's time (or 9:00), then the drive from the stop before plus the time spent there.
// A stop with its own time waits for it when early; arriving later than that time is a delay worth showing.
const clock = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const nowMin = () => { const t = new Date(); return t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60; };
const STAY_BY = [[/공항|여객터미널|항구|렌터카|주유소|충전소|주차장|버스터미널|안내소|편의점|마트|약국|은행|ATM|우체국|화장실|숙소|캠핑장/, 30],
  [/테마파크|박물관|미술관|동물원|아쿠아리움/, 120], [/오름·봉우리|동굴|숲|계곡/, 90]];
const stayCache = new Map();
function defaultStay(s){                  // minutes, by the kind of place found at the stop
  if (/공항|렌터카|터미널/.test(s.name)) return 30;
  const k = s.lat.toFixed(4) + ',' + s.lon.toFixed(4);
  if (!stayCache.has(k)) {
    const p = nearestPlace(s.lat, s.lon, 0.12), c = p ? CATS[p.cat] : '';
    let m = 60; for (const [re, v] of STAY_BY) if (re.test(c)) { m = v; break; }
    stayCache.set(k, m);
  }
  return stayCache.get(k);
}
const stayOf = s => s.stay != null ? s.stay : defaultStay(s);
function dayPlan(d){
  const st = trip.days[d] ? trip.days[d].stops : [];
  // a day that starts at a stop without a time (the hotel, say) leaves it in time for the first stop that has one,
  // so an early start (a sunrise, a morning boat) is not flagged late; with no times at all the day starts at 9:00
  const k = st.length && !st[0].time ? st.findIndex(s => s.time) : -1;
  return planFrom(d, k > 0 ? clamp(toMin(st[k].time) - planFrom(d, 0)[k].eta, 0, 1439) : 540);
}
function planFrom(d, start){
  const st = trip.days[d] ? trip.days[d].stops : [], L = legs[d] || [], out = [];
  let t = 0;
  st.forEach((s, i) => {
    let eta = s.time ? toMin(s.time) : start;
    if (i > 0) {
      const l = L[i - 1];
      let m = l ? legMin(l, s) : 0;
      if (m == null) m = crossMin(l);
      eta = t + m;
    }
    const plan = s.time ? toMin(s.time) : null, late = plan != null && i > 0 ? Math.round(eta - plan) : 0;
    const arr = plan != null ? Math.max(eta, plan) : eta;
    t = s.dep ? Math.max(arr, toMin(s.dep)) : arr + stayOf(s);
    out.push({eta, arr, late});
  });
  return out;
}
const dayEnd = d => { const st = trip.days[d] ? trip.days[d].stops : []; if (st.length < 2) return ''; const p = dayPlan(d); return '마지막 도착 ~' + clock(p[p.length - 1].arr); };
function saveTrip(){ if (!store.set(TRIP_KEY, JSON.stringify(trip))) toast('이 브라우저에 일정을 저장하지 못했습니다. 개인정보 보호 모드인지 확인해 주세요.'); }
const countStops = t => t.days.reduce((a, x) => a + x.stops.length, 0);

/* ================= today: the day of the trip that is today ================= */
// During the trip the app opens on today's day: the next stop sits in the peek line with the distance from the phone,
// and each stop can be checked off on arrival. Without dates, a day can be picked as 'today' from its editor.
function todayIndex(){
  const a = dayDate(0);
  if (!a) return -1;
  const n = new Date(), k = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - a) / 864e5);
  return k >= 0 && k < trip.days.length ? k : -1;
}
const todayOn = () => state.today && !!trip.days[state.todayDay];
const btnToday = $('btnToday');
function updateDock(){
  btnToday.hidden = !todayOn() && todayIndex() < 0;
  $('dock').classList.toggle('three', !btnToday.hidden);       // three buttons: tighter, so they fit a 360 px phone
  btnToday.setAttribute('aria-pressed', String(todayOn()));
  btnToday.setAttribute('aria-label', todayOn() ? '오늘 일정 보기 끄기' : '오늘 일정 보기');
}
function setToday(on, d){
  if (on) {
    state.today = true; state.todayDay = d != null ? d : Math.max(0, todayIndex());
    state.day = state.todayDay; state.sel = null; legOpen = null;
    if (play) stopPlay();
    setOrbit(false); applyFilter(); renderPanel(true);
    if (!isDesk() && snap !== 'half') setSnap('half');
    if (me.fix) centerMe(); else fitStops(trip.days[state.day].stops);
    if (me.watch == null && navigator.geolocation && window.isSecureContext) startLoc(false);
  } else { state.today = false; renderPanel(); }
  updateDock();
}
btnToday.innerHTML = IC.today + '<span>오늘</span>';
btnToday.addEventListener('click', () => setToday(!todayOn()));
function checkIn(d, i, on){
  const s = trip.days[d] && trip.days[d].stops[i];
  if (!s) return;
  s.done = on; s.doneAt = on ? clock(nowMin()) : '';
  saveTrip();
  if (state.sel && state.sel.d === d && state.sel.i === i) state.sel = null;
  me.route = null; renderPanel();
  if (me.fix) meMoved();
  if (!on) return;
  const nx = trip.days[d].stops.find(x => !x.done);
  toast('‘' + s.name + '’ 도착 체크했습니다.' + (nx ? ' 다음은 ‘' + nx.name + '’입니다.' : ' 오늘 일정을 모두 마쳤습니다.'), '되돌리기', () => checkIn(d, i, false));
}
function renderTodayPeek(pk){
  const d = state.todayDay, st = trip.days[d].stops, k = st.findIndex(s => !s.done);
  pk.classList.add('today'); pk.style.setProperty('--c', dayColor(d));
  const badge = h('span', {class: 'p-badge'}, '오늘');
  if (!st.length) return put(pk, badge, h('span', {class: 'p-txt'}, h('span', {class: 'p-main'}, '오늘 일정에 장소가 없습니다'), h('span', {class: 'p-sub'}, '‘장소 추가’로 넣어 보세요')));
  if (k < 0) return put(pk, badge, h('span', {class: 'p-txt'}, h('span', {class: 'p-main'}, '오늘 일정을 모두 마쳤습니다'), h('span', {class: 'p-sub'}, st.length + '곳 모두 도착 체크 · 즐거운 하루였기를')));
  const s = st[k];
  badge.textContent = '다음';
  put(pk, badge, h('span', {class: 'n'}, String(k + 1)),
    h('span', {class: 'p-txt'}, h('span', {class: 'p-main'}, s.name), h('span', {class: 'p-sub', id: 'nextInfo'}, nextText(d, k))),
    h('div', {class: 'p-act'},
      h('button', {class: 'btn sm', type: 'button', html: IC.check + '<span>도착 체크</span>', 'aria-label': s.name + ' 도착 체크', onclick: () => checkIn(d, k, true)}),
      h('button', {class: 'btn sm', type: 'button', html: IC.nav + '<span>길안내</span>', 'aria-label': s.name + '까지 길안내', onclick: () => openNav(null, s, modeOf(s))})));
}
function nextText(d, k){
  const s = trip.days[d].stops[k], r = me.route;
  if (me.fix && r && r.id === s.id) {
    const l = r.leg, m = legMin(l, s), parts = ['여기서 ' + fmtKm(l.kind === 'road' ? l.km : hav(me.fix, s))];
    if (m != null) {
      const arr = nowMin() + m;
      parts.push(MODES.find(x => x.id === roadMode(s)).label + ' 약 ' + fmtMin(m), clock(arr) + '쯤 도착');
      if (s.time) { const late = Math.round(arr - toMin(s.time)); if (late > 10) parts.push('예정보다 ' + fmtMin(late) + ' 늦음'); else if (late < -10) parts.push('예정보다 ' + fmtMin(-late) + ' 일찍'); }
    } else parts.push(l.kind === 'ferry' ? '배로 건너는 곳' : '도로로 이어지지 않음');
    return parts.join(' · ');
  }
  if (me.watch != null && !me.fix) return '내 위치를 찾는 중…';
  const p = dayPlan(d)[k];
  return [s.time ? s.time + ' 도착 예정' : k > 0 && p ? '~' + clock(p.eta) + ' 도착 예상' : '', '내 위치를 켜면 남은 거리를 알려 드려요'].filter(Boolean).join(' · ');
}
function refreshNext(){
  const el = $('nextInfo');
  if (!el || !todayOn()) return;
  const k = trip.days[state.todayDay].stops.findIndex(s => !s.done);
  if (k >= 0) el.textContent = nextText(state.todayDay, k);
}

/* ================= my location ================= */
// The phone's position as a dot on the map (with its accuracy ring). The first tap finds it and follows it; dragging
// the map stops following; a tap while not following comes back to it; a tap while following turns it off.
const me = {watch: null, fix: null, follow: false, want: false, el: null, out: false, route: null, near: new Set()};
function locTap(){
  if (!navigator.geolocation || !window.isSecureContext) return toast('이 브라우저에서는 위치를 쓸 수 없습니다.');
  if (me.watch == null) return startLoc(true);
  if (!me.fix) { me.want = true; return toast('내 위치를 찾는 중입니다…'); }
  if (!me.follow) { setFollow(true); centerMe(); return; }
  stopLoc(); toast('내 위치 표시를 껐습니다.');
}
function startLoc(center){
  me.want = center; me.out = false;
  btnLoc.classList.add('busy'); btnLoc.setAttribute('aria-pressed', 'true');
  if (center) toast('내 위치를 찾는 중…', null, null, 2500);
  try { me.watch = navigator.geolocation.watchPosition(onFix, onLocErr, {enableHighAccuracy: true, maximumAge: 10000, timeout: 30000}); }
  catch (e) { me.watch = null; btnLoc.classList.remove('busy'); btnLoc.setAttribute('aria-pressed', 'false'); }
}
function stopLoc(){
  if (me.watch != null) try { navigator.geolocation.clearWatch(me.watch); } catch (e) {}
  me.watch = null; me.fix = null; me.route = null; me.want = false;
  setFollow(false);
  btnLoc.classList.remove('busy'); btnLoc.setAttribute('aria-pressed', 'false');
  refreshNext(); dirty = true;
}
function onFix(p){
  const c = p.coords;
  btnLoc.classList.remove('busy');
  if (!inBox(c.latitude, c.longitude)) {
    if (!me.out) toast('지금 위치가 제주 밖이라 지도에 표시하지 않습니다. 제주에 도착한 뒤 다시 눌러 주세요.', null, null, 5000);
    me.out = true; stopLoc(); return;
  }
  me.fix = {lat: c.latitude, lon: c.longitude, acc: c.accuracy || 50, t: Date.now()};
  if (me.want) { me.want = false; setFollow(true); centerMe(); }
  else if (me.follow && !(play && !play.paused)) { goal.tx = toX(me.fix.lon); goal.tz = toZ(me.fix.lat); }
  dirty = true;
  meMoved();
}
function onLocErr(e){
  btnLoc.classList.remove('busy');
  if (e.code === 1) { stopLoc(); toast('위치 권한이 꺼져 있습니다. 브라우저나 휴대폰 설정에서 이 사이트의 위치 사용을 허용해 주세요.', null, null, 6000); }
  else if (!me.fix) toast('위치를 아직 찾지 못했습니다. 하늘이 트인 곳에서 잠시 기다려 주세요.');
}
function setFollow(on){
  me.follow = on;
  btnLoc.classList.toggle('follow', on);
  btnLoc.setAttribute('aria-label', me.watch == null ? '내 위치' : on ? '내 위치 표시 끄기' : '내 위치로 가기');
}
function centerMe(){
  if (!me.fix) return;
  if (play) stopPlay();
  setOrbit(false);
  goal.tx = toX(me.fix.lon); goal.tz = toZ(me.fix.lat);
  if (goal.dist > 6) goal.dist = 2.4;
}
function placeMe(W, H){
  if (!me.fix) { if (me.el) me.el.hidden = true; return; }
  if (!me.el) { me.el = h('div', {class: 'me'}, h('i', {class: 'acc'}), h('i', {class: 'dot'})); labelsEl.append(me.el); }
  const x = toX(me.fix.lon), z = toZ(me.fix.lat);
  tmp.set(x, groundY(x, z), z).project(camera);
  const on = tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
  me.el.hidden = !on;
  if (!on) return;
  me.el.style.transform = 'translate(' + ((tmp.x * 0.5 + 0.5) * W).toFixed(1) + 'px,' + ((-tmp.y * 0.5 + 0.5) * H).toFixed(1) + 'px)';
  me.el.style.setProperty('--acc', clamp(me.fix.acc / 500 / (cam.dist * pxScale), 0, 600).toFixed(0) + 'px');
}
// today: the drive from here to the next stop (again after 100 m, a new next stop, or 30 s), and an offer to check in
function meMoved(){
  if (!todayOn() || !me.fix) return;
  const d = state.todayDay, st = trip.days[d].stops, k = st.findIndex(s => !s.done);
  if (k < 0) return;
  const s = st[k];
  if (hav(me.fix, s) < 0.15 && me.fix.acc < 150 && !me.near.has(s.id)) {
    me.near.add(s.id);
    toast('‘' + s.name + '’ 근처에 왔습니다.', '도착 체크', () => checkIn(d, k, true), 12000);
  }
  const r = me.route, now = Date.now();
  if (!r || r.id !== s.id || hav(r.from, me.fix) > 0.1 || now - r.t > 30000) {
    const from = {lat: me.fix.lat, lon: me.fix.lon};
    me.route = {id: s.id, from, t: now, leg: routeLeg(from, s, true)};
  }
  refreshNext();
}

/* ================= directions in Kakao Map / Naver Map ================= */
// Kakao: its documented web links (map.kakao.com/link/by/{car|traffic|walk}/A/B, or /link/to/B from where the phone is);
// they open the Kakao Map app when it is installed. Naver: its app scheme (nmap://route/{car|public|walk}), through an
// Android intent that falls back to the Play Store, or on iPhone the App Store when the app does not answer.
const UA = navigator.userAgent, IS_ANDROID = /Android/i.test(UA), IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const navNm = s => String(s.name || '목적지').replace(/[,/\\#?%]+/g, ' ').trim().slice(0, 40) || '목적지';
const kakaoPt = s => encodeURIComponent(navNm(s)) + ',' + (+s.lat).toFixed(6) + ',' + (+s.lon).toFixed(6);
function kakaoUrl(a, b, mode){
  return a ? 'https://map.kakao.com/link/by/' + ({bus: 'traffic', walk: 'walk', bike: 'bicycle'}[mode] || 'car') + '/' + kakaoPt(a) + '/' + kakaoPt(b)
    : 'https://map.kakao.com/link/to/' + kakaoPt(b);
}
function naverPath(a, b, mode){
  const q = a ? {slat: (+a.lat).toFixed(6), slng: (+a.lon).toFixed(6), sname: navNm(a)} : {};
  Object.assign(q, {dlat: (+b.lat).toFixed(6), dlng: (+b.lon).toFixed(6), dname: navNm(b), appname: location.origin + location.pathname});
  return 'route/' + ({bus: 'public', walk: 'walk', bike: 'bicycle'}[mode] || 'car') + '?' + Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
}
function naverOpen(a, b, mode){
  const path = naverPath(a, b, mode);
  if (IS_ANDROID) location.href = 'intent://' + path + '#Intent;scheme=nmap;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.nhn.android.nmap;end';
  else if (IS_IOS) {
    const t0 = Date.now();
    location.href = 'nmap://' + path;
    setTimeout(() => { if (!document.hidden && Date.now() - t0 < 2500) location.href = 'https://apps.apple.com/app/id311867728'; }, 1500);
  } else toast('네이버지도 길안내는 휴대폰의 네이버지도 앱에서 열립니다. 컴퓨터에서는 카카오맵을 써 주세요.', null, null, 5000);
}
// a = null: from wherever the phone is (the map app finds it)
function openNav(a, b, mode){
  if (mode === 'ferry' || mode === 'plane') mode = 'car';        // map apps route roads only
  ask('어느 지도로 길안내를 열까요?', (a ? a.name : '내 위치') + ' → ' + b.name + ({bus: ' (대중교통)', walk: ' (도보)', bike: ' (자전거)'}[mode] || ' (자동차)'),
    '카카오맵', () => window.open(kakaoUrl(a, b, mode), '_blank', 'noopener'), {label: '네이버지도', fn: () => naverOpen(a, b, mode)});
}

/* ================= reordering a day (shortest drive) ================= */
// All pairs of driving minutes (one Dijkstra per stop, a pause between them so the screen stays alive), then the best
// order with the first stop fixed (and the last, if asked): exact for up to 13 stops, 2-opt and single moves beyond.
async function costMatrix(stops, live){
  const n = stops.length, M = [], K = [];
  const sn = stops.map(s => { const x = toX(s.lon), z = toZ(s.lat), id = G ? snapNode(x, z) : -1; return {id, off: id >= 0 ? Math.hypot(G.x[id] - x, G.z[id] - z) : 0}; });
  for (let i = 0; i < n; i++) {
    await new Promise(r => setTimeout(r, 0));
    if (live && !live()) return null;
    const a = sn[i], tg = sn.map((b, j) => a.id >= 0 && j !== i && b.id >= 0 && G.comp[b.id] === G.comp[a.id] ? b.id : -1);
    const ids = [...new Set(tg.filter(v => v >= 0))], res = ids.length ? roadFrom(a.id, ids) : [], got = new Map(ids.map((v, q) => [v, res[q]]));
    M.push(new Float64Array(n)); K.push(new Float64Array(n));
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const r = tg[j] >= 0 ? got.get(tg[j]) : null, walk = a.off + sn[j].off;
      if (r && isFinite(r.h)) { M[i][j] = (r.h + walk / 15) * 60 * 1.15; K[i][j] = r.km + walk; }
      else { const km = hav(stops[i], stops[j]); K[i][j] = km; M[i][j] = km / 25 * 60 + 40; }   // a ferry or a gap in the roads
    }
  }
  return {M, K};
}
const pathCost = (M, p) => { let c = 0; for (let k = 1; k < p.length; k++) c += M[p[k - 1]][p[k]]; return c; };
function bestOrder(M, fixLast){
  const n = M.length, free = [];
  for (let i = 1; i < n - (fixLast ? 1 : 0); i++) free.push(i);
  const m = free.length, tail = fixLast ? [n - 1] : [];
  if (m <= 1) return [...Array(n).keys()];
  if (m <= 12) {                                           // Held-Karp over the free stops
    const S = 1 << m, dp = new Float64Array(S * m).fill(Infinity), par = new Int8Array(S * m).fill(-1);
    for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = M[0][free[j]];
    for (let s = 1; s < S; s++) for (let j = 0; j < m; j++) {
      const v = dp[s * m + j];
      if (!(s >> j & 1) || v === Infinity) continue;
      for (let q = 0; q < m; q++) if (!(s >> q & 1)) {
        const ns = s | 1 << q, c = v + M[free[j]][free[q]];
        if (c < dp[ns * m + q]) { dp[ns * m + q] = c; par[ns * m + q] = j; }
      }
    }
    const full = S - 1; let bj = 0, bc = Infinity;
    for (let j = 0; j < m; j++) { const c = dp[full * m + j] + (fixLast ? M[free[j]][n - 1] : 0); if (c < bc) { bc = c; bj = j; } }
    const seq = [];
    for (let s = full, j = bj; j >= 0;) { seq.push(free[j]); const pj = par[s * m + j]; s &= ~(1 << j); j = pj; }
    return [0, ...seq.reverse(), ...tail];
  }
  let p = [0];
  const left = new Set(free);
  while (left.size) { const u = p[p.length - 1]; let b = -1; for (const v of left) if (b < 0 || M[u][v] < M[u][b]) b = v; p.push(b); left.delete(b); }
  p = p.concat(tail);
  const lo = 1, hi = p.length - 1 - tail.length;
  let best = pathCost(M, p), better = true, guard = 0;
  while (better && guard++ < 50) {
    better = false;
    for (let i = lo; i < hi; i++) for (let j = i + 1; j <= hi; j++) {
      const q = p.slice(0, i).concat(p.slice(i, j + 1).reverse(), p.slice(j + 1)), c = pathCost(M, q);
      if (c < best - 1e-6) { p = q; best = c; better = true; }
    }
    for (let i = lo; i <= hi; i++) for (let j = lo; j <= hi; j++) {
      if (i === j) continue;
      const q = p.slice(), v = q.splice(i, 1)[0]; q.splice(j, 0, v);
      const c = pathCost(M, q);
      if (c < best - 1e-6) { p = q; best = c; better = true; }
    }
  }
  return p;
}
// a day that ends where it started, or at a place to sleep or fly from, keeps its last stop
function guessFixLast(st){
  const a = st[0], b = st[st.length - 1];
  if (hav(a, b) < 0.4 || /숙소|호텔|리조트|펜션|게스트|민박|스테이|공항|하우스|콘도/.test(b.name)) return true;
  const p = nearestPlace(b.lat, b.lon, 0.1);
  return !!p && /숙소|캠핑장|공항/.test(CATS[p.cat]);
}
async function openOrder(d){
  const day = trip.days[d];
  if (!day || day.stops.length < 3) return toast('장소가 3곳 이상일 때 순서를 정리할 수 있습니다.');
  const stops = day.stops.slice(), token = {};
  let fix = guessFixLast(stops), body;
  openView('order', v => {
    view.token = token;
    body = h('div', {'aria-live': 'polite'}, h('p', {class: 'hint'}, '길을 계산하는 중…'));
    put(v, vhead((d + 1) + '일차 동선 자동 정리'),
      h('p', {class: 'hint', style: 'margin-bottom:14px'}, '이동 시간이 가장 짧은 순서를 찾습니다. 첫 장소(' + stops[0].name + ')는 출발지로 그대로 둡니다.'), body);
  });
  const live = () => !!view && view.token === token;
  const C = await costMatrix(stops, live);
  if (!C || !live()) return;
  const draw = () => {
    const ord = bestOrder(C.M, fix), id = stops.map((_, k) => k);
    const cur = pathCost(C.M, id), nw = pathCost(C.M, ord), gain = cur - nw, same = ord.every((v, k) => v === k) || gain < 1;
    body.textContent = '';
    put(body,
      h('label', {class: 'switch', style: 'margin-bottom:14px'},
        h('span', null, h('b', null, '마지막 장소도 그대로 두기'), h('span', {class: 'hint'}, '숙소처럼 하루를 마칠 곳이 정해져 있으면 켜 두세요.')),
        h('input', {type: 'checkbox', checked: fix, onchange: e => { fix = e.target.checked; draw(); }})),
      h('div', {class: 'cmp'},
        h('div', null, h('span', {class: 'lbl'}, '지금 순서'), h('b', null, '약 ' + fmtMin(cur)), h('span', null, fmtKm(pathCost(C.K, id)))),
        h('div', {class: same ? '' : 'win'}, h('span', {class: 'lbl'}, '정리한 순서'), h('b', null, '약 ' + fmtMin(nw)), h('span', null, fmtKm(pathCost(C.K, ord))))),
      h('p', {class: same ? 'hint gain' : 'gain'}, same ? '지금 순서가 이미 가장 짧습니다.' : '이동 시간이 약 ' + fmtMin(gain) + ' 줄어듭니다.'),
      h('ol', {class: 'order-list', style: '--c:' + dayColor(d)}, ord.map((k, pos) => h('li', {class: k !== pos ? 'moved' : null},
        h('span', {class: 'n'}, String(pos + 1)), h('span', {class: 'o-name'}, stops[k].name), k !== pos ? h('span', {class: 'o-was'}, '원래 ' + (k + 1) + '번') : null))),
      h('p', {class: 'hint', style: 'margin:10px 0'}, '자동차로 계산한 추정 시간입니다.' + (stops.some(s => s.time) ? ' 시간을 넣은 장소는 시간과 함께 옮겨지니, 바꾼 뒤 예상 도착 시각을 확인해 주세요.' : '')),
      h('div', {class: 'row2', style: 'margin-top:8px'},
        h('button', {class: 'btn', type: 'button', onclick: () => closeView()}, '그대로 두기'),
        h('button', {class: 'btn primary', type: 'button', disabled: same, onclick: () => applyOrder(d, stops, ord, gain)}, '이 순서로 바꾸기')));
  };
  draw();
}
function applyOrder(d, stops, ord, gain){
  const day = trip.days[d];
  if (!day || day.stops.length !== stops.length || day.stops.some((s, k) => s !== stops[k])) { toast('그사이 일정이 바뀌어 다시 계산합니다.'); return openOrder(d); }
  const old = day.stops.slice();
  day.stops = ord.map(k => old[k]);
  state.sel = null; legOpen = null;
  closeView(true); commit(); setSnap('half');
  toast('동선을 정리했습니다. 이동 시간이 약 ' + fmtMin(gain) + ' 줄었습니다.', '되돌리기', () => { trip.days[d].stops = old; commit(); });
}

/* ================= sending a trip as a link ================= */
// The whole trip rides in the link's #fragment, compressed and base64url-encoded. Browsers never send the fragment to
// the server, so the itinerary goes from phone to phone (through the chat app) and nowhere else. Check marks stay home.
const LINK_KEY = 'trip=', BEFORE_KEY = 'jejumap.trip.beforeLink';
const b64u = {
  enc(b){ let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(s){ s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return b64bytes(s); }
};
const streamBytes = async (bytes, t) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(t)).arrayBuffer());
async function packTrip(t){
  const o = JSON.parse(JSON.stringify(t));
  for (const d of o.days) for (const s of d.stops) { delete s.done; delete s.doneAt; }
  let json = JSON.stringify(o);
  if (json.length > 30000) { for (const d of o.days) for (const s of d.stops) { delete s.walk; delete s.airIn; delete s.airOut; } json = JSON.stringify(o); }
  const raw = new TextEncoder().encode(json);
  if (window.CompressionStream) try { return 'z' + b64u.enc(await streamBytes(raw, new CompressionStream('deflate'))); } catch (e) {}
  return 'j' + b64u.enc(raw);
}
async function unpackTrip(code){
  let raw = b64u.dec(code.slice(1));
  if (code[0] === 'z') raw = await streamBytes(raw, new DecompressionStream('deflate'));
  else if (code[0] !== 'j') throw new Error('format');
  return sanitizeTrip(JSON.parse(new TextDecoder().decode(raw)));
}
const linkCode = s => { const m = /trip=([zj][A-Za-z0-9_-]{8,})/.exec(String(s || '')); return m ? m[1] : ''; };
// Safari wants the share sheet opened right in the tap, so the link is made beforehand (when 여행 정보 opens)
let shareCache = null;
async function makeLink(){
  const key = JSON.stringify(trip);
  if (!shareCache || shareCache.key !== key) shareCache = {key, url: location.origin + location.pathname + '#' + LINK_KEY + await packTrip(trip)};
  return shareCache.url;
}
async function shareTrip(){
  const n = countStops(trip);
  if (!n) return toast('보낼 장소가 아직 없습니다.');
  let url;
  try { url = shareCache && shareCache.key === JSON.stringify(trip) ? shareCache.url : await makeLink(); }
  catch (e) { return toast('링크를 만들지 못했습니다.'); }
  const text = '제주 여행 일정 ‘' + trip.title + '’ (' + trip.days.length + '일, ' + n + '곳)';
  if (navigator.share) {
    try { await navigator.share({title: trip.title, text, url}); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('일정 링크를 복사했습니다. 카카오톡이나 문자에 붙여 넣어 보내세요.', null, null, 5000); }
  catch (e) { openLinkText(url); }
}
function openLinkText(url){
  openView('link', v => {
    const ta = h('textarea', {class: 'in', id: fid(), rows: 5, readOnly: true}, url);
    put(v, vhead('일정 링크', openTrip), h('p', {class: 'hint', style: 'margin-bottom:12px'}, '아래 링크를 길게 눌러 전부 복사한 뒤 보내 주세요.'), field('링크', ta));
    setTimeout(() => ta.select(), 50);
  });
}
async function receiveLink(code, src){
  let t = null;
  try { t = await unpackTrip(code); } catch (e) {}
  if (!t) return toast('일정 링크를 읽지 못했습니다. 링크가 잘리지 않고 전부 복사됐는지 확인해 주세요.', null, null, 6000);
  const n = countStops(t), mine = countStops(trip);
  const sig = x => x.title + JSON.stringify(x.days.map(d => d.stops.map(s => [s.name, s.lat, s.lon, s.time])));
  if (mine && sig(t) === sig(trip)) return toast('받은 일정과 같은 일정이 이미 열려 있습니다.');
  const open = () => {
    const old = trip;
    if (mine) store.set(BEFORE_KEY, JSON.stringify(old));
    replaceTrip(t);
    // KakaoTalk's own browser keeps its own storage: the trip belongs in the phone's browser, where the app lives
    if (/KAKAOTALK/i.test(UA) && src) toast('카카오톡 안에서 열렸습니다. 앱에 저장하려면 기본 브라우저로 여세요.', '브라우저로 열기',
      () => { location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(src); }, 15000);
    else toast('받은 일정 ‘' + t.title + '’' + josa(t.title, '을', '를') + ' 열었습니다.', mine ? '되돌리기' : null, mine ? () => replaceTrip(old, '전에 쓰던 일정으로 되돌렸습니다.') : null, 8000);
  };
  if (!mine) return open();
  ask('받은 일정을 열까요?', '‘' + t.title + '’ · ' + t.days.length + '일 · 장소 ' + n + '곳. 지금 일정(장소 ' + mine + '곳)은 이 기기에 보관해 두고, 여행 정보에서 다시 열 수 있습니다.', '열기', open);
}
function restoreBefore(){
  let t = null;
  try { t = sanitizeTrip(JSON.parse(store.get(BEFORE_KEY))); } catch (e) {}
  if (!t) return toast('보관한 일정을 읽지 못했습니다.');
  store.set(BEFORE_KEY, JSON.stringify(trip));          // a swap: the trip open now is kept in its place
  replaceTrip(t, '‘' + t.title + '’' + josa(t.title, '을', '를') + ' 다시 열었습니다. 방금 일정은 보관해 두었습니다.');
}
function openPaste(){
  openView('paste', v => {
    const ta = h('textarea', {class: 'in', id: fid(), rows: 4, placeholder: '받은 일정 링크를 여기에 붙여 넣으세요', spellcheck: false, autocomplete: 'off'});
    const go = () => {
      const c = linkCode(ta.value);
      if (!c) return toast('링크에서 일정을 찾지 못했습니다. ‘#trip=’이 들어 있는 링크 전체를 붙여 넣어 주세요.', null, null, 5000);
      closeView(); receiveLink(c);
    };
    put(v, vhead('받은 링크로 일정 열기', openTrip),
      h('p', {class: 'hint', style: 'margin-bottom:12px'}, '카카오톡 등으로 받은 일정 링크를 붙여 넣으면 이 앱에서 엽니다. 아이폰 홈 화면 앱처럼 링크를 눌러도 앱으로 바로 열리지 않을 때 쓰세요.'),
      field('일정 링크', ta),
      navigator.clipboard && navigator.clipboard.readText ? h('button', {class: 'btn wide', type: 'button', style: 'margin-bottom:8px', html: IC.open + '<span>복사해 둔 링크 붙여넣기</span>',
        onclick: async () => { try { ta.value = await navigator.clipboard.readText(); } catch (e) { toast('붙여넣기 권한이 없습니다. 입력칸을 길게 눌러 붙여 넣어 주세요.'); } }}) : null,
      h('button', {class: 'btn primary wide', type: 'button', onclick: go}, '이 일정 열기'));
    return ta;
  });
}

/* ================= photo journal ================= */
// Photos live in this browser's IndexedDB, filed under the stop's id: a 480 px thumbnail (pins, lists, playback) and a
// 1600 px copy (the viewer). They never leave the phone, and links and trip files go without them.
const PH = {db: null, ready: null, idx: new Map(), failed: false};      // idx: stop id -> [{id, url, t, bytes}]
function phDb(){
  if (!PH.ready) PH.ready = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no IndexedDB'));
    const r = indexedDB.open('jejumap', 1);
    r.onupgradeneeded = () => { const db = r.result; for (const n of ['thumbs', 'full']) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, {keyPath: 'id'}); };
    r.onsuccess = () => res(PH.db = r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
  return PH.ready;
}
const phReq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const phDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); });
const photosOf = s => (s && s.id && PH.idx.get(s.id)) || [];
function indexPhoto(r){
  let a = PH.idx.get(r.sid);
  if (!a) PH.idx.set(r.sid, a = []);
  a.push({id: r.id, url: URL.createObjectURL(r.thumb), t: r.t || 0, bytes: r.bytes || 0});
  a.sort((x, y) => x.t - y.t);
}
async function loadPhotos(){
  try {
    const db = await phDb(), all = await phReq(db.transaction('thumbs').objectStore('thumbs').getAll());
    for (const r of all) if (r && r.sid && r.thumb instanceof Blob) indexPhoto(r);
    if (PH.idx.size && !play) { rebuildScene(); renderPanel(); }
  } catch (e) { PH.failed = true; console.warn('photos unavailable', e); }
}
async function shrinkPhoto(file){
  let src, url = null;
  try { src = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
  catch (e) {
    url = URL.createObjectURL(file);
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('decode')); im.src = url; });
  }
  try {
    const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
    if (!w0 || !h0) throw new Error('size');
    const draw = (max, q) => {
      const k = Math.min(1, max / Math.max(w0, h0)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
      return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', q));
    };
    return {full: await draw(1600, 0.84), thumb: await draw(480, 0.78)};
  } finally { if (src.close) src.close(); if (url) URL.revokeObjectURL(url); }
}
async function addPhotos(s, files){
  let ok = 0, bad = 0;
  for (const f of files) {
    try {
      const im = await shrinkPhoto(f), db = await phDb();
      const r = {id: newId() + newId(), sid: s.id, thumb: im.thumb, t: f.lastModified || Date.now(), bytes: im.full.size + im.thumb.size, added: Date.now()};
      const tx = db.transaction(['thumbs', 'full'], 'readwrite');
      tx.objectStore('thumbs').put(r); tx.objectStore('full').put({id: r.id, blob: im.full});
      await phDone(tx);
      indexPhoto(r); ok++;
    } catch (e) {
      bad++; console.warn('photo', e);
      if (e && e.name === 'QuotaExceededError') { toast('저장 공간이 부족해 사진을 더 넣지 못했습니다.'); break; }
    }
  }
  return {ok, bad};
}
async function deletePhotos(ids){
  const db = await phDb(), tx = db.transaction(['thumbs', 'full'], 'readwrite');
  for (const id of ids) { tx.objectStore('thumbs').delete(id); tx.objectStore('full').delete(id); }
  await phDone(tx);
  for (const [sid, a] of PH.idx) {
    for (let k = a.length - 1; k >= 0; k--) if (ids.includes(a[k].id)) { URL.revokeObjectURL(a[k].url); a.splice(k, 1); }
    if (!a.length) PH.idx.delete(sid);
  }
}
async function fullPhoto(id){ const db = await phDb(); const r = await phReq(db.transaction('full').objectStore('full').get(id)); return r && r.blob; }
// photos filed under stops that are in neither the open trip nor the one kept aside when a link was opened
function strayPhotos(){
  const keep = new Set(trip.days.flatMap(x => x.stops.map(s => s.id)));
  try { const b = JSON.parse(store.get(BEFORE_KEY) || 'null'); if (b && b.days) for (const x of b.days) for (const s of x.stops || []) if (s && s.id) keep.add(s.id); } catch (e) {}
  return [...PH.idx].filter(([sid]) => !keep.has(sid)).flatMap(([, a]) => a.map(p => p.id));
}
function photoGroup(d, i){
  const s = trip.days[d].stops[i], box = h('div', {class: 'group'}), grid = h('div', {class: 'ph-grid'});
  const draw = () => {
    grid.textContent = '';
    photosOf(s).forEach((p, k) => grid.append(h('button', {class: 'ph-th', type: 'button', 'aria-label': '사진 ' + (k + 1) + ' 크게 보기', onclick: () => openViewer(d, i, k)},
      h('img', {src: p.url, alt: '', decoding: 'async'}))));
    grid.hidden = !grid.children.length;
  };
  const inp = h('input', {type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async () => {
    const files = [...inp.files]; inp.value = '';
    if (!files.length) return;
    add.disabled = true; add.lastChild.textContent = '사진 넣는 중… (' + files.length + '장)';
    const r = await addPhotos(s, files);
    add.disabled = false; add.lastChild.textContent = '사진 넣기';
    draw(); if (!play) rebuildScene();
    toast(r.ok ? '사진 ' + r.ok + '장을 넣었습니다.' + (r.bad ? ' 읽지 못한 ' + r.bad + '장은 뺐습니다.' : '') : '사진을 읽지 못했습니다. JPG나 PNG 사진인지 확인해 주세요.');
  }});
  const add = h('button', {class: 'btn', type: 'button', html: IC.camera + '<span>사진 넣기</span>', disabled: PH.failed, onclick: () => inp.click()});
  draw(); box.redraw = draw;
  return put(box, grid, add, inp, h('p', {class: 'hint'}, PH.failed ? '이 브라우저에서는 사진을 저장할 수 없습니다. 개인정보 보호 모드인지 확인해 주세요.'
    : '사진은 이 기기에만 저장되고, 동선 재생 때 이 장소에서 보여 줍니다. 링크나 파일로 일정을 보낼 때는 빠집니다.'));
}
function photoStats(){
  const box = h('div', {class: 'group'});
  if (PH.failed) return put(box, h('p', {class: 'hint'}, '이 브라우저에서는 사진을 저장할 수 없습니다. 개인정보 보호 모드인지 확인해 주세요.'));
  let n = 0, bytes = 0;
  for (const a of PH.idx.values()) for (const p of a) { n++; bytes += p.bytes; }
  const stray = strayPhotos();
  put(box, h('p', {class: 'hint'}, n ? '이 기기에 사진 ' + n + '장(약 ' + Math.max(0.1, bytes / 1048576).toFixed(1) + 'MB)이 저장되어 있습니다. 장소의 ‘고치기’에서 넣고 지울 수 있습니다.'
    : '장소의 ‘고치기’에서 사진을 넣으면 지도 핀과 동선 재생에 나옵니다. 사진은 이 기기에만 저장됩니다.'));
  if (stray.length) box.append(h('button', {class: 'btn danger', type: 'button', onclick: () =>
    ask('일정에 없는 사진을 지울까요?', '지금 일정에 없는 장소에 붙어 있던 사진 ' + stray.length + '장을 이 기기에서 지웁니다. 되돌릴 수 없습니다.', '지우기', async () => {
      try { await deletePhotos(stray); toast('사진 ' + stray.length + '장을 지웠습니다.'); } catch (e) { toast('사진을 지우지 못했습니다.'); }
      if (view && view.kind === 'trip') openTrip();
    })}, '일정에 없는 사진 ' + stray.length + '장 지우기'));
  return box;
}
/* ---- the photo viewer ---- */
let vw = null;
function openViewer(d, i, k){
  const s = trip.days[d] && trip.days[d].stops[i];
  if (!s || !photosOf(s).length) return;
  vw = {d, i, sid: s.id, k, nav: !navArmed, back: document.activeElement, full: null};
  navOpen();
  $('viewer').hidden = false;
  showViewer(); $('vwClose').focus();
}
async function showViewer(){
  const a = PH.idx.get(vw.sid) || [];
  if (!a.length) return closeViewer();
  vw.k = clamp(vw.k, 0, a.length - 1);
  const p = a[vw.k], s = trip.days[vw.d] && trip.days[vw.d].stops[vw.i], img = $('vwImg');
  img.src = p.url;                                      // the thumbnail at once, the full photo once it is read
  $('vwCap').textContent = (s ? s.name + ' · ' : '') + (vw.k + 1) + ' / ' + a.length;
  $('vwPrev').hidden = vw.k === 0; $('vwNext').hidden = vw.k === a.length - 1;
  const b = await fullPhoto(p.id).catch(() => null), g = vw;
  if (b && g && (PH.idx.get(g.sid) || [])[g.k] === p) { if (g.full) URL.revokeObjectURL(g.full); g.full = URL.createObjectURL(b); img.src = g.full; }
}
function closeViewer(fromHistory){
  if (!vw) return;
  const g = vw; vw = null;
  $('viewer').hidden = true; $('vwImg').removeAttribute('src');
  if (g.full) URL.revokeObjectURL(g.full);
  if (!fromHistory && g.nav) navClose();
  if (g.back && g.back.isConnected) g.back.focus({preventScroll: true});
}
const viewerStep = k => { if (vw) { vw.k += k; showViewer(); } };
$('vwClose').innerHTML = IC.close; $('vwPrev').innerHTML = IC.prev; $('vwNext').innerHTML = IC.next; $('vwDel').innerHTML = IC.trash;
$('vwClose').addEventListener('click', () => closeViewer());
$('vwPrev').addEventListener('click', () => viewerStep(-1));
$('vwNext').addEventListener('click', () => viewerStep(1));
$('vwDel').addEventListener('click', () => {
  if (!vw) return;
  const p = (PH.idx.get(vw.sid) || [])[vw.k];
  if (p) ask('이 사진을 삭제하시겠습니까?', '삭제한 사진은 되돌릴 수 없습니다.', '삭제', async () => {
    try { await deletePhotos([p.id]); } catch (e) { return toast('사진을 지우지 못했습니다.'); }
    document.querySelectorAll('#vSub .group').forEach(g => g.redraw && g.redraw());
    if (!play) rebuildScene();
    if (vw) showViewer();
    toast('사진을 삭제했습니다.');
  });
});
(() => {      // swipe sideways between photos
  const el = $('viewer'); let sx = null;
  el.addEventListener('pointerdown', e => { if (!e.target.closest('button')) sx = {x: e.clientX, y: e.clientY}; });
  el.addEventListener('pointerup', e => {
    if (!sx) return;
    const dx = e.clientX - sx.x, dy = e.clientY - sx.y; sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) viewerStep(dx < 0 ? 1 : -1);
  });
  el.addEventListener('keydown', e => { if (e.key === 'ArrowRight') viewerStep(1); else if (e.key === 'ArrowLeft') viewerStep(-1); });
})();
/* ---- photos during playback: a print that comes up while the mover waits at the stop ---- */
let ppKey = '';
function playPhoto(ph){
  const el = $('playPhoto');
  const s = ph && trip.days[ph.at.d] && trip.days[ph.at.d].stops[ph.at.i], a = photosOf(s);
  if (!a.length) { if (ppKey) { ppKey = ''; el.classList.remove('on'); } return; }
  const n = Math.min(a.length, PHOTO_MAX), k = clamp(Math.floor(ph.f * n), 0, n - 1), key = s.id + ':' + k;
  if (key === ppKey) return;
  ppKey = key;
  $('ppImg').src = a[k].url;
  $('ppCap').textContent = (ph.at.i + 1) + '. ' + s.name + (n > 1 ? '  ' + (k + 1) + '/' + n : '');
  el.style.setProperty('--c', dayColor(ph.at.d));
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}

/* ---- installable app: offline cache (sw.js), updates, install ---- */
// A new version installs in the background and waits until the user picks '새로 열기' (or the app is next started
// fresh). The trip in localStorage is never part of that, so it survives every update.
const pwa = {reg: null, waiting: null, install: null, updating: false};
function standalone(){ return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function offerUpdate(w){
  pwa.waiting = w;
  toast('새 버전이 준비됐습니다. 일정은 그대로 남습니다.', '새로 열기', applyUpdate, 15000);
}
function applyUpdate(){
  if (!pwa.waiting) return;
  pwa.updating = true;
  pwa.waiting.postMessage('skipWaiting');
}
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (pwa.updating) location.reload(); });
  // what the last install fetched and what it reused from the older cache (an update should fetch only changed files)
  navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'sw-installed') pwa.lastInstall = e.data; });
  navigator.serviceWorker.register('sw.js').then(reg => {
    pwa.reg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
    });
    // a home-screen app can stay open for days: look for a new version whenever it comes back to the front
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); pwa.install = e; });
addEventListener('appinstalled', () => { pwa.install = null; toast('홈 화면에 앱을 추가했습니다.'); });

/* ---- static wiring ---- */
$('hudToggle').addEventListener('click', () => pausePlay(!play.paused));
$('hudStop').innerHTML = IC.close; $('hudStop').addEventListener('click', stopPlay);
$('btnAdd').innerHTML = IC.plus + '<span>장소 추가</span>';
$('btnAdd').addEventListener('click', () => openSearch());
$('pickOk').addEventListener('click', pickConfirm);
$('pickCancel').addEventListener('click', () => { const p = state.pick; endPick(); if (p && p.mode === 'move') openStop(p.d, p.i); });
$('mast').addEventListener('click', openTrip);
$('titleBtn').addEventListener('click', () => state.day >= 0 && trip.days.length > 1 ? openDay(state.day) : openTrip());
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (askCb) closeAsk(false); else if (vw) closeViewer(); else if (view && !state.pick) closeView();
});
const relayout = () => { measurePeek(); setSnap(snap); resize(); };
addEventListener('resize', relayout);
// web fonts arrive late and change the folded sheet's height: re-measure when its top part changes size
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => { const old = peekPx; measurePeek(); if (Math.abs(peekPx - old) > 2) { setSnap(snap); resize(); } });
  for (const id of ['dayhead', 'dayChips', 'peek']) ro.observe($(id));
}
if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);

/* ================= main loop ================= */
let last = performance.now();
function frame(now){
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  keyMove(dt);
  if (play && !play.paused) stepPlay(dt);
  if (orbit) { goal.az += 0.16 * dt; dirty = true; }
  goal.ty = groundY(goal.tx, goal.tz);
  const k = REDUCED ? 1 : 1 - Math.exp(-dt * (play && play.glide && !play.paused ? 2.6 : 9));
  let moving = false;
  // during playback the car can cover kilometres per second: once the view has caught up, it stays locked on the car
  const follow = play && !play.paused && !play.glide && Math.hypot(goal.tx - cam.tx, goal.tz - cam.tz) < cam.dist * 3;
  for (const p of ['tx', 'ty', 'tz', 'dist', 'az', 'pol']) {
    const d = goal[p] - cam[p];
    if (follow && p !== 'dist' && p !== 'az' && p !== 'pol') { if (d) { cam[p] = goal[p]; moving = true; } continue; }
    if (Math.abs(d) > 1e-4) { cam[p] += d * k; moving = true; } else cam[p] = goal[p];
  }
  if (moving || dirty) {
    dirty = false;
    applyCamera();
    if (!routeDist || Math.abs(Math.log(cam.dist / routeDist)) > 0.16) updateRouteGeometry();
    updateOsm();
    updateOverlay();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

buildRoads();
buildGraph();
parseBuildings();
parseCover();
buildGeoLabels();
// on a day of the trip the app opens on that day, with its check list and the next stop
const td0 = todayIndex();
if (td0 >= 0) { state.today = true; state.todayDay = td0; state.day = td0; }
rebuildScene();
renderPanel(false);
measurePeek(); setSnap('peek'); resize();
const allStops = trip.days.flatMap(x => x.stops);
if (allStops.length) fitStops(state.day >= 0 ? trip.days[state.day].stops : allStops); else fitIsland();
Object.assign(cam, goal); cam.ty = goal.ty = groundY(goal.tx, goal.tz);
requestAnimationFrame(frame);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
// how long this start took (shown in 여행 정보): the whole start, and the part spent reading the map data
bootSec = (performance.now() / 1000).toFixed(1); dataSec = ((window.__bootData || 0) / 1000).toFixed(1);
$('loading').classList.add('done'); setTimeout(() => $('loading').remove(), 500);
// today, with the location already allowed once: show where the phone is without asking again
if (todayOn() && navigator.geolocation && navigator.permissions && window.isSecureContext)
  navigator.permissions.query({name: 'geolocation'}).then(p => { if (p.state === 'granted' && me.watch == null) startLoc(false); }).catch(() => {});
loadPhotos();
// a trip sent as a link (#trip=...): read it, then take it out of the address so a reload does not ask again
const takeLink = () => {
  const c = linkCode(location.hash);
  if (!c) return;
  const src = location.href;
  history.replaceState(history.state, '', location.pathname + location.search);
  setTimeout(() => receiveLink(c, src), 600);
};
takeLink();
addEventListener('hashchange', takeLink);
// a stored trip this version could not read was set aside, never overwritten: offer it as a file
if (rescued) setTimeout(() => toast('저장된 일정을 이 버전에서 읽지 못해 따로 보관해 두었습니다.', '파일로 받기', () => {
  const a = h('a', {href: URL.createObjectURL(new Blob([store.get(RESCUE_KEY) || ''], {type: 'application/json'})), download: 'jeju-trip-saved.json'});
  document.body.append(a); a.click(); a.remove();
}), 700);
window.__jeju = {cam, goal, state, mover, get mode(){ return moverMode; }, get play(){ return play; }, get snap(){ return snap; }, get view(){ return view && view.kind; },
  // test hooks: jump to a fraction f of segment si (pausing if asked), or to a time; startPlay takes {day} / {stop: {d, i}}
  seek(si, f, pause){ if (play && play.segs[si]) { const s = play.segs[si]; if (pause) pausePlay(true); setPlayTime(s.t0 + s.hold + s.dur * f); } },
  seekTime(t){ if (play) setPlayTime(t); }, startPlay, timeline(){ return play && {T: play.T, t: play.t, k: play.k, n: play.segs.length, dayAt: play.dayAt,
    labels: play.segs.map(s => s.label), mode: play.segs[play.k].mode, paused: play.paused}; },
  stroll(d, i){ const s = trip.days[d].stops[i]; const w = s && walkOf(s); return w && {km: w.km, n: w.path.length, label: w.label}; },
  get trees(){ let tiles = 0, drawn = 0; for (const t of treeTiles.values()) if (t.mesh) { tiles++; if (t.mesh.visible) drawn += t.mesh.geometry.instanceCount; } return {tiles, built: treeCount, drawn}; },
  get bldVerts(){ return B ? B.verts : 0; }, ask: () => askCb != null, pwa, toast,
  get trip(){ return trip; }, get pins(){ return pins; }, get routes(){ return routes; }, get legs(){ return legs; },
  setSnap, openSearch, openStop, openTrip, openDay, search: searchPlaces,
  // today, location, directions, reordering, links, photos
  setToday, checkIn, todayIndex, me, dayPlan, openOrder, costMatrix, bestOrder, pathCost, kakaoUrl, naverPath, openNav,
  packTrip, unpackTrip, linkCode, receiveLink, makeLink, shareTrip, openPaste, restoreBefore,
  async addPhoto(d, i, blob){ const r = await addPhotos(trip.days[d].stops[i], [blob]); if (!play) rebuildScene(); return r; }, photosOf: (d, i) => photosOf(trip.days[d].stops[i]).length,
  openViewer, get viewer(){ return vw && {k: vw.k, sid: vw.sid}; }, strayPhotos, get photoFailed(){ return PH.failed; },
  async loadExample(){ replaceTrip(sanitizeTrip(await (await fetch('data/example_trip.json')).json())); },
  get osm(){ return {tilesBuilt: B ? B.built : 0, buildings: B ? B.x.length : 0, graphNodes: G ? G.n : 0, peekPx, inset}; }};
}

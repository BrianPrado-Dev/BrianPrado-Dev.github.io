/* ============================================================================
   world3d.js — live WebGL renderer for the scroll-world chain on brianprado.me
   ----------------------------------------------------------------------------
   The scroll-world skill normally scrubs pre-rendered video. Here the same chain
   (architecture B: dive into each scene → aerial connector → next scene) is
   rendered in real time with three.js: six precision-machined miniatures in
   brass, graphite, oxide red, sage and bone, laid out on a drafting sheet.

   The scrub engine owns scroll, copy, nav and pacing; it hands this module the
   current segment through `bridge.state = { seg, kind, si, local, near }`.
   Seams are continuous by construction: each connector starts on the exact pose
   the previous dive ends on and lands on the exact pose the next dive starts on,
   and every segment eases in/out so the camera never reverses at speed.
   ========================================================================== */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BG = 0xECE5D6;
const Y0 = 0.92;                 // island top surface
const R = 6.2;                   // island radius
const PI = Math.PI;
const UP = new THREE.Vector3(0, 1, 0);

const CENTERS = [[0, 0, 0], [30, 0, -12], [60, 0, 2], [90, 0, -12], [120, 0, 2], [151, 0, -6]];
const LABELS = ['01 · TALLER', '02 · CETI COLOMOS', '03 · TORMACH', '04 · TORTAS SUSY', '05 · TETRIS', '06 · CONTACTO'];
const E_OFF = new THREE.Vector3(9, 15, 18);          // establishing shot, same iso angle for every scene
const SUN_DIR = new THREE.Vector3(-0.66, 0.56, 0.5).normalize();   // warm, low, from the left

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const ease = x => 0.5 - 0.5 * Math.cos(PI * clamp(x));
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let M;   // materials, created once the renderer exists

// ---------------------------------------------------------------------------
// modelling helpers — positions are centres; the *b variants take the bottom y
// ---------------------------------------------------------------------------
function place(obj, p, x, y, z, o) {
  obj.position.set(x, y, z);
  if (o.rx) obj.rotation.x = o.rx;
  if (o.ry) obj.rotation.y = o.ry;
  if (o.rz) obj.rotation.z = o.rz;
  if (o.s) obj.scale.set(o.s[0], o.s[1], o.s[2]);
  if (obj.isMesh) obj.castShadow = obj.receiveShadow = true;
  p.add(obj);
  return obj;
}
function B(p, w, h, d, m, x, y, z, o = {}) {
  const r = o.r != null ? o.r : Math.min(0.05, Math.min(w, h, d) * 0.22);
  const geo = r > 0.012
    ? new RoundedBoxGeometry(w, h, d, Math.min(w, h, d) > 0.5 ? 2 : 1, r)
    : new THREE.BoxGeometry(w, h, d);
  return place(new THREE.Mesh(geo, m), p, x, y, z, o);
}
const Bb = (p, w, h, d, m, x, y, z, o) => B(p, w, h, d, m, x, y + h / 2, z, o);
function Cy(p, r, h, m, x, y, z, o = {}) {
  const geo = new THREE.CylinderGeometry(o.rt != null ? o.rt : r, r, h, o.seg || 24);
  return place(new THREE.Mesh(geo, m), p, x, y, z, o);
}
const Cb = (p, r, h, m, x, y, z, o) => Cy(p, r, h, m, x, y + h / 2, z, o);
function S(p, r, m, x, y, z, o = {}) {
  return place(new THREE.Mesh(new THREE.SphereGeometry(r, o.seg || 20, Math.ceil((o.seg || 20) * 0.7)), m), p, x, y, z, o);
}
function T(p, r, tube, m, x, y, z, o = {}) {
  return place(new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, o.seg || 48, o.arc || PI * 2), m), p, x, y, z, o);
}
function G(p, x = 0, y = 0, z = 0, o = {}) { return place(new THREE.Group(), p, x, y, z, o); }
function dyn(p, x, y, z, o) { const g = G(p, x, y, z, o); g.userData.dynamic = true; return g; }
function plane(p, w, h, m, x, y, z, o = {}) {
  const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(w, h), m), p, x, y, z, o);
  mesh.castShadow = false;
  return mesh;
}

// architectural-model people: monochrome bone, like a museum maquette
function figure(p, x, y, z, ry = 0) {
  const f = G(p, x, y, z, { ry });
  place(new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.36, 3, 10), M.figure), f, 0, 0.295, 0, {});
  S(f, 0.095, M.figure, 0, 0.69, 0, { seg: 14 });
  return f;
}

const TET = {
  L: [[0, 0], [1, 0], [0, 1], [0, 2]], T: [[0, 0], [1, 0], [2, 0], [1, 1]],
  S: [[0, 0], [1, 0], [1, 1], [2, 1]], O: [[0, 0], [1, 0], [0, 1], [1, 1]], I: [[0, 0], [0, 1], [0, 2], [0, 3]],
};
function tetro(p, key, m, x, y, z, c = 0.42, o = {}) {
  const t = G(p, x, y, z, o);
  for (const [a, b] of TET[key]) B(t, c * 0.95, c * 0.95, c * 0.95, m, a * c, b * c + c / 2, 0, { r: c * 0.09 });
  return t;
}

// Merge every static mesh under `root` into one mesh per material (draw-call budget).
function bake(root) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const buckets = new Map();
  const dead = [];
  (function walk(o) {
    for (const c of o.children) {
      if (c.userData.dynamic) continue;
      if (c.isMesh && !c.userData.keep) {
        // RoundedBoxGeometry is non-indexed, the primitives are indexed: unify before merging
        const g = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld));
        if (!buckets.has(c.material)) buckets.set(c.material, []);
        buckets.get(c.material).push(g);
        dead.push(c);
      }
      walk(c);
    }
  })(root);
  for (const c of dead) { c.parent.remove(c); c.geometry.dispose(); }
  for (const [m, list] of buckets) {
    const merged = mergeGeometries(list, false);
    list.forEach(g => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, m);
    mesh.castShadow = !m.transparent && !(m.isMeshBasicMaterial);
    mesh.receiveShadow = !m.isMeshBasicMaterial;
    root.add(mesh);
  }
}
function bakeTree(root) {
  const dyns = [];
  root.traverse(o => { if (o !== root && o.userData.dynamic) dyns.push(o); });
  bake(root);
  dyns.forEach(bake);
}

// ---------------------------------------------------------------------------
// canvas textures (screens, ground, labels) — no text on screens, palette only
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.userData.ctx = x;
  t.userData.draw = draw;
  return t;
}
const screenMat = tex => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });

function codeTex(seed) {
  return canvasTex(256, 160, (x, w, h) => {
    const r = rng(seed);
    x.fillStyle = '#1D1C19'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#272622'; x.fillRect(0, 0, 22, h);
    const cols = ['#C9A86A', '#9EAD93', '#D8CFBD', '#C27358', '#8E887C'];
    let y = 12, ind = 0;
    while (y < h - 8) {
      x.fillStyle = '#48453E'; x.fillRect(6, y, 10, 4);
      if (r() > 0.12) {
        ind = clamp(ind + (r() < 0.3 ? 1 : r() < 0.35 ? -1 : 0), 0, 4);
        let cx = 30 + ind * 14;
        const words = 1 + Math.floor(r() * 4);
        for (let k = 0; k < words && cx < w - 20; k++) {
          const len = 10 + r() * 44;
          x.fillStyle = cols[Math.floor(r() * cols.length)];
          x.fillRect(cx, y, len, 4);
          cx += len + 7;
        }
      }
      y += 11;
    }
    x.fillStyle = '#C9A86A'; x.fillRect(30, y - 11, 7, 6);   // caret
  });
}
function menuTex() {        // the Tortas Susy site / POS: header, hero, product cards
  return canvasTex(256, 176, (x, w, h) => {
    x.fillStyle = '#F1EADB'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#9A4B32'; x.fillRect(0, 0, w, 22);
    x.fillStyle = '#F1EADB'; x.fillRect(10, 8, 34, 6); x.fillRect(w - 70, 9, 16, 4); x.fillRect(w - 46, 9, 16, 4); x.fillRect(w - 24, 9, 12, 4);
    x.fillStyle = '#E2D7C1'; x.fillRect(10, 30, w - 20, 44);
    x.fillStyle = '#B4935A'; x.beginPath(); x.arc(w - 50, 52, 16, 0, PI * 2); x.fill();
    x.fillStyle = '#3B3934'; x.fillRect(20, 42, 90, 7); x.fillStyle = '#8A8274'; x.fillRect(20, 56, 64, 4);
    const cw = (w - 40) / 3;
    for (let k = 0; k < 6; k++) {
      const cx = 10 + (k % 3) * (cw + 10), cy = 84 + Math.floor(k / 3) * 46;
      x.fillStyle = '#E6DCC8'; x.fillRect(cx, cy, cw, 38);
      x.fillStyle = k % 2 ? '#B4935A' : '#9A4B32'; x.beginPath(); x.arc(cx + 13, cy + 19, 9, 0, PI * 2); x.fill();
      x.fillStyle = '#4A463E'; x.fillRect(cx + 28, cy + 12, cw - 38, 4);
      x.fillStyle = '#9A9284'; x.fillRect(cx + 28, cy + 22, cw - 50, 3);
    }
  });
}
function scopeTex() {
  return canvasTex(192, 128, (x, w, h) => {
    x.fillStyle = '#1B1C19'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#2E302B'; x.lineWidth = 1;
    for (let i = 0; i <= w; i += 24) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
    for (let j = 0; j <= h; j += 21) { x.beginPath(); x.moveTo(0, j); x.lineTo(w, j); x.stroke(); }
    const wave = (amp, f, ph, col, lw) => {
      x.strokeStyle = col; x.lineWidth = lw; x.beginPath();
      for (let i = 0; i <= w; i += 2) { const yy = h / 2 + Math.sin(i * f + ph) * amp; i ? x.lineTo(i, yy) : x.moveTo(i, yy); }
      x.stroke();
    };
    wave(34, 0.075, 0, '#9DB38F', 3);
    wave(18, 0.15, 1.2, '#C9A86A', 2);
  });
}
function gridTex(renderer) {
  const t = canvasTex(512, 512, (x, w) => {
    x.fillStyle = '#ECE5D6'; x.fillRect(0, 0, w, w);
    x.strokeStyle = 'rgba(35,34,31,0.075)'; x.lineWidth = 1.5;
    for (let i = 0; i < w; i += w / 10) {
      x.beginPath(); x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, w); x.stroke();
      x.beginPath(); x.moveTo(0, i + 0.5); x.lineTo(w, i + 0.5); x.stroke();
    }
    x.strokeStyle = 'rgba(35,34,31,0.15)'; x.lineWidth = 2.5;
    x.strokeRect(1, 1, w - 2, w - 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function blobTex() {
  const t = canvasTex(256, 256, (x, w) => {
    const g = x.createRadialGradient(w / 2, w / 2, w * 0.18, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(60,48,32,0.42)'); g.addColorStop(0.55, 'rgba(60,48,32,0.16)'); g.addColorStop(1, 'rgba(60,48,32,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, w);
  });
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
function labelTex(text) {
  const draw = (x, w, h) => {
    x.clearRect(0, 0, w, h);
    x.fillStyle = 'rgba(35,34,31,0.6)';
    x.font = '500 72px "IBM Plex Mono", ui-monospace, Menlo, monospace';
    x.textBaseline = 'middle';
    x.fillText(text, 10, h / 2 - 8);
    x.fillRect(10, h - 22, Math.min(w - 20, x.measureText(text).width), 4);
  };
  return canvasTex(1024, 140, draw);
}

// self-playing Tetris for the arcade screen (palette colours, no text)
function makeTetris() {
  const W = 10, H = 18, CS = 16;
  const tex = canvasTex(W * CS, H * CS, () => {});
  const x = tex.userData.ctx;
  const SH = {
    I: [[0, 0], [1, 0], [2, 0], [3, 0]], O: [[0, 0], [1, 0], [0, 1], [1, 1]], T: [[0, 0], [1, 0], [2, 0], [1, 1]],
    L: [[0, 0], [0, 1], [0, 2], [1, 2]], J: [[1, 0], [1, 1], [1, 2], [0, 2]], S: [[1, 0], [2, 0], [0, 1], [1, 1]], Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  };
  const COLS = ['#C2A066', '#B85C3E', '#93A687', '#E3D9C4', '#D1B57F'];
  const r = rng(11);
  let grid, piece, acc = 0;
  const fresh = () => {
    grid = Array.from({ length: H }, () => Array(W).fill(null));
    for (let y = H - 4; y < H; y++) for (let k = 0; k < W; k++) if (r() < 0.62) grid[y][k] = COLS[Math.floor(r() * COLS.length)];
  };
  const fits = (cells, px, py) => cells.every(([a, b]) => {
    const cx = px + a, cy = py + b;
    return cx >= 0 && cx < W && cy < H && (cy < 0 || !grid[cy][cx]);
  });
  const spawn = () => {
    const keys = Object.keys(SH);
    let cells = SH[keys[Math.floor(r() * keys.length)]].map(c => c.slice());
    const rot = Math.floor(r() * 4);
    for (let i = 0; i < rot; i++) cells = cells.map(([a, b]) => [b, -a]);
    const mx = Math.min(...cells.map(c => c[0])), my = Math.min(...cells.map(c => c[1]));
    cells = cells.map(([a, b]) => [a - mx, b - my]);
    const wid = Math.max(...cells.map(c => c[0])) + 1;
    piece = { cells, x: Math.floor(r() * (W - wid + 1)), y: -2, col: COLS[Math.floor(r() * COLS.length)] };
    if (!fits(piece.cells, piece.x, piece.y + 1)) fresh();
  };
  const step = () => {
    if (fits(piece.cells, piece.x, piece.y + 1)) { piece.y++; return; }
    for (const [a, b] of piece.cells) if (piece.y + b >= 0) grid[piece.y + b][piece.x + a] = piece.col;
    grid = grid.filter(row => row.some(c => !c));
    while (grid.length < H) grid.unshift(Array(W).fill(null));
    spawn();
  };
  const cell = (cx, cy, col) => {
    x.fillStyle = col; x.fillRect(cx * CS + 1, cy * CS + 1, CS - 2, CS - 2);
    x.fillStyle = 'rgba(255,255,255,0.18)'; x.fillRect(cx * CS + 1, cy * CS + 1, CS - 2, 2);
    x.fillStyle = 'rgba(0,0,0,0.22)'; x.fillRect(cx * CS + 1, cy * CS + CS - 3, CS - 2, 2);
  };
  const draw = () => {
    x.fillStyle = '#1C1B18'; x.fillRect(0, 0, W * CS, H * CS);
    x.fillStyle = '#24231F';
    for (let i = 1; i < W; i++) x.fillRect(i * CS, 0, 1, H * CS);
    for (let y = 0; y < H; y++) for (let k = 0; k < W; k++) if (grid[y][k]) cell(k, y, grid[y][k]);
    for (const [a, b] of piece.cells) if (piece.y + b >= 0) cell(piece.x + a, piece.y + b, piece.col);
    tex.needsUpdate = true;
  };
  fresh(); spawn(); draw();
  return { tex, tick(dt) { acc += dt; let moved = false; while (acc > 0.17) { acc -= 0.17; step(); moved = true; } if (moved) draw(); } };
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------
function makeMaterials() {
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...o });
  const phys = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.5, metalness: 0, ...o });
  return {
    graphite: std(0x2B2A26, { metalness: 0.5, roughness: 0.46 }),
    graphite2: std(0x3D3B35, { metalness: 0.35, roughness: 0.55 }),
    brass: std(0xB4935A, { metalness: 1, roughness: 0.3 }),
    brassDark: std(0x8E7044, { metalness: 1, roughness: 0.42 }),
    brassPaint: std(0xB4935A, { roughness: 0.65 }),
    alu: std(0xCFCBC2, { metalness: 1, roughness: 0.26 }),
    bone: std(0xE9E1D0, { roughness: 0.72 }),
    bone2: std(0xD9CFBB, { roughness: 0.85 }),
    stucco: std(0xE7DDC9, { roughness: 0.95 }),
    concrete: std(0xD0C7B4, { roughness: 0.95 }),
    terracotta: std(0xB98468, { roughness: 0.9 }),
    oxide: phys(0x9A4B32, { roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.35 }),
    oxideDark: std(0x6C2E1E, { roughness: 0.5 }),
    sage: phys(0x7D8B74, { roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
    wood: std(0xB39270, { roughness: 0.82 }),
    woodDark: std(0x8C6D4E, { roughness: 0.85 }),
    granite: std(0x4B4944, { roughness: 0.32, metalness: 0.08 }),
    asphalt: std(0x3B3934, { roughness: 0.95 }),
    belt: std(0x262522, { roughness: 0.9 }),
    figure: std(0xEFE8D8, { roughness: 0.9 }),
    paper: std(0xF3ECDD, { roughness: 0.92 }),
    paper2: std(0xE6DCC7, { roughness: 0.92 }),
    bread: std(0xC9975C, { roughness: 0.78 }),
    clay: std(0xA85F40, { roughness: 0.88 }),
    sauce: std(0x7E2C1D, { roughness: 0.28 }),
    pencil: phys(0x2F2D29, { roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    glass: std(0xCAD3CC, { roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false }),
    darkGlass: std(0x2A2D2A, { roughness: 0.12, metalness: 0.4 }),
    lamp: std(0xF0C67E, { emissive: 0xE9B15E, emissiveIntensity: 0.9, roughness: 0.4 }),
    marquee: std(0xF1E6CC, { emissive: 0xE8D3A2, emissiveIntensity: 0.55, roughness: 0.5 }),
  };
}

// ---------------------------------------------------------------------------
// the island plinth: a turned graphite puck with a brass collar and dial ticks
// ---------------------------------------------------------------------------
function islandBase(g) {
  Cb(g, R + 0.03, 0.12, M.brassDark, 0, 0, 0, { seg: 72 });
  Cb(g, R, 0.7, M.graphite, 0, 0.1, 0, { seg: 72 });
  Cb(g, R + 0.07, 0.07, M.brass, 0, 0.8, 0, { seg: 72 });
  Cb(g, R - 0.04, 0.05, M.bone2, 0, 0.87, 0, { seg: 72 });
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * PI * 2, long = k % 6 === 0;
    const len = long ? 0.42 : 0.2, rr = R - 0.12 - len / 2;
    B(g, 0.045, 0.02, len, M.brass, Math.sin(a) * rr, Y0 + 0.005, Math.cos(a) * rr, { ry: a, r: 0 });
  }
}

// ---------------------------------------------------------------------------
// 01 · the engineer's workshop
// ---------------------------------------------------------------------------
function buildTaller(g, ctx) {
  const y = Y0, H = 3.0;
  Bb(g, 7.2, 0.08, 5.4, M.concrete, 0, y, -0.5, { r: 0.02 });
  Bb(g, 7.2, H, 0.22, M.graphite, 0, y, -3.1);
  Bb(g, 0.22, H, 5.4, M.graphite, -3.5, y, -0.5);
  Bb(g, 0.22, 1.0, 5.4, M.graphite, 3.5, y, -0.5);
  Bb(g, 0.22, 0.75, 5.4, M.graphite, 3.5, y + H - 0.75, -0.5);
  Bb(g, 0.06, 1.25, 5.0, M.glass, 3.5, y + 1.0, -0.5, { r: 0 });
  for (const z of [-2.6, -1.3, 0, 1.3]) Bb(g, 0.1, 1.25, 0.06, M.brass, 3.5, y + 1.0, z, { r: 0 });
  Bb(g, 1.1, H, 0.22, M.graphite, -2.95, y, 2.1);
  Bb(g, 1.1, H, 0.22, M.graphite, 2.95, y, 2.1);
  Bb(g, 4.8, 0.55, 0.22, M.graphite, 0, y + H - 0.55, 2.1);
  Cy(g, 0.2, 4.7, M.brass, 0, y + H - 0.75, 2.32, { rz: PI / 2 });           // rolled-up door
  for (const [px, pz] of [[-3.62, -3.22], [3.62, -3.22], [-3.62, 2.22], [3.62, 2.22]]) Bb(g, 0.1, H + 0.04, 0.1, M.brass, px, y, pz, { r: 0.02 });

  const roof = dyn(g, 0, y + H, -3.3);                                       // hinged at the back
  Bb(roof, 7.6, 0.22, 5.8, M.graphite2, 0, 0, 2.9);
  Bb(roof, 7.68, 0.06, 5.88, M.brass, 0, -0.01, 2.9, { r: 0 });
  Bb(roof, 1.8, 0.3, 1.3, M.glass, 1.6, 0.22, 3.4, { r: 0 });
  Bb(roof, 1.9, 0.06, 1.4, M.brass, 1.6, 0.2, 3.4, { r: 0 });
  Cb(roof, 0.2, 0.45, M.brassDark, -2.3, 0.22, 2.0);
  Cb(roof, 0.14, 0.35, M.brassDark, -1.6, 0.22, 4.4);
  ctx.roofs.push({ obj: roof, mode: 'hinge' });

  const by = y + 0.92;                                                       // bench top
  Bb(g, 3.8, 0.08, 1.0, M.bone, -0.2, by - 0.08, -2.45);
  for (const [lx, lz] of [[-2.0, -2.85], [1.6, -2.85], [-2.0, -2.05], [1.6, -2.05]]) Bb(g, 0.07, 0.84, 0.07, M.graphite, lx, y, lz, { r: 0 });
  Bb(g, 3.6, 0.05, 0.85, M.bone2, -0.2, y + 0.3, -2.45, { r: 0 });
  Bb(g, 0.45, 0.25, 0.4, M.oxide, -1.4, y + 0.35, -2.45); Bb(g, 0.45, 0.25, 0.4, M.sage, -0.8, y + 0.35, -2.45);
  // laptop
  Bb(g, 0.64, 0.035, 0.44, M.graphite, -0.45, by, -2.35, { r: 0.01 });
  const lid = G(g, -0.45, by + 0.035, -2.57, { rx: -0.3 });
  Bb(lid, 0.64, 0.44, 0.025, M.graphite, 0, 0, 0, { r: 0.01 });
  plane(lid, 0.58, 0.38, screenMat(codeTex(3)), 0, 0.22, 0.014);
  // circuit board + calipers
  Bb(g, 0.5, 0.025, 0.34, M.sage, 0.35, by, -2.4, { r: 0 });
  Bb(g, 0.11, 0.03, 0.11, M.graphite, 0.3, by + 0.025, -2.42, { r: 0 });
  Bb(g, 0.06, 0.025, 0.08, M.graphite, 0.48, by + 0.025, -2.48, { r: 0 });
  Bb(g, 0.3, 0.04, 0.03, M.brass, 0.38, by + 0.025, -2.27, { r: 0 });
  const cal = G(g, 0.85, by, -2.05, { ry: 0.45 });
  Bb(cal, 0.7, 0.015, 0.05, M.brass, 0, 0, 0, { r: 0 });
  Bb(cal, 0.03, 0.015, 0.16, M.brass, -0.33, 0, 0.07, { r: 0 });
  Bb(cal, 0.06, 0.02, 0.18, M.brassDark, -0.1, 0, 0.05, { r: 0 });
  // 3D printer with a moving head
  const px = 1.25, pz = -2.45;
  for (const [ax, az] of [[-0.27, -0.22], [0.27, -0.22], [-0.27, 0.22], [0.27, 0.22]]) Bb(g, 0.035, 0.62, 0.035, M.graphite, px + ax, by, pz + az, { r: 0 });
  Bb(g, 0.58, 0.04, 0.48, M.graphite, px, by + 0.62, pz, { r: 0 });
  Bb(g, 0.46, 0.03, 0.38, M.bone2, px, by + 0.12, pz, { r: 0 });
  Cb(g, 0.07, 0.1, M.oxide, px, by + 0.15, pz, { seg: 16 });
  Bb(g, 0.54, 0.03, 0.03, M.brass, px, by + 0.42, pz, { r: 0 });
  const head = dyn(g, px, by + 0.36, pz);
  Bb(head, 0.1, 0.1, 0.1, M.brass, 0, 0, 0, { r: 0.01 });
  Cb(head, 0.015, 0.05, M.graphite, 0, -0.05, 0);
  // gripper prototype
  const gb = dyn(g, -1.55, by, -2.35);
  Cb(gb, 0.12, 0.06, M.brass, 0, 0, 0);
  const a1 = dyn(gb, 0, 0.06, 0);
  Bb(a1, 0.07, 0.38, 0.07, M.oxide, 0, 0, 0, { r: 0.015 });
  S(a1, 0.05, M.brass, 0, 0.4, 0);
  const a2 = dyn(a1, 0, 0.4, 0);
  Bb(a2, 0.06, 0.3, 0.06, M.graphite, 0, 0, 0, { r: 0.012 });
  Bb(a2, 0.02, 0.1, 0.04, M.brass, -0.03, 0.3, 0, { r: 0 });
  Bb(a2, 0.02, 0.1, 0.04, M.brass, 0.03, 0.3, 0, { r: 0 });
  // pegboard of tools
  Bb(g, 2.8, 1.3, 0.04, M.bone2, -0.2, y + 1.45, -2.97, { r: 0 });
  Bb(g, 0.06, 0.5, 0.02, M.brass, -1.2, y + 1.6, -2.94, { r: 0 }); T(g, 0.07, 0.02, M.brass, -1.2, y + 2.17, -2.94, { seg: 16 });
  Bb(g, 0.05, 0.2, 0.04, M.oxide, -0.8, y + 1.95, -2.93, { r: 0 }); Bb(g, 0.015, 0.25, 0.015, M.graphite, -0.8, y + 1.7, -2.93, { r: 0 });
  Bb(g, 0.05, 0.2, 0.04, M.sage, -0.6, y + 1.95, -2.93, { r: 0 }); Bb(g, 0.015, 0.22, 0.015, M.graphite, -0.6, y + 1.73, -2.93, { r: 0 });
  Bb(g, 0.04, 0.42, 0.03, M.wood, -0.2, y + 1.6, -2.93, { r: 0 }); Bb(g, 0.2, 0.07, 0.05, M.graphite, -0.2, y + 2.0, -2.93, { r: 0 });
  for (let k = 0; k < 4; k++) Bb(g, 0.2, 0.14, 0.12, M.brass, 0.35 + k * 0.26, y + 1.55, -2.9, { r: 0.015 });
  T(g, 0.16, 0.025, M.graphite, 0.75, y + 2.05, -2.93, { seg: 20 });
  // shelving + stool + the engineer
  Bb(g, 0.45, 1.8, 1.6, M.graphite2, -3.1, y, -1.3);
  for (const [hy, m] of [[0.15, M.oxide], [0.75, M.sage], [1.3, M.bone]]) Bb(g, 0.35, 0.3, 0.6, m, -3.05, y + hy, -1.0);
  Cb(g, 0.03, 0.62, M.graphite, 0.15, y, -1.55); Cb(g, 0.16, 0.03, M.graphite, 0.15, y, -1.55);
  Cb(g, 0.2, 0.06, M.oxide, 0.15, y + 0.62, -1.55);
  figure(g, -0.45, y, -1.6, PI);
  // outside
  Bb(g, 0.7, 0.6, 0.7, M.wood, -2.6, y, 3.0); Bb(g, 0.72, 0.05, 0.72, M.woodDark, -2.6, y + 0.3, 3.0, { r: 0 });
  Bb(g, 0.55, 0.45, 0.55, M.wood, -2.55, y + 0.6, 3.0, { ry: 0.35 });
  Cb(g, 0.2, 0.32, M.clay, 2.75, y, 2.95, { rt: 0.25 }); S(g, 0.36, M.sage, 2.75, y + 0.62, 2.95, { s: [1, 1.15, 1] });
  figure(g, 1.4, y, 3.2, -0.6);

  ctx.ticks.push(t => {
    head.position.x = px + 0.18 * Math.sin(t * 1.7);
    head.position.z = pz + 0.1 * Math.sin(t * 2.3);
    gb.rotation.y = 0.7 * Math.sin(t * 0.5);
    a1.rotation.z = 0.35 * Math.sin(t * 0.6);
    a2.rotation.z = 0.8 + 0.3 * Math.sin(t * 0.7);
  });
  return { focal: new THREE.Vector3(-0.45, by + 0.22, -2.35), cam: new THREE.Vector3(2.0, y + 4.6, 3.4), pull: 1 };
}

// ---------------------------------------------------------------------------
// 02 · the mechatronics lab at CETI Colomos
// ---------------------------------------------------------------------------
function buildCeti(g, ctx) {
  const y = Y0, H = 3.1;
  Bb(g, 8.0, 0.08, 5.8, M.bone2, 0, y, -0.4, { r: 0.02 });
  T(g, 1.25, 0.03, M.brassPaint, 0, y + 0.09, -0.6, { rx: PI / 2, seg: 64 });
  Bb(g, 8.0, H, 0.22, M.graphite, 0, y, -3.2);
  for (const wx of [-2.5, 0, 2.5]) {
    Bb(g, 1.7, 2.1, 0.06, M.glass, wx, y + 0.6, -3.07, { r: 0 });
    Bb(g, 1.8, 0.07, 0.1, M.brass, wx, y + 2.7, -3.05, { r: 0 });
    Bb(g, 1.8, 0.07, 0.1, M.brass, wx, y + 0.53, -3.05, { r: 0 });
    Bb(g, 0.06, 2.1, 0.08, M.brass, wx, y + 0.6, -3.04, { r: 0 });
  }
  Bb(g, 0.22, H, 5.8, M.graphite, -4.0, y, -0.4);
  Bb(g, 0.22, H, 2.0, M.graphite, 4.0, y, -2.3);
  Bb(g, 0.22, 0.5, 3.8, M.graphite, 4.0, y + H - 0.5, 0.6);
  Bb(g, 0.06, 2.4, 3.6, M.glass, 4.0, y + 0.1, 0.6, { r: 0 });
  Bb(g, 0.25, H, 0.25, M.graphite, -3.88, y, 2.38); Bb(g, 0.25, H, 0.25, M.graphite, 3.88, y, 2.38);

  const roof = dyn(g, 0, y + H, 0);                                          // sawtooth, lifts away
  Bb(roof, 8.0, 0.3, 0.25, M.graphite, 0, -0.3, 2.38);
  Bb(roof, 8.02, 0.05, 0.27, M.brass, 0, -0.33, 2.38, { r: 0 });
  Bb(roof, 8.4, 0.14, 6.2, M.graphite2, 0, 0, -0.4);
  for (const tz of [-2.4, -0.4, 1.6]) {
    B(roof, 8.4, 0.08, 2.19, M.graphite, 0, 0.14 + 0.45, tz, { rx: 0.423, r: 0 });
    Bb(roof, 8.3, 0.9, 0.05, M.glass, 0, 0.14, tz - 1.0, { r: 0 });
    Bb(roof, 8.42, 0.05, 0.08, M.brass, 0, 1.02, tz - 1.0, { r: 0 });
  }
  ctx.roofs.push({ obj: roof, mode: 'lift' });

  // six-axis robot arm
  const rb = G(g, 0, y, -0.6);
  Cb(rb, 0.55, 0.16, M.graphite, 0, 0, 0, { seg: 32 });
  Cb(rb, 0.58, 0.04, M.brass, 0, 0.16, 0, { seg: 32 });
  const turn = dyn(rb, 0, 0.2, 0);
  Cb(turn, 0.36, 0.42, M.oxide, 0, 0, 0, { rt: 0.3, seg: 28 });
  const sh = dyn(turn, 0, 0.55, 0);
  Cy(sh, 0.2, 0.46, M.brass, 0, 0, 0, { rx: PI / 2 });
  Bb(sh, 0.26, 1.15, 0.26, M.oxide, 0, 0, 0);
  const el = dyn(sh, 0, 1.15, 0);
  Cy(el, 0.15, 0.36, M.brass, 0, 0, 0, { rx: PI / 2 });
  Bb(el, 0.2, 0.9, 0.2, M.oxide, 0, 0, 0);
  const wr = dyn(el, 0, 0.9, 0);
  Cb(wr, 0.1, 0.12, M.graphite, 0, 0, 0);
  Bb(wr, 0.24, 0.05, 0.12, M.graphite, 0, 0.12, 0, { r: 0.01 });
  Bb(wr, 0.04, 0.16, 0.08, M.brass, -0.09, 0.17, 0, { r: 0 });
  Bb(wr, 0.04, 0.16, 0.08, M.brass, 0.09, 0.17, 0, { r: 0 });
  // conveyor with parts
  const cx = -2.85;
  Bb(g, 0.75, 0.62, 3.8, M.graphite, cx, y, -0.6);
  Bb(g, 0.66, 0.03, 3.82, M.belt, cx, y + 0.62, -0.6, { r: 0 });
  Cy(g, 0.08, 0.7, M.brass, cx, y + 0.6, -2.5, { rz: PI / 2 }); Cy(g, 0.08, 0.7, M.brass, cx, y + 0.6, 1.3, { rz: PI / 2 });
  Bb(g, 0.05, 0.5, 0.05, M.brass, cx - 0.4, y + 0.62, 0, { r: 0 }); Bb(g, 0.05, 0.5, 0.05, M.brass, cx + 0.4, y + 0.62, 0, { r: 0 });
  Bb(g, 0.85, 0.06, 0.1, M.brass, cx, y + 1.12, 0, { r: 0 });
  Cy(g, 0.03, 0.04, M.lamp, cx, y + 1.08, 0.06, { rx: PI / 2 });
  const parts = [];
  for (let k = 0; k < 5; k++) {
    const p = dyn(g, cx, y + 0.73, 0);
    Bb(p, 0.16, 0.16, 0.16, [M.brass, M.bone, M.sage][k % 3], 0, -0.08, 0, { r: 0.02 });
    parts.push(p);
  }
  // control cabinets
  for (let k = 0; k < 3; k++) {
    const x = 1.7 + k * 0.78;
    Bb(g, 0.72, 1.75, 0.5, M.graphite, x, y, -2.75);
    Bb(g, 0.6, 1.4, 0.02, M.sage, x, y + 0.2, -2.49, { r: 0 });
    Cy(g, 0.035, 0.03, M.lamp, x - 0.18, y + 1.45, -2.47, { rx: PI / 2 });
    Cy(g, 0.035, 0.03, M.brass, x, y + 1.45, -2.47, { rx: PI / 2 });
    Bb(g, 0.03, 0.25, 0.03, M.brass, x + 0.22, y + 0.85, -2.47, { r: 0 });
  }
  // bench + oscilloscope
  Bb(g, 1.5, 0.06, 0.7, M.bone, 2.5, y + 0.76, 0.8);
  for (const [lx, lz] of [[1.8, 0.5], [3.2, 0.5], [1.8, 1.1], [3.2, 1.1]]) Bb(g, 0.06, 0.76, 0.06, M.graphite, lx, y, lz, { r: 0 });
  Bb(g, 0.5, 0.32, 0.36, M.graphite, 2.3, y + 0.82, 0.72);
  plane(g, 0.3, 0.2, screenMat(scopeTex()), 2.24, y + 0.99, 0.905);
  Cy(g, 0.025, 0.02, M.brass, 2.47, y + 1.04, 0.905, { rx: PI / 2 }); Cy(g, 0.025, 0.02, M.brass, 2.47, y + 0.94, 0.905, { rx: PI / 2 });
  // pneumatic test rig
  Bb(g, 1.0, 0.5, 0.5, M.graphite2, -1.4, y, 1.25);
  const rods = [];
  for (let k = 0; k < 2; k++) {
    Cy(g, 0.07, 0.45, M.brass, -1.55, y + 0.6 + k * 0.17, 1.25, { rz: PI / 2 });
    const rod = dyn(g, -1.2, y + 0.6 + k * 0.17, 1.25);
    Cy(rod, 0.025, 0.4, M.alu, 0, 0, 0, { rz: PI / 2 });
    Bb(rod, 0.06, 0.1, 0.1, M.oxide, 0.2, 0, 0, { r: 0.01 });
    rods.push(rod);
  }
  figure(g, 1.0, y, 0.55, -2.4); figure(g, -1.05, y, 0.25, 2.3); figure(g, 1.9, y, 1.4, -0.4);

  ctx.ticks.push(t => {
    turn.rotation.y = 0.9 * Math.sin(t * 0.35);
    sh.rotation.z = 0.5 + 0.18 * Math.sin(t * 0.5);
    el.rotation.z = 1.0 + 0.3 * Math.sin(t * 0.5 + 1.2);
    wr.rotation.z = 0.5 * Math.sin(t * 0.7);
    parts.forEach((p, k) => {
      const u = (t * 0.4 + k * 0.76) % 3.8;
      p.position.z = -2.45 + u;
      const s = Math.max(0.001, Math.min(smoothstep(0, 0.3, u), 1 - smoothstep(3.5, 3.8, u)));
      p.scale.setScalar(s);
    });
    rods.forEach((rod, k) => { rod.position.x = -1.2 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.4 + k * 1.7)); });
  });
  return { focal: new THREE.Vector3(0, y + 1.35, -0.6), cam: new THREE.Vector3(3.6, y + 5.0, 4.6), pull: 1 };
}

// ---------------------------------------------------------------------------
// 03 · the CNC machine-tool hall (Tormach)
// ---------------------------------------------------------------------------
function mill(p, x, z, open) {
  const m = G(p, x, Y0, z);
  Bb(m, 1.3, 0.22, 1.1, M.graphite, 0, 0, 0);
  let spindle = null;
  if (!open) {
    Bb(m, 1.3, 1.4, 1.1, M.bone, 0, 0.22, 0);
    Bb(m, 0.72, 0.6, 0.02, M.darkGlass, 0, 0.6, 0.555, { r: 0 });
    Bb(m, 0.8, 0.68, 0.015, M.brass, 0, 0.56, 0.552, { r: 0 });
  } else {
    Bb(m, 1.3, 1.4, 0.06, M.bone, 0, 0.22, -0.52);
    Bb(m, 0.06, 1.4, 1.1, M.bone, -0.62, 0.22, 0); Bb(m, 0.06, 1.4, 1.1, M.bone, 0.62, 0.22, 0);
    Bb(m, 1.3, 0.08, 1.1, M.bone, 0, 1.54, 0);
    Bb(m, 1.18, 0.05, 1.0, M.graphite2, 0, 0.22, 0, { r: 0 });
    Bb(m, 0.32, 1.25, 0.3, M.graphite, 0, 0.27, -0.33);
    Bb(m, 0.34, 0.3, 0.4, M.graphite2, 0, 1.0, -0.12);
    spindle = dyn(m, 0, 0.98, 0.0);
    Cy(spindle, 0.06, 0.22, M.brass, 0, -0.11, 0);
    Bb(spindle, 0.16, 0.035, 0.035, M.brassDark, 0, -0.06, 0, { r: 0 });
    Cy(spindle, 0.022, 0.13, M.alu, 0, -0.28, 0);
    Bb(m, 0.86, 0.07, 0.46, M.graphite2, 0, 0.5, 0.05);
    Bb(m, 0.28, 0.12, 0.2, M.brass, 0, 0.57, 0.05, { r: 0.015 });
    Bb(m, 0.18, 0.09, 0.12, M.alu, 0, 0.69, 0.05, { r: 0.01 });
    Bb(m, 0.03, 0.03, 0.26, M.alu, 0.22, 0.86, 0.02, { r: 0 });
    Cy(m, 0.065, 0.025, M.bone, 0.22, 0.86, 0.17, { rx: PI / 2 });
    T(m, 0.065, 0.012, M.brass, 0.22, 0.86, 0.183, { seg: 20 });
    for (const [hx, ry, ox] of [[-0.65, -2.0, 0.31], [0.65, 2.0, -0.31]]) {
      const door = G(m, hx, 0.22, 0.55, { ry });
      Bb(door, 0.62, 1.1, 0.04, M.bone, ox, 0.15, 0);
      Bb(door, 0.4, 0.5, 0.01, M.darkGlass, ox, 0.45, 0.022, { r: 0 });
    }
  }
  Bb(m, 1.34, 0.05, 1.14, M.brass, 0, 1.6, 0, { r: 0.01 });
  Bb(m, 0.05, 0.05, 0.3, M.brass, 0.7, 1.32, 0.3, { r: 0 });
  const pend = G(m, 0.82, 1.15, 0.48, { ry: -0.5 });
  Bb(pend, 0.3, 0.38, 0.06, M.graphite, 0, 0, 0);
  plane(pend, 0.22, 0.16, screenMat(codeTex(17 + Math.round(x * 10))), 0, 0.21, 0.031);
  return spindle;
}
function lathe(p, x, z) {
  const L = G(p, x, Y0, z);
  Bb(L, 1.9, 0.62, 0.55, M.bone, 0, 0, 0);
  Bb(L, 1.92, 0.04, 0.57, M.brass, 0, 0.58, 0, { r: 0 });
  Bb(L, 1.9, 0.1, 0.4, M.graphite, 0, 0.62, -0.02);
  Bb(L, 0.48, 0.48, 0.5, M.bone, -0.7, 0.72, -0.02);
  const ch = dyn(L, -0.4, 0.94, -0.02);
  Cy(ch, 0.16, 0.12, M.brass, 0, 0, 0, { rz: PI / 2 });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * PI * 2;
    Bb(ch, 0.06, 0.07, 0.05, M.graphite, 0.05, Math.cos(a) * 0.1, Math.sin(a) * 0.1, { r: 0, rx: -a });
  }
  Cy(L, 0.045, 0.75, M.alu, 0.05, 0.94, -0.02, { rz: PI / 2 });
  Bb(L, 0.25, 0.3, 0.3, M.bone, 0.65, 0.72, -0.02);
  Bb(L, 0.22, 0.14, 0.22, M.graphite2, 0.1, 0.72, 0.1, { r: 0.015 });
  return ch;
}
function buildTormach(g, ctx) {
  const y = Y0, H = 3.3;
  Bb(g, 8.4, 0.08, 6.0, M.concrete, 0, y, -0.45, { r: 0.02 });
  Bb(g, 8.2, 0.012, 0.07, M.brassPaint, 0, y + 0.08, 0.2, { r: 0 });
  Bb(g, 8.2, 0.012, 0.07, M.brassPaint, 0, y + 0.08, -1.3, { r: 0 });
  for (const cx of [-4.1, 0, 4.1]) for (const cz of [-3.35, 2.45]) Bb(g, 0.2, H, 0.2, M.graphite, cx, y, cz, { r: 0.02 });
  Bb(g, 8.4, 0.22, 0.2, M.graphite, 0, y + H - 0.22, -3.35);
  Bb(g, 8.4, 0.22, 0.2, M.graphite, 0, y + H - 0.22, 2.45);
  for (const cx of [-4.1, 4.1]) Bb(g, 0.2, 0.22, 5.8, M.graphite, cx, y + H - 0.22, -0.45);
  Bb(g, 8.2, 2.3, 0.1, M.graphite2, 0, y, -3.4, { r: 0 });
  for (let k = 0; k < 20; k++) Bb(g, 0.04, 2.3, 0.05, M.graphite, -3.9 + k * 0.41, y, -3.33, { r: 0 });
  Bb(g, 0.1, 2.3, 5.8, M.graphite2, -4.15, y, -0.45, { r: 0 });

  const roof = dyn(g, 0, y + H, 0);                                          // glazed, lifts away
  Bb(roof, 8.6, 0.1, 0.25, M.graphite, 0, 0, -3.35, { r: 0 });
  Bb(roof, 8.6, 0.1, 0.25, M.graphite, 0, 0, 2.45, { r: 0 });
  for (const rx of [-4.2, -2.1, 0, 2.1, 4.2]) Bb(roof, 0.14, 0.12, 6.1, M.graphite, rx, 0, -0.45, { r: 0 });
  for (const rx of [-3.15, -1.05, 1.05, 3.15]) Bb(roof, 1.95, 0.04, 6.0, M.glass, rx, 0.05, -0.45, { r: 0 });
  ctx.roofs.push({ obj: roof, mode: 'lift' });

  mill(g, -2.65, -2.45, false);
  const spindle = mill(g, -0.75, -2.45, true);
  mill(g, 1.15, -2.45, false);
  const ch1 = lathe(g, -2.45, 0.85), ch2 = lathe(g, -2.45, 1.85);
  // granite inspection table
  Bb(g, 1.3, 0.72, 0.75, M.graphite, 0.75, y, 0.55);
  Bb(g, 1.4, 0.16, 0.85, M.granite, 0.75, y + 0.72, 0.55);
  Bb(g, 0.2, 0.05, 0.16, M.alu, 0.4, y + 0.88, 0.5, { r: 0 });
  Bb(g, 0.03, 0.5, 0.03, M.alu, 0.4, y + 0.93, 0.5, { r: 0 });
  Bb(g, 0.12, 0.05, 0.07, M.brass, 0.44, y + 1.15, 0.5, { r: 0 });
  for (let k = 0; k < 3; k++) Bb(g, 0.1, 0.06 + k * 0.03, 0.04, M.brass, 0.9 + k * 0.14, y + 0.88, 0.6, { r: 0 });
  // loading dock: crates, a crated machine on a pallet, pallet jack, roll-up door
  Bb(g, 0.8, 0.75, 0.8, M.wood, 3.15, y, -2.4); Bb(g, 0.82, 0.06, 0.82, M.woodDark, 3.15, y + 0.35, -2.4, { r: 0 });
  Bb(g, 0.7, 0.6, 0.7, M.wood, 3.15, y + 0.75, -2.4, { ry: 0.2 });
  Bb(g, 0.8, 0.75, 0.8, M.wood, 3.15, y, -1.4); Bb(g, 0.82, 0.06, 0.82, M.woodDark, 3.15, y + 0.35, -1.4, { r: 0 });
  Bb(g, 1.0, 0.12, 0.9, M.woodDark, 2.95, y, 0.3);
  Bb(g, 0.85, 0.8, 0.8, M.wood, 2.95, y + 0.12, 0.3);
  for (const sy of [0.2, 0.55]) Bb(g, 0.87, 0.06, 0.82, M.woodDark, 2.95, y + 0.12 + sy, 0.3, { r: 0 });
  Bb(g, 0.12, 0.06, 0.9, M.graphite, 2.05, y, 1.35, { r: 0 }); Bb(g, 0.12, 0.06, 0.9, M.graphite, 2.45, y, 1.35, { r: 0 });
  Bb(g, 0.5, 0.28, 0.22, M.oxide, 2.25, y, 1.9);
  Cy(g, 0.025, 0.9, M.graphite, 2.25, y + 0.62, 2.15, { rx: 0.5 });
  Bb(g, 0.14, 0.05, 0.05, M.brass, 2.25, y + 1.0, 2.36, { r: 0 });
  Bb(g, 0.12, H - 0.3, 0.12, M.graphite, 4.15, y, -0.9); Bb(g, 0.12, H - 0.3, 0.12, M.graphite, 4.15, y, 1.9);
  Bb(g, 0.08, 1.3, 2.8, M.graphite2, 4.15, y + 1.7, 0.5, { r: 0 });
  for (let k = 0; k < 6; k++) Bb(g, 0.1, 0.03, 2.8, M.graphite, 4.15, y + 1.75 + k * 0.21, 0.5, { r: 0 });
  figure(g, -1.5, y, -1.45, 2.6); figure(g, 2.6, y, 0.95, -0.3);

  ctx.ticks.push(t => {
    spindle.rotation.y = t * 7;
    ch1.rotation.x = t * 4; ch2.rotation.x = -t * 3;
  });
  return { focal: new THREE.Vector3(-0.75, y + 0.8, -2.4), cam: new THREE.Vector3(0.95, y + 1.95, 0.85) };
}

// ---------------------------------------------------------------------------
// 04 · Tortas Susy — the family shop, its website and its POS
// ---------------------------------------------------------------------------
function buildTortas(g, ctx) {
  const y = Y0, H = 2.8;
  Bb(g, 8.6, 0.04, 1.7, M.asphalt, 0, y, 3.55, { r: 0 });
  for (let k = -3; k <= 3; k++) Bb(g, 0.6, 0.012, 0.08, M.bone, k * 1.25, y + 0.04, 3.55, { r: 0 });
  Bb(g, 8.6, 0.14, 1.0, M.bone2, 0, y, 2.2, { r: 0.02 });
  Bb(g, 6.6, 0.06, 4.5, M.terracotta, 0, y, -0.55, { r: 0 });
  Bb(g, 6.6, H, 0.2, M.stucco, 0, y, -2.8);
  Bb(g, 0.2, H, 4.5, M.stucco, -3.3, y, -0.55);
  Bb(g, 0.2, H, 4.5, M.stucco, 3.3, y, -0.55);
  Bb(g, 6.62, 0.5, 0.24, M.oxide, 0, y, -2.8, { r: 0 });
  Bb(g, 0.24, 0.5, 4.52, M.oxide, -3.3, y, -0.55, { r: 0 });
  Bb(g, 0.24, 0.5, 4.52, M.oxide, 3.3, y, -0.55, { r: 0 });
  Bb(g, 0.6, H, 0.24, M.stucco, -3.0, y, 1.6); Bb(g, 0.6, H, 0.24, M.stucco, 3.0, y, 1.6);
  Bb(g, 6.6, 0.6, 0.24, M.stucco, 0, y + H - 0.6, 1.6);
  Bb(g, 2.7, 0.5, 0.04, M.brass, 0, y + H - 0.56, 1.73, { r: 0 });
  Bb(g, 2.6, 0.42, 0.06, M.oxide, 0, y + H - 0.52, 1.75, { r: 0 });
  // striped awning
  for (let k = 0; k < 10; k++) {
    const x = -2.7 + k * 0.6, m = k % 2 ? M.bone : M.oxide;
    B(g, 0.6, 0.035, 1.08, m, x, y + 2.0, 2.2, { rx: 0.38, r: 0 });
    Bb(g, 0.6, 0.16, 0.03, m, x, y + 1.66, 2.71, { r: 0 });
  }
  const roof = dyn(g, 0, y + H, -2.95);                                      // hinged at the back
  Bb(roof, 6.9, 0.18, 4.75, M.bone2, 0, 0, 2.4);
  Bb(roof, 6.9, 0.3, 0.12, M.stucco, 0, 0.18, 0.06); Bb(roof, 6.9, 0.3, 0.12, M.stucco, 0, 0.18, 4.72);
  Bb(roof, 0.12, 0.3, 4.75, M.stucco, -3.39, 0.18, 2.4); Bb(roof, 0.12, 0.3, 4.75, M.stucco, 3.39, 0.18, 2.4);
  Bb(roof, 0.9, 0.2, 0.9, M.brassDark, -2.0, 0.18, 1.2);
  Cb(roof, 0.42, 0.75, M.graphite, -2.0, 0.38, 1.2, { seg: 24 });             // rooftop water tank
  Cb(roof, 0.24, 0.08, M.graphite, -2.0, 1.13, 1.2);
  Cb(roof, 0.15, 0.55, M.alu, 1.9, 0.18, 0.7); Cb(roof, 0.15, 0.55, M.alu, 2.3, 0.18, 0.7);
  ctx.roofs.push({ obj: roof, mode: 'hinge' });

  // counter, bread, salsa pots
  Bb(g, 4.4, 0.92, 0.65, M.oxide, -0.2, y + 0.06, -1.85);
  Bb(g, 4.5, 0.06, 0.75, M.bone, -0.2, y + 0.98, -1.85);
  const ct = y + 1.04;
  Bb(g, 0.75, 0.04, 0.42, M.brass, -1.55, ct, -1.85, { r: 0.01 });
  for (let k = 0; k < 6; k++) S(g, 0.085, M.bread, -1.79 + (k % 3) * 0.24, ct + 0.07, -1.95 + Math.floor(k / 3) * 0.2, { s: [1.5, 0.75, 1], seg: 14 });
  for (const [px, pz] of [[-0.75, -1.95], [-0.42, -1.78], [-0.1, -1.97]]) {
    Cb(g, 0.13, 0.2, M.clay, px, ct, pz, { rt: 0.16, seg: 18 });
    Cb(g, 0.145, 0.02, M.sauce, px, ct + 0.18, pz, { seg: 18 });
  }
  // POS terminal + receipt printer (project 02)
  Bb(g, 0.16, 0.12, 0.14, M.graphite, 0.75, ct, -1.95);
  const pos = G(g, 0.75, ct + 0.14, -1.92, { rx: -0.35 });
  Bb(pos, 0.46, 0.32, 0.04, M.graphite, 0, 0.16, 0, { r: 0.015 });
  plane(pos, 0.42, 0.28, screenMat(menuTex()), 0, 0.16, 0.021);
  Bb(g, 0.22, 0.13, 0.24, M.bone, 1.15, ct, -1.9, { r: 0.02 });
  Bb(g, 0.12, 0.004, 0.16, M.paper, 1.15, ct + 0.15, -1.76, { rx: -0.6, r: 0 });
  // tablet showing the website (project 01)
  Bb(g, 0.05, 0.18, 0.05, M.brass, -2.15, ct, -1.8, { r: 0 });
  const tab = G(g, -2.15, ct + 0.18, -1.78, { rx: -0.4 });
  Bb(tab, 0.42, 0.3, 0.02, M.graphite, 0, 0.15, 0, { r: 0.01 });
  plane(tab, 0.38, 0.26, screenMat(menuTex()), 0, 0.15, 0.011);
  // shelves, lamps, tables
  Bb(g, 3.2, 0.05, 0.3, M.wood, -0.4, y + 1.7, -2.6, { r: 0 });
  Bb(g, 3.2, 0.05, 0.3, M.wood, -0.4, y + 2.15, -2.6, { r: 0 });
  for (let k = 0; k < 9; k++) Cb(g, 0.07, 0.17, [M.sage, M.clay, M.bone][k % 3], -1.8 + k * 0.33, y + (k % 2 ? 2.2 : 1.75), -2.6, { seg: 12 });
  for (const lx of [-1.4, 0.6]) {
    Cb(g, 0.008, 0.62, M.graphite, lx, y + H - 0.62, -1.5);
    Cb(g, 0.15, 0.14, M.brass, lx, y + H - 0.76, -1.5, { rt: 0.04 });
    S(g, 0.05, M.lamp, lx, y + H - 0.78, -1.5, { seg: 10 });
  }
  for (const [tx, tz] of [[-1.9, 0.5], [0.2, 0.7], [2.0, -0.2]]) {
    Cb(g, 0.04, 0.68, M.graphite, tx, y, tz); Cb(g, 0.2, 0.03, M.graphite, tx, y, tz);
    Cb(g, 0.36, 0.04, M.bone, tx, y + 0.7, tz, { seg: 32 });
    for (const sx of [-0.5, 0.5]) { Cb(g, 0.025, 0.45, M.graphite, tx + sx, y, tz); Cb(g, 0.14, 0.05, M.oxide, tx + sx, y + 0.45, tz); }
  }
  Cb(g, 0.13, 0.015, M.bone, 0.2, y + 0.74, 0.7, { seg: 24 });
  S(g, 0.085, M.bread, 0.2, y + 0.8, 0.7, { s: [1.6, 0.7, 1], seg: 14 });
  Cb(g, 0.1, 0.012, M.sauce, 0.2, y + 0.84, 0.7, { seg: 18, s: [1.4, 1, 0.9] });
  figure(g, 0.0, y, -2.4, 0); figure(g, 0.9, y, -1.1, PI); figure(g, -2.3, y, 0.6, 2.2);
  // street: delivery scooter, plants, lamp post
  const sc = G(g, -2.5, y + 0.04, 3.4);
  T(sc, 0.17, 0.055, M.graphite, -0.45, 0.17, 0, { seg: 24 }); T(sc, 0.17, 0.055, M.graphite, 0.45, 0.17, 0, { seg: 24 });
  Bb(sc, 0.7, 0.22, 0.3, M.oxide, 0, 0.18, 0, { r: 0.05 });
  Bb(sc, 0.35, 0.12, 0.28, M.graphite, -0.15, 0.42, 0, { r: 0.04 });
  B(sc, 0.1, 0.55, 0.22, M.oxide, 0.4, 0.55, 0, { rz: -0.25, r: 0.03 });
  Bb(sc, 0.04, 0.04, 0.5, M.brass, 0.48, 0.82, 0, { r: 0 });
  Bb(sc, 0.42, 0.38, 0.42, M.bone, -0.42, 0.54, 0, { r: 0.04 });
  Cy(sc, 0.06, 0.04, M.lamp, 0.53, 0.66, 0, { rz: PI / 2 });
  for (const ppx of [-3.65, 3.65]) { Cb(g, 0.18, 0.3, M.clay, ppx, y + 0.14, 2.15, { rt: 0.22 }); S(g, 0.3, M.sage, ppx, y + 0.68, 2.15, { s: [1, 1.15, 1] }); }
  Cb(g, 0.05, 2.4, M.graphite, 3.95, y + 0.14, 2.55);
  Bb(g, 0.5, 0.04, 0.04, M.graphite, 3.75, y + 2.5, 2.55, { r: 0 });
  Cb(g, 0.14, 0.14, M.brass, 3.52, y + 2.36, 2.55, { rt: 0.04 });
  S(g, 0.05, M.lamp, 3.52, y + 2.36, 2.55, { seg: 10 });

  return { focal: new THREE.Vector3(0.6, ct + 0.3, -1.92), cam: new THREE.Vector3(2.4, y + 4.0, 3.2), pull: 1 };
}

// ---------------------------------------------------------------------------
// 05 · the Tetris studio (C++ / SFML)
// ---------------------------------------------------------------------------
function buildTetris(g, ctx) {
  const y = Y0, H = 2.7;
  Bb(g, 6.8, 0.06, 4.8, M.bone2, 0, y, -0.5, { r: 0 });
  Bb(g, 2.6, 0.015, 1.7, M.sage, -0.3, y + 0.06, -1.2, { r: 0 });
  Bb(g, 2.3, 0.016, 1.4, M.bone, -0.3, y + 0.061, -1.2, { r: 0 });
  Bb(g, 2.2, 0.017, 1.3, M.sage, -0.3, y + 0.062, -1.2, { r: 0 });
  Bb(g, 1.3, 0.95, 0.05, M.graphite, 0.15, y + 1.2, -2.77);
  Bb(g, 1.15, 0.8, 0.02, M.paper, 0.15, y + 1.275, -2.74, { r: 0 });
  for (const [cx, cy, m] of [[-0.15, 0, M.oxide], [0.05, 0, M.oxide], [0.05, 0.2, M.oxide], [0.25, 0, M.oxide],
                             [0.25, 0.2, M.sage], [0.45, 0.2, M.sage], [0.45, 0.4, M.sage], [-0.15, 0.2, M.brass], [-0.15, 0.4, M.brass]]) {
    Bb(g, 0.18, 0.18, 0.02, m, cx, y + 1.4 + cy, -2.72, { r: 0 });
  }
  Cb(g, 0.18, 0.04, M.graphite, -2.9, y, -2.4); Cb(g, 0.02, 1.7, M.brass, -2.9, y, -2.4);
  Cb(g, 0.2, 0.22, M.brass, -2.9, y + 1.7, -2.4, { rt: 0.08 }); S(g, 0.06, M.lamp, -2.9, y + 1.72, -2.4, { seg: 10 });
  Bb(g, 6.8, H, 0.2, M.stucco, 0, y, -2.9);
  Bb(g, 0.2, H, 4.8, M.stucco, -3.4, y, -0.5);
  Bb(g, 0.2, H, 4.8, M.stucco, 3.4, y, -0.5);
  for (const wx of [3.52, 3.28]) {
    T(g, 0.45, 0.06, M.brass, wx, y + 1.5, -0.6, { ry: PI / 2, seg: 40 });
    Cy(g, 0.42, 0.02, M.glass, wx, y + 1.5, -0.6, { rz: PI / 2, seg: 40 });
  }
  Bb(g, 0.7, H, 0.22, M.stucco, -3.05, y, 1.8); Bb(g, 0.7, H, 0.22, M.stucco, 3.05, y, 1.8);
  Bb(g, 6.8, 0.45, 0.22, M.stucco, 0, y + H - 0.45, 1.8);
  Bb(g, 6.84, 0.08, 0.26, M.graphite, 0, y + H - 0.08, 1.8, { r: 0 });

  const roof = dyn(g, 0, y + H, -3.05);
  Bb(roof, 7.1, 0.2, 5.0, M.graphite2, 0, 0, 2.5);
  for (let k = 0; k <= 8; k++) {
    Cb(roof, 0.02, 0.4, M.brass, -3.4 + k * 0.85, 0.2, 0.15);
    Cb(roof, 0.02, 0.4, M.brass, -3.4 + k * 0.85, 0.2, 4.85);
  }
  Bb(roof, 6.9, 0.03, 0.03, M.brass, 0, 0.6, 0.15, { r: 0 }); Bb(roof, 6.9, 0.03, 0.03, M.brass, 0, 0.6, 4.85, { r: 0 });
  tetro(roof, 'S', M.oxide, -1.6, 0.2, 2.0, 0.38);
  tetro(roof, 'L', M.sage, 1.0, 0.2, 3.0, 0.38, { ry: 0.5 });
  ctx.roofs.push({ obj: roof, mode: 'hinge' });

  // arcade cabinet with a live game
  const tet = makeTetris();
  const a = G(g, -1.45, y, -2.25);
  Bb(a, 0.7, 1.8, 0.66, M.graphite, 0, 0, 0);
  Bb(a, 0.02, 1.8, 0.68, M.brass, -0.36, 0, 0, { r: 0 }); Bb(a, 0.02, 1.8, 0.68, M.brass, 0.36, 0, 0, { r: 0 });
  Bb(a, 0.6, 0.62, 0.04, M.graphite2, 0, 1.0, 0.33, { rx: -0.12, r: 0.01 });
  plane(a, 0.5, 0.54, screenMat(tet.tex), 0, 1.31, 0.356, { rx: -0.12 });
  Bb(a, 0.7, 0.07, 0.34, M.graphite2, 0, 0.92, 0.45, { rx: 0.22 });
  Cb(a, 0.015, 0.12, M.alu, -0.15, 0.98, 0.48); S(a, 0.04, M.oxide, -0.15, 1.12, 0.48, { seg: 12 });
  Cb(a, 0.03, 0.02, M.sage, 0.05, 0.99, 0.47, { seg: 12 }); Cb(a, 0.03, 0.02, M.brass, 0.15, 0.99, 0.46, { seg: 12 });
  Cb(a, 0.03, 0.02, M.bone, 0.25, 0.99, 0.45, { seg: 12 });
  Bb(a, 0.6, 0.75, 0.02, M.oxide, 0, 0.08, 0.335, { r: 0 });
  Bb(a, 0.7, 0.22, 0.12, M.marquee, 0, 1.6, 0.28, { r: 0.02 });
  // desk, monitor, keyboard, chair
  Bb(g, 2.0, 0.06, 0.75, M.wood, 1.3, y + 0.74, -2.3);
  for (const [lx, lz] of [[0.4, -2.6], [2.2, -2.6], [0.4, -2.0], [2.2, -2.0]]) Bb(g, 0.05, 0.74, 0.05, M.graphite, lx, y, lz, { r: 0 });
  Bb(g, 0.06, 0.25, 0.06, M.graphite, 1.3, y + 0.8, -2.5, { r: 0 });
  Bb(g, 0.85, 0.5, 0.03, M.graphite, 1.3, y + 1.05, -2.52, { r: 0.01 });
  plane(g, 0.8, 0.45, screenMat(codeTex(29)), 1.3, y + 1.3, -2.503);
  Bb(g, 0.56, 0.03, 0.18, M.graphite, 1.25, y + 0.8, -2.08, { r: 0.01 });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 12; c++) {
    Bb(g, 0.034, 0.02, 0.034, (r === 0 && c % 5 === 0) ? M.oxide : M.bone, 1.25 - 0.231 + c * 0.042, y + 0.83, -2.143 + r * 0.042, { r: 0 });
  }
  Cb(g, 0.05, 0.1, M.oxide, 1.95, y + 0.8, -2.2, { seg: 14 });
  Bb(g, 0.45, 0.07, 0.45, M.oxide, 1.25, y + 0.45, -1.55); Bb(g, 0.45, 0.5, 0.06, M.oxide, 1.25, y + 0.52, -1.33);
  Cb(g, 0.03, 0.45, M.graphite, 1.25, y, -1.55);
  Bb(g, 0.5, 0.03, 0.06, M.graphite, 1.25, y, -1.55, { r: 0 }); Bb(g, 0.06, 0.03, 0.5, M.graphite, 1.25, y, -1.55, { r: 0 });
  figure(g, -0.75, y, -1.45, -2.6);
  // tetromino sculptures around the studio
  tetro(g, 'L', M.oxide, -3.2, y, 2.65, 0.42, { ry: 0.3 });
  tetro(g, 'O', M.brass, 2.1, y, 2.6, 0.42);
  tetro(g, 'T', M.sage, 2.1, y + 0.84, 2.6, 0.42);
  tetro(g, 'S', M.bone, 4.05, y, 0.4, 0.42, { ry: -PI / 2 });
  const fall = dyn(g, 0.2, y + 4.6, 2.4);
  tetro(fall, 'T', M.brass, -0.42, -0.32, 0, 0.42);

  ctx.ticks.push((t, dt) => {
    tet.tick(dt);
    fall.rotation.y = t * 0.45;
    fall.position.y = y + 4.6 + 0.25 * Math.sin(t * 0.8);
  });
  return { focal: new THREE.Vector3(-1.45, y + 1.31, -1.9), cam: new THREE.Vector3(1.6, y + 4.4, 3.6), pull: 1 };
}

// ---------------------------------------------------------------------------
// 06 · finale — a machined hand holding out a sealed envelope
// ---------------------------------------------------------------------------
function buildContacto(g, ctx) {
  const y = Y0;
  Cb(g, 2.4, 0.5, M.graphite, 0, y, 0, { seg: 64 });
  Cb(g, 2.46, 0.05, M.brass, 0, y + 0.5, 0, { seg: 64 });
  Cb(g, 2.2, 0.06, M.bone, 0, y + 0.55, 0, { seg: 64 });
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * PI * 2, len = k % 4 ? 0.12 : 0.24, rr = 2.08 - len / 2;
    B(g, 0.03, 0.015, len, M.brass, Math.sin(a) * rr, y + 0.61, Math.cos(a) * rr, { ry: a, r: 0 });
  }
  T(g, 3.3, 0.018, M.brass, 0, y + 2.6, 0, { rx: PI / 2 + 0.18, seg: 128 });
  T(g, 3.65, 0.012, M.brassDark, 0, y + 2.4, 0, { rx: PI / 2 - 0.12, rz: 0.2, seg: 128 });

  const arm = G(g, 0, y + 0.61, -0.4, { rx: 0.28 });
  Cb(arm, 0.6, 0.3, M.brass, 0, 0, 0, { seg: 40 });
  Cb(arm, 0.42, 0.25, M.graphite, 0, 0.3, 0, { seg: 32 });
  Cb(arm, 0.3, 1.7, M.graphite2, 0, 0.55, 0, { rt: 0.26, seg: 32 });
  Cb(arm, 0.31, 0.06, M.brass, 0, 0.9, 0, { seg: 32 }); Cb(arm, 0.28, 0.06, M.brass, 0, 1.75, 0, { seg: 32 });
  S(arm, 0.32, M.brass, 0, 2.35, 0, { seg: 28 });
  const hand = G(arm, 0, 2.45, 0.05, { rx: 0.1 });
  B(hand, 1.25, 0.32, 1.15, M.brass, 0, 0.12, 0, { r: 0.12 });
  Cy(hand, 0.12, 1.2, M.graphite, 0, 0.12, 0.6, { rz: PI / 2 });
  const lens = [0.42, 0.34, 0.28];
  for (let k = 0; k < 4; k++) {
    let parent = hand, off = [-0.45 + k * 0.3, 0.12, 0.62];
    for (let j = 0; j < 3; j++) {
      const seg = G(parent, off[0], off[1], off[2], { rx: j ? -0.42 : -0.12 });
      Cy(seg, 0.105, 0.23, M.brass, 0, 0, 0, { rz: PI / 2 });
      B(seg, 0.21, 0.2, lens[j], M.graphite, 0, 0, lens[j] / 2 + 0.06, { r: 0.06 });
      parent = seg; off = [0, 0, lens[j] + 0.1];
    }
  }

  const env = G(hand, 0.05, 0.74, 0.3, { rx: 0.95 });
  B(env, 1.5, 0.03, 1.0, M.paper, 0, 0, 0, { r: 0.012 });
  Cy(env, 0.6, 0.012, M.paper2, 0, 0.021, -0.275, { seg: 3, s: [2.4, 1, 0.75] });
  Cy(env, 0.14, 0.04, M.oxide, 0, 0.035, 0.12, { seg: 28 });
  Cy(env, 0.085, 0.05, M.oxideDark, 0, 0.04, 0.12, { seg: 20 });

  // small objects in slow orbit: gear, calipers, circuit board, a tetromino
  const orbit = dyn(g, 0, y + 2.9, 0, { rx: 0.12 });
  const items = [];
  const mkItem = (a, r) => { const it = dyn(orbit, Math.cos(a) * r, 0, Math.sin(a) * r); items.push(it); return it; };
  const gear = mkItem(0.3, 3.3);
  Cy(gear, 0.38, 0.1, M.brass, 0, 0, 0, { rx: PI / 2, seg: 32 });
  for (let k = 0; k < 14; k++) { const a = (k / 14) * PI * 2; B(gear, 0.12, 0.14, 0.1, M.brass, Math.cos(a) * 0.43, Math.sin(a) * 0.43, 0, { rz: a, r: 0 }); }
  Cy(gear, 0.12, 0.16, M.graphite, 0, 0, 0, { rx: PI / 2, seg: 16 });
  const cal = mkItem(1.9, 3.4);
  B(cal, 1.1, 0.03, 0.08, M.alu, 0, 0, 0, { r: 0 });
  B(cal, 0.05, 0.03, 0.3, M.alu, -0.52, 0, 0.12, { r: 0 });
  B(cal, 0.16, 0.05, 0.28, M.brass, -0.15, 0, 0.08, { r: 0.01 });
  B(cal, 0.05, 0.03, 0.22, M.alu, -0.2, 0, 0.18, { r: 0 });
  const pcb = mkItem(3.4, 3.25);
  B(pcb, 0.7, 0.04, 0.48, M.sage, 0, 0, 0, { r: 0 });
  B(pcb, 0.16, 0.05, 0.16, M.graphite, -0.1, 0.04, 0, { r: 0 });
  B(pcb, 0.36, 0.05, 0.04, M.brass, 0.1, 0.04, 0.17, { r: 0 });
  const tb = mkItem(4.9, 3.35);
  tetro(tb, 'T', M.oxide, -0.24, -0.18, 0, 0.24);

  ctx.ticks.push(t => {
    orbit.rotation.y = t * 0.12;
    items.forEach((it, k) => { it.rotation.x = t * 0.35 + k; it.rotation.y = t * 0.25 + k * 2; });
  });
  return { focal: env, camOff: new THREE.Vector3(3.4, 2.4, 7.4) };
}

const BUILDERS = [buildTaller, buildCeti, buildTormach, buildTortas, buildTetris, buildContacto];

// ---------------------------------------------------------------------------
// drafting-table decor: route dashes, registration rings, labels, pencil, ruler
// ---------------------------------------------------------------------------
function buildDecor(scene, islands) {
  const d = new THREE.Group();
  scene.add(d);
  const pts = islands.map(I => I.center.clone().setY(0));
  const route = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const len = route.getLength();
  for (let s = 0; s < len; s += 0.9) {
    const p = route.getPointAt(s / len), tg = route.getTangentAt(s / len);
    if (islands.some(I => Math.hypot(p.x - I.center.x, p.z - I.center.z) < R + 1.4)) continue;
    B(d, 0.5, 0.01, 0.07, M.brassPaint, p.x, 0.01, p.z, { ry: Math.atan2(-tg.z, tg.x), r: 0 });
  }
  islands.forEach((I, i) => {
    T(d, R + 0.9, 0.02, M.brassPaint, I.center.x, 0.01, I.center.z, { rx: PI / 2, seg: 96 });
    for (let k = 0; k < 4; k++) {
      const a = k * PI / 2;
      B(d, 0.04, 0.01, 0.9, M.brassPaint, I.center.x + Math.sin(a) * (R + 0.9), 0.012, I.center.z + Math.cos(a) * (R + 0.9), { ry: a, r: 0 });
    }
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 0.9),
      new THREE.MeshBasicMaterial({ map: I.labelTex = labelTex(LABELS[i]), transparent: true, depthWrite: false, toneMapped: false }));
    const lg = new THREE.Group();
    lg.position.set(I.center.x - 3.1, 0.02, I.center.z + R + 2.0);
    lg.rotation.y = 0.46;
    lab.rotation.x = -PI / 2;
    lg.add(lab);
    scene.add(lg);
  });
  // an oversized pencil and a steel rule left on the sheet
  const pen = G(d, 44, 0.22, 10, { ry: 0.55 });
  Cy(pen, 0.22, 7.5, M.pencil, 0, 0, 0, { rz: PI / 2, seg: 6 });
  Cy(pen, 0.225, 0.5, M.brass, -4.0, 0, 0, { rz: PI / 2, seg: 24 });
  Cy(pen, 0.21, 0.42, M.oxide, -4.45, 0, 0, { rz: PI / 2, seg: 24 });
  Cy(pen, 0.22, 1.0, M.wood, 4.25, 0, 0, { rz: -PI / 2, rt: 0.06, seg: 6 });
  Cy(pen, 0.06, 0.28, M.graphite, 4.89, 0, 0, { rz: -PI / 2, rt: 0.005, seg: 6 });
  const rule = G(d, 105, 0.03, -16, { ry: -0.3 });
  B(rule, 12, 0.05, 1.3, M.alu, 0, 0, 0, { r: 0 });
  for (let k = 0; k <= 48; k++) B(rule, 0.025, 0.01, k % 4 ? 0.18 : 0.38, M.graphite, -5.8 + k * 0.2417, 0.03, 0.65 - (k % 4 ? 0.09 : 0.19), { r: 0 });
  const prot = G(d, 15, 0.02, -13, { ry: 0.3 });
  place(new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.03, 48, 1, false, 0, PI), M.brassPaint), prot, 0, 0, 0, {});
  for (let k = 0; k <= 18; k++) {
    const a = (k / 18) * PI;
    B(prot, 0.03, 0.01, k % 3 ? 0.18 : 0.35, M.graphite, Math.sin(a) * 1.95, 0.02, Math.cos(a) * 1.95, { ry: a, r: 0 });
  }
  bake(d);
  // redraw labels once the mono face has loaded
  if (document.fonts && document.fonts.load) {
    document.fonts.load('500 72px "IBM Plex Mono"').then(() => islands.forEach(I => {
      const t = I.labelTex; t.userData.draw(t.userData.ctx, 1024, 140); t.needsUpdate = true;
    })).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------
export function mountWorld3D(host, bridge) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(hover: none) and (pointer: coarse)').matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    host.classList.add('is-failed');
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.setClearColor(BG, 1);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  M = makeMaterials();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 46, 140);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;

  scene.add(new THREE.HemisphereLight(0xF6F1E7, 0xC9BDA4, 1.0));
  const sun = new THREE.DirectionalLight(0xFFE4C4, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: gridTex(renderer), roughness: 1, metalness: 0 }));
  ground.material.map.repeat.set(70, 70);
  ground.material.color.setRGB(0.69, 0.75, 0.81);
  ground.rotation.x = -PI / 2;
  ground.position.set(76, 0, -4);
  ground.receiveShadow = true;
  scene.add(ground);
  const blob = blobTex();

  // islands
  const islands = CENTERS.map((c, i) => {
    const g = new THREE.Group();
    g.position.set(c[0], c[1], c[2]);
    scene.add(g);
    islandBase(g);
    const ctx = { roofs: [], ticks: [] };
    const r = BUILDERS[i](g, ctx);
    bakeTree(g);
    g.updateMatrixWorld(true);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2 * R + 6, 2 * R + 6),
      new THREE.MeshBasicMaterial({ map: blob, color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false }));
    shadow.rotation.x = -PI / 2;
    shadow.position.set(c[0] + 0.6, 0.006, c[2] + 0.4);
    scene.add(shadow);

    const center = g.position.clone();
    const focal = r.focal.isObject3D ? r.focal.getWorldPosition(new THREE.Vector3()) : r.focal.clone().add(center);
    let cam = r.cam ? r.cam.clone().add(center) : focal.clone().add(r.camOff);
    const k = r.pull != null ? r.pull : (r.cam ? 1.8 : 1);
    cam = focal.clone().add(cam.sub(focal).multiplyScalar(k));
    const E = center.clone().add(E_OFF);
    const lookE = center.clone().add(new THREE.Vector3(0, 2.0, 0));
    const mid = E.clone().lerp(cam, 0.55).add(new THREE.Vector3(2.5, 1.2, 1.5));
    ctx.roofs.forEach(rf => { rf.base = rf.obj.position.clone(); rf.open = 0; });
    return {
      g, center, focal, cam, E, lookE, drift: 0.22,
      diveCurve: new THREE.CatmullRomCurve3([E, mid, cam], false, 'centripetal'),
      roofs: ctx.roofs, ticks: ctx.ticks,
    };
  });
  const NI = islands.length, NSEG = 2 * NI - 1;

  // ---- camera chain ----
  const tmp = new THREE.Vector3();
  function divePose(i, t, out) {
    const I = islands[i];
    I.diveCurve.getPoint(ease(t / 0.72), out.pos);
    out.look.lerpVectors(I.lookE, I.focal, ease(t / 0.78));
    const th = I.drift * smoothstep(0.4, 1, t);
    if (th) { tmp.subVectors(out.pos, I.focal).applyAxisAngle(UP, th); out.pos.copy(I.focal).add(tmp); }
  }
  for (let i = 0; i < NI - 1; i++) {
    const a = islands[i], b = islands[i + 1];
    const end = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    divePose(i, 1, end);
    const mid = a.center.clone().lerp(b.center, 0.5);
    a.connCurve = new THREE.CatmullRomCurve3([
      end.pos, a.center.clone().add(new THREE.Vector3(-1, 16, 14)),
      mid.clone().add(new THREE.Vector3(0, 27, 22)), b.E.clone(),
    ], false, 'centripetal');
    a.connLook = new THREE.CatmullRomCurve3([
      a.focal.clone(), a.center.clone().add(new THREE.Vector3(0, 1.5, 0)),
      mid.clone().lerp(b.center, 0.35), b.lookE.clone(),
    ], false, 'centripetal');
  }
  function pose(P, out) {
    let k = Math.floor(P), t = P - k;
    if (k >= NSEG) { k = NSEG - 1; t = 1; }
    if (k < 0) { k = 0; t = 0; }
    if (k % 2 === 0) divePose(k / 2, t, out);
    else { const I = islands[(k - 1) / 2], e = ease(t); I.connCurve.getPoint(e, out.pos); I.connLook.getPoint(e, out.look); }
  }

  buildDecor(scene, islands);

  // ---- camera, viewport ----
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
  let W = 0, Hh = 0, pull = 1;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    if (coarse && w === W && Math.abs(h - Hh) < 160) return;     // ignore URL-bar-only changes
    W = w; Hh = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    camera.fov = aspect < 0.8 ? 44 : aspect < 1.25 ? 36 : 30;
    pull = aspect < 0.8 ? 1.45 : 1;
    // lens shift: keep the subject clear of the copy (left column on desktop, bottom on phones)
    const sx = w > 860 ? 0.12 : 0, sy = w <= 860 ? 0.16 : 0;
    camera.setViewOffset(w, h, -sx * w, sy * h, w, h);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  let dirty = true;
  addEventListener('resize', resize);
  resize();

  // pointer parallax (desktop only)
  let mx = 0, my = 0, pmx = 0, pmy = 0;
  if (!coarse && !reduce) {
    addEventListener('pointermove', e => { mx = (e.clientX / innerWidth) * 2 - 1; my = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  }

  // ---- loop ----
  const cur = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const right = new THREE.Vector3(), shadowAt = new THREE.Vector3();
  const SHADOW_SHIFT = new THREE.Vector3(3.5, 0, -2.6);   // shadows fall down-sun of each island
  let P = 0, lastP = -1, time = reduce ? 3.2 : 0, last = performance.now(), shadowSize = 0, first = true;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (document.hidden) return;
    const st = bridge.state;
    let target = st ? st.seg + st.local : 0;
    if (reduce && st) target = 2 * st.near + 0.85;          // settled view per section, no flight
    P = reduce ? target : P + (target - P) * (1 - Math.exp(-dt * 5.5));
    if (Math.abs(target - P) < 1e-4) P = target;
    if (reduce && P === lastP && !dirty) return;
    lastP = P; dirty = false;
    if (!reduce) time += dt;
    draw(dt, reduce);
    if (first) { first = false; host.classList.add('is-ready'); }
  }

  function draw(dt, snap) {
    pose(P, cur);
    if (pull !== 1) cur.pos.sub(cur.look).multiplyScalar(pull).add(cur.look);
    pmx += (mx - pmx) * Math.min(1, dt * 3); pmy += (my - pmy) * Math.min(1, dt * 3);
    const camDist = cur.pos.distanceTo(cur.look);
    if (pmx || pmy) {
      right.subVectors(cur.look, cur.pos).cross(UP).normalize();
      const k = clamp(camDist / 20, 0.12, 1);
      cur.pos.addScaledVector(right, pmx * 0.6 * k).addScaledVector(UP, -pmy * 0.35 * k);
    }
    camera.position.copy(cur.pos);
    camera.lookAt(cur.look);

    const fi = clamp(P / 2, 0, NI - 1), i0 = Math.floor(fi), i1 = Math.min(NI - 1, i0 + 1);
    shadowAt.lerpVectors(islands[i0].center, islands[i1].center, smoothstep(0.25, 0.75, fi - i0)).add(SHADOW_SHIFT);
    sun.target.position.copy(shadowAt);
    sun.position.copy(shadowAt).addScaledVector(SUN_DIR, 60);
    const s = 20;
    if (s !== shadowSize) {
      shadowSize = s;
      Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
      sun.shadow.camera.updateProjectionMatrix();
    }

    for (const I of islands) {
      const d = camera.position.distanceTo(I.center);
      const want = 1 - smoothstep(9, 18, d);
      for (const rf of I.roofs) {
        rf.open = snap ? want : rf.open + (want - rf.open) * Math.min(1, dt * 6);
        const e = ease(rf.open);
        if (rf.mode === 'hinge') {
          rf.obj.rotation.x = -1.05 * e;
          rf.obj.position.y = rf.base.y + 0.9 * e;
        } else {
          rf.obj.position.set(rf.base.x + 0.6 * e, rf.base.y + 4.2 * e, rf.base.z);
          rf.obj.rotation.z = -0.1 * e;
        }
      }
      if (d < 60) I.ticks.forEach(fn => fn(time, reduce ? 0 : dt));
    }

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  return {
    scene, camera, renderer, islands,
    // render one settled frame at chain position p (debugging / QA captures)
    renderAt(p, t = 3) { P = p; time = t; pmx = pmy = 0; draw(0, true); return renderer.domElement; },
  };
}

import { hslToRgb } from './merkury';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

let _t = 0;
export function resetFxTime() { _t = 0; }

const fireHeat = new Float32Array(256);
const rainDrops = new Array(256).fill(0);
const rainColors = [[0, 100, 255], [0, 180, 255], [0, 255, 200], [0, 255, 100]];

const snakeState = { pos: 0, dir: 1, len: 6, trail: new Int16Array(256).fill(-1) };
const meteorState = Array.from({ length: 4 }, () => ({
  x: Math.floor(Math.random() * 16), y: -1,
  speed: 1 + Math.random() * 2,
  col: hslToRgb(Math.random() * 360, 1, 0.7),
  len: 3 + Math.floor(Math.random() * 5)
}));

const matrixCols = Array.from({ length: 16 }, () => ({
  y: Math.floor(Math.random() * 16),
  speed: 0.3 + Math.random() * 0.5,
  trail: new Array(16).fill(0)
}));

const rippleRings = [];
let rippleNext = 0;

const confettiPieces = Array.from({ length: 20 }, () => ({
  x: Math.random() * 16, y: Math.random() * 16 - 8,
  vy: 0.3 + Math.random() * 0.5,
  col: hslToRgb(Math.random() * 360, 1, 0.7)
}));

export const EFFECTS = {
  fire: () => {
    for (let i = 0; i < 256; i++) fireHeat[i] = Math.max(0, fireHeat[i] - Math.random() * 0.08 - 0.02);
    for (let x = 0; x < 16; x++) fireHeat[15 * 16 + x] = Math.min(1, fireHeat[15 * 16 + x] + Math.random() * 0.6 + 0.4);
    for (let y = 0; y < 15; y++) for (let x = 0; x < 16; x++) {
      const xl = x > 0 ? fireHeat[y * 16 + x - 1] : fireHeat[y * 16 + x];
      const xr = x < 15 ? fireHeat[y * 16 + x + 1] : fireHeat[y * 16 + x];
      fireHeat[y * 16 + x] = (fireHeat[(y + 1) * 16 + x] + xl + xr) / 3;
    }
    return Array.from(fireHeat).map(v => {
      const h = clamp(v, 0, 1);
      if (h < 0.33) return [Math.round(h * 3 * 200), 0, 0];
      else if (h < 0.66) return [200, Math.round((h - 0.33) * 3 * 200), 0];
      else return [255, Math.round((h - 0.66) * 3 * 255), Math.round((h - 0.66) * 3 * 128)];
    });
  },

  rain: () => {
    const grid = new Array(256).fill(null).map(() => [0, 0, 0]);
    for (let y = 15; y > 0; y--) for (let x = 0; x < 16; x++) if (rainDrops[(y - 1) * 16 + x]) rainDrops[y * 16 + x] = rainDrops[(y - 1) * 16 + x];
    for (let x = 0; x < 16; x++) rainDrops[x] = 0;
    if (Math.random() < 0.3) { const x = Math.floor(Math.random() * 16); rainDrops[x] = rainColors[Math.floor(Math.random() * rainColors.length)]; }
    for (let i = 0; i < 256; i++) if (rainDrops[i]) grid[i] = rainDrops[i];
    return grid;
  },

  plasma: () => {
    _t += 0.08;
    return Array.from({ length: 256 }, (_, i) => {
      const x = i % 16 / 16, y = Math.floor(i / 16) / 16;
      const v = Math.sin(x * 8 + _t) + Math.sin(y * 8 + _t) + Math.sin((x + y) * 6 + _t) + Math.sin(Math.sqrt((x - .5) ** 2 + (y - .5) ** 2) * 10 + _t);
      const n = (v + 4) / 8;
      return [Math.round(Math.sin(n * Math.PI * 2) * 127 + 128), Math.round(Math.sin(n * Math.PI * 2 + 2.094) * 127 + 128), Math.round(Math.sin(n * Math.PI * 2 + 4.189) * 127 + 128)];
    });
  },

  sparkle: () => {
    return Array.from({ length: 256 }, () => {
      if (Math.random() < 0.05) return hslToRgb(Math.random() * 360, 1, 0.5 + Math.random() * 0.5);
      return [0, 0, 0];
    });
  },

  snake: () => {
    const s = snakeState;
    for (let i = 0; i < 256; i++) if (s.trail[i] > 0) s.trail[i]--;
    s.trail[s.pos] = s.len;
    s.pos = (s.pos + s.dir + 256) % 256;
    if (Math.random() < 0.15) { const dirs = [-1, 1, -16, 16]; s.dir = dirs[Math.floor(Math.random() * dirs.length)]; }
    const col = hslToRgb(_t * 100 % 360, 1, 0.6);
    _t += 0.002;
    return Array.from({ length: 256 }, (_, i) => {
      if (s.trail[i] <= 0) return [0, 0, 0];
      const f = s.trail[i] / s.len;
      return [Math.round(col[0] * f), Math.round(col[1] * f), Math.round(col[2] * f)];
    });
  },

  wave: () => {
    _t += 0.12;
    return Array.from({ length: 256 }, (_, i) => {
      const x = i % 16, y = Math.floor(i / 16);
      const hue = (x * 22.5 + y * 5 + _t * 50) % 360;
      return hslToRgb(hue, 1, 0.55);
    });
  },

  meteors: () => {
    const grid = new Array(256).fill(null).map(() => [0, 0, 0]);
    meteorState.forEach(m => {
      m.y += m.speed * 0.5;
      if (m.y > 16 + m.len) { m.y = -m.len; m.x = Math.floor(Math.random() * 16); m.col = hslToRgb(Math.random() * 360, 1, 0.7); }
      for (let j = 0; j < m.len; j++) {
        const py = Math.round(m.y) - j;
        if (py >= 0 && py < 16) { const f = (m.len - j) / m.len; grid[py * 16 + m.x] = [Math.round(m.col[0] * f), Math.round(m.col[1] * f), Math.round(m.col[2] * f)]; }
      }
    });
    return grid;
  },

  pulse: () => {
    _t += 0.06;
    const v = Math.sin(_t) * 0.5 + 0.5;
    const col = hslToRgb(_t * 30 % 360, 1, 0.3 + v * 0.5);
    return new Array(256).fill(col);
  },

  matrix: () => {
    const grid = new Array(256).fill(null).map(() => [0, 0, 0]);
    matrixCols.forEach((c, x) => {
      c.y += c.speed;
      if (c.y > 16) { c.y = 0; c.trail.fill(0); }
      for (let i = 0; i < c.trail.length; i++) c.trail[i] = Math.max(0, c.trail[i] - 0.15);
      c.trail[Math.floor(c.y) % 16] = 1;
      for (let y = 0; y < 16; y++) {
        const f = c.trail[y];
        if (f > 0) grid[y * 16 + x] = [0, Math.round(f === 1 ? 255 : f * 150), 0];
      }
    });
    return grid;
  },

  ripple: () => {
    _t++;
    if (_t - rippleNext > 12) {
      rippleRings.push({ cx: 2 + Math.floor(Math.random() * 12), cy: 2 + Math.floor(Math.random() * 12), r: 0, col: hslToRgb(Math.random() * 360, 1, 0.7) });
      rippleNext = _t;
    }
    const grid = new Array(256).fill(null).map(() => [0, 0, 0]);
    for (let ri = rippleRings.length - 1; ri >= 0; ri--) {
      const ring = rippleRings[ri]; ring.r += 0.4;
      if (ring.r > 16) { rippleRings.splice(ri, 1); continue; }
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const d = Math.sqrt((x - ring.cx) ** 2 + (y - ring.cy) ** 2);
        const dist = Math.abs(d - ring.r);
        if (dist < 1.2) { const f = (1.2 - dist) / 1.2; grid[y * 16 + x] = [Math.round(ring.col[0] * f), Math.round(ring.col[1] * f), Math.round(ring.col[2] * f)]; }
      }
    }
    return grid;
  },

  confetti: () => {
    const grid = new Array(256).fill(null).map(() => [0, 0, 0]);
    confettiPieces.forEach(p => {
      p.y += p.vy;
      if (p.y > 16) { p.y = -2; p.x = Math.random() * 16; p.col = hslToRgb(Math.random() * 360, 1, 0.7); }
      const xi = Math.floor(p.x), yi = Math.floor(p.y);
      if (xi >= 0 && xi < 16 && yi >= 0 && yi < 16) grid[yi * 16 + xi] = p.col;
    });
    return grid;
  },

  pride: () => {
    _t += 2;
    const stripe = [[255, 0, 0], [255, 165, 0], [255, 255, 0], [0, 255, 0], [0, 0, 255], [139, 0, 211]];
    return Array.from({ length: 256 }, (_, i) => {
      const x = i % 16, y = Math.floor(i / 16);
      const si = Math.floor((_t / 4 + x + y * 0.3) % 6 + 6) % 6;
      return stripe[si];
    });
  },
};

export const FX_META = [
  { id: 'fire', name: '🔥 Fire', desc: 'Upward flickering flame simulation' },
  { id: 'rain', name: '🌧 Rain', desc: 'Falling colored drops' },
  { id: 'plasma', name: '🌀 Plasma', desc: 'Smooth sine-wave color field' },
  { id: 'sparkle', name: '✨ Sparkle', desc: 'Random twinkling pixels' },
  { id: 'snake', name: '🐍 Snake', desc: 'Wandering color snake' },
  { id: 'wave', name: '🌊 Wave', desc: 'Scrolling rainbow wave' },
  { id: 'meteors', name: '☄ Meteors', desc: 'Falling light streaks' },
  { id: 'pulse', name: '💗 Pulse', desc: 'Breathing color pulse' },
  { id: 'matrix', name: '🖥 Matrix', desc: 'Falling green code rain' },
  { id: 'ripple', name: '💧 Ripple', desc: 'Circular expanding rings' },
  { id: 'confetti', name: '🎉 Confetti', desc: 'Multi-color random bursts' },
  { id: 'pride', name: '🏳️‍🌈 Pride', desc: 'Scrolling rainbow stripes' },
];
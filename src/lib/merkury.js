// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Merkury LED Display — connection & protocol manager
//  Supports: BLE (MI-LNL62-999W) + USB Serial
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BLE_SERVICE        = '0000ffd0-0000-1000-8000-00805f9b34fb';
const BLE_CHARACTERISTIC = '0000ffd1-0000-1000-8000-00805f9b34fb';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function hexToBytes(hexStr) {
  const h = hexStr.replace(/\s/g, '');
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function buildMerkuryBlock(blockIndex, pixels32) {
  const pkt = new Uint8Array(100);
  pkt[0] = 0xBC; pkt[1] = 0x0F; pkt[2] = (blockIndex + 1) & 0xFF;
  for (let i = 0; i < 32; i++) {
    const [r, g, b] = pixels32[i];
    pkt[3 + i * 3] = r;
    pkt[3 + i * 3 + 1] = g;
    pkt[3 + i * 3 + 2] = b;
  }
  pkt[99] = 0x55;
  return pkt;
}

export function hasBLE() { return 'bluetooth' in navigator; }
export function hasSerial() { return 'serial' in navigator; }
export function hasAny() { return hasBLE() || hasSerial(); }

// Connection state object
export function createConnection() {
  return {
    mode: 'ble',
    bleDevice: null,
    bleServer: null,
    bleChar: null,
    bleConnected: false,
    port: null,
    writer: null,
    usbConnected: false,
    proto: 'hex',
    onDisconnect: null,
    onLog: null,
  };
}

function log(conn, msg, type) {
  if (conn.onLog) conn.onLog(msg, type);
}

export function isConnected(conn) {
  return conn.bleConnected || conn.usbConnected;
}

export function getDeviceName(conn) {
  if (conn.bleConnected && conn.bleDevice) return conn.bleDevice.name || conn.bleDevice.id;
  if (conn.usbConnected) return 'USB Serial';
  return null;
}

// ── BLE ──────────────────────────────────────────
export async function connectBLE(conn) {
  if (!hasBLE()) throw new Error('Web Bluetooth not supported');
  
  log(conn, 'Requesting BLE device…', 'i');
  
  try {
    // Try specific filters first
    conn.bleDevice = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'MI Matrix' },
        { namePrefix: 'Merkury' },
        { namePrefix: 'MI-' },
      ],
      optionalServices: [BLE_SERVICE]
    });
  } catch (filterErr) {
    // If user cancelled or no filter match, try acceptAllDevices
    if (filterErr && filterErr.name === 'NotFoundError') {
      log(conn, 'No named device found, scanning all devices…', 'a');
      conn.bleDevice = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [BLE_SERVICE]
      });
    } else {
      throw filterErr;
    }
  }

  conn.bleDevice.addEventListener('gattserverdisconnected', () => {
    if (!conn.bleConnected) return;
    log(conn, 'BLE device disconnected', 'e');
    conn.bleConnected = false;
    conn.bleChar = null;
    conn.bleServer = null;
    if (conn.onDisconnect) conn.onDisconnect();
  });

  log(conn, 'Connecting to GATT server…', 'i');
  conn.bleServer = await conn.bleDevice.gatt.connect();

  log(conn, 'Getting primary service…', 'i');
  const svc = await conn.bleServer.getPrimaryService(BLE_SERVICE);

  log(conn, 'Getting characteristic…', 'i');
  conn.bleChar = await svc.getCharacteristic(BLE_CHARACTERISTIC);

  conn.bleConnected = true;
  conn.mode = 'ble';
  log(conn, 'BLE connected to ' + (conn.bleDevice.name || 'device'), 'k');

  // Power on
  await bleSendRaw(conn, hexToBytes('bc ff 01 00 55'));
}

async function bleSendRaw(conn, bytes) {
  if (!conn.bleChar) return;
  // Retry up to 3 times for GATT busy errors
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await conn.bleChar.writeValueWithoutResponse(bytes);
      return;
    } catch (e) {
      if (attempt < 2 && e && typeof e.message === 'string' && e.message.includes('GATT operation already in progress')) {
        await sleep(50);
        continue;
      }
      throw e;
    }
  }
}

export async function disconnectBLE(conn) {
  try {
    if (conn.bleDevice && conn.bleDevice.gatt.connected) {
      await bleSendRaw(conn, hexToBytes('bc ff 00 ff 55'));
      conn.bleDevice.gatt.disconnect();
    }
  } catch (e) { /* ignore */ }
  conn.bleConnected = false;
  conn.bleChar = null;
  conn.bleServer = null;
  conn.bleDevice = null;
}

// ── USB Serial ───────────────────────────────────
export async function connectUSB(conn, baud = 115200, proto = 'hex') {
  if (!hasSerial()) throw new Error('Web Serial not supported (use Chrome/Edge desktop)');
  
  conn.port = await navigator.serial.requestPort();
  await conn.port.open({ baudRate: baud });
  conn.writer = conn.port.writable.getWriter();
  conn.usbConnected = true;
  conn.mode = 'usb';
  conn.proto = proto;
  log(conn, `USB serial connected @ ${baud} baud [proto: ${proto}]`, 'k');
}

export async function disconnectUSB(conn) {
  try {
    if (conn.writer) { conn.writer.releaseLock(); conn.writer = null; }
    if (conn.port) { await conn.port.close(); conn.port = null; }
  } catch (e) { /* ignore */ }
  conn.usbConnected = false;
}

export async function disconnect(conn) {
  if (conn.bleConnected) await disconnectBLE(conn);
  if (conn.usbConnected) await disconnectUSB(conn);
}

// ── Send frame ───────────────────────────────────
// rgbArr: 256-element array of [r,g,b]
export async function sendRGBFrame(conn, rgbArr) {
  if (!isConnected(conn)) return;
  
  if (conn.bleConnected) {
    // init packet
    await bleSendRaw(conn, hexToBytes('bc0ff1080855'));
    await sleep(2);
    // 8 blocks of 32 pixels
    for (let blk = 0; blk < 8; blk++) {
      const pkt = buildMerkuryBlock(blk, rgbArr.slice(blk * 32, blk * 32 + 32));
      await bleSendRaw(conn, pkt);
      await sleep(25);
    }
    // end packet
    await bleSendRaw(conn, hexToBytes('bc0ff2080955'));
    await sleep(2);
  } else if (conn.usbConnected && conn.writer) {
    if (conn.proto === 'hex') {
      let line = 'F:';
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = rgbArr[i];
        line += r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
      }
      line += '\n';
      await conn.writer.write(new TextEncoder().encode(line));
    } else {
      const bytes = new Uint8Array(256 * 3);
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = rgbArr[i];
        bytes[i * 3] = r; bytes[i * 3 + 1] = g; bytes[i * 3 + 2] = b;
      }
      await conn.writer.write(bytes);
    }
  }
}

// ── Color helpers ────────────────────────────────
export function applyColorAdj(r, g, b, bright, satAdj, gamma, rBoost, gBoost, bBoost) {
  const s = bright / 100;
  r = r * s; g = g * s; b = b * s;
  r *= rBoost; g *= gBoost; b *= bBoost;
  if (satAdj !== 0) {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const f = 1 + satAdj / 100;
    r = lum + f * (r - lum); g = lum + f * (g - lum); b = lum + f * (b - lum);
  }
  if (gamma !== 1.0) {
    r = 255 * Math.pow(Math.max(0, r) / 255, gamma);
    g = 255 * Math.pow(Math.max(0, g) / 255, gamma);
    b = 255 * Math.pow(Math.max(0, b) / 255, gamma);
  }
  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)];
}

export function hslToRgb(h, s, l) {
  h = h % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Default palette
export const DEF_PALETTE = [
  [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  [255, 128, 0], [128, 0, 255], [0, 255, 128], [255, 215, 0],
  [255, 20, 100], [0, 128, 255], [128, 255, 64], [160, 82, 45],
];

export function floodFill(arr, start, from, to) {
  if (from === to) return;
  const q = [start];
  const v = new Set();
  while (q.length) {
    const i = q.shift();
    if (v.has(i) || arr[i] !== from) continue;
    v.add(i);
    arr[i] = to;
    const x = i % 16, y = Math.floor(i / 16);
    if (x > 0) q.push(i - 1);
    if (x < 15) q.push(i + 1);
    if (y > 0) q.push(i - 16);
    if (y < 15) q.push(i + 16);
  }
}
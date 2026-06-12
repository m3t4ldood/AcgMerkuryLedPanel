import React, { useState, useRef, useCallback, useEffect } from 'react';
import ConnectBar from '@/components/merkury/ConnectBar';
import DrawTab from '@/components/merkury/DrawTab';
import AnimateTab from '@/components/merkury/AnimateTab';
import EffectsTab from '@/components/merkury/EffectsTab';
import ImageTab from '@/components/merkury/ImageTab';
import {
  createConnection, isConnected as checkConnected, connectBLE, connectUSB,
  disconnectBLE, disconnectUSB, disconnect, sendRGBFrame, applyColorAdj,
  DEF_PALETTE, floodFill, hasAny,
} from '@/lib/merkury';
import { EFFECTS, resetFxTime } from '@/lib/effects';

const TABS = [
  { id: 'draw', label: '✏ Draw' },
  { id: 'animate', label: '🎞 Animate' },
  { id: 'image', label: '📷 Image' },
  { id: 'effects', label: '✨ Effects' },
];

function now() { return new Date().toLocaleTimeString('en', { hour12: false }); }

export default function Home() {
  // Connection
  const conn = useRef(createConnection());
  const [connected, setConnected] = useState(false);
  const [connLabel, setConnLabel] = useState('');
  const [connStatus, setConnStatus] = useState('off');
  const [mode, setMode] = useState('ble');
  const [baudRate, setBaudRate] = useState(115200);
  const [proto, setProto] = useState('hex');

  // Grid state
  const [grid, setGrid] = useState(() => new Uint8Array(256));
  const [palette, setPalette] = useState(() => DEF_PALETTE.map(c => [...c]));
  const [activeColor, setActiveColor] = useState(1);
  const [tool, setTool] = useState('draw');
  const [clip, setClip] = useState(null);
  const [frameCount, setFrameCount] = useState(0);
  const [autoSend, setAutoSend] = useState(true);
  const [activeTab, setActiveTab] = useState('draw');

  // Color adjust
  const [colorAdj, setColorAdj] = useState({ bright: 85, satAdj: 0, gamma: 1.0, rBoost: 1.0, gBoost: 1.0, bBoost: 1.0 });

  // Animation
  const [animFrames, setAnimFrames] = useState(() => [new Uint8Array(256)]);
  const [animCur, setAnimCur] = useState(0);
  const [animFPS, setAnimFPS] = useState(8);
  const [animLoop, setAnimLoop] = useState(true);
  const [animPlaying, setAnimPlaying] = useState(false);
  const animTimer = useRef(null);

  // Effects
  const [activeFX, setActiveFX] = useState(null);
  const [fxSpeed, setFxSpeed] = useState(100);
  const fxTimer = useRef(null);
  const [fxPixels, setFxPixels] = useState(null);

  // Logs
  const [logs, setLogs] = useState([]);

  const addLog = useCallback((msg, type = 'i') => {
    setLogs(prev => [...prev.slice(-79), { time: now(), msg, type }]);
  }, []);

  const autoTimer = useRef(null);

  // ── Connection ──
  conn.current.onLog = addLog;
  conn.current.onDisconnect = () => {
    setConnected(false);
    setConnLabel('');
    setConnStatus('off');
  };

  const handleConnect = useCallback(async () => {
    setConnStatus('busy');
    const c = conn.current;
    try {
      if (mode === 'ble') {
        await connectBLE(c);
      } else {
        await connectUSB(c, baudRate, proto);
      }
      setConnected(true);
      const name = mode === 'ble' ? (c.bleDevice?.name || 'BLE Device') : `USB @ ${baudRate}`;
      setConnLabel(name);
      setConnStatus('ok');
    } catch (e) {
      setConnStatus('err');
      addLog('Connect failed: ' + e.message, 'e');
      setTimeout(() => setConnStatus('off'), 2000);
    }
  }, [mode, baudRate, proto, addLog]);

  const handleDisconnect = useCallback(async () => {
    // Stop effects/animation
    setActiveFX(null);
    clearTimeout(fxTimer.current);
    setAnimPlaying(false);
    clearTimeout(animTimer.current);

    await disconnect(conn.current);
    setConnected(false);
    setConnLabel('');
    setConnStatus('off');
    addLog('Disconnected', 'a');
  }, [addLog]);

  // ── Auto-send ──
  const schedAuto = useCallback(() => {
    if (!autoSend || activeFX) return;
    clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      if (checkConnected(conn.current)) {
        const rgb = gridToRGB(grid, palette, colorAdj);
        sendRGBFrame(conn.current, rgb);
      }
    }, 180);
  }, [autoSend, activeFX, grid, palette, colorAdj]);

  function gridToRGB(g, pal, adj) {
    return Array.from({ length: 256 }, (_, i) => {
      const [r, gb, b] = pal[g[i]] || [0, 0, 0];
      return applyColorAdj(r, gb, b, adj.bright, adj.satAdj, adj.gamma, adj.rBoost, adj.gBoost, adj.bBoost);
    });
  }

  // ── Draw cell action ──
  const handleDrawCell = useCallback((i, t, color) => {
    setGrid(prev => {
      const next = new Uint8Array(prev);
      if (t === 'draw') { next[i] = color; }
      else if (t === 'erase') { next[i] = 0; }
      else if (t === 'fill') { floodFill(next, i, next[i], color); }
      else if (t === 'pick') {
        setActiveColor(prev[i]);
        return prev;
      }
      return next;
    });
    if (tool !== 'pick') schedAuto();
  }, [tool, schedAuto]);

  // ── Anim cell action ──
  const handleAnimCell = useCallback((i, t, color) => {
    setAnimFrames(prev => {
      const next = prev.map((f, idx) => idx === animCur ? new Uint8Array(f) : f);
      const frame = next[animCur];
      if (t === 'draw') { frame[i] = color; }
      else if (t === 'erase') { frame[i] = 0; }
      else if (t === 'fill') { floodFill(frame, i, frame[i], color); }
      return next;
    });
  }, [animCur]);

  // ── Presets ──
  const handlePreset = useCallback((p) => {
    setGrid(prev => {
      const next = new Uint8Array(256);
      const c = activeColor || 1;
      for (let i = 0; i < 256; i++) {
        const x = i % 16, y = Math.floor(i / 16);
        switch (p) {
          case 'checker': next[i] = (x + y) % 2 === 0 ? c : 0; break;
          case 'rainbow': next[i] = (x % 8) + 1; break;
          case 'border': next[i] = (x === 0 || x === 15 || y === 0 || y === 15) ? c : 0; break;
          case 'cross': next[i] = (x === 7 || x === 8 || y === 7 || y === 8) ? c : 0; break;
          case 'diag': next[i] = (x + y) % 4 < 2 ? c : 0; break;
          case 'random': next[i] = Math.random() > .5 ? (Math.floor(Math.random() * 7) + 1) : 0; break;
          case 'gradient': next[i] = Math.round(x / 15 * (palette.length - 1)); break;
          case 'radial': {
            const dx = x - 7.5, dy = y - 7.5, d = Math.sqrt(dx * dx + dy * dy);
            next[i] = d < 8 ? Math.round((8 - d) / 8 * (palette.length - 1)) : 0; break;
          }
        }
      }
      return next;
    });
    schedAuto();
  }, [activeColor, palette.length, schedAuto]);

  // ── Send ──
  const handleSend = useCallback(() => {
    if (!checkConnected(conn.current)) { addLog('Not connected', 'e'); return; }
    const rgb = gridToRGB(grid, palette, colorAdj);
    sendRGBFrame(conn.current, rgb);
    setFrameCount(prev => prev + 1);
    addLog('↑ frame sent', 'k');
  }, [grid, palette, colorAdj, addLog]);

  // ── Effects ──
  useEffect(() => {
    if (!activeFX) {
      clearTimeout(fxTimer.current);
      setFxPixels(null);
      return;
    }
    resetFxTime();
    let running = true;
    async function tick() {
      if (!running) return;
      const pixels = EFFECTS[activeFX]();
      const bright = colorAdj.bright;
      const adjusted = pixels.map(p => {
        const [r, g, b] = p || [0, 0, 0];
        const s = bright / 100;
        return [Math.min(255, Math.round(r * s)), Math.min(255, Math.round(g * s)), Math.min(255, Math.round(b * s))];
      });
      setFxPixels(adjusted);
      if (checkConnected(conn.current)) {
        try { await sendRGBFrame(conn.current, adjusted); } catch (e) { /* BLE busy, skip frame */ }
      }
      if (running) fxTimer.current = setTimeout(tick, fxSpeed);
    }
    setActiveTab('draw');
    tick();
    addLog('Effect started: ' + activeFX, 'i');
    return () => { running = false; clearTimeout(fxTimer.current); };
  }, [activeFX, fxSpeed, colorAdj.bright, addLog]);

  // ── Animation playback ──
  useEffect(() => {
    if (!animPlaying) { clearTimeout(animTimer.current); return; }
    let idx = 0;
    let running = true;
    const ms = 1000 / animFPS;
    async function step() {
      if (!running) return;
      const frame = animFrames[idx];
      setAnimCur(idx);
      if (checkConnected(conn.current)) {
        try { await sendRGBFrame(conn.current, gridToRGB(frame, palette, colorAdj)); } catch (e) { /* skip frame */ }
      }
      idx++;
      if (idx >= animFrames.length) {
        if (animLoop) idx = 0;
        else { setAnimPlaying(false); return; }
      }
      animTimer.current = setTimeout(step, ms);
    }
    step();
    addLog('Animation playing', 'i');
    return () => { running = false; clearTimeout(animTimer.current); };
  }, [animPlaying, animFPS, animLoop, animFrames, palette, colorAdj, addLog]);

  // ── Animation actions ──
  const handleAnimShift = useCallback((dx, dy) => {
    setAnimFrames(prev => {
      const next = prev.map((f, idx) => idx === animCur ? new Uint8Array(f) : f);
      const fr = next[animCur];
      const tmp = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const x = i % 16, y = Math.floor(i / 16);
        const nx = ((x + dx) % 16 + 16) % 16, ny = ((y + dy) % 16 + 16) % 16;
        tmp[ny * 16 + nx] = fr[i];
      }
      next[animCur] = tmp;
      return next;
    });
  }, [animCur]);

  const handleAnimExport = useCallback(() => {
    const data = JSON.stringify({ palette, frames: animFrames.map(f => Array.from(f)) });
    const a = document.createElement('a');
    a.href = 'data:application/json,' + encodeURIComponent(data);
    a.download = 'merkury_anim.json'; a.click();
    addLog('Animation exported', 'i');
  }, [palette, animFrames, addLog]);

  const handleAnimImport = useCallback((file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.palette) setPalette(data.palette);
        setAnimFrames(data.frames.map(f => new Uint8Array(f)));
        setAnimCur(0);
        addLog('Animation loaded: ' + data.frames.length + ' frames', 'i');
      } catch (err) { addLog('Load failed: ' + err.message, 'e'); }
    };
    r.readAsText(file);
  }, [addLog]);

  // ── Browser check ──
  const supported = hasAny();

  // Init log
  useEffect(() => {
    addLog('Ready. Click CONNECT → select your device.', 'i');
    addLog('Brightness defaults to 85% with full-range palette.', 'a');
  }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center px-3 py-4 pb-12"
      style={{ backgroundImage: 'radial-gradient(ellipse 80% 35% at 50% 0%, rgba(0,120,160,0.14) 0%, transparent 70%)' }}
    >
      {/* Header */}
      <header className="text-center mb-[14px]">
        <h1 className="font-display text-[clamp(1.8rem,5.5vw,3rem)] text-primary tracking-wide leading-none"
          style={{ textShadow: '0 0 12px hsl(var(--primary)), 0 0 40px rgba(0,229,255,0.25)' }}
        >
          MERKURY LED PRO
        </h1>
        <p className="text-[0.58rem] tracking-[0.25em] text-muted-foreground uppercase mt-[3px]">
          16 × 16 NeoPixel · BLE + USB Serial · Web API
        </p>
      </header>

      {/* Browser warning */}
      {!supported && (
        <div className="bg-destructive/10 border border-destructive rounded p-[10px_14px] text-[0.68rem] text-red-300 max-w-[860px] w-full mb-[10px] leading-relaxed">
          ⚠ Your browser doesn't support <strong>Web Bluetooth</strong> or <strong>Web Serial</strong>. Use <strong>Chrome</strong> or <strong>Edge</strong> on desktop.
        </div>
      )}

      {/* Connect bar */}
      <ConnectBar
        mode={mode}
        setMode={setMode}
        connected={connected}
        connLabel={connLabel}
        connStatus={connStatus}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        baudRate={baudRate}
        setBaudRate={setBaudRate}
        proto={proto}
        setProto={setProto}
      />

      {/* Tabs */}
      <div className="flex gap-[2px] w-full max-w-[860px] mb-3">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`font-display text-base tracking-wide px-[14px] py-[5px] border border-b-0 cursor-pointer rounded-t transition-colors ${
              activeTab === tab.id
                ? 'bg-secondary text-primary border-primary'
                : 'bg-card text-muted-foreground border-border hover:text-foreground hover:bg-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Workspace */}
      <div className="w-full max-w-[860px] bg-card border border-border rounded-b rounded-tr p-3">
        {activeTab === 'draw' && (
          <DrawTab
            grid={grid}
            palette={palette}
            colorAdj={colorAdj}
            tool={tool}
            activeColor={activeColor}
            frameCount={frameCount}
            autoSend={autoSend}
            logs={logs}
            connected={connected}
            onCellAction={handleDrawCell}
            onToolChange={setTool}
            onColorSelect={setActiveColor}
            onAddColor={(c) => setPalette(prev => prev.length < 32 ? [...prev, c] : [...prev.slice(0, -1), c])}
            onClear={() => { setGrid(new Uint8Array(256)); schedAuto(); }}
            onInvert={() => { setGrid(prev => { const n = new Uint8Array(256); for (let i = 0; i < 256; i++) n[i] = prev[i] === 0 ? activeColor : 0; return n; }); schedAuto(); }}
            onCopy={() => { setClip(Uint8Array.from(grid)); addLog('Frame copied', 'i'); }}
            onPaste={() => { if (!clip) { addLog('Nothing to paste', 'e'); return; } setGrid(Uint8Array.from(clip)); schedAuto(); addLog('Frame pasted', 'i'); }}
            onPreset={handlePreset}
            onAdjust={(key, val) => setColorAdj(prev => ({ ...prev, [key]: val }))}
            onAutoSendChange={setAutoSend}
            onSend={handleSend}
            rawRGB={fxPixels}
          />
        )}

        {activeTab === 'animate' && (
          <AnimateTab
            frames={animFrames}
            currentFrame={animCur}
            palette={palette}
            colorAdj={colorAdj}
            tool={tool}
            activeColor={activeColor}
            fps={animFPS}
            loop={animLoop}
            playing={animPlaying}
            connected={connected}
            onCellAction={handleAnimCell}
            onToolChange={setTool}
            onAddFrame={() => { setAnimFrames(prev => [...prev, new Uint8Array(256)]); setAnimCur(animFrames.length); }}
            onDupFrame={() => { setAnimFrames(prev => { const dup = Uint8Array.from(prev[animCur]); return [...prev.slice(0, animCur + 1), dup, ...prev.slice(animCur + 1)]; }); setAnimCur(animCur + 1); }}
            onDeleteFrame={(idx) => {
              if (animFrames.length <= 1) { addLog('Need at least 1 frame', 'e'); return; }
              setAnimFrames(prev => prev.filter((_, i) => i !== idx));
              if (animCur >= animFrames.length - 1) setAnimCur(Math.max(0, animFrames.length - 2));
            }}
            onSelectFrame={setAnimCur}
            onClear={() => setAnimFrames(prev => prev.map((f, i) => i === animCur ? new Uint8Array(256) : f))}
            onShift={handleAnimShift}
            onFpsChange={setAnimFPS}
            onLoopToggle={() => setAnimLoop(prev => !prev)}
            onPlay={() => setAnimPlaying(true)}
            onStop={() => { setAnimPlaying(false); addLog('Animation stopped', 'a'); }}
            onImportFromDraw={() => { setAnimFrames(prev => [...prev, Uint8Array.from(grid)]); setAnimCur(animFrames.length); addLog('Draw frame imported', 'i'); }}
            onExport={handleAnimExport}
            onImportFile={handleAnimImport}
            onStreamToPanel={() => setAnimPlaying(true)}
          />
        )}

        {activeTab === 'image' && (
          <ImageTab
            palette={palette}
            connected={connected}
            onSendGrid={(imgGrid) => {
              const rgb = gridToRGB(imgGrid, palette, colorAdj);
              sendRGBFrame(conn.current, rgb);
              addLog('Image sent to panel', 'k');
            }}
            onSendToDraw={(imgGrid) => { setGrid(Uint8Array.from(imgGrid)); addLog('Image sent to Draw tab', 'i'); }}
            onAddAsFrame={(imgGrid) => { setAnimFrames(prev => [...prev, Uint8Array.from(imgGrid)]); setAnimCur(animFrames.length); addLog('Image added as anim frame', 'i'); }}
            addLog={addLog}
          />
        )}

        {activeTab === 'effects' && (
          <EffectsTab
            activeFX={activeFX}
            fxSpeed={fxSpeed}
            onStartFX={(fx) => { setActiveFX(null); setTimeout(() => setActiveFX(fx), 10); }}
            onStopFX={() => setActiveFX(null)}
            onSpeedChange={setFxSpeed}
          />
        )}
      </div>
    </div>
  );
}
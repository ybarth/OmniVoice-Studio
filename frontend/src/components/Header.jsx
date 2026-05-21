import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MessagesSquare, Fingerprint, Wand2, FolderOpen, RefreshCw, Settings2, ChevronRight, ChevronDown, Zap, Trash2, Landmark } from 'lucide-react';
import { Button, Badge } from '../ui';

const VIEW_META = {
  conversation: { label: 'Conversation', Icon: MessagesSquare, accent: '#d96b78', kicker: 'Builder' },
  clone:    { label: 'Voice Clone',  Icon: Fingerprint, accent: '#c65f4a', kicker: 'Builder' },
  design:   { label: 'Voice Design', Icon: Wand2,       accent: '#2b8f83', kicker: 'Builder' },
  projects: { label: 'Drive',        Icon: FolderOpen,  accent: '#2f67b1', kicker: 'Library' },
  settings: { label: 'Settings',     Icon: Settings2,   accent: '#c28b2c', kicker: 'System' },
};

function WaveBars({ color = '#f3a5b6', active }) {
  const heights = [4, 9, 5, 11, 6, 10, 5, 8];
  return (
    <div className={`hq-wave ${active ? 'is-active' : ''}`} aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className={active ? 'hq-wave-bar active' : 'hq-wave-bar'}
          style={{
            // Height + color are per-instance; animation-delay is per-bar.
            // These three are genuinely dynamic so stay inline.
            height: h,
            background: color,
            animationDelay: `${i * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function Header({
  mode, sysStats, modelStatus, doubleClickMaximize,
  activeProjectName, onFlushMemory, device,
}) {
  const [flushing, setFlushing] = useState(false);
  const [flushOpen, setFlushOpen] = useState(false);
  const [loadedModels, setLoadedModels] = useState([]);
  const [unloading, setUnloading] = useState(null);
  const flushRef = useRef(null);
  const flushBtnRef = useRef(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  // Dynamically compute dropdown position from button rect
  const computePos = useCallback(() => {
    if (!flushBtnRef.current) return;
    const rect = flushBtnRef.current.getBoundingClientRect();
    const dropW = 260;
    const dropH = 220; // approximate max height
    const pad = 6;

    // Default: below button, right-aligned
    let top = rect.bottom + pad;
    let left = rect.right - dropW;

    // Flip up if too close to bottom
    if (top + dropH > window.innerHeight - 10) {
      top = rect.top - dropH - pad;
    }
    // Clamp left so it doesn't go off-screen
    if (left < 8) left = 8;
    if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;

    setDropdownPos({ top, left });
  }, []);

  // Recompute on open, resize, and scroll
  useEffect(() => {
    if (!flushOpen) return;
    computePos();
    window.addEventListener('resize', computePos);
    window.addEventListener('scroll', computePos, true);
    return () => {
      window.removeEventListener('resize', computePos);
      window.removeEventListener('scroll', computePos, true);
    };
  }, [flushOpen, computePos]);
  const view = VIEW_META[mode] || VIEW_META.conversation;
  const ViewIcon = view.Icon;
  const mobileDeviceLabel = device?.isIPhone ? 'iPhone mobile form' : 'Mobile form';

  // Fetch loaded models when dropdown opens
  useEffect(() => {
    if (!flushOpen) return;
    const fetchModels = async () => {
      try {
        const { API } = await import('../api/client');
        const res = await fetch(`${API}/model/loaded`);
        if (res.ok) {
          const data = await res.json();
          setLoadedModels(data.models || []);
        }
      } catch {}
    };
    fetchModels();
  }, [flushOpen]);

  // Click outside to close (must check both the button wrapper AND the portal dropdown)
  const dropdownRef = useRef(null);
  useEffect(() => {
    if (!flushOpen) return;
    const handler = (e) => {
      const inBtn = flushRef.current && flushRef.current.contains(e.target);
      const inDrop = dropdownRef.current && dropdownRef.current.contains(e.target);
      if (!inBtn && !inDrop) setFlushOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [flushOpen]);

  const unloadModel = async (modelId) => {
    setUnloading(modelId);
    try {
      const { API } = await import('../api/client');
      const res = await fetch(`${API}/model/unload/${modelId}`, { method: 'POST' });
      if (res.ok) {
        setLoadedModels(prev => prev.filter(m => m.id !== modelId));
      }
    } catch {} finally {
      setUnloading(null);
    }
  };
  // Dynamic accent color must stay inline — it's driven by the current view.
  const dotStyle   = { background: view.accent, boxShadow: `0 0 10px ${view.accent}90` };
  const labelStyle = { color: view.accent };
  return (
    <div
      className="header-area"
      data-tauri-drag-region
      onDoubleClick={doubleClickMaximize}
    >
      {/* Left: view title + breadcrumb */}
      <div className="hq-col-left">
        <div className="hq-col-left__spacer" />
        <div className="hq-view-title">
          <span className="hq-view-dot" style={dotStyle} />
          <span className="hq-view-kicker">{view.kicker}</span>
          <ChevronRight size={10} color="#504945" className="hq-breadcrumb-sep" />
          <span className="hq-view-label" style={labelStyle}>
            <ViewIcon size={12} className="hq-view-icon" />
            {view.label}
          </span>
          {activeProjectName ? (
            <>
              <ChevronRight size={10} color="#504945" className="hq-breadcrumb-sep" />
              <span className="hq-view-project" title={activeProjectName}>{activeProjectName}</span>
            </>
          ) : null}
        </div>
        {device?.kind === 'phone' && (
          <span className="hq-mobile-mode-badge" aria-label={`${view.label} is using the ${mobileDeviceLabel}`}>
            <span className="hq-mobile-mode-badge__device">{mobileDeviceLabel}</span>
          </span>
        )}
        {import.meta.env.DEV && (
          <Button
            variant="ghost"
            size="sm"
            title="Force Reload UI"
            onClick={() => window.location.reload()}
            leading={<RefreshCw size={9} />}
            className="hq-reload-btn"
          >
            Reload
          </Button>
        )}
      </div>

      {/* Center: logo */}
      <div className="hq-col-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 32 32" fill="none" className="hq-logo-mark" aria-hidden="true">
          <path d="M6 25h20" stroke="#f5efe2" strokeWidth="1.5" strokeLinecap="round" opacity="0.72" />
          <path d="M9 25V12l7-5 7 5v13" stroke="#f5efe2" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M12 23V14h3v9M17 23V14h3v9" stroke="#2b8f83" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M10.5 17.5h11M10.5 20.5h11" stroke="#c28b2c" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M9 12c3 2.8 11 2.8 14 0" stroke="#c65f4a" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="hq-logo-word">
          Vox<span className="hq-logo-word__accent">Tower</span>
        </span>
        <span className="hq-logo-kicker"><Landmark size={10} /> Concord</span>
      </div>

      {/* Right: wave + sys stats. UI scale (S/M/L) lives in the bottom
          LogsFooter bar so all app-wide chrome sits together. */}
      <div className="hq-col-right">
        {device && (
          <Badge tone={device.isIPhone ? 'info' : 'neutral'} size="xs" className="hq-device-badge">
            {device.isIPhone ? 'iPhone mode' : device.kind}
          </Badge>
        )}
        <WaveBars color={view.accent} active={modelStatus === 'ready' || modelStatus === 'loading'} />
        {sysStats && (
          <div className="hq-stats">
            <span><b className="hq-stats__key">RAM</b> {sysStats.ram.toFixed(1)}/{sysStats.total_ram.toFixed(0)}G</span>
            <span><b className="hq-stats__key">CPU</b> {sysStats.cpu.toFixed(0)}%</span>
            <span className="hq-stats__sep" aria-label={`VRAM usage: ${sysStats.vram.toFixed(1)} gigabytes`}>
              <b className={`hq-stats__key ${sysStats.gpu_active ? 'hq-stats__key--gpu-active' : ''}`}>VRAM</b> {sysStats.vram.toFixed(1)}G
            </span>
            <span className="hq-stats__status-wrap">
              <Badge
                tone={modelStatus === 'ready' ? 'success' : modelStatus === 'loading' ? 'warn' : 'neutral'}
                size="xs"
                dot
                className={`hq-stats__status-badge ${modelStatus === 'loading' ? 'ui-badge--pulse' : ''}`}
              >
                {modelStatus === 'ready' ? 'Ready' : modelStatus === 'loading' ? 'Loading…' : 'Idle'}
              </Badge>
            </span>
            {onFlushMemory && (
              <div ref={flushRef} style={{ position: 'relative' }}>
                <Button
                  ref={flushBtnRef}
                  variant="subtle"
                  size="sm"
                  title="Memory management"
                  loading={flushing}
                  leading={!flushing && <Zap size={8} />}
                  trailing={<ChevronDown size={8} />}
                  onClick={() => setFlushOpen(o => !o)}
                  className="hq-flush-btn"
                >
                  Flush
                </Button>
                {flushOpen && createPortal(
                  <div
                    className="hq-flush-dropdown"
                    style={{ top: dropdownPos.top, left: dropdownPos.left }}
                    ref={dropdownRef}
                  >
                    <div className="hq-flush-dropdown__header">Loaded Models</div>
                    {loadedModels.length === 0 ? (
                      <div className="hq-flush-dropdown__empty">No models loaded</div>
                    ) : (
                      loadedModels.map(m => (
                        <div key={m.id} className="hq-flush-dropdown__item">
                          <div className="hq-flush-dropdown__info">
                            <span className="hq-flush-dropdown__name">{m.name}</span>
                            <span className="hq-flush-dropdown__meta">
                              {m.device} {m.vram_mb > 0 ? `· ${m.vram_mb.toFixed(0)} MB` : ''}
                            </span>
                          </div>
                          {m.unloadable && (
                            <button
                              className="hq-flush-dropdown__unload"
                              onClick={() => unloadModel(m.id)}
                              disabled={unloading === m.id}
                              aria-label={`Unload ${m.name}`}
                            >
                              {unloading === m.id ? '…' : 'Unload'}
                            </button>
                          )}
                        </div>
                      ))
                    )}
                    <div className="hq-flush-dropdown__divider" />
                    <button
                      className="hq-flush-dropdown__action"
                      onClick={async () => {
                        setFlushing(true);
                        setFlushOpen(false);
                        try { await onFlushMemory(false); } finally { setFlushing(false); }
                      }}
                    >
                      <Zap size={10} /> Flush caches
                    </button>
                    <button
                      className="hq-flush-dropdown__action hq-flush-dropdown__action--danger"
                      onClick={async () => {
                        setFlushing(true);
                        setFlushOpen(false);
                        try { await onFlushMemory(true); } finally { setFlushing(false); }
                      }}
                    >
                      <Trash2 size={10} /> Unload all + flush
                    </button>
                  </div>,
                  document.body
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

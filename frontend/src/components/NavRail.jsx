import React from 'react';
import {
  Fingerprint, Wand2, FolderOpen, Settings2,
} from 'lucide-react';

const ITEMS = [
  { id: 'clone',    label: 'Clone',    Icon: Fingerprint, accent: '#c65f4a' },
  { id: 'design',   label: 'Design',   Icon: Wand2,       accent: '#2b8f83' },
  { id: 'projects', label: 'Drive',    Icon: FolderOpen,  accent: '#2f67b1' },
  { id: 'settings', label: 'Settings', Icon: Settings2,   accent: '#c28b2c' },
];

function RailBtn({ active, Icon, label, accent, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rail-btn ${active ? 'active' : ''}`}
      style={{ '--rail-accent': accent }}
    >
      <Icon size={18} />
      <span className="rail-label">{label}</span>
    </button>
  );
}

export default function NavRail({ mode, setMode }) {
  return (
    <aside className="nav-rail" aria-label="Primary">
      <div className="rail-brand" aria-hidden="true">
        <span className="rail-brand__stone rail-brand__stone--one" />
        <span className="rail-brand__stone rail-brand__stone--two" />
        <span className="rail-brand__stone rail-brand__stone--three" />
      </div>
      <div className="rail-top">
        {ITEMS.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
      </div>
    </aside>
  );
}

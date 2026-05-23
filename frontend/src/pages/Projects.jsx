import React, { useMemo, useState } from 'react';
import {
  Search, FolderOpen, Film, Fingerprint, Wand2, Music, Download,
  LayoutGrid, List as ListIcon, Clock, FileText, Mic,
} from 'lucide-react';
import './Projects.css';

const FILTERS = [
  { id: 'all', label: 'All', Icon: FolderOpen },
  { id: 'dubs', label: 'Dub Projects', Icon: Film },
  { id: 'profiles', label: 'Voice Profiles', Icon: Fingerprint },
  { id: 'transcripts', label: 'Transcripts', Icon: Mic },
  { id: 'history', label: 'History', Icon: Music },
  { id: 'exports', label: 'Exports', Icon: Download },
];

function fmtTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(d)) return '';
  const diff = Date.now() - d;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const n = Number(sec);
  if (!Number.isFinite(n)) return '';
  if (n < 60) return `${Math.floor(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}m ${s}s`;
}

function Card({ kind, accent, title, subtitle, trailing, onClick, IconC }) {
  return (
    <button
      type="button"
      className="projects__card"
      onClick={onClick}
      style={{ '--card-accent': accent }}
    >
      <div className="projects__card-head">
        <span className="projects__card-kind">
          {IconC && <IconC size={11} />}
          {kind}
        </span>
        <span className="projects__card-trailing">{trailing}</span>
      </div>
      <div className="projects__card-title" title={title}>{title}</div>
      {subtitle && <div className="projects__card-sub" title={subtitle}>{subtitle}</div>}
    </button>
  );
}

export default function Projects({
  studioProjects = [],
  profiles = [],
  history = [],
  exportHistory = [],
  onOpenDub,
  onOpenProfile,
  onRevealExport,
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState('grid');
  const [transcriptions, setTranscriptions] = useState(() => {
    try { return JSON.parse(localStorage.getItem('omni_transcriptions') || '[]'); }
    catch { return []; }
  });

  React.useEffect(() => {
    const handler = () => {
      try { setTranscriptions(JSON.parse(localStorage.getItem('omni_transcriptions') || '[]')); }
      catch {}
    };
    window.addEventListener('omni:transcription-added', handler);
    return () => window.removeEventListener('omni:transcription-added', handler);
  }, []);

  const items = useMemo(() => {
    const list = [];
    for (const project of studioProjects) {
      list.push({
        type: 'dubs',
        id: project.id,
        title: project.name || project.video_path?.split('/').pop() || project.id,
        subtitle: fmtDuration(project.duration),
        ts: (project.updated_at || project.created_at || 0) * 1000,
        accent: '#fe8019',
        Icon: Film,
        onClick: () => onOpenDub?.(project.id),
      });
    }
    for (const profile of profiles) {
      const kind = profile.kind || 'clone';
      list.push({
        type: 'profiles',
        id: profile.id,
        title: profile.name || profile.id,
        subtitle: kind === 'design' ? 'Designed voice' : 'Cloned voice',
        ts: (profile.updated_at || profile.created_at || 0) * 1000,
        accent: kind === 'design' ? '#8ec07c' : '#d3869b',
        Icon: kind === 'design' ? Wand2 : Fingerprint,
        onClick: () => onOpenProfile?.(profile.id),
      });
    }
    for (const item of history) {
      list.push({
        type: 'history',
        id: item.filename || item.id || String(Math.random()),
        title: (item.text || item.prompt || item.filename || 'Generated audio').slice(0, 80),
        subtitle: item.language || item.voice || '',
        ts: item.timestamp || item.created_at || 0,
        accent: '#f3a5b6',
        Icon: Music,
        onClick: undefined,
      });
    }
    for (const item of exportHistory) {
      list.push({
        type: 'exports',
        id: item.path || item.id,
        title: item.path?.split('/').pop() || item.filename || 'Export',
        subtitle: item.mode || '',
        ts: (item.created_at || 0) * 1000,
        accent: '#fabd2f',
        Icon: Download,
        onClick: () => item.path && onRevealExport?.(item.path),
      });
    }
    for (const transcript of transcriptions) {
      list.push({
        type: 'transcripts',
        id: transcript.id || String(Math.random()),
        title: (transcript.text || 'Transcription').slice(0, 120),
        subtitle: [
          transcript.language,
          transcript.duration_s ? `${Math.round(transcript.duration_s)}s` : '',
        ].filter(Boolean).join(' · '),
        ts: transcript.timestamp ? Date.parse(transcript.timestamp) : 0,
        accent: '#83a598',
        Icon: FileText,
        onClick: () => {
          navigator.clipboard.writeText(transcript.text || '');
        },
      });
    }
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return list;
  }, [studioProjects, profiles, history, exportHistory, transcriptions, onOpenDub, onOpenProfile, onRevealExport]);

  const counts = useMemo(() => {
    const nextCounts = { all: items.length };
    for (const item of items) nextCounts[item.type] = (nextCounts[item.type] || 0) + 1;
    return nextCounts;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(item => {
      if (filter !== 'all' && item.type !== filter) return false;
      if (!q) return true;
      return `${item.title} ${item.subtitle || ''}`.toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  return (
    <div className="projects">
      <div className="projects__header">
        <h1 className="projects__title">Drive</h1>
        <div className="projects__toolbar">
          <div className="projects__search">
            <Search size={12} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search dubs, clones, transcripts, exports…"
              spellCheck={false}
            />
          </div>
          <div className="projects__view-toggle">
            <button
              className={view === 'grid' ? 'is-active' : ''}
              onClick={() => setView('grid')}
              title="Card grid"
              type="button"
            >
              <LayoutGrid size={12} />
            </button>
            <button
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => setView('list')}
              title="List"
              type="button"
            >
              <ListIcon size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="projects__body">
        <aside className="projects__rail">
          {FILTERS.map(filterItem => {
            const FilterIcon = filterItem.Icon;
            const count = counts[filterItem.id] ?? 0;
            return (
              <button
                key={filterItem.id}
                type="button"
                className={`projects__rail-item ${filter === filterItem.id ? 'is-active' : ''}`}
                onClick={() => setFilter(filterItem.id)}
              >
                <FilterIcon size={12} />
                <span>{filterItem.label}</span>
                <span className="projects__rail-count">{count}</span>
              </button>
            );
          })}
        </aside>

        <section className={`projects__content projects__content--${view}`}>
          {visible.length === 0 && (
            <div className="projects__empty">
              <FolderOpen size={28} />
              <p>{query ? `No matches for “${query}”` : 'Nothing here yet. Start a dub, design a voice, or generate audio to see it appear.'}</p>
            </div>
          )}
          {visible.map(item => (
            <Card
              key={`${item.type}:${item.id}`}
              kind={item.type.toUpperCase()}
              accent={item.accent}
              title={item.title}
              subtitle={item.subtitle}
              trailing={<span className="projects__card-time"><Clock size={10} />{fmtTime(item.ts)}</span>}
              onClick={item.onClick}
              IconC={item.Icon}
            />
          ))}
        </section>
      </div>
    </div>
  );
}

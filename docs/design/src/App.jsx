import { useState } from 'react';
import TarmotoWireframes from '../wireframes';

const tabs = [
  { id: 'wireframes', label: 'Wireframes' },
  { id: 'erd', label: 'Database ERD' },
];

export default function App() {
  const [active, setActive] = useState('wireframes');

  return (
    <div style={{ minHeight: '100vh', background: '#070A10' }}>
      {/* Nav */}
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          padding: '16px 24px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: '#0C1018',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <span
          style={{
            fontSize: 16,
            fontWeight: 800,
            color: '#0ED3CF',
            letterSpacing: '-0.02em',
            marginRight: 16,
          }}
        >
          TARMOTO
        </span>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            style={{
              background: active === tab.id ? 'rgba(14,211,207,0.12)' : 'transparent',
              color: active === tab.id ? '#0ED3CF' : '#8B95A8',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#4A5568' }}>
          Design Docs — Local Dev
        </span>
      </nav>

      {/* Content */}
      <div style={{ padding: 24 }}>
        {active === 'wireframes' && <TarmotoWireframes />}
        {active === 'erd' && <ErdViewer />}
      </div>
    </div>
  );
}

function ErdViewer() {
  return (
    <div
      style={{
        background: '#0C1018',
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}
    >
      <iframe
        src="/database_erd.html"
        style={{
          width: '100%',
          height: 'calc(100vh - 140px)',
          border: 'none',
          background: '#0C1018',
        }}
        title="Database ERD"
      />
    </div>
  );
}

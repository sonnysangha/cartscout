import React from 'react';

// Tiny drawings for the three steps, made from the same shapes as the product: a window, the ink tile, a pressable button.
const frame = { fill: 'var(--canvas)', stroke: 'var(--ink)', strokeWidth: 2.5, strokeLinejoin: 'round' };
const line = { fill: 'none', stroke: 'var(--ink)', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' };

function Drawing({ children }) {
  return <svg className="step-art" viewBox="0 0 96 64" width="96" height="64" aria-hidden="true" focusable="false">{children}</svg>;
}

export function ShopArt() {
  return (
    <Drawing>
      <rect x="3" y="4" width="90" height="56" rx="9" {...frame} />
      <path d="M3 18h90" {...line} />
      <circle cx="12" cy="11" r="2" fill="var(--ink)" />
      <circle cx="19" cy="11" r="2" fill="var(--ink)" />
      <path d="M26 27h44v5a5.500 5.500 0 0 1-11 0 5.500 5.500 0 0 1-11 0 5.500 5.500 0 0 1-11 0 5.500 5.500 0 0 1-11 0Z" fill="var(--sun)" />
      <path d="M31 40v20M65 40v20" {...line} />
      <rect x="43" y="44" width="10" height="16" rx="2" fill="var(--ink)" />
    </Drawing>
  );
}

export function ToolbarArt() {
  return (
    <Drawing>
      <rect x="3" y="4" width="90" height="56" rx="9" {...frame} />
      <path d="M3 30h90" {...line} />
      <rect x="11" y="12" width="46" height="10" rx="5" fill="var(--fill-strong)" />
      <rect x="64" y="6.500" width="21" height="21" rx="6.500" fill="var(--sun)" />
      <rect x="67.500" y="10" width="14" height="14" rx="4" fill="#1f1b16" />
      <path d="M71 15.500h7.400l-1.300 4.600h-4.800Z" fill="#ffd23f" />
      <path d="M69.600 13.400h1.200l.9 2.100h7" fill="none" stroke="#fff" strokeWidth="1.300" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M76 30v19l5-4.400 3.400 8 3.600-1.600-3.400-7.800h6.600Z" fill="var(--canvas)" stroke="var(--ink)" strokeWidth="2.500" strokeLinejoin="round" />
    </Drawing>
  );
}

export function ScanArt() {
  return (
    <Drawing>
      <path d="M30 13l-3.500-6M48 11V4M66 13l3.500-6" {...line} />
      <rect x="13" y="26" width="70" height="30" rx="10" fill="var(--sun-deep)" />
      <rect x="13" y="21" width="70" height="30" rx="10" fill="var(--sun)" />
      <text x="48" y="41" textAnchor="middle" fontFamily="var(--font-ui)" fontWeight="800" fontSize="13.500" fill="var(--on-sun)">Scan</text>
    </Drawing>
  );
}

export function Tick() {
  return (
    <svg className="tick" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M4.500 10.600l3.700 3.700 7.300-8.300" fill="none" stroke="currentColor" strokeWidth="2.600" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BackArrow() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M11.500 4.500 6 10l5.500 5.500M6.500 10H15" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import manifest from '../manifest.json';
import CtaTracker from '../src/index';
import { mockPluginFetch } from './mock';
import { makeHostDisplayCache } from './host-cache';

// Stand-in for the host: just enough SDK for the module to run.
(window as unknown as { React: typeof React }).React = React;
(window as unknown as { __HS_SDK__: unknown }).__HS_SDK__ = {
  pluginFetch: mockPluginFetch,
  displayCache: makeHostDisplayCache(),
};

const style = {
  fontSize: Number(new URLSearchParams(location.search).get('fs') ?? 16), fontFamily: 'inter', textColor: '#ffffff',
  // `?modalpha=0.1`: a nearly see-through module, like a light Style setting.
  backgroundColor: `rgba(0, 0, 0, ${Number(new URLSearchParams(location.search).get('modalpha') ?? 0.55)})`,
  borderRadius: 12, padding: 12, opacity: 1, backdropBlur: 12,
};

const params = new URLSearchParams(location.search);
const w = Number(params.get('w') ?? manifest.defaultSize.w);
const h = Number(params.get('h') ?? manifest.defaultSize.h);
const config = { ...manifest.defaultConfig, ...Object.fromEntries([...params].filter(([k]) => !['w', 'h', 'scene', 'fs', 'bg', 'modalpha'].includes(k))) };

// `?bg=busy`: bright and dark patches, like a photo behind a translucent
// module, to check that thin lines and small text still read.
if (params.get('bg') === 'busy') {
  document.body.style.background = [
    'radial-gradient(circle at 20% 30%, #f5f0e6 0 12%, transparent 22%)',
    'radial-gradient(circle at 55% 65%, #e8d9b0 0 10%, transparent 20%)',
    'radial-gradient(circle at 80% 20%, #9fc3e8 0 14%, transparent 24%)',
    'radial-gradient(circle at 35% 85%, #c94f2c 0 8%, transparent 18%)',
    'linear-gradient(160deg, #1b2a1f 0%, #6d7f8a 45%, #d8d4c8 60%, #2a2622 100%)',
  ].join(', ');
}
// `?bg=bright`: a vivid, mostly light wallpaper (blue to cyan, orange,
// yellow and peach), the hardest case for white text.
if (params.get('bg') === 'bright') {
  document.body.style.background = [
    'radial-gradient(circle at 75% 35%, #00e5ff 0 8%, transparent 30%)',
    'radial-gradient(circle at 30% 70%, #ff7a00 0 10%, transparent 35%)',
    'radial-gradient(circle at 60% 75%, #ffd400 0 8%, transparent 30%)',
    'linear-gradient(180deg, #0a6cff 0%, #1aa3e8 35%, #f3c9a0 75%, #f7d7c0 100%)',
  ].join(', ');
}

createRoot(document.getElementById('root')!).render(
  <div style={{ width: w, height: h }}>
    <CtaTracker config={config} style={style} />
  </div>,
);

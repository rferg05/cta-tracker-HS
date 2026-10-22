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
  fontSize: Number(new URLSearchParams(location.search).get('fs') ?? 16), fontFamily: 'inter', textColor: '#ffffff', backgroundColor: 'rgba(0, 0, 0, 0.55)',
  borderRadius: 12, padding: 12, opacity: 1, backdropBlur: 12,
};

const params = new URLSearchParams(location.search);
const w = Number(params.get('w') ?? manifest.defaultSize.w);
const h = Number(params.get('h') ?? manifest.defaultSize.h);
const config = { ...manifest.defaultConfig, ...Object.fromEntries([...params].filter(([k]) => !['w', 'h', 'scene', 'fs', 'bg'].includes(k))) };

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

createRoot(document.getElementById('root')!).render(
  <div style={{ width: w, height: h }}>
    <CtaTracker config={config} style={style} />
  </div>,
);

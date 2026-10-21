import React from 'react';
import { createRoot } from 'react-dom/client';
import manifest from '../manifest.json';
import CtaTracker from '../src/index';
import { mockPluginFetch } from './mock';

// Stand-in for the host: just enough SDK for the module to run.
const cache = new Map<string, unknown>();
(window as unknown as { React: typeof React }).React = React;
(window as unknown as { __HS_SDK__: unknown }).__HS_SDK__ = {
  pluginFetch: mockPluginFetch,
  displayCache: { get: (k: string) => cache.get(k), set: (k: string, v: unknown) => cache.set(k, v), prefetch: async () => {} },
};

const style = {
  fontSize: 16, fontFamily: 'inter', textColor: '#ffffff', backgroundColor: 'rgba(0, 0, 0, 0.55)',
  borderRadius: 12, padding: 12, opacity: 1, backdropBlur: 12,
};

const params = new URLSearchParams(location.search);
const w = Number(params.get('w') ?? manifest.defaultSize.w);
const h = Number(params.get('h') ?? manifest.defaultSize.h);
const config = { ...manifest.defaultConfig, ...Object.fromEntries([...params].filter(([k]) => k !== 'w' && k !== 'h')) };

createRoot(document.getElementById('root')!).render(
  <div style={{ width: w, height: h }}>
    <CtaTracker config={config} style={style} />
  </div>,
);

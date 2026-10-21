// Runs the *built* dist/bundle.js the way Home Screens does: React on
// window, the bundle injected as an inline script, the component read from
// window.__HS_PLUGIN__ and rendered inside an error boundary. The source
// preview (index.html) can't catch problems that only exist in the bundle.
import React from 'react';
import { createRoot } from 'react-dom/client';
import manifest from '../manifest.json';
import { mockPluginFetch } from './mock';
import { makeHostDisplayCache } from './host-cache';
// The exact file that ships (run `npm run build` first).
import bundle from '../dist/bundle.js?raw';

const errEl = document.getElementById('err')!;
const report = (msg: string) => { errEl.textContent += `${msg}\n`; };

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    report(`RENDER ERROR: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`);
  }
  render() {
    return this.state.error ? <p>This item could not be shown.</p> : this.props.children;
  }
}

(async () => {
  const w = window as unknown as Record<string, unknown>;
  w.React = React;
  // `?nokey`: answer like the proxy does when no API key has been entered.
  const noKey: typeof mockPluginFetch = async (_id, opts) => new Response(JSON.stringify({
    error: 'Plugin proxy request failed',
    detail: `Secret "${opts.url.includes('lapi') ? 'train_key' : 'bus_key'}" is not configured for plugin "cta-tracker"`,
  }), { status: 500, headers: { 'content-type': 'application/json' } });
  const fetcher = new URLSearchParams(location.search).has('nokey') ? noKey : mockPluginFetch;
  w.__HS_SDK__ = { pluginFetch: fetcher, displayCache: makeHostDisplayCache() };
  try {
    const script = document.createElement('script');
    script.textContent = bundle;
    document.head.appendChild(script);
    document.head.removeChild(script);
  } catch (e) {
    report(`BUNDLE EXECUTION ERROR: ${String(e)}`);
  }
  const exp = w.__HS_PLUGIN__ as Record<string, unknown> | undefined;
  if (!exp?.default) { report('Bundle did not set window.__HS_PLUGIN__.default'); return; }
  const Component = exp.default as React.ComponentType<Record<string, unknown>>;
  // What the host passes: the module's saved config and its resolved style.
  const style = {
    fontSize: 16, fontFamily: 'inter', textColor: '#ffffff', backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 12, padding: 16, opacity: 1, backdropBlur: 12, borderWidth: 0, borderColor: 'rgba(255,255,255,0.15)', shadowSize: 0,
  };
  const box = { width: manifest.defaultSize.w, height: manifest.defaultSize.h, marginBottom: 16 };
  const instance = <Boundary><Component config={{ ...manifest.defaultConfig }} style={style} timezone="America/Chicago" /></Boundary>;
  const root = createRoot(document.getElementById('root')!);
  root.render(<div style={box}>{instance}</div>);
  // The case that broke on the Pi: a second copy mounting after the first
  // has loaded and cached data (the editor does this as soon as you add it).
  setTimeout(() => {
    root.render(<><div style={box}>{instance}</div><div id="second" style={box}>{instance}</div></>);
    setTimeout(() => report(errEl.textContent ? 'FAILED' : 'OK: both copies rendered'), 3000);
  }, 3000);
})();

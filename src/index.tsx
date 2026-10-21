import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { BLUE_SOUTH_LIMIT, BLUE_STATIONS_SHOWN, BLUE_TRACK_SHOWN } from './blue-line';
import type { LatLon } from './blue-line';
import {
  busRowKey, classify, loadArrivals, loadPatterns, loadPositions, message, parseRoutes, PATTERN_TTL_MS,
  trainRowKey,
} from './cta';
import type { Arrival, ArrivalData, FetchJson, LiveRequest, Pattern, PositionData, Vehicle } from './cta';
import { approachZone, busPdistNow, positionNow, stopsToCenter, withObservedSpeed } from './motion';

const PLUGIN_ID = 'cta-tracker';

const BLUE = '#00A1DE';
/** Bus colors by position in the route list; chosen to stay apart from the
 *  Blue Line and from each other on a dark background. */
const BUS_COLORS = ['#F5A524', '#3DDC84', '#F472B6', '#A78BFA', '#F87171', '#FDE047', '#5EEAD4'];

const ROUTE_NAMES: Record<string, string> = {
  9: 'Ashland', X9: 'Ashland Express', 49: 'Western', 50: 'Damen', 56: 'Milwaukee',
  65: 'Grand', 66: 'Chicago', 70: 'Division', 72: 'North', 8: 'Halsted',
};

const DIR_ORDER = ['Northbound', 'Southbound', 'Eastbound', 'Westbound'];
const DIR_ARROW: Record<string, string> = {
  Northbound: '↑', Southbound: '↓', Eastbound: '→', Westbound: '←',
};

/** How far past the map edge (as a fraction of half the view) a point still
 *  counts as in view, so lines and vehicles run off the edge cleanly. */
const VIEW_MARGIN = 1.15;

/** Drawn positions advance once a second; CSS glides each marker between
 *  them, so motion is continuous for one render per second. */
const MOTION_TICK_MS = 1000;

// ── Config ──────────────────────────────────────────────────────────────────

interface Config {
  layout: 'auto' | 'side' | 'stacked' | 'map';
  radiusMiles: number;
  /** Arrival predictions. */
  refreshSeconds: number;
  /** Vehicle positions. */
  positionSeconds: number;
  busRoutes: string;
  trainStation: string;
  centerLat: number;
  centerLon: number;
  centerLabel: string;
  arrivalsPerDirection: number;
  timeFormat: 'minutes' | 'clock' | 'both';
  showPassed: boolean;
  showStreets: boolean;
  /** A bus this many stops or fewer from the center is emphasized; 0 = off. */
  nearStops: number;
  /** Routes whose approach zone (the last `nearStops` stops) is drawn. */
  highlightRoutes: string[];
  iconStyle: IconStyle;
}

function readConfig(raw: Record<string, unknown>): Config {
  const n = (v: unknown, d: number, lo: number, hi: number) => {
    const x = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  const pick = <T extends string>(v: unknown, opts: T[], d: T): T =>
    opts.includes(v as T) ? (v as T) : d;
  return {
    layout: pick(raw.layout, ['auto', 'side', 'stacked', 'map'], 'auto'),
    radiusMiles: n(raw.radiusMiles, 1.5, 0.25, 10),
    refreshSeconds: n(raw.refreshSeconds, 30, 15, 300),
    positionSeconds: n(raw.positionSeconds, 10, 10, 60),
    busRoutes: typeof raw.busRoutes === 'string' ? raw.busRoutes : '56,70,9',
    trainStation: typeof raw.trainStation === 'string' ? raw.trainStation.trim() : '40320',
    centerLat: n(raw.centerLat, 41.903355, -90, 90),
    centerLon: n(raw.centerLon, -87.666496, -180, 180),
    centerLabel: typeof raw.centerLabel === 'string' ? raw.centerLabel : 'Division',
    arrivalsPerDirection: Math.round(n(raw.arrivalsPerDirection, 3, 1, 5)),
    timeFormat: pick(raw.timeFormat, ['minutes', 'clock', 'both'], 'minutes'),
    showPassed: raw.showPassed !== false,
    showStreets: raw.showStreets !== false,
    nearStops: Math.round(n(raw.nearStops, 4, 0, 10)),
    highlightRoutes: parseRoutes(typeof raw.highlightRoutes === 'string' ? raw.highlightRoutes : '56'),
    iconStyle: pick(raw.iconStyle, ['badge', 'car', 'tile'], 'car'),
  };
}

// ── Data ────────────────────────────────────────────────────────────────────

/** The host proxy allows 60 requests a minute per plugin, cached answers
 *  included. One module uses ~16; this backstop keeps any number of modules
 *  on the display under the limit by skipping a poll rather than tripping a
 *  429 for every module at once. */
const PAGE_BUDGET_PER_MIN = 50;
const recentRequests: number[] = [];

function takeBudget(): boolean {
  const now = Date.now();
  while (recentRequests.length && now - recentRequests[0] > 60_000) recentRequests.shift();
  if (recentRequests.length >= PAGE_BUDGET_PER_MIN) return false;
  recentRequests.push(now);
  return true;
}

const fetchJson: FetchJson = async (url, secret, cacheTtlMs) => {
  const sdk = window.__HS_SDK__;
  if (!sdk?.pluginFetch) throw new Error('Host SDK unavailable');
  if (!takeBudget()) throw new Error('Skipped a refresh to stay under the request limit');
  const res = await sdk.pluginFetch(PLUGIN_ID, {
    url,
    secretInjections: { query: { key: `{{${secret}}}` } },
    cacheTtlMs,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}`); }
  if (!res.ok) {
    // The proxy puts the real reason in `detail`, under a generic `error`.
    const body = json as { error?: string; detail?: string } | null;
    const err = body?.detail || body?.error || `HTTP ${res.status}`;
    if (/not configured/i.test(err)) {
      throw new Error(`${secret === 'train_key' ? 'Train' : 'Bus'} Tracker key not set (Plugin Store > Installed > CTA Tracker)`);
    }
    throw new Error(err);
  }
  return json;
};

/** How long the host keeps what we stash in its display cache. Long enough
 *  to cover screen rotation and editor remounts; fresh data replaces it
 *  within one poll either way. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Read back something we cached, or undefined.
 *
 *  The host's `displayCache.get` returns an envelope, `{ data, stale,
 *  fetchedAt }`, not the stored value (1.2.0 missed this and crashed on any
 *  second mount). An older host or a test double may hand back the bare
 *  value, so both are accepted, and `valid` checks the shape either way: a
 *  bad entry means a fresh load, never a crash. */
function cacheGet<T>(key: string, valid: (v: unknown) => v is T): T | undefined {
  try {
    const hit = window.__HS_SDK__?.displayCache?.get(key) as unknown;
    if (hit && typeof hit === 'object' && 'data' in hit && 'stale' in hit) {
      const data = (hit as { data: unknown }).data;
      return valid(data) ? data : undefined;
    }
    return valid(hit) ? hit : undefined;
  } catch {
    return undefined;
  }
}
function cacheSet(key: string, value: unknown): void {
  try { window.__HS_SDK__?.displayCache?.set(key, value, CACHE_TTL_MS); } catch { /* preview without host */ }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isPatternState = (v: unknown): v is PatternState =>
  isObj(v) && Array.isArray(v.patterns) && Array.isArray(v.errors) && typeof v.at === 'number';
const isPositionData = (v: unknown): v is PositionData =>
  isObj(v) && Array.isArray(v.vehicles) && Array.isArray(v.errors) && typeof v.fetchedAt === 'number';
const isArrivalData = (v: unknown): v is ArrivalData =>
  isObj(v) && Array.isArray(v.arrivals) && Array.isArray(v.errors) && typeof v.fetchedAt === 'number';

interface PatternState { patterns: Pattern[]; errors: string[]; at: number }

function usePatterns(routes: string[], center: LatLon): PatternState | null {
  const key = `${PLUGIN_ID}:patterns:${routes.join(',')}:${center.join(',')}`;
  const [state, setState] = useState<PatternState | null>(() => cacheGet(key, isPatternState) ?? null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cached = cacheGet(key, isPatternState);
    setState(cached ?? null);

    const run = async () => {
      const result = await loadPatterns(fetchJson, routes, center);
      if (cancelled) return;
      // Keep the last good geometry through a failed refresh.
      const prev = cacheGet(key, isPatternState);
      const next = result.patterns.length || !prev
        ? { ...result, at: Date.now() }
        : { ...prev, errors: result.errors };
      cacheSet(key, next);
      setState(next);
      // Retry sooner when a route failed to load.
      timer = setTimeout(run, result.errors.length ? 60_000 : PATTERN_TTL_MS);
    };
    const age = cached ? Date.now() - cached.at : Infinity;
    timer = setTimeout(run, cached && !cached.errors.length ? Math.max(0, PATTERN_TTL_MS - age) : 0);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** Poll `load` every `intervalMs` once `req` is ready (patterns loaded, so
 *  bus stops are known), keeping the last result in the display cache so a
 *  remount shows data immediately. */
function usePoll<T>(
  key: string,
  req: LiveRequest | null,
  intervalMs: number,
  load: (req: LiveRequest) => Promise<T>,
  valid: (v: unknown) => v is T,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(() => cacheGet(key, valid) ?? null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!req) return undefined;
    let cancelled = false;
    let busy = false;
    const run = async () => {
      // A slow response must not stack a second request on top of it.
      if (busy) return;
      busy = true;
      try {
        const next = await loadRef.current(req);
        if (cancelled) return;
        cacheSet(key, next);
        setData(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(message(err));
      } finally {
        busy = false;
      }
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [key, req, intervalMs]);

  return { data, error };
}

function useLive(
  routes: string[], station: string, patterns: PatternState | null, center: LatLon,
  positionMs: number, arrivalsMs: number,
) {
  const patternList = patterns?.patterns;
  const ready = !!patterns;
  const makeReq = (intervalMs: number): LiveRequest | null => (ready
    ? {
      routes, station, patterns: patternList ?? [], center,
      // Shared through the proxy cache by any other module asking for the
      // same thing, but always fresh for our own next poll.
      cacheTtlMs: Math.max(5_000, intervalMs - 2_000),
    }
    : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const posReq = useMemo(() => makeReq(positionMs), [ready, patternList, routes, station, center, positionMs]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const arrReq = useMemo(() => makeReq(arrivalsMs), [ready, patternList, routes, station, center, arrivalsMs]);

  const base = `${PLUGIN_ID}:${routes.join(',')}:${station}`;
  const history = useRef(new Map());
  const positions = usePoll<PositionData>(`${base}:positions`, posReq, positionMs, async (req) => {
    const p = await loadPositions(fetchJson, req);
    return { ...p, vehicles: withObservedSpeed(p.vehicles, history.current) };
  }, isPositionData);
  const arrivals = usePoll<ArrivalData>(
    `${base}:arrivals`, arrReq, arrivalsMs, (req) => loadArrivals(fetchJson, req), isArrivalData,
  );
  return { positions, arrivals };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface Row {
  key: string;
  kind: 'train' | 'bus';
  badge: string;
  color: string;
  label: string;
  arrow: string;
  arrivals: Arrival[];
}

function routeColor(routes: string[], route: string): string {
  const i = routes.indexOf(route.toUpperCase());
  return BUS_COLORS[(i < 0 ? 0 : i) % BUS_COLORS.length];
}

function buildRows(
  routes: string[], station: string, patterns: Pattern[], live: ArrivalData | null, now: number, perDir: number,
): Row[] {
  const byRow = new Map<string, Arrival[]>();
  for (const a of live?.arrivals ?? []) {
    // A vehicle that is "due" stays listed until it's half a minute late.
    if (a.etaMs < now - 30_000) continue;
    const list = byRow.get(a.rowKey) ?? [];
    list.push(a);
    byRow.set(a.rowKey, list);
  }
  const take = (key: string) =>
    (byRow.get(key) ?? []).sort((a, b) => a.etaMs - b.etaMs).slice(0, perDir);

  const rows: Row[] = [];
  if (station) {
    rows.push(
      { key: trainRowKey('1'), kind: 'train', badge: 'Blue', color: BLUE, label: "O'Hare", arrow: '↖', arrivals: take(trainRowKey('1')) },
      { key: trainRowKey('5'), kind: 'train', badge: 'Blue', color: BLUE, label: 'Forest Pk', arrow: '↘', arrivals: take(trainRowKey('5')) },
    );
  }
  for (const rt of routes) {
    const dirs = new Set(patterns.filter((p) => p.route === rt && p.centerStop).map((p) => p.dir));
    // Patterns failed to load: fall back to whatever the predictions say.
    for (const a of live?.arrivals ?? []) if (a.kind === 'bus' && a.route === rt) dirs.add(a.rowKey.split(':')[2]);
    const sorted = [...dirs].sort((a, b) => DIR_ORDER.indexOf(a) - DIR_ORDER.indexOf(b));
    for (const dir of sorted) {
      const key = busRowKey(rt, dir);
      rows.push({
        key, kind: 'bus', badge: rt, color: routeColor(routes, rt),
        label: dir.replace(/bound$/, ''), arrow: DIR_ARROW[dir] ?? '', arrivals: take(key),
      });
    }
  }
  return rows;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function minutesUntil(etaMs: number, now: number): number {
  return Math.max(0, Math.round((etaMs - now) / 60000));
}

const clockFmt = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  }
})();

function clock(ms: number): string {
  return clockFmt.format(new Date(ms)).replace(/\s?[AP]M$/i, '');
}

function shortMinutes(etaMs: number, now: number): string {
  const m = minutesUntil(etaMs, now);
  return m < 1 ? 'Due' : `${m}m`;
}

// ── Map ─────────────────────────────────────────────────────────────────────

/** Chicago's street grid: 800 address numbers to the mile from State and
 *  Madison. Close enough to draw faint reference streets. */
const GRID_ORIGIN: LatLon = [41.88185, -87.62794];
const NS_STREETS: [string, number][] = [
  ['Pulaski', 4000], ['Kedzie', 3200], ['California', 2800], ['Western', 2400], ['Damen', 2000],
  ['Ashland', 1600], ['Racine', 1200], ['Halsted', 800], ['Clark', 100],
];
const EW_STREETS: [string, number][] = [
  ['Belmont', 3200], ['Fullerton', 2400], ['Armitage', 2000], ['North', 1600], ['Division', 1200],
  ['Chicago', 800], ['Grand', 530], ['Lake', 200], ['Madison', 0], ['Roosevelt', -1200],
];

interface Projection {
  x: (p: LatLon) => number;
  y: (p: LatLon) => number;
  inView: (p: LatLon, margin?: number) => boolean;
}

function makeProjection(center: LatLon, radius: number, w: number, h: number): Projection {
  const pxPerMile = Math.min(w, h) / 2 / radius;
  const ky = 69.05 * pxPerMile;
  const kx = ky * Math.cos((center[0] * Math.PI) / 180);
  const x = (p: LatLon) => w / 2 + (p[1] - center[1]) * kx;
  const y = (p: LatLon) => h / 2 - (p[0] - center[0]) * ky;
  return {
    x, y,
    inView: (p, margin = VIEW_MARGIN) => {
      const dx = Math.abs(x(p) - w / 2);
      const dy = Math.abs(y(p) - h / 2);
      return dx <= (w / 2) * margin && dy <= (h / 2) * margin;
    },
  };
}

function pathOf(points: LatLon[], proj: Projection): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // Keep a point when it or a neighbour is in view, so lines run off the
    // edge instead of stopping short of it.
    const show = proj.inView(p, 1.6)
      || (i > 0 && proj.inView(points[i - 1], 1.6))
      || (i + 1 < points.length && proj.inView(points[i + 1], 1.6));
    if (!show) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${proj.x(p).toFixed(1)} ${proj.y(p).toFixed(1)}`;
    pen = true;
  }
  return d;
}

interface Placed {
  v: Vehicle;
  x: number;
  y: number;
  r: number;
  /** Radius the marker needs clear around it. */
  hit: number;
  color: string;
  faded: boolean;
  near: boolean;
  label: string | null;
  /** Where the time tag goes, relative to the vehicle (set by placeTags). */
  tag?: { dx: number; dy: number; w: number; h: number; fs: number };
}

/** Push overlapping markers apart until each one is visible. A faded
 *  (already passed) marker gives way to one still coming, so the vehicles
 *  that matter stay where they really are; two of the same rank split the
 *  move. A few passes settle clusters of three or more. */
function separate(items: Placed[], passes = 6): void {
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const need = a.hit + b.hit;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d < 0.5) {
          // Exactly on top of each other: split across b's direction of travel.
          const rad = (b.v.heading * Math.PI) / 180;
          dx = Math.cos(rad);
          dy = Math.sin(rad);
          d = 1;
        }
        const push = need - Math.hypot(b.x - a.x, b.y - a.y);
        const ux = dx / d;
        const uy = dy / d;
        const share = a.faded === b.faded ? 0.5 : a.faded ? 1 : 0;
        a.x -= ux * push * share;
        a.y -= uy * push * share;
        b.x += ux * push * (1 - share);
        b.y += uy * push * (1 - share);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

interface MapProps {
  w: number;
  h: number;
  fontPx: number;
  center: LatLon;
  centerLabel: string;
  radius: number;
  routes: string[];
  patterns: Pattern[];
  vehicles: Vehicle[];
  arrivals: Arrival[];
  now: number;
  showPassed: boolean;
  showStreets: boolean;
  timeFormat: Config['timeFormat'];
  nearStops: number;
  highlightRoutes: string[];
  /** Stops to go before the center, by bus id, for buses headed there. */
  busStops: Map<string, number>;
  iconStyle: IconStyle;
}

function TransitMap(props: MapProps) {
  const { w, h, fontPx, center, radius, routes, patterns, vehicles, arrivals, now, nearStops } = props;
  const proj = useMemo(() => makeProjection(center, radius, w, h), [center[0], center[1], radius, w, h]);

  const routePaths = useMemo(() => {
    // Both directions of a route trace the same street; draw each once.
    const seen = new Set<string>();
    const out: { key: string; d: string; color: string }[] = [];
    for (const p of patterns) {
      const d = pathOf(p.points, proj);
      if (!d || seen.has(`${p.route}:${d.length}`)) continue;
      seen.add(`${p.route}:${d.length}`);
      out.push({ key: p.pid, d, color: routeColor(routes, p.route) });
    }
    return out;
  }, [patterns, proj, routes]);

  const bluePaths = useMemo(() => BLUE_TRACK_SHOWN.map((seg) => pathOf(seg, proj)).filter(Boolean), [proj]);

  // The last few stops before the center on highlighted routes, drawn bright
  // so a bus inside them reads as "almost here" at a glance.
  const zones = useMemo(() => {
    if (nearStops < 1) return [];
    const seen = new Set<string>();
    return patterns.flatMap((p) => {
      if (!props.highlightRoutes.includes(p.route.toUpperCase())) return [];
      const zone = approachZone(p, nearStops);
      // Short-turn patterns share the same approach; draw each once.
      const key = `${p.route}:${p.dir}:${zone?.stops.map((s) => s.join()).join('|')}`;
      if (!zone || seen.has(key)) return [];
      seen.add(key);
      return [{
        key: p.pid,
        d: pathOf(zone.path, proj),
        stops: zone.stops.map((s) => [proj.x(s), proj.y(s)] as [number, number]),
        color: routeColor(routes, p.route),
      }];
    });
  }, [patterns, proj, routes, nearStops, props.highlightRoutes]);

  const streets = useMemo(() => {
    if (!props.showStreets) return [];
    const milesPerLon = 69.05 * Math.cos((GRID_ORIGIN[0] * Math.PI) / 180);
    const out: { key: string; x1: number; y1: number; x2: number; y2: number; name: string; lx: number; ly: number; vertical: boolean }[] = [];
    for (const [name, addr] of NS_STREETS) {
      const lon = GRID_ORIGIN[1] - addr / 800 / milesPerLon;
      const x = proj.x([center[0], lon]);
      if (x < 0 || x > w) continue;
      out.push({ key: `ns${name}`, x1: x, y1: 0, x2: x, y2: h, name, lx: x + fontPx * 0.3, ly: fontPx * 0.95, vertical: true });
    }
    for (const [name, addr] of EW_STREETS) {
      const lat = GRID_ORIGIN[0] + addr / 800 / 69.05;
      const y = proj.y([lat, center[1]]);
      if (y < 0 || y > h) continue;
      out.push({ key: `ew${name}`, x1: 0, y1: y, x2: w, y2: y, name, lx: fontPx * 0.3, ly: y - fontPx * 0.3, vertical: false });
    }
    return out;
  }, [proj, props.showStreets, w, h, fontPx, center[0], center[1]]);

  const etaByVehicle = useMemo(() => {
    const m = new Map<string, Arrival>();
    for (const a of arrivals) {
      if (a.scheduled || a.etaMs < now - 30_000) continue;
      const k = `${a.kind}:${a.vehicleId}`;
      const prev = m.get(k);
      if (!prev || a.etaMs < prev.etaMs) m.set(k, a);
    }
    return m;
  }, [arrivals, now]);

  const byPid = useMemo(() => new Map(patterns.map((p) => [p.pid, p])), [patterns]);

  const visible = vehicles
    .filter((v) => props.showPassed || v.approaching !== false)
    .map((v) => {
      // A bus prediction's implied speed is only about the way to our stop.
      const implied = v.kind === 'bus' && v.approaching !== false
        ? etaByVehicle.get(`bus:${v.id}`)?.impliedFtPerS
        : undefined;
      return { v, at: positionNow(v, now, byPid, implied) };
    })
    // Trains past Monroe toward Forest Park are off the drawn line.
    .filter(({ v, at }) => proj.inView(at, 1.02) && !(v.kind === 'train' && at[0] < BLUE_SOUTH_LIMIT - 0.0005));
  // Faded ones underneath, so an approaching vehicle is never hidden, and
  // buses about to reach the center on top of everything.
  const layer = (v: Vehicle) => {
    if (v.approaching === false) return 0;
    const stops = v.kind === 'bus' ? props.busStops.get(v.id) : undefined;
    if (stops !== undefined && stops <= nearStops) return 3;
    return v.kind === 'train' ? 2 : 1;
  };
  visible.sort((a, b) => layer(a.v) - layer(b.v));

  const busR = fontPx * 0.62;
  const trainR = fontPx * 0.8;
  const small = fontPx * 0.72;

  const placed: Placed[] = visible.map(({ v, at }) => {
    const color = v.kind === 'train' ? BLUE : routeColor(routes, v.route);
    const faded = v.approaching === false;
    const stops = v.kind === 'bus' && !faded ? props.busStops.get(v.id) : undefined;
    const near = stops !== undefined && nearStops > 0 && stops <= nearStops;
    const r = (v.kind === 'train' ? trainR : busR) * (near ? 1.3 : 1);
    const rad = (v.heading * Math.PI) / 180;
    // Nudge each vehicle to the right of its direction of travel, so two
    // buses passing on one street don't sit on top of each other.
    const off = r * 0.9;
    const eta = etaByVehicle.get(`${v.kind}:${v.id}`);
    let label = eta && !faded
      ? (props.timeFormat === 'clock' ? clock(eta.etaMs) : shortMinutes(eta.etaMs, now))
      : null;
    if (near) label = `${label ? `${label} · ` : ''}${stops === 1 ? 'next stop' : `${stops} stops`}`;
    return {
      v, color, faded, near, label, r,
      x: proj.x(at) + Math.cos(rad) * off,
      y: proj.y(at) + Math.sin(rad) * off,
      hit: near ? r * 1.7 : r * (props.iconStyle === 'car' && v.kind === 'train' ? 1.45 : 1.15),
    };
  });
  // The Blue Line runs right over Milwaukee, so a train and a 56 bus at
  // Division land on the same spot; push overlapping markers apart.
  separate(placed);
  const labelW = (props.centerLabel.length * 0.62 + 0.3) * fontPx * 0.85;
  placeTags(placed, small, [
    // The center stop and its label
    { x0: w / 2 - fontPx * 0.5, y0: h / 2 - fontPx * 0.5, x1: w / 2 + fontPx * 0.5, y1: h / 2 + fontPx * 0.5 },
    { x0: w / 2 + fontPx * 0.9, y0: h / 2 - fontPx * 1.7, x1: w / 2 + fontPx * 0.9 + labelW, y1: h / 2 - fontPx * 0.6 },
  ], { x0: 0, y0: 0, x1: w, y1: h });

  const cx = w / 2;
  const cy = h / 2;
  const scaleMiles = radius >= 2 ? 1 : 0.5;
  const scalePx = (Math.min(w, h) / 2 / radius) * scaleMiles;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {streets.map((s) => (
        <g key={s.key}>
          <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="currentColor" strokeOpacity={0.12} strokeWidth={1} />
          <text x={s.lx} y={s.ly} fontSize={small * 0.9} fill="currentColor" fillOpacity={0.4}>{s.name}</text>
        </g>
      ))}

      {routePaths.map((r) => (
        <path key={r.key} d={r.d} fill="none" stroke={r.color} strokeOpacity={0.55}
          strokeWidth={fontPx * 0.22} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {bluePaths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={BLUE} strokeOpacity={0.8}
          strokeWidth={fontPx * 0.42} strokeLinecap="round" strokeLinejoin="round" />
      ))}

      {zones.map((z) => (
        <g key={`zone${z.key}`}>
          <path d={z.d} fill="none" stroke={z.color} strokeOpacity={0.28}
            strokeWidth={fontPx * 0.95} strokeLinecap="round" strokeLinejoin="round" />
          <path d={z.d} fill="none" stroke={z.color}
            strokeWidth={fontPx * 0.3} strokeLinecap="round" strokeLinejoin="round" />
          {z.stops.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={fontPx * 0.2} fill="#111" stroke={z.color} strokeWidth={fontPx * 0.1} />
          ))}
        </g>
      ))}
      {BLUE_STATIONS_SHOWN.filter((s) => proj.inView([s.lat, s.lon], 1)).map((s) => {
        const x = proj.x([s.lat, s.lon]);
        const y = proj.y([s.lat, s.lon]);
        const isCenter = Math.hypot(x - cx, y - cy) < fontPx * 0.5;
        if (isCenter) return null;
        return (
          <g key={s.id}>
            <circle cx={x} cy={y} r={fontPx * 0.28} fill="#fff" stroke={BLUE} strokeWidth={fontPx * 0.12} />
            <text x={x - fontPx * 0.55} y={y + small * 0.35} fontSize={small} textAnchor="end"
              fill="currentColor" fillOpacity={0.75} style={haloStyle}>{s.name}</text>
          </g>
        );
      })}

      {/* The stop everything is timed against */}
      <circle cx={cx} cy={cy} r={fontPx * 1.1} fill="none" stroke="#fff" strokeOpacity={0.5}
        strokeWidth={1.5} strokeDasharray="3 3" />
      <circle cx={cx} cy={cy} r={fontPx * 0.38} fill="#fff" stroke="#000" strokeWidth={1.5} />
      {props.centerLabel && (
        // Up and right of the stop: at Division that corner is clear of
        // Milwaukee (NW-SE), Division (E-W) and Ashland (N-S).
        <text x={cx + fontPx * 0.9} y={cy - fontPx * 0.9} fontSize={fontPx * 0.85} fontWeight={700}
          textAnchor="start" fill="currentColor" style={haloStyle}>{props.centerLabel}</text>
      )}

      {placed.map(({ v, x, y, r, color, faded, near, label, tag }) => {
        return (
          <g key={`${v.kind}:${v.id}`} style={{
            // Glide from the last drawn position to this one over exactly one
            // tick, so the marker never stops between ticks. A vehicle seen
            // for the first time has nothing to glide from and just appears.
            transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
            transition: `transform ${MOTION_TICK_MS}ms linear, opacity 1s`,
            opacity: faded ? 0.3 : 1,
          }}>
            {near && <circle r={r * 1.7} fill={color} fillOpacity={0.3} stroke={color} strokeOpacity={0.9} strokeWidth={1.5} />}
            <VehicleIcon kind={v.kind} r={r} heading={v.heading} color={color} style={props.iconStyle} />
            {label && tag && (
              <EtaTag x={tag.dx} y={tag.dy} w={tag.w} h={tag.h} text={label} color={color} fontPx={tag.fs} />
            )}
          </g>
        );
      })}

      {/* Scale bar */}
      <g transform={`translate(${w - scalePx - fontPx * 0.6} ${h - fontPx * 0.7})`} opacity={0.6}>
        <path d={`M0 -4 V0 H${scalePx} V-4`} fill="none" stroke="currentColor" strokeWidth={1.5} />
        <text x={scalePx} y={-fontPx * 0.45} fontSize={small * 0.9} textAnchor="end" fill="currentColor">
          {scaleMiles === 1 ? '1 mi' : '½ mi'}
        </text>
      </g>
    </svg>
  );
}

// Pictograms from Lucide (ISC license): `bus-front` and `train-front`, on a
// 24-unit grid drawn as 2-unit strokes.
const BUS_GLYPH = [
  'M4 6 2 7', 'M10 6h4', 'm22 7-2-1', 'M6 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  'M4 11h16', 'M8 15h.01', 'M16 15h.01', 'M6 19v2', 'M18 21v-2',
];
const TRAIN_GLYPH = [
  'M8 3.1V7a4 4 0 0 0 8 0V3.1', 'm9 15-1-1', 'm15 15 1-1',
  'M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z', 'm8 19-2 3', 'm16 19 2 3',
];

type IconStyle = 'badge' | 'car' | 'tile';

function Glyph(props: { kind: 'train' | 'bus'; r: number; ink: string }) {
  const glyph = (props.r * 1.25) / 24;
  return (
    <g transform={`scale(${glyph}) translate(-12 -12)`} fill="none" stroke={props.ink}
      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      {(props.kind === 'train' ? TRAIN_GLYPH : BUS_GLYPH).map((d, i) => <path key={i} d={d} />)}
    </g>
  );
}

function VehicleIcon(props: { kind: 'train' | 'bus'; r: number; heading: number; color: string; style: IconStyle }) {
  if (props.style === 'car') return props.kind === 'train' ? <TrainCar {...props} /> : <Badge {...props} />;
  if (props.style === 'tile') return <Tile {...props} />;
  return <Badge {...props} />;
}

/** Top-down rail car, long and aligned with the track, with a pointed cab
 *  at the front and a coupling line between two cars: nothing like a bus. */
function TrainCar(props: { r: number; heading: number; color: string }) {
  const { r, color } = props;
  const w = r * 0.78; // half width
  const len = r * 1.9; // half length
  const cab = r * 0.75; // taper of the front
  const body = `M${-w} ${len} L${-w} ${-len + cab} Q${-w} ${-len} 0 ${-len - r * 0.15} `
    + `Q${w} ${-len} ${w} ${-len + cab} L${w} ${len} Q${w} ${len + r * 0.2} 0 ${len + r * 0.2} `
    + `Q${-w} ${len + r * 0.2} ${-w} ${len} Z`;
  return (
    <g transform={`rotate(${props.heading})`}>
      <path d={body} fill={color} stroke="#fff" strokeWidth={1.8} strokeLinejoin="round" />
      {/* Windshield, then the gap between the two cars */}
      <path d={`M${-w * 0.55} ${-len + cab * 0.9} L${w * 0.55} ${-len + cab * 0.9}`} stroke="#fff" strokeWidth={r * 0.28} strokeLinecap="round" />
      <path d={`M${-w} ${len * 0.18} L${w} ${len * 0.18}`} stroke="rgba(0,0,0,0.55)" strokeWidth={1.5} />
      {/* Chevron pointing forward on the lead car */}
      <path d={`M${-w * 0.5} ${-len * 0.05} L0 ${-len * 0.45} L${w * 0.5} ${-len * 0.05}`}
        stroke="#fff" strokeWidth={r * 0.22} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </g>
  );
}

/** Square for trains, circle for buses, each with an upright pictogram and a
 *  separate arrow just outside it showing which way it's going. */
function Tile(props: { kind: 'train' | 'bus'; r: number; heading: number; color: string }) {
  const { r, color } = props;
  const train = props.kind === 'train';
  const edge = train ? r * 1.12 : r;
  return (
    <g>
      <path d={`M${-r * 0.5} ${-edge - r * 0.12} L0 ${-edge - r * 0.75} L${r * 0.5} ${-edge - r * 0.12} Z`}
        transform={`rotate(${props.heading})`} fill={color} stroke={train ? '#fff' : '#000'} strokeWidth={1.2} strokeLinejoin="round" />
      {train
        ? <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={r * 0.3} fill={color} stroke="#fff" strokeWidth={1.8} />
        : <circle r={r} fill={color} stroke="#000" strokeWidth={1.2} />}
      <Glyph kind={props.kind} r={r} ink={train ? '#fff' : '#000'} />
    </g>
  );
}

/** A round badge with a pointed nose aimed along the heading, and an
 *  upright train or bus pictogram inside. */
function Badge(props: { kind: 'train' | 'bus'; r: number; heading: number; color: string }) {
  const { r, color } = props;
  const train = props.kind === 'train';
  const ink = train ? '#fff' : '#000';
  // Circle of radius r with a tip 1.75r out: the tangent points sit at
  // asin(1/1.75) ~ 35 deg either side of the nose.
  const tip = r * 1.75;
  const tx = r * 0.82;
  const ty = -r * 0.57;
  const badge = `M0 ${-tip} L${tx} ${ty} A${r} ${r} 0 1 1 ${-tx} ${ty} Z`;
  return (
    <g>
      <path d={badge} transform={`rotate(${props.heading})`} fill={color}
        stroke={train ? '#fff' : '#000'} strokeWidth={train ? 1.6 : 1.2} strokeLinejoin="round" />
      <Glyph kind={props.kind} r={r} ink={ink} />
    </g>
  );
}

const haloStyle: CSSProperties = {
  paintOrder: 'stroke',
  stroke: 'rgba(0,0,0,0.85)',
  strokeWidth: 3,
  strokeLinejoin: 'round',
};

/** A time tag; `x`/`y` is its top-left corner relative to the vehicle. */
function EtaTag(props: { x: number; y: number; w: number; h: number; text: string; color: string; fontPx: number }) {
  const { x, y, w, h, fontPx } = props;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={h / 2}
        fill="rgba(0,0,0,0.8)" stroke={props.color} strokeWidth={1.5} />
      <text x={x + w / 2} y={y + h / 2 + fontPx * 0.36} fontSize={fontPx} fontWeight={700}
        textAnchor="middle" fill="#fff">{props.text}</text>
    </g>
  );
}

interface Box { x0: number; y0: number; x1: number; y1: number }

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
    * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

/** Put each time tag on whichever side of its vehicle (right of travel
 *  first, then the other side, above, below) covers the least of the other
 *  vehicles, tags and `keepClear` boxes. The vehicles closest to the center
 *  choose first, since their tags matter most. */
function placeTags(items: Placed[], small: number, keepClear: Box[], view: Box): void {
  const viewArea = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);
  const icons: Box[] = items.map((it) => ({ x0: it.x - it.hit, y0: it.y - it.hit, x1: it.x + it.hit, y1: it.y + it.hit }));
  const taken: Box[] = [];
  const order = items.map((_, i) => i).reverse(); // items are sorted lowest layer first
  for (const i of order) {
    const it = items[i];
    if (!it.label) continue;
    const fs = it.near ? small * 1.1 : small;
    const w = it.label.length * fs * 0.62 + fs * 0.6;
    const h = fs * 1.35;
    const gap = it.hit + fs * 0.15;
    const right = Math.cos((it.v.heading * Math.PI) / 180) >= 0;
    const sides: [number, number][] = [
      [gap, -h / 2], [-gap - w, -h / 2], [-w / 2, -gap - h], [-w / 2, gap],
    ];
    if (!right) [sides[0], sides[1]] = [sides[1], sides[0]];
    let best = sides[0];
    let bestScore = Infinity;
    for (const [dx, dy] of sides) {
      const box = { x0: it.x + dx, y0: it.y + dy, x1: it.x + dx + w, y1: it.y + dy + h };
      let score = 0;
      icons.forEach((b, j) => { if (j !== i) score += overlapArea(box, b); });
      for (const b of taken) score += overlapArea(box, b) * 2; // tag on tag is worst
      for (const b of keepClear) score += overlapArea(box, b);
      score += (viewArea(box) - overlapArea(box, view)) * 3; // cut off by the map edge
      if (score < bestScore - 0.5) { best = [dx, dy]; bestScore = score; }
    }
    it.tag = { dx: best[0], dy: best[1], w, h, fs };
    taken.push({ x0: it.x + best[0], y0: it.y + best[1], x1: it.x + best[0] + w, y1: it.y + best[1] + h });
  }
}

// ── Arrivals board ──────────────────────────────────────────────────────────

function ArrivalChip(props: {
  a: Arrival; now: number; fmt: Config['timeFormat']; color: string; tracked: boolean;
  /** Stops to go, set only when the bus is within the "near" count. */
  nearStops?: number;
}) {
  const { a, now, fmt } = props;
  const main = fmt === 'clock' ? clock(a.etaMs) : shortMinutes(a.etaMs, now);
  const near = props.nearStops !== undefined;
  const stopsText = near ? (props.nearStops === 1 ? 'next stop' : `${props.nearStops} stops`) : null;
  const sub = [fmt === 'both' ? clock(a.etaMs) : null, stopsText].filter(Boolean).join(' · ') || null;
  // A dashed chip is a timetable promise with no vehicle seen behind it:
  // the one to be skeptical of.
  const ghost = a.scheduled || !props.tracked;
  return (
    <div style={{
      minWidth: '3.4em',
      padding: '0.15em 0.4em',
      borderRadius: '0.4em',
      border: `${near ? '0.18em' : '0.1em'} ${ghost ? 'dashed' : 'solid'} ${ghost ? 'rgba(255,255,255,0.45)' : props.color}`,
      background: ghost ? 'transparent' : near ? `${props.color}40` : 'rgba(255,255,255,0.08)',
      opacity: ghost ? 0.75 : 1,
      textAlign: 'center',
      lineHeight: 1.1,
    }}>
      <div style={{ fontWeight: 700, fontSize: '1.05em', color: a.delayed ? '#FBBF24' : undefined }}>
        {ghost && a.scheduled ? '~' : ''}{main}
      </div>
      {sub && <div style={{ fontSize: '0.7em', opacity: near ? 0.95 : 0.7, fontWeight: near ? 700 : undefined }}>{sub}</div>}
    </div>
  );
}

function Board(props: {
  rows: Row[]; now: number; fmt: Config['timeFormat']; vehicleIds: Set<string>;
  busStops: Map<string, number>; nearStops: number;
  footer: React.ReactNode;
}) {
  const { rows, now } = props;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35em', minWidth: 0, height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35em', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
            <div style={{
              background: r.color, color: '#000', fontWeight: 800, borderRadius: '0.35em',
              minWidth: '2.6em', textAlign: 'center', padding: '0.15em 0.3em', fontSize: '0.9em',
            }}>{r.badge}</div>
            <div style={{ width: '5.6em', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.9em' }}>
              <span style={{ opacity: 0.7 }}>{r.arrow}</span> {r.label}
            </div>
            <div style={{ display: 'flex', gap: '0.3em', flex: 1, minWidth: 0 }}>
              {r.arrivals.length
                ? r.arrivals.map((a, i) => (
                  <ArrivalChip key={`${a.vehicleId}:${i}`} a={a} now={now} fmt={props.fmt} color={r.color}
                    tracked={props.vehicleIds.has(`${a.kind}:${a.vehicleId}`)}
                    nearStops={a.kind === 'bus' ? nearCount(props.busStops.get(a.vehicleId), props.nearStops) : undefined} />
                ))
                : <div style={{ opacity: 0.45, fontSize: '0.85em' }}>No arrivals</div>}
            </div>
          </div>
        ))}
      </div>
      {props.footer}
    </div>
  );
}

function nearCount(stops: number | undefined, limit: number): number | undefined {
  return stops !== undefined && limit > 0 && stops <= limit ? stops : undefined;
}

/** Stops to go before the center, by bus id, for buses headed there. Uses
 *  the same advanced position the map draws, so the two always agree. */
function stopsByBus(
  vehicles: Vehicle[], patterns: Pattern[], arrivals: Arrival[], now: number,
): Map<string, number> {
  const byPid = new Map(patterns.map((p) => [p.pid, p]));
  const implied = new Map<string, number>();
  for (const a of arrivals) {
    if (a.kind === 'bus' && a.impliedFtPerS !== undefined && !implied.has(a.vehicleId)) {
      implied.set(a.vehicleId, a.impliedFtPerS);
    }
  }
  const out = new Map<string, number>();
  for (const v of vehicles) {
    if (v.kind !== 'bus' || v.approaching === false || !v.pid) continue;
    const p = byPid.get(v.pid);
    const pdist = busPdistNow(v, now, byPid, implied.get(v.id));
    const n = p && pdist !== null ? stopsToCenter(p, pdist) : null;
    if (n !== null) out.set(v.id, n);
  }
  return out;
}

// ── Root ────────────────────────────────────────────────────────────────────

export default function CtaTracker(props: PluginComponentProps) {
  const cfg = readConfig(props.config ?? {});
  const routes = useMemo(() => parseRoutes(cfg.busRoutes), [cfg.busRoutes]);
  const center = useMemo<LatLon>(() => [cfg.centerLat, cfg.centerLon], [cfg.centerLat, cfg.centerLon]);
  const refreshMs = cfg.refreshSeconds * 1000;
  const positionMs = cfg.positionSeconds * 1000;

  const patterns = usePatterns(routes, center);
  const { positions, arrivals } = useLive(routes, cfg.trainStation, patterns, center, positionMs, refreshMs);
  const data = arrivals.data;
  const vehicles = useMemo(
    () => classify(positions.data?.vehicles ?? [], arrivals.data),
    [positions.data, arrivals.data],
  );
  const error = positions.error ?? arrivals.error;
  const now = useNow(MOTION_TICK_MS);

  const [rootRef, rootSize] = useSize<HTMLDivElement>();
  const [mapRef, mapSize] = useSize<HTMLDivElement>();

  const fontPx = Number.isFinite(props.style?.fontSize) && props.style.fontSize > 0 ? props.style.fontSize : 16;
  const layout = cfg.layout === 'auto'
    ? (rootSize.w >= rootSize.h * 1.15 ? 'side' : 'stacked')
    : cfg.layout;

  const patternList = patterns?.patterns ?? [];
  const rows = buildRows(routes, cfg.trainStation, patternList, data, now, cfg.arrivalsPerDirection);
  const busStops = useMemo(
    () => stopsByBus(vehicles, patternList, data?.arrivals ?? [], now),
    [vehicles, patternList, data, now],
  );
  const vehicleIds = useMemo(() => new Set(vehicles.map((v) => `${v.kind}:${v.id}`)), [vehicles]);

  const errors = [
    error, ...(patterns?.errors ?? []), ...(positions.data?.errors ?? []), ...(data?.errors ?? []),
  ].filter(Boolean) as string[];
  // Stale when either feed has missed three polls in a row.
  const age = data ? now - data.fetchedAt : 0;
  const posAge = positions.data ? now - positions.data.fetchedAt : 0;
  const stale = (data && age > refreshMs * 3) || (positions.data && posAge > positionMs * 3);

  const footer = (
    <div style={{ fontSize: '0.72em', opacity: 0.75, display: 'flex', flexDirection: 'column', gap: '0.15em' }}>
      {errors.length > 0 && (
        <div style={{ color: '#FCA5A5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {errors[0]}{errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.8em', flexWrap: 'wrap' }}>
        <span style={{ color: stale ? '#FBBF24' : undefined }}>
          {!data ? 'Loading…' : stale
            ? `Last update ${Math.max(1, Math.round(Math.max(age, posAge) / 60000))} min ago`
            : `Updated ${clock(data.fetchedAt)}`}
        </span>
        <span>Solid: tracked vehicle</span>
        <span>Dashed: schedule only</span>
        {cfg.nearStops > 0 && cfg.highlightRoutes.length > 0 && (
          <span>Bright: last {cfg.nearStops} stops before {cfg.centerLabel || 'the stop'}</span>
        )}
      </div>
    </div>
  );

  const map = (
    <div ref={mapRef} style={{ position: 'relative', flex: layout === 'side' ? '1.35 1 0' : '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden', borderRadius: '0.5em' }}>
      {mapSize.w > 0 && mapSize.h > 0 && (
        <TransitMap
          w={mapSize.w} h={mapSize.h} fontPx={fontPx}
          center={center} centerLabel={cfg.centerLabel} radius={cfg.radiusMiles}
          routes={routes} patterns={patternList}
          vehicles={vehicles} arrivals={data?.arrivals ?? []} now={now}
          showPassed={cfg.showPassed} showStreets={cfg.showStreets} timeFormat={cfg.timeFormat}
          nearStops={cfg.nearStops} highlightRoutes={cfg.highlightRoutes} busStops={busStops}
          iconStyle={cfg.iconStyle}
        />
      )}
      {layout === 'map' && (
        <div style={{ position: 'absolute', left: '0.5em', top: '0.4em', right: '0.5em' }}>{footer}</div>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      style={{
        ...hostFrameStyle(props.style),
        display: 'flex',
        flexDirection: layout === 'side' ? 'row' : 'column',
        gap: '0.75em',
      }}
    >
      {map}
      {layout !== 'map' && (
        <div style={layout === 'side'
          ? { flex: '1 1 0', minWidth: '17em', minHeight: 0 }
          : { flex: '0 0 auto', minHeight: 0 }}>
          <Board rows={rows} now={now} fmt={cfg.timeFormat} vehicleIds={vehicleIds}
            busStops={busStops} nearStops={cfg.nearStops} footer={footer} />
        </div>
      )}
    </div>
  );
}

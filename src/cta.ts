// CTA Train Tracker and Bus Tracker (v3) requests and response parsing.
//
// Everything here is pure apart from the `load*` functions, which take
// the fetcher as an argument, so the parsing can be tested against recorded
// responses and the preview harness can feed mock data through the same path.

import type { LatLon } from './blue-line';

export const TRAIN_BASE = 'https://lapi.transitchicago.com/api/1.0';
export const BUS_BASE = 'https://www.ctabustracker.com/bustime/api/v3';

/** Fetch JSON through the host proxy, with the named secret injected as the
 *  `key` query parameter. */
export type FetchJson = (url: string, secret: 'train_key' | 'bus_key', cacheTtlMs: number) => Promise<unknown>;

export type Kind = 'train' | 'bus';

export interface Vehicle {
  kind: Kind;
  id: string;
  route: string;
  /** Row key this vehicle belongs to: `train:1`, `bus:9:Northbound`. */
  rowKey: string;
  lat: number;
  lon: number;
  /** Degrees clockwise from north. */
  heading: number;
  dest: string;
  /** True when headed toward the center stop, false once past it, null when
   *  we can't tell. */
  approaching: boolean | null;
  /** Epoch ms the position was measured (not when we fetched it). */
  fixMs: number;
  /** Bus: pattern and distance along it in feet. */
  pid?: string;
  pdist?: number;
  /** Bus: speed along the pattern from successive fixes, ft/s. */
  observedFtPerS?: number;
  /** Train: next station and when it's predicted to get there (epoch ms). */
  nextStaId?: string;
  nextArrMs?: number;
}

export interface Arrival {
  kind: Kind;
  route: string;
  rowKey: string;
  dest: string;
  vehicleId: string;
  /** Bus stop the prediction is for; empty for trains. */
  stpid: string;
  /** Local epoch ms the vehicle is expected, on this machine's clock. */
  etaMs: number;
  /** Train Tracker is quoting the timetable: no live train is behind it. */
  scheduled: boolean;
  delayed: boolean;
  /** Bus: the speed Bus Tracker's prediction implies, distance left over
   *  time left (ft/s). Averages in stops and lights, which a speed measured
   *  between two fixes can't. */
  impliedFtPerS?: number;
}

export interface PatternStop {
  stpid: string;
  name: string;
  lat: number;
  lon: number;
  pdist: number;
}

export interface Pattern {
  pid: string;
  route: string;
  dir: string;
  points: LatLon[];
  /** Pattern length in feet, the unit of every `pdist`. */
  lengthFt: number;
  stops: PatternStop[];
  /** The stop on this pattern nearest the center, if one is close enough. */
  centerStop: PatternStop | null;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const MILES_PER_DEG = 69.05;

export function milesBetween(a: LatLon, b: LatLon): number {
  const k = Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * MILES_PER_DEG, (a[1] - b[1]) * MILES_PER_DEG * k);
}

/** CTA JSON is converted from XML, so a list of one can arrive as a bare
 *  object. */
export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : NaN;
}

function flag(value: unknown): boolean {
  return value === true || value === '1' || value === 'true' || value === 1;
}

/** Parse CTA's zone-less local timestamps (`2026-10-21T14:32:10`,
 *  `20261021 14:32:10`, `20261021 14:32`) as if they were UTC. Only ever
 *  used to take the difference of two such stamps, which cancels the zone. */
export function parseCtaTime(value: unknown): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value ?? ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

let chicagoParts: Intl.DateTimeFormat | null | undefined;

/** How far Chicago's wall clock is from UTC at `epochMs` (e.g. -5 h in CDT). */
function chicagoOffsetMs(epochMs: number): number {
  if (chicagoParts === undefined) {
    try {
      chicagoParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      chicagoParts = null;
    }
  }
  if (!chicagoParts) return -new Date(epochMs).getTimezoneOffset() * 60000;
  const v: Record<string, number> = {};
  for (const part of chicagoParts.formatToParts(new Date(epochMs))) v[part.type] = +part.value;
  const wall = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
  return Math.round((wall - epochMs) / 60000) * 60000;
}

/** A `parseCtaTime` value (Chicago wall clock) as a real epoch. */
export function chicagoToEpoch(wallMs: number): number {
  if (!Number.isFinite(wallMs)) return NaN;
  // The offset at the wall time read as UTC is right except within hours of
  // a DST change; a second pass settles it.
  const first = wallMs - chicagoOffsetMs(wallMs);
  return wallMs - chicagoOffsetMs(first);
}

export function trainRowKey(trDr: string): string {
  return `train:${trDr}`;
}

export function busRowKey(route: string, dir: string): string {
  return `bus:${route}:${dir}`;
}

// ── Bus Tracker ─────────────────────────────────────────────────────────────

/** Messages Bus Tracker uses for "nothing right now" rather than a failure. */
const BUS_EMPTY = /no (data|arrival|service)|no vehicles|no predictions/i;

/** Dynamic action types that mean the bus won't pick up at the stop:
 *  canceled (1), expressed (4), delayed cancel (12), invalidated (16, 17),
 *  cancelled trip new (18). */
const BUS_SKIP_DYN = new Set([1, 4, 12, 16, 17, 18]);

function busBody(json: unknown, what: string): Record<string, unknown> {
  const body = (json as Record<string, unknown> | null)?.['bustime-response'] as
    | Record<string, unknown>
    | undefined;
  if (!body) throw new Error(`Bus Tracker ${what}: unexpected response`);
  const errs = toArray(body.error as { msg?: string } | { msg?: string }[]);
  const fatal = errs.map((e) => e?.msg ?? '').filter((m) => m && !BUS_EMPTY.test(m));
  // A multi-route request reports "no data" per route alongside real results,
  // so only a request that returned nothing at all counts as failed.
  if (fatal.length && !body.vehicle && !body.prd && !body.ptr) {
    throw new Error(`Bus Tracker: ${fatal[0]}`);
  }
  return body;
}

export function busUrl(endpoint: string, params: Record<string, string>): string {
  const q = new URLSearchParams({ ...params, format: 'json' });
  return `${BUS_BASE}/${endpoint}?${q.toString()}`;
}

interface RawPoint {
  lat: number | string;
  lon: number | string;
  typ: string;
  stpid?: string;
  stpnm?: string;
  pdist?: number | string;
}

/** Stops further than this from the center don't count as "the" stop. */
const CENTER_STOP_MAX_MILES = 0.4;

export function parsePatterns(json: unknown, route: string, center: LatLon): Pattern[] {
  const body = busBody(json, 'patterns');
  return toArray(body.ptr as Record<string, unknown>[]).map((p) => {
    const pts = toArray(p.pt as RawPoint[]);
    const points: LatLon[] = [];
    const stops: PatternStop[] = [];
    for (const pt of pts) {
      const lat = num(pt.lat);
      const lon = num(pt.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push([lat, lon]);
      if (pt.typ === 'S' && pt.stpid) {
        stops.push({ stpid: String(pt.stpid), name: pt.stpnm ?? '', lat, lon, pdist: num(pt.pdist) });
      }
    }
    let centerStop: PatternStop | null = null;
    let best = CENTER_STOP_MAX_MILES;
    for (const s of stops) {
      const d = milesBetween(center, [s.lat, s.lon]);
      if (d < best) { best = d; centerStop = s; }
    }
    return {
      pid: String(p.pid), route, dir: String(p.rtdir ?? ''), points, lengthFt: num(p.ln), stops, centerStop,
    };
  });
}

/** One stop per route and direction, nearest the center across all of that
 *  direction's patterns (short turns and detours share most stops). */
export function centerStops(patterns: Pattern[], center: LatLon): Map<string, PatternStop> {
  const out = new Map<string, PatternStop>();
  for (const p of patterns) {
    if (!p.centerStop) continue;
    const key = busRowKey(p.route, p.dir);
    const prev = out.get(key);
    if (!prev || milesBetween(center, [p.centerStop.lat, p.centerStop.lon])
      < milesBetween(center, [prev.lat, prev.lon])) {
      out.set(key, p.centerStop);
    }
  }
  return out;
}

export function parseBusVehicles(json: unknown, patterns: Map<string, Pattern>): Vehicle[] {
  const body = busBody(json, 'vehicles');
  return toArray(body.vehicle as Record<string, unknown>[]).flatMap((v) => {
    const lat = num(v.lat);
    const lon = num(v.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const route = String(v.rt);
    const pattern = patterns.get(String(v.pid));
    const pdist = num(v.pdist);
    // Distance along the pattern is exact; position alone can't tell a bus
    // that's 100 ft short of the stop from one 100 ft past it.
    const approaching = pattern?.centerStop && Number.isFinite(pdist)
      ? pdist < pattern.centerStop.pdist
      : null;
    return [{
      kind: 'bus' as const,
      id: String(v.vid),
      route,
      rowKey: busRowKey(route, pattern?.dir ?? ''),
      lat,
      lon,
      heading: num(v.hdg) || 0,
      dest: String(v.des ?? ''),
      approaching,
      fixMs: chicagoToEpoch(parseCtaTime(v.tmstmp)),
      pid: String(v.pid),
      pdist,
    }];
  });
}

export function parseBusPredictions(json: unknown, fetchedAt: number): Arrival[] {
  const body = busBody(json, 'predictions');
  return toArray(body.prd as Record<string, unknown>[]).flatMap((p) => {
    if (BUS_SKIP_DYN.has(num(p.dyn))) return [];
    const leadMs = parseCtaTime(p.prdtm) - parseCtaTime(p.tmstmp);
    let minutes = leadMs / 60000;
    if (!Number.isFinite(minutes)) {
      const cd = String(p.prdctdn ?? '');
      minutes = /due/i.test(cd) ? 0 : num(cd);
    }
    if (!Number.isFinite(minutes)) return [];
    const route = String(p.rt);
    return [{
      kind: 'bus' as const,
      route,
      rowKey: busRowKey(route, String(p.rtdir ?? '')),
      dest: String(p.des ?? ''),
      vehicleId: String(p.vid ?? ''),
      stpid: String(p.stpid ?? ''),
      etaMs: fetchedAt + minutes * 60000,
      scheduled: false,
      delayed: flag(p.dly),
      // Under half a minute out, minute rounding swamps the time left.
      impliedFtPerS: leadMs >= 30_000 && num(p.dstp) > 0 ? num(p.dstp) / (leadMs / 1000) : undefined,
    }];
  });
}

// ── Train Tracker ───────────────────────────────────────────────────────────

export function trainUrl(endpoint: string, params: Record<string, string>): string {
  const q = new URLSearchParams({ ...params, outputType: 'JSON' });
  return `${TRAIN_BASE}/${endpoint}?${q.toString()}`;
}

function trainBody(json: unknown): Record<string, unknown> {
  const body = (json as Record<string, unknown> | null)?.ctatt as Record<string, unknown> | undefined;
  if (!body) throw new Error('Train Tracker: unexpected response');
  if (body.errCd && String(body.errCd) !== '0') {
    throw new Error(`Train Tracker: ${String(body.errNm ?? `error ${String(body.errCd)}`)}`);
  }
  return body;
}

export function parseTrainArrivals(json: unknown, fetchedAt: number): Arrival[] {
  const body = trainBody(json);
  return toArray(body.eta as Record<string, unknown>[]).flatMap((e) => {
    const minutes = (parseCtaTime(e.arrT) - parseCtaTime(e.prdt)) / 60000;
    if (!Number.isFinite(minutes)) return [];
    return [{
      kind: 'train' as const,
      route: String(e.rt ?? 'Blue'),
      rowKey: trainRowKey(String(e.trDr)),
      dest: String(e.destNm ?? ''),
      vehicleId: String(e.rn ?? ''),
      stpid: '',
      etaMs: fetchedAt + minutes * 60000,
      scheduled: flag(e.isSch),
      delayed: flag(e.isDly) || flag(e.isFlt),
    }];
  });
}

export function parseTrainPositions(json: unknown, fetchedAt: number): Vehicle[] {
  const body = trainBody(json);
  const tmst = parseCtaTime(body.tmst);
  return toArray(body.route as Record<string, unknown>[]).flatMap((r) =>
    toArray(r.train as Record<string, unknown>[]).flatMap((t) => {
      const lat = num(t.lat);
      const lon = num(t.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const rn = String(t.rn);
      // Times are Chicago wall clock; measure them against the response's
      // own timestamp so the zone (and any clock skew) cancels out.
      const prdt = parseCtaTime(t.prdt);
      const age = Number.isFinite(tmst) && Number.isFinite(prdt) ? Math.max(0, tmst - prdt) : 0;
      const fixMs = fetchedAt - age;
      const arrT = parseCtaTime(t.arrT);
      return [{
        kind: 'train' as const,
        id: rn,
        route: String(r['@name'] ?? 'blue'),
        rowKey: trainRowKey(String(t.trDr)),
        lat,
        lon,
        heading: num(t.heading) || 0,
        dest: String(t.destNm ?? ''),
        approaching: null,
        fixMs,
        nextStaId: t.nextStaId ? String(t.nextStaId) : undefined,
        nextArrMs: Number.isFinite(arrT) && Number.isFinite(prdt) ? fixMs + (arrT - prdt) : undefined,
      }];
    }),
  );
}

// ── Loading ─────────────────────────────────────────────────────────────────

export function parseRoutes(value: string): string[] {
  const seen = new Set<string>();
  for (const part of String(value ?? '').split(/[\s,]+/)) {
    const rt = part.trim().toUpperCase();
    if (rt) seen.add(rt);
  }
  // Bus Tracker accepts at most 10 routes per request.
  return [...seen].slice(0, 10);
}

/** Patterns change only with detours and schedule picks. */
export const PATTERN_TTL_MS = 60 * 60 * 1000;

export async function loadPatterns(
  fetchJson: FetchJson,
  routes: string[],
  center: LatLon,
): Promise<{ patterns: Pattern[]; errors: string[] }> {
  const results = await Promise.allSettled(routes.map(async (rt) =>
    parsePatterns(await fetchJson(busUrl('getpatterns', { rt }), 'bus_key', PATTERN_TTL_MS), rt, center)));
  const patterns: Pattern[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') patterns.push(...r.value);
    else errors.push(`Route ${routes[i]}: ${message(r.reason)}`);
  });
  return { patterns, errors };
}

export interface LiveRequest {
  routes: string[];
  station: string;
  patterns: Pattern[];
  center: LatLon;
  /** Proxy cache TTL, so two modules on one display share a request
   *  instead of doubling the rate. */
  cacheTtlMs: number;
}

export interface PositionData {
  vehicles: Vehicle[];
  fetchedAt: number;
  errors: string[];
}

export interface ArrivalData {
  arrivals: Arrival[];
  fetchedAt: number;
  errors: string[];
  /** Which feeds answered, so a failed one doesn't mark every vehicle passed. */
  trainsOk: boolean;
  busesOk: boolean;
}

function settled<T>(r: PromiseSettledResult<T>): T {
  if (r.status === 'rejected') throw r.reason;
  return r.value;
}

function guarded<T>(errors: string[], label: string, fn: () => T, fallback: T): T {
  try { return fn(); } catch (err) { errors.push(`${label}: ${message(err)}`); return fallback; }
}

/** Train and bus positions: the fast poll. */
export async function loadPositions(fetchJson: FetchJson, req: LiveRequest): Promise<PositionData> {
  const fetchedAt = Date.now();
  const errors: string[] = [];
  const byPid = new Map(req.patterns.map((p) => [p.pid, p]));
  const [trainPos, busVeh] = await Promise.allSettled([
    req.station
      ? fetchJson(trainUrl('ttpositions.aspx', { rt: 'blue' }), 'train_key', req.cacheTtlMs)
      : Promise.resolve(null),
    req.routes.length
      ? fetchJson(busUrl('getvehicles', { rt: req.routes.join(','), tmres: 's' }), 'bus_key', req.cacheTtlMs)
      : Promise.resolve(null),
  ]);
  const vehicles = [
    ...guarded(errors, 'Train positions', () => {
      const json = settled(trainPos);
      return json ? parseTrainPositions(json, fetchedAt) : [];
    }, [] as Vehicle[]),
    ...guarded(errors, 'Bus positions', () => {
      const json = settled(busVeh);
      return json ? parseBusVehicles(json, byPid) : [];
    }, [] as Vehicle[]),
  ];
  return { vehicles, fetchedAt, errors };
}

/** Predictions at the center: the slower poll. */
export async function loadArrivals(fetchJson: FetchJson, req: LiveRequest): Promise<ArrivalData> {
  const fetchedAt = Date.now();
  const errors: string[] = [];
  const stopByRow = centerStops(req.patterns, req.center);
  const stpids = [...new Set([...stopByRow.values()].map((s) => s.stpid))].slice(0, 10);
  const [trainEtas, busPrd] = await Promise.allSettled([
    req.station
      ? fetchJson(trainUrl('ttarrivals.aspx', { mapid: req.station }), 'train_key', req.cacheTtlMs)
      : Promise.resolve(null),
    stpids.length
      ? fetchJson(busUrl('getpredictions', { stpid: stpids.join(','), rt: req.routes.join(','), tmres: 's' }), 'bus_key', req.cacheTtlMs)
      : Promise.resolve(null),
  ]);
  const trains = guarded<Arrival[] | null>(errors, 'Train arrivals', () => {
    const json = settled(trainEtas);
    return json ? parseTrainArrivals(json, fetchedAt) : [];
  }, null);
  const buses = guarded<Arrival[] | null>(errors, 'Bus predictions', () => {
    const json = settled(busPrd);
    // A shared stop (two routes at one corner) returns every route's buses;
    // keep only the route and direction the stop was picked for.
    return json
      ? parseBusPredictions(json, fetchedAt).filter((a) => stopByRow.get(a.rowKey)?.stpid === a.stpid)
      : [];
  }, null);
  return {
    arrivals: [...(trains ?? []), ...(buses ?? [])],
    fetchedAt,
    errors,
    trainsOk: trains !== null,
    busesOk: buses !== null,
  };
}

/** Settle approaching/passed for vehicles the positions feed couldn't.
 *  Trains: every train still headed to the center station has a prediction
 *  there, and none that passed do. Buses on a pattern we haven't loaded (a
 *  new detour) fall back to the same test. Returns new objects. */
export function classify(vehicles: Vehicle[], arr: ArrivalData | null): Vehicle[] {
  if (!arr) return vehicles;
  const predicted = new Map<string, Arrival>();
  for (const a of arr.arrivals) predicted.set(`${a.kind}:${a.vehicleId}`, a);
  return vehicles.map((v) => {
    if (v.approaching !== null) return v;
    if (v.kind === 'train' ? !arr.trainsOk : !arr.busesOk) return v;
    const a = predicted.get(`${v.kind}:${v.id}`);
    return {
      ...v,
      approaching: !!a,
      rowKey: v.kind === 'bus' && a ? a.rowKey : v.rowKey,
    };
  });
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

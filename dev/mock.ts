// Fake CTA backend for the preview page. Responses use the real Train
// Tracker / Bus Tracker v3 JSON shapes (strings where CTA sends strings), and
// vehicles move with the clock so successive refreshes show motion.

type LL = [number, number];

const FT_PER_MILE = 5280;
function miles(a: LL, b: LL): number {
  const k = Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * 69.05, (a[1] - b[1]) * 69.05 * k);
}
function heading(a: LL, b: LL): number {
  const k = Math.cos((a[0] * Math.PI) / 180);
  const deg = (Math.atan2((b[1] - a[1]) * k, b[0] - a[0]) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}

interface Line { pts: LL[]; cum: number[] }
function line(pts: LL[]): Line {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + miles(pts[i - 1], pts[i]) * FT_PER_MILE);
  return { pts, cum };
}
function at(l: Line, ft: number): { p: LL; hdg: number } {
  const total = l.cum[l.cum.length - 1];
  const d = Math.max(0, Math.min(total, ft));
  let i = 1;
  while (i < l.cum.length - 1 && l.cum[i] < d) i++;
  const t = (d - l.cum[i - 1]) / (l.cum[i] - l.cum[i - 1] || 1);
  const a = l.pts[i - 1];
  const b = l.pts[i];
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], hdg: heading(a, b) };
}
function densify(pts: LL[], step = 0.002): LL[] {
  const out: LL[] = [];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.ceil(miles(pts[i - 1], pts[i]) / 69.05 / step));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const CENTER: LL = [41.903355, -87.666496];

interface MockPattern { pid: number; rt: string; dir: string; line: Line; stops: { id: string; name: string; ft: number; p: LL }[] }

function pattern(pid: number, rt: string, dir: string, pts: LL[], street: string): MockPattern {
  const l = line(densify(pts));
  const total = l.cum[l.cum.length - 1];
  const stops: MockPattern['stops'] = [];
  // A stop every eighth of a mile, plus one exactly at the center.
  for (let ft = 0; ft <= total; ft += 660) {
    const { p } = at(l, ft);
    if (miles(p, CENTER) < 0.06) continue;
    stops.push({ id: `${pid}${stops.length}`, name: `${street} & stop ${stops.length}`, ft, p });
  }
  let best = 0;
  l.cum.forEach((c, i) => { if (miles(l.pts[i], CENTER) < miles(l.pts[best], CENTER)) best = i; });
  stops.push({ id: `${pid}00`, name: `${street} & Division/Ashland`, ft: l.cum[best], p: l.pts[best] });
  stops.sort((a, b) => a.ft - b.ft);
  return { pid, rt, dir, line: l, stops };
}

const ASHLAND: LL[] = [[41.85, -87.6668], [41.96, -87.6668]];
const DIVISION: LL[] = [[41.9034, -87.78], [41.9034, -87.63]];
const MILWAUKEE: LL[] = [
  [41.8846, -87.642], [41.8912, -87.6476], [41.8961, -87.6552], [41.903355, -87.666496],
  [41.9097, -87.6774], [41.9162, -87.6874], [41.9219, -87.6969], [41.9297, -87.7085], [41.94, -87.724],
];

const PATTERNS: MockPattern[] = [
  pattern(5601, '56', 'Northbound', MILWAUKEE, 'Milwaukee'),
  pattern(5602, '56', 'Southbound', [...MILWAUKEE].reverse(), 'Milwaukee'),
  pattern(7001, '70', 'Eastbound', DIVISION, 'Division'),
  pattern(7002, '70', 'Westbound', [...DIVISION].reverse(), 'Division'),
  pattern(901, '9', 'Northbound', ASHLAND, 'Ashland'),
  pattern(902, '9', 'Southbound', [...ASHLAND].reverse(), 'Ashland'),
];

const BUS_FT_PER_MIN = 800; // ~9 mph with stops
const TRAIN_FT_PER_MIN = 2200; // ~25 mph

const chicago = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Chicago wall-clock stamp, as CTA sends them. */
function stamp(ms: number, seconds = true): string {
  const v: Record<string, string> = {};
  for (const part of chicago.formatToParts(new Date(ms))) v[part.type] = part.value;
  return `${v.year}${v.month}${v.day} ${v.hour}:${v.minute}${seconds ? `:${v.second}` : ''}`;
}

/** Like CTA, only publish a new position every so often: buses ~30 s,
 *  trains when they cross into a new track section (~45 s here). */
function fixTime(now: number, everyMs: number, phase: number): number {
  return Math.floor((now - phase) / everyMs) * everyMs + phase;
}
const BUS_FIX_MS = 30_000;
const TRAIN_FIX_MS = 45_000;
function isoStamp(ms: number): string {
  const s = stamp(ms);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9)}`;
}

/** Buses on a pattern: evenly spaced, looping, phase-shifted per pattern. */
function busesOn(pt: MockPattern, now: number) {
  const total = pt.line.cum[pt.line.cum.length - 1];
  const headway = 12 * BUS_FT_PER_MIN; // a bus every 12 minutes
  const shift = ((now / 60000) * BUS_FT_PER_MIN + pt.pid * 977) % headway;
  const out: { vid: string; ft: number }[] = [];
  for (let ft = shift, i = 0; ft < total; ft += headway, i++) out.push({ vid: `${pt.pid}${i}`, ft });
  return out;
}

const BLUE_PATH: LL[] = [
  [41.929728, -87.708541], [41.921939, -87.69689], [41.916157, -87.687364], [41.909744, -87.677437],
  [41.903355, -87.666496], [41.896075, -87.655214], [41.891189, -87.647578], [41.885737, -87.630886],
];
const BLUE_SB = line(densify(BLUE_PATH));
const BLUE_NB = line(densify([...BLUE_PATH].reverse()));
const BLUE_PATH_IDS = ['41020', '40570', '40670', '40590', '40320', '41410', '40490', '40380'];
function stationFeet(l: Line, ids: string[], pts: LL[]) {
  return ids.map((id, i) => ({
    id, ft: l.cum[l.pts.findIndex((p) => miles(p, pts[i]) < 0.001)],
  })).sort((a, b) => a.ft - b.ft);
}
const BLUE_STATION_FT_SB = stationFeet(BLUE_SB, BLUE_PATH_IDS, BLUE_PATH);
const BLUE_STATION_FT_NB = stationFeet(BLUE_NB, [...BLUE_PATH_IDS].reverse(), [...BLUE_PATH].reverse());
const DIVISION_FT_SB =BLUE_SB.cum[BLUE_SB.pts.findIndex((p) => miles(p, CENTER) < 0.01)];
const DIVISION_FT_NB = BLUE_NB.cum[BLUE_NB.pts.findIndex((p) => miles(p, CENTER) < 0.01)];

function trainsOn(dir: '1' | '5', now: number) {
  const l = dir === '5' ? BLUE_SB : BLUE_NB;
  const total = l.cum[l.cum.length - 1];
  const headway = 8 * TRAIN_FT_PER_MIN;
  const shift = ((now / 60000) * TRAIN_FT_PER_MIN + (dir === '1' ? 5000 : 0)) % headway;
  const out: { rn: string; ft: number }[] = [];
  for (let ft = shift, i = 0; ft < total; ft += headway, i++) out.push({ rn: `${dir === '1' ? 1 : 2}${String(i).padStart(2, '0')}`, ft });
  return out;
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function mockPluginFetch(_id: string, opts: { url: string }): Promise<Response> {
  await new Promise((r) => setTimeout(r, 120));
  const url = new URL(opts.url);
  const q = url.searchParams;
  const now = Date.now();
  const ep = url.pathname.split('/').pop();

  if (ep === 'getpatterns') {
    const rt = q.get('rt');
    return respond({ 'bustime-response': { ptr: PATTERNS.filter((p) => p.rt === rt).map((p) => ({
      pid: p.pid, ln: p.line.cum[p.line.cum.length - 1], rtdir: p.dir,
      pt: [
        ...p.line.pts.map((pt, i) => ({ seq: i, lat: pt[0], lon: pt[1], typ: 'W', pdist: p.line.cum[i] })),
        ...p.stops.map((s, i) => ({ seq: 10000 + i, lat: s.p[0], lon: s.p[1], typ: 'S', stpid: s.id, stpnm: s.name, pdist: s.ft })),
      ].sort((a, b) => a.pdist - b.pdist),
    })) } });
  }

  if (ep === 'getvehicles') {
    const rts = (q.get('rt') ?? '').split(',');
    const vehicle = PATTERNS.filter((p) => rts.includes(p.rt)).flatMap((p) => {
      const fix = fixTime(now, BUS_FIX_MS, (p.pid * 3137) % BUS_FIX_MS);
      return busesOn(p, fix).map((b) => {
        const { p: pos, hdg } = at(p.line, b.ft);
        return { vid: b.vid, tmstmp: stamp(fix), lat: String(pos[0]), lon: String(pos[1]), hdg: String(hdg),
          pid: p.pid, rt: p.rt, des: p.dir === 'Northbound' ? 'Irving Park' : 'Downtown', pdist: Math.round(b.ft), dly: false };
      });
    });
    return respond({ 'bustime-response': { vehicle } });
  }

  if (ep === 'getpredictions') {
    const stpids = new Set((q.get('stpid') ?? '').split(','));
    const prd = PATTERNS.flatMap((p) => p.stops.filter((s) => stpids.has(s.id)).flatMap((s) =>
      busesOn(p, now).filter((b) => b.ft < s.ft && s.ft - b.ft < 30 * BUS_FT_PER_MIN).map((b) => {
        const mins = (s.ft - b.ft) / BUS_FT_PER_MIN;
        return { tmstmp: stamp(now), typ: 'A', stpnm: s.name, stpid: s.id, vid: b.vid, dstp: Math.round(s.ft - b.ft),
          rt: p.rt, rtdd: p.rt, rtdir: p.dir, des: 'Somewhere', prdtm: stamp(now + mins * 60000),
          dly: b.vid.endsWith('2'), dyn: 0, prdctdn: mins < 1 ? 'DUE' : String(Math.round(mins)) };
      })));
    prd.sort((a, b) => a.prdtm.localeCompare(b.prdtm));
    return respond({ 'bustime-response': prd.length ? { prd } : { error: [{ msg: 'No arrival times' }] } });
  }

  if (ep === 'ttpositions.aspx') {
    const fix = fixTime(now, TRAIN_FIX_MS, 7_000);
    const train = (['1', '5'] as const).flatMap((dir) => trainsOn(dir, fix).map((t) => {
      const l = dir === '5' ? BLUE_SB : BLUE_NB;
      const stations = dir === '5' ? BLUE_STATION_FT_SB : BLUE_STATION_FT_NB;
      const { p, hdg } = at(l, t.ft);
      const next = stations.find((s) => s.ft > t.ft + 1) ?? stations[stations.length - 1];
      return { rn: t.rn, destSt: '0', destNm: dir === '1' ? "O'Hare" : 'Forest Park', trDr: dir,
        nextStaId: next.id, nextStpId: '0', nextStaNm: next.id, prdt: isoStamp(fix),
        arrT: isoStamp(fix + (Math.max(0, next.ft - t.ft) / TRAIN_FT_PER_MIN) * 60000),
        isApp: '0', isDly: '0', flags: null, lat: String(p[0]), lon: String(p[1]), heading: String(hdg) };
    }));
    return respond({ ctatt: { tmst: isoStamp(now), errCd: '0', errNm: null, route: [{ '@name': 'blue', train }] } });
  }

  if (ep === 'ttarrivals.aspx') {
    const eta = (['1', '5'] as const).flatMap((dir) => {
      const div = dir === '5' ? DIVISION_FT_SB : DIVISION_FT_NB;
      const live = trainsOn(dir, now).filter((t) => t.ft < div).map((t) => ({ rn: t.rn, mins: (div - t.ft) / TRAIN_FT_PER_MIN, sch: '0' }));
      // Beyond the mock line: one scheduled-only train, the kind that may never show.
      const last = live.length ? Math.max(...live.map((l) => l.mins)) : 0;
      live.push({ rn: `${dir}99`, mins: last + 8, sch: '1' }, { rn: `${dir}98`, mins: last + 16, sch: '1' });
      return live.map((t) => ({
        staId: '40320', stpId: dir === '1' ? '30063' : '30064', staNm: 'Division', stpDe: `Service toward ${dir === '1' ? "O'Hare" : 'Forest Park'}`,
        rn: t.rn, rt: 'Blue', destSt: '0', destNm: dir === '1' ? "O'Hare" : 'Forest Park', trDr: dir,
        prdt: isoStamp(now), arrT: isoStamp(now + t.mins * 60000), isApp: t.mins < 1 ? '1' : '0',
        isSch: t.sch, isDly: '0', isFlt: '0', flags: null, lat: null, lon: null, heading: null,
      }));
    });
    eta.sort((a, b) => a.arrT.localeCompare(b.arrT));
    return respond({ ctatt: { tmst: isoStamp(now), errCd: '0', errNm: null, eta } });
  }

  return respond({ error: `mock: unknown endpoint ${ep}` }, 404);
}

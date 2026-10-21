// Where to draw a vehicle *now*, between position fixes.
//
// CTA publishes a new bus position about every 30 s and a new train position
// whenever the train enters a new track section, so drawing only the last
// fix makes icons jump and then sit still. Instead each vehicle moves along
// its real path from the moment it was measured:
//
//   Trains glide from the fix to their next station, arriving at the time
//   Train Tracker predicts for that station, then wait there.
//
//   Buses move along their pattern at the speed Bus Tracker's own prediction
//   implies (distance left / time left, which already averages in stops and
//   lights), or failing that the speed measured between their last two fixes.
//
// Accuracy comes first: the drawn position always starts from the reported
// one, is moved by CTA's own numbers, and stops coasting after a short cap
// rather than drifting on with no fresh data behind it.

import { BLUE_STATIONS, BLUE_TRACK } from './blue-line';
import type { LatLon } from './blue-line';
import type { Pattern, Vehicle } from './cta';

const MILES_PER_DEG = 69.05;
const FT_PER_MILE = 5280;

/** Stop coasting a bus this long after its fix: two missed updates. */
export const MAX_BUS_COAST_MS = 90_000;
/** Trains are timed to a station, so they can coast until they reach it. */
export const MAX_TRAIN_COAST_MS = 180_000;
/** Fastest believable speed along a pattern, ft/s (~50 mph). */
const MAX_FT_PER_S = 75;

/** A polyline measured in feet, to move a point a given distance along it. */
export class Track {
  readonly pts: LatLon[];
  readonly cum: number[];
  private readonly kx: number;

  constructor(pts: LatLon[]) {
    this.pts = pts;
    this.kx = Math.cos(((pts[0]?.[0] ?? 41.9) * Math.PI) / 180);
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + this.feet(pts[i - 1], pts[i]));
    }
  }

  get length(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  private feet(a: LatLon, b: LatLon): number {
    return Math.hypot((a[0] - b[0]) * MILES_PER_DEG, (a[1] - b[1]) * MILES_PER_DEG * this.kx) * FT_PER_MILE;
  }

  /** The point `ft` feet along the line, clamped to its ends. */
  at(ft: number): LatLon {
    const n = this.pts.length;
    if (n === 0) return [NaN, NaN];
    if (ft <= 0 || n === 1) return this.pts[0];
    if (ft >= this.length) return this.pts[n - 1];
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < ft) lo = mid + 1; else hi = mid;
    }
    const a = this.pts[lo - 1];
    const b = this.pts[lo];
    const t = (ft - this.cum[lo - 1]) / (this.cum[lo] - this.cum[lo - 1] || 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** The part of the line between two distances along it. */
  slice(fromFt: number, toFt: number): LatLon[] {
    const a = Math.max(0, Math.min(fromFt, toFt));
    const b = Math.min(this.length, Math.max(fromFt, toFt));
    const out: LatLon[] = [this.at(a)];
    for (let i = 0; i < this.pts.length; i++) {
      if (this.cum[i] > a && this.cum[i] < b) out.push(this.pts[i]);
    }
    out.push(this.at(b));
    return out;
  }

  /** The nearest point on the line: how far along it, and how far off it (ft). */
  project(p: LatLon): { ft: number; offFt: number } {
    let best = { ft: 0, offFt: Infinity };
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1];
      const b = this.pts[i];
      // Local flat coordinates in feet, relative to a.
      const bx = (b[1] - a[1]) * MILES_PER_DEG * this.kx * FT_PER_MILE;
      const by = (b[0] - a[0]) * MILES_PER_DEG * FT_PER_MILE;
      const px = (p[1] - a[1]) * MILES_PER_DEG * this.kx * FT_PER_MILE;
      const py = (p[0] - a[0]) * MILES_PER_DEG * FT_PER_MILE;
      const len2 = bx * bx + by * by;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / len2)) : 0;
      const off = Math.hypot(px - t * bx, py - t * by);
      if (off < best.offFt) best = { ft: this.cum[i - 1] + t * Math.sqrt(len2), offFt: off };
    }
    return best;
  }
}

/** The data portal splits the Blue Line into pieces between stations; join
 *  pieces whose ends meet so a train can be walked through a station. */
export function stitch(segments: LatLon[][], joinFt = 150): LatLon[][] {
  const chains = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const close = (a: LatLon, b: LatLon) => new Track([a, b]).length <= joinFt;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i];
        const b = chains[j];
        let joined: LatLon[] | null = null;
        if (close(a[a.length - 1], b[0])) joined = [...a, ...b.slice(1)];
        else if (close(a[a.length - 1], b[b.length - 1])) joined = [...a, ...[...b].reverse().slice(1)];
        else if (close(a[0], b[b.length - 1])) joined = [...b, ...a.slice(1)];
        else if (close(a[0], b[0])) joined = [...[...a].reverse(), ...b.slice(1)];
        if (joined) {
          chains[i] = joined;
          chains.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return chains;
}

let blueTracks: Track[] | null = null;
function blue(): Track[] {
  if (!blueTracks) blueTracks = stitch(BLUE_TRACK).map((c) => new Track(c));
  return blueTracks;
}

const stationById = new Map(BLUE_STATIONS.map((s) => [s.id, [s.lat, s.lon] as LatLon]));

const patternTracks = new WeakMap<Pattern, Track>();
export function patternTrack(p: Pattern): Track {
  let t = patternTracks.get(p);
  if (!t) { t = new Track(p.points); patternTracks.set(p, t); }
  return t;
}

/** `fix` moved by the same amount as `from` -> `to` along the path. The path
 *  only supplies the motion; the starting point stays the reported one. */
function shifted(fix: LatLon, from: LatLon, to: LatLon): LatLon {
  return [fix[0] + to[0] - from[0], fix[1] + to[1] - from[1]];
}

export function positionNow(
  v: Vehicle,
  now: number,
  patternsByPid: Map<string, Pattern>,
  impliedFtPerS?: number,
): LatLon {
  const fix: LatLon = [v.lat, v.lon];
  if (!Number.isFinite(v.fixMs)) return fix;
  const sinceFix = Math.max(0, now - v.fixMs);
  return v.kind === 'bus'
    ? busNow(v, fix, Math.min(sinceFix, MAX_BUS_COAST_MS), patternsByPid, impliedFtPerS)
    : trainNow(v, fix, Math.min(sinceFix, MAX_TRAIN_COAST_MS));
}

/** pdist is in the pattern's own feet; this scales it to our measure of the
 *  pattern's geometry. */
export function pdistScale(p: Pattern): number {
  const track = patternTrack(p);
  return p.lengthFt > 0 ? track.length / p.lengthFt : 1;
}

/** A bus's distance along its pattern now (pattern feet): the reported
 *  pdist advanced the same way `positionNow` moves the marker, so counts
 *  like "stops to go" agree with what's drawn. */
export function busPdistNow(
  v: Vehicle, now: number, patternsByPid: Map<string, Pattern>, impliedFtPerS?: number,
): number | null {
  const p = v.pid ? patternsByPid.get(v.pid) : undefined;
  if (!p || !Number.isFinite(v.pdist)) return null;
  const dtMs = Number.isFinite(v.fixMs) ? Math.min(Math.max(0, now - v.fixMs), MAX_BUS_COAST_MS) : 0;
  const speed = Math.min(MAX_FT_PER_S, impliedFtPerS ?? v.observedFtPerS ?? 0);
  const length = p.lengthFt > 0 ? p.lengthFt : patternTrack(p).length;
  return Math.min(length, v.pdist! + (speed > 0 ? speed * (dtMs / 1000) : 0));
}

function busNow(
  v: Vehicle, fix: LatLon, dtMs: number, patternsByPid: Map<string, Pattern>, impliedFtPerS?: number,
): LatLon {
  const p = v.pid ? patternsByPid.get(v.pid) : undefined;
  if (!p || !Number.isFinite(v.pdist) || p.points.length < 2 || dtMs <= 0) return fix;
  const pdist = busPdistNow(v, v.fixMs + dtMs, patternsByPid, impliedFtPerS);
  if (pdist === null || pdist === v.pdist) return fix;
  const track = patternTrack(p);
  const k = pdistScale(p);
  return shifted(fix, track.at(v.pdist! * k), track.at(pdist * k));
}

/** Stops still ahead of a bus before it reaches the center stop, counting
 *  the center stop itself: 1 means Division is the next stop. Null once it's
 *  past, or when the pattern has no center stop. */
export function stopsToCenter(p: Pattern, pdist: number): number | null {
  const c = p.centerStop;
  if (!c || !(pdist <= c.pdist)) return null;
  return p.stops.filter((s) => s.pdist > pdist && s.pdist <= c.pdist).length || 1;
}

/** The stretch of a pattern covering its last `n` stops before the center
 *  stop, with those stops, for drawing the approach zone. */
export function approachZone(p: Pattern, n: number): { path: LatLon[]; stops: LatLon[] } | null {
  const c = p.centerStop;
  if (!c || p.points.length < 2 || n < 1) return null;
  const before = p.stops.filter((s) => s.pdist < c.pdist).sort((a, b) => b.pdist - a.pdist);
  if (!before.length) return null;
  // Start a little before the nth stop, so a bus waiting there is inside.
  const first = before[Math.min(n, before.length) - 1];
  const k = pdistScale(p);
  const startFt = Math.max(0, first.pdist - 150) * k;
  return {
    path: patternTrack(p).slice(startFt, c.pdist * k),
    stops: before.slice(0, n).map((s) => [s.lat, s.lon] as LatLon),
  };
}

/** The fix and the station must both sit on the track for along-track
 *  motion; otherwise (an off-map station, bad data) move in a straight line. */
const ON_TRACK_FT = 600;

function trainNow(v: Vehicle, fix: LatLon, dtMs: number): LatLon {
  const sta = v.nextStaId ? stationById.get(v.nextStaId) : undefined;
  if (!sta || !v.nextArrMs || v.nextArrMs <= v.fixMs) return fix;
  const frac = Math.min(1, dtMs / (v.nextArrMs - v.fixMs));
  if (frac <= 0) return fix;

  let best: { t: Track; s0: number; s1: number } | null = null;
  let bestOff = Infinity;
  for (const t of blue()) {
    const a = t.project(fix);
    const b = t.project(sta);
    const off = a.offFt + b.offFt;
    if (off < bestOff && a.offFt < ON_TRACK_FT && b.offFt < ON_TRACK_FT) {
      bestOff = off;
      best = { t, s0: a.ft, s1: b.ft };
    }
  }
  if (!best) {
    return [fix[0] + (sta[0] - fix[0]) * frac, fix[1] + (sta[1] - fix[1]) * frac];
  }
  const s = best.s0 + (best.s1 - best.s0) * frac;
  return shifted(fix, best.t.at(best.s0), best.t.at(s));
}

interface Seen { fixMs: number; pid: string; pdist: number; speed?: number }

/** Fill in each bus's `observedFtPerS` from its previous fix. `history`
 *  carries fixes between polls; polls that bring no new fix keep the last
 *  measured speed. Returns new objects. */
export function withObservedSpeed(vehicles: Vehicle[], history: Map<string, Seen>): Vehicle[] {
  const live = new Set<string>();
  const out = vehicles.map((v) => {
    if (v.kind !== 'bus' || !v.pid || !Number.isFinite(v.pdist) || !Number.isFinite(v.fixMs)) return v;
    live.add(v.id);
    const prev = history.get(v.id);
    let speed = prev?.pid === v.pid ? prev.speed : undefined;
    if (prev && prev.pid === v.pid && v.fixMs - prev.fixMs >= 5_000) {
      const fts = (v.pdist! - prev.pdist) / ((v.fixMs - prev.fixMs) / 1000);
      speed = Math.min(MAX_FT_PER_S, Math.max(0, fts));
    }
    if (!prev || v.fixMs !== prev.fixMs || v.pid !== prev.pid) {
      history.set(v.id, { fixMs: v.fixMs, pid: v.pid, pdist: v.pdist!, speed });
    }
    return speed === undefined ? v : { ...v, observedFtPerS: speed };
  });
  for (const id of history.keys()) if (!live.has(id)) history.delete(id);
  return out;
}

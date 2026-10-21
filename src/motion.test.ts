import { describe, expect, it } from 'vitest';
import { BLUE_STATIONS, BLUE_TRACK } from './blue-line';
import type { LatLon } from './blue-line';
import { milesBetween } from './cta';
import type { Pattern, Vehicle } from './cta';
import { MAX_BUS_COAST_MS, positionNow, stitch, Track, withObservedSpeed } from './motion';

const FT = 1 / 5280;

// A straight north-south pattern on Ashland, ~1 mile long.
const ashland: Pattern = {
  pid: '901', route: '9', dir: 'Northbound',
  points: [[41.8890, -87.6668], [41.9035, -87.6668]],
  lengthFt: 0, stops: [], centerStop: null,
};
ashland.lengthFt = new Track(ashland.points).length;
const byPid = new Map([[ashland.pid, ashland]]);

function bus(over: Partial<Vehicle> = {}): Vehicle {
  return {
    kind: 'bus', id: '1', route: '9', rowKey: 'bus:9:Northbound', lat: 41.8890, lon: -87.6668, heading: 0,
    dest: '', approaching: true, fixMs: 0, pid: '901', pdist: 0, ...over,
  };
}

describe('Track', () => {
  it('walks and projects along a line', () => {
    const t = new Track(ashland.points);
    const mid = t.at(t.length / 2);
    expect(mid[0]).toBeCloseTo((41.8890 + 41.9035) / 2, 5);
    expect(t.project(mid).ft).toBeCloseTo(t.length / 2, 0);
    expect(t.project([41.896, -87.6658]).offFt).toBeGreaterThan(200);
  });

  it('stitches the Blue Line into one continuous track', () => {
    const chains = stitch(BLUE_TRACK);
    const longest = Math.max(...chains.map((c) => new Track(c).length));
    const total = BLUE_TRACK.reduce((s, seg) => s + new Track(seg).length, 0);
    // Essentially all of the track ends up in one chain.
    expect(longest / total).toBeGreaterThan(0.95);
  });
});

describe('positionNow: buses', () => {
  it('moves along the pattern at the prediction-implied speed', () => {
    const at = positionNow(bus(), 30_000, byPid, 20); // 20 ft/s for 30 s = 600 ft
    expect(milesBetween([41.8890, -87.6668], at) / FT).toBeCloseTo(600, -1);
    expect(at[1]).toBeCloseTo(-87.6668, 6); // stays on the street
  });

  it('falls back to observed speed, and holds still with neither', () => {
    expect(positionNow(bus({ observedFtPerS: 10 }), 10_000, byPid)[0]).toBeGreaterThan(41.8890);
    expect(positionNow(bus(), 10_000, byPid)).toEqual([41.8890, -87.6668]);
  });

  it('stops coasting after the cap', () => {
    const capped = positionNow(bus(), MAX_BUS_COAST_MS, byPid, 10);
    expect(positionNow(bus(), MAX_BUS_COAST_MS * 3, byPid, 10)).toEqual(capped);
  });

  it('starts from the reported position even if it is off the drawn line', () => {
    const at = positionNow(bus({ lon: -87.6670 }), 0, byPid, 20);
    expect(at).toEqual([41.8890, -87.6670]);
  });
});

describe('positionNow: trains', () => {
  const chicago = BLUE_STATIONS.find((s) => s.name === 'Chicago')!;
  const division = BLUE_STATIONS.find((s) => s.name === 'Division')!;
  const train: Vehicle = {
    kind: 'train', id: '200', route: 'blue', rowKey: 'train:5', lat: division.lat, lon: division.lon,
    heading: 135, dest: 'Forest Park', approaching: false, fixMs: 0, nextStaId: chicago.id, nextArrMs: 100_000,
  };
  const sta: LatLon = [chicago.lat, chicago.lon];
  const from: LatLon = [division.lat, division.lon];

  it('arrives at the next station when Train Tracker says it will, then waits', () => {
    const half = positionNow(train, 50_000, new Map());
    const d = milesBetween(from, sta);
    expect(milesBetween(from, half)).toBeGreaterThan(d * 0.35);
    expect(milesBetween(from, half)).toBeLessThan(d * 0.65);
    expect(milesBetween(positionNow(train, 100_000, new Map()), sta)).toBeLessThan(0.02);
    expect(positionNow(train, 150_000, new Map())).toEqual(positionNow(train, 100_000, new Map()));
  });
});

describe('withObservedSpeed', () => {
  it('measures speed between distinct fixes and keeps it between them', () => {
    const history = new Map();
    withObservedSpeed([bus({ fixMs: 0, pdist: 1000 })], history);
    const [a] = withObservedSpeed([bus({ fixMs: 30_000, pdist: 1600 })], history);
    expect(a.observedFtPerS).toBeCloseTo(20);
    // Same fix again (no new data from CTA): same speed.
    const [b] = withObservedSpeed([bus({ fixMs: 30_000, pdist: 1600 })], history);
    expect(b.observedFtPerS).toBeCloseTo(20);
  });
});

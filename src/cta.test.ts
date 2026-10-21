import { describe, expect, it } from 'vitest';
import {
  busRowKey, centerStops, chicagoToEpoch, classify, loadArrivals, parseBusPredictions, parseBusVehicles,
  parseCtaTime, parsePatterns, parseRoutes, parseTrainArrivals, parseTrainPositions,
} from './cta';
import type { FetchJson } from './cta';
import type { LatLon } from './blue-line';

const CENTER: LatLon = [41.903355, -87.666496];

const patternJson = {
  'bustime-response': {
    ptr: [{
      pid: 901, ln: 50000, rtdir: 'Northbound',
      pt: [
        { seq: 1, lat: 41.89, lon: -87.6668, typ: 'S', stpid: '100', stpnm: 'Ashland & Chicago', pdist: 1000 },
        { seq: 2, lat: 41.8975, lon: -87.6668, typ: 'W', pdist: 3700 },
        { seq: 3, lat: 41.9034, lon: -87.6668, typ: 'S', stpid: '101', stpnm: 'Ashland & Division', pdist: 6000 },
        { seq: 4, lat: 41.9105, lon: -87.6668, typ: 'S', stpid: '102', stpnm: 'Ashland & North', pdist: 8600 },
      ],
    }],
  },
};

describe('parseCtaTime', () => {
  it('reads every CTA timestamp form and only differences matter', () => {
    const a = parseCtaTime('2026-10-21T14:32:10');
    expect(parseCtaTime('20261021 14:32:10')).toBe(a);
    expect(parseCtaTime('20261021 14:32')).toBe(a - 10_000);
    expect(parseCtaTime('garbage')).toBeNaN();
  });

  it('converts Chicago wall time to a real instant across DST', () => {
    // 14:32 CDT (UTC-5) and 14:32 CST (UTC-6)
    expect(chicagoToEpoch(parseCtaTime('20261021 14:32:00'))).toBe(Date.UTC(2026, 9, 21, 19, 32));
    expect(chicagoToEpoch(parseCtaTime('20261221 14:32:00'))).toBe(Date.UTC(2026, 11, 21, 20, 32));
  });
});

describe('parseRoutes', () => {
  it('dedupes, uppercases and caps at 10', () => {
    expect(parseRoutes(' 9, 56 ,x9,9')).toEqual(['9', '56', 'X9']);
    expect(parseRoutes('1,2,3,4,5,6,7,8,9,10,11')).toHaveLength(10);
  });
});

describe('bus patterns and vehicles', () => {
  const patterns = parsePatterns(patternJson, '9', CENTER);

  it('picks the stop nearest the center', () => {
    expect(patterns[0].centerStop?.stpid).toBe('101');
    expect(centerStops(patterns, CENTER).get(busRowKey('9', 'Northbound'))?.stpid).toBe('101');
  });

  it('uses distance along the pattern to tell approaching from passed', () => {
    const byPid = new Map(patterns.map((p) => [p.pid, p]));
    const json = { 'bustime-response': { vehicle: [
      { vid: '1', lat: '41.8975', lon: '-87.6668', hdg: '0', pid: 901, rt: '9', des: 'Irving', pdist: 3700 },
      { vid: '2', lat: '41.9105', lon: '-87.6668', hdg: '0', pid: 901, rt: '9', des: 'Irving', pdist: 8600 },
      { vid: '3', lat: '41.9', lon: '-87.6668', hdg: '0', pid: 999, rt: '9', des: 'Detour', pdist: 10 },
    ] } };
    const v = parseBusVehicles(json, byPid);
    expect(v.map((x) => x.approaching)).toEqual([true, false, null]);
    expect(v[0].rowKey).toBe('bus:9:Northbound');
  });

  it('treats "no data" as empty rather than an error', () => {
    const json = { 'bustime-response': { error: [{ msg: 'No data found for parameter' }] } };
    expect(parseBusVehicles(json, new Map())).toEqual([]);
    expect(() => parseBusVehicles({ 'bustime-response': { error: [{ msg: 'Invalid API access key supplied' }] } }, new Map()))
      .toThrow(/Invalid API access key/);
  });
});

describe('parseBusPredictions', () => {
  it('computes minutes from timestamps and drops canceled trips', () => {
    const json = { 'bustime-response': { prd: [
      { tmstmp: '20261021 14:00:00', prdtm: '20261021 14:04:30', stpid: '101', vid: '1', rt: '9', rtdir: 'Northbound', dly: false, dyn: 0, prdctdn: '4' },
      { tmstmp: '20261021 14:00:00', prdtm: '20261021 14:09:00', stpid: '101', vid: '2', rt: '9', rtdir: 'Northbound', dly: true, dyn: 1, prdctdn: '9' },
    ] } };
    const a = parseBusPredictions(json, 0);
    expect(a).toHaveLength(1);
    expect(a[0].etaMs).toBe(4.5 * 60000);
    expect(a[0].rowKey).toBe('bus:9:Northbound');
  });
});

describe('Train Tracker', () => {
  it('reads arrivals with the scheduled flag', () => {
    const json = { ctatt: { errCd: '0', eta: [
      { rn: '123', rt: 'Blue', trDr: '1', destNm: "O'Hare", prdt: '2026-10-21T14:00:00', arrT: '2026-10-21T14:03:00', isSch: '0', isDly: '0', isFlt: '0' },
      { rn: '124', rt: 'Blue', trDr: '5', destNm: 'Forest Park', prdt: '2026-10-21T14:00:00', arrT: '2026-10-21T14:12:00', isSch: '1', isDly: '0', isFlt: '0' },
    ] } };
    const a = parseTrainArrivals(json, 0);
    expect(a.map((x) => [x.rowKey, x.etaMs / 60000, x.scheduled])).toEqual([
      ['train:1', 3, false], ['train:5', 12, true],
    ]);
  });

  it('accepts a lone train as an object and times it from the response clock', () => {
    const json = { ctatt: { errCd: '0', tmst: '2026-10-21T14:00:20', route: [{ '@name': 'blue', train: {
      rn: '200', trDr: '5', destNm: 'Forest Park', lat: '41.9', lon: '-87.66', heading: '135',
      nextStaId: '41410', prdt: '2026-10-21T14:00:00', arrT: '2026-10-21T14:01:30',
    } }] } };
    const v = parseTrainPositions(json, 1_000_000);
    expect(v).toHaveLength(1);
    expect(v[0].heading).toBe(135);
    expect(v[0].fixMs).toBe(1_000_000 - 20_000);
    expect(v[0].nextArrMs).toBe(1_000_000 - 20_000 + 90_000);
    // Not due at the center station: already passed.
    const arr = { arrivals: [], fetchedAt: 0, errors: [], trainsOk: true, busesOk: true };
    expect(classify(v, arr)[0].approaching).toBe(false);
    // Unknown when the arrivals feed failed, rather than wrongly "passed".
    expect(classify(v, { ...arr, trainsOk: false })[0].approaching).toBeNull();
  });

  it('surfaces API errors', () => {
    expect(() => parseTrainArrivals({ ctatt: { errCd: '101', errNm: 'Invalid API key.' } }, 0))
      .toThrow(/Invalid API key/);
  });
});

describe('loadArrivals', () => {
  it('keeps bus data when trains fail, and only keeps predictions for the chosen stop', async () => {
    const patterns = parsePatterns(patternJson, '9', CENTER);
    const fetchJson: FetchJson = async (url) => {
      if (url.includes('lapi.transitchicago.com')) throw new Error('Train Tracker key not set');
      if (url.includes('getpredictions')) {
        expect(url).toContain('stpid=101');
        return { 'bustime-response': { prd: [
          { tmstmp: '20261021 14:00:00', prdtm: '20261021 14:05:00', stpid: '101', vid: '1', rt: '9', rtdir: 'Northbound', dyn: 0 },
          // Same corner, another route's direction: not ours.
          { tmstmp: '20261021 14:00:00', prdtm: '20261021 14:02:00', stpid: '101', vid: '7', rt: '9', rtdir: 'Southbound', dyn: 0 },
        ] } };
      }
      throw new Error(`unexpected ${url}`);
    };
    const live = await loadArrivals(fetchJson, { routes: ['9'], station: '40320', patterns, center: CENTER, cacheTtlMs: 0 });
    expect(live.arrivals.map((a) => a.vehicleId)).toEqual(['1']);
    expect(live.errors.join(' ')).toMatch(/Train arrivals: Train Tracker key not set/);
    expect([live.trainsOk, live.busesOk]).toEqual([false, true]);
  });
});

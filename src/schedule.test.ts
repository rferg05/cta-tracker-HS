import { describe, expect, it } from 'vitest';
import { chicagoNow, inWindow, parseClock } from './schedule';

describe('parseClock', () => {
  it('reads 24-hour and 12-hour times', () => {
    expect(parseClock('6:00')).toBe(360);
    expect(parseClock('06:30')).toBe(390);
    expect(parseClock('18:15')).toBe(1095);
    expect(parseClock('6:00 AM')).toBe(360);
    expect(parseClock('12:00 am')).toBe(0);
    expect(parseClock('12:30 PM')).toBe(750);
    expect(parseClock('6pm')).toBe(1080);
  });

  it('rejects nonsense', () => {
    for (const bad of ['', 'noon', '25:00', '6:75', '13:00 pm', undefined]) expect(parseClock(bad)).toBeNull();
  });
});

describe('inWindow', () => {
  const at = (day: number, h: number, m = 0) => ({ day, minutes: h * 60 + m });
  const six = 360;
  const ten = 600;

  it('covers weekday mornings only', () => {
    expect(inWindow(at(3, 8), six, ten, 'weekdays')).toBe(true); // Wednesday 8:00
    expect(inWindow(at(3, 10), six, ten, 'weekdays')).toBe(false); // ends at 10:00
    expect(inWindow(at(3, 5, 59), six, ten, 'weekdays')).toBe(false);
    expect(inWindow(at(6, 8), six, ten, 'weekdays')).toBe(false); // Saturday
    expect(inWindow(at(6, 8), six, ten, 'weekends')).toBe(true);
    expect(inWindow(at(0, 8), six, ten, 'everyday')).toBe(true);
  });

  it('runs past midnight from the day it started', () => {
    const ten_pm = 22 * 60;
    const five = 5 * 60;
    expect(inWindow(at(5, 23), ten_pm, five, 'weekdays')).toBe(true); // Friday 23:00
    expect(inWindow(at(6, 1), ten_pm, five, 'weekdays')).toBe(true); // Saturday 1:00, started Friday
    expect(inWindow(at(1, 1), ten_pm, five, 'weekdays')).toBe(false); // Monday 1:00, started Sunday
    expect(inWindow(at(3, 12), ten_pm, five, 'everyday')).toBe(false);
  });

  it('is off without a usable window', () => {
    expect(inWindow(at(3, 8), null, ten, 'everyday')).toBe(false);
    expect(inWindow(at(3, 8), six, six, 'everyday')).toBe(false);
  });
});

describe('chicagoNow', () => {
  it('uses Chicago time whatever the machine zone', () => {
    // 2026-10-22 13:30 UTC is a Thursday, 8:30 in Chicago (CDT).
    expect(chicagoNow(Date.UTC(2026, 9, 22, 13, 30))).toEqual({ day: 4, minutes: 8 * 60 + 30 });
  });
});

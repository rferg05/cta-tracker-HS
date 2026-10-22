// "Hide these routes during these hours": e.g. the 70 during the morning
// commute, when it doesn't go anywhere useful. Evaluated on Chicago's clock,
// since that's the timetable being read, whatever zone the Pi is set to.

export type Days = 'weekdays' | 'weekends' | 'everyday';

/** Minutes after midnight for "6:00", "06:00", "6:00 AM", "18:30", "6pm".
 *  Null when it can't be read, which leaves the schedule off. */
export function parseClock(value: unknown): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  } else if (h > 24) {
    return null;
  }
  return (h % 24) * 60 + min;
}

let chicagoClock: Intl.DateTimeFormat | null | undefined;

/** Day of week (0 = Sunday) and minutes after midnight in Chicago. */
export function chicagoNow(epochMs: number): { day: number; minutes: number } {
  if (chicagoClock === undefined) {
    try {
      chicagoClock = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
      });
    } catch {
      chicagoClock = null;
    }
  }
  if (!chicagoClock) {
    const d = new Date(epochMs);
    return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
  }
  const v: Record<string, string> = {};
  for (const p of chicagoClock.formatToParts(new Date(epochMs))) v[p.type] = p.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(v.weekday);
  return { day: day < 0 ? 0 : day, minutes: (Number(v.hour) % 24) * 60 + Number(v.minute) };
}

function dayMatches(days: Days, day: number): boolean {
  if (days === 'everyday') return true;
  const weekend = day === 0 || day === 6;
  return days === 'weekends' ? weekend : !weekend;
}

/** Whether `now` falls in the window. A window that ends before it starts
 *  runs past midnight (22:00 to 5:00), and then the day that counts is the
 *  one it started on: Friday 22:00 to 5:00 still covers Saturday 1:00. */
export function inWindow(
  now: { day: number; minutes: number }, start: number | null, end: number | null, days: Days,
): boolean {
  if (start === null || end === null || start === end) return false;
  if (start < end) return now.minutes >= start && now.minutes < end && dayMatches(days, now.day);
  if (now.minutes >= start) return dayMatches(days, now.day);
  if (now.minutes < end) return dayMatches(days, (now.day + 6) % 7);
  return false;
}

// A stand-in for the host's displayCache with the host's real contract:
// `get` returns `{ data, stale, fetchedAt }` (or null) and `set` takes a TTL.
// Mirrors src/lib/display-cache.ts in home-screens, so a plugin that treats
// `get` as returning the bare value breaks here exactly as it would on a Pi.
interface Entry { data: unknown; fetchedAt: number; ttlMs: number }

export function makeHostDisplayCache() {
  const cache = new Map<string, Entry>();
  return {
    get(key: string): { data: unknown; stale: boolean; fetchedAt: number } | null {
      const e = cache.get(key);
      if (!e) return null;
      return { data: e.data, stale: Date.now() - e.fetchedAt > e.ttlMs, fetchedAt: e.fetchedAt };
    },
    set(key: string, data: unknown, ttlMs: number): void {
      cache.set(key, { data, fetchedAt: Date.now(), ttlMs });
    },
    prefetch: async () => {},
  };
}

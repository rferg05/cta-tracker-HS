import { useLayoutEffect, useRef, useState } from 'react';

/** Never scale below this, however small the box gets. */
const MIN_FONT_PX = 6;
/** Leave a sliver of slack so sub-pixel rounding can't reintroduce an overflow. */
const SAFETY = 0.995;
/** Stop once the largest known-fitting and smallest known-too-big scales are this close. */
const TOLERANCE = 0.02;
/** Hard cap on measure/correct rounds per content change. */
const MAX_STEPS = 8;

/** How far the box, or any `[data-fit]` region inside it, overflows: 1 when
 *  nothing does, else the worst client/scroll ratio. The regions matter in the
 *  combined view: its bands have fixed heights, so a band whose rows spill over
 *  overlaps the next one without ever pushing the box itself past its bottom
 *  edge. `data-fit="x"` checks width only, for rows sized to their own content
 *  (their height can read a rounding pixel over without anything overflowing). */
function overflowRatio(box: HTMLElement): number {
  let ratio = 1;
  const els = [box, ...Array.from(box.querySelectorAll<HTMLElement>('[data-fit]'))];
  for (const el of els) {
    const h = el.dataset.fit === 'x' ? 0 : el.clientHeight;
    const w = el.clientWidth;
    if (h && el.scrollHeight > h + 0.5) ratio = Math.min(ratio, h / el.scrollHeight);
    if (w && el.scrollWidth > w + 0.5) ratio = Math.min(ratio, w / el.scrollWidth);
  }
  return ratio;
}

/**
 * Scales a font size down until the content fits its box, landing on the
 * largest size that fits (a port of the host's useFitFontSize). Every size in
 * the layout is in `em`, so shrinking the root font shrinks all of it.
 *
 * Attach `boxRef` to the fixed-size root. Pass a `resetKey` that changes
 * whenever the content changes, so the fit restarts from full size rather than
 * staying shrunk after the content gets shorter. A change in the box's own
 * size restarts it as well.
 *
 * Never scales up past `desired`, so a module that already fits renders
 * exactly as before.
 */
export function useFitFontSize(desired: number, resetKey: string): {
  boxRef: React.RefObject<HTMLDivElement | null>;
  fontSize: number;
} {
  const boxRef = useRef<HTMLDivElement>(null);
  // `lo` is the largest scale measured to fit, `hi` the smallest measured not to.
  const [fit, setFit] = useState({ key: '', box: '', scale: 1, lo: 0, hi: Infinity, steps: 0 });
  const key = `${desired}|${resetKey}`;
  const matches = fit.key === key;
  const scale = matches ? fit.scale : 1;
  const lo = matches ? fit.lo : 0;
  const hi = matches ? fit.hi : Infinity;
  const steps = matches ? fit.steps : 0;

  // Layout effect: measure and correct before the browser paints, so an
  // overflowing first frame never reaches the screen.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const boxKey = `${box.clientWidth}x${box.clientHeight}`;
      if (!box.clientWidth || !box.clientHeight) return;

      // Text laid out in a fallback face moves once the real font lands.
      if (typeof document !== 'undefined' && document.fonts?.status === 'loading') {
        document.fonts.ready.then(() => { if (!cancelled) measure(); });
        return;
      }

      // A resized box invalidates the bracket: a settled one would otherwise
      // pin the fit forever, since a bigger box can only ever report "fits".
      if (matches && fit.box !== boxKey) {
        setFit({ key, box: boxKey, scale: 1, lo: 0, hi: Infinity, steps: 0 });
        return;
      }

      const ratio = overflowRatio(box);
      const fits = ratio >= 1;
      const nextLo = fits ? Math.max(lo, scale) : lo;
      const nextHi = fits ? hi : Math.min(hi, scale);

      if (fits && nextHi === Infinity) {
        if (!matches) setFit({ key, box: boxKey, scale: 1, lo: 0, hi: Infinity, steps: 0 });
        return;
      }
      // Bracket tight enough, or out of rounds: settle on a size known to fit.
      if (steps >= MAX_STEPS || nextHi - nextLo <= TOLERANCE) {
        if (!fits && nextLo > 0 && nextLo < scale) {
          setFit({ key, box: boxKey, scale: nextLo, lo: nextLo, hi: nextHi, steps: steps + 1 });
        }
        return;
      }

      // No known-good scale yet: jump to the proportional estimate, then bisect.
      const next = fits
        ? Math.min(1, (scale + nextHi) / 2)
        : nextLo > 0
          ? (nextLo + scale) / 2
          : Math.max(Math.min(1, MIN_FONT_PX / desired), scale * ratio * SAFETY);

      if (Math.abs(next - scale) > 0.001) {
        setFit({ key, box: boxKey, scale: next, lo: nextLo, hi: nextHi, steps: steps + 1 });
      }
    };

    const ro = new ResizeObserver(measure);
    ro.observe(box);
    measure();
    return () => { cancelled = true; ro.disconnect(); };
  });

  return { boxRef, fontSize: desired * scale };
}

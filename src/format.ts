/** Format seconds as m:ss (or h:mm:ss past an hour). */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Format seconds as m:ss.d (one decimal) for fine timing controls. */
export function formatPrecise(seconds: number): string {
  const v = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}


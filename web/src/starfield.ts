// Procedural starfield that follows the globe's orientation, so it reads as a
// fixed celestial backdrop rather than a pasted-on wallpaper.
//
// Implementation: a seamlessly-tileable star tile is set as a repeating CSS
// background on an oversized element behind the (transparent) map. We then
// drive it from the camera:
//   - bearing  -> rotate the element            (compass heading)
//   - longitude/latitude -> pan background-position (globe spin / N-S)
//   - pitch    -> pan vertically                 (tilt reveals more sky)
// Because the tile repeats, panning never reveals an edge or pops, and the
// oversize + repeat means rotation is always fully covered. No 3D star sphere.

// Build a star tile whose edges wrap, so it tiles seamlessly in all directions.
export function makeStarTileDataURL(size = 600): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000008";
  ctx.fillRect(0, 0, size, size);

  const star = (x: number, y: number, r: number, a: number, tint: number) => {
    ctx.fillStyle = tint < 0.15 ? `rgba(185,205,255,${a})`
      : tint > 0.9 ? `rgba(255,228,196,${a})` : `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // Draw a star and any wrapped copies needed near the edges (for seamless tiling).
  const placeWrapped = (draw: (x: number, y: number) => void, x: number, y: number, m: number) => {
    draw(x, y);
    if (x < m) draw(x + size, y);
    if (x > size - m) draw(x - size, y);
    if (y < m) draw(x, y + size);
    if (y > size - m) draw(x, y - size);
  };

  const n = Math.round((size * size) / 2200);
  for (let i = 0; i < n; i++) {
    const r = Math.random() * 1.1 + 0.25;
    const a = Math.random() * 0.55 + 0.4;
    const tint = Math.random();
    placeWrapped((x, y) => star(x, y, r, a, tint), Math.random() * size, Math.random() * size, 3);
  }
  // a few brighter, haloed stars
  for (let i = 0; i < n / 35; i++) {
    const r = Math.random() * 1.4 + 1.1;
    const drawBright = (x: number, y: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 4, 0, Math.PI * 2);
      ctx.fill();
    };
    placeWrapped(drawBright, Math.random() * size, Math.random() * size, r * 4 + 2);
  }
  return c.toDataURL();
}

export interface Orientation {
  bearing: number;
  pitch: number;
  lng: number;
  lat: number;
}

// Pan + rotate the starfield to match the camera orientation.
export function applyStarTransform(el: HTMLElement, o: Orientation): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Spin the globe east -> stars slide west; N-S and tilt shift vertically.
  const panX = -o.lng * (vw / 200);
  const panY = o.lat * (vh / 320) + o.pitch * (vh / 130);
  el.style.backgroundPosition = `${panX}px ${panY}px`;
  el.style.transform = `rotate(${-o.bearing}deg)`;
}

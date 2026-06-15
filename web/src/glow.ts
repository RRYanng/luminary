// Warm radial-glow sprite, shared by the MapLibre symbol icon (far-zoom glow
// points) and the Three.js lighthouse lantern halo.
export function glowCanvas(size = 64): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,236,190,0.9)");
  g.addColorStop(0.55, "rgba(255,196,110,0.45)");
  g.addColorStop(1.0, "rgba(255,176,70,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// MapLibre's addImage wants ImageData (a canvas element is not accepted).
export function glowIconImageData(size = 64): ImageData {
  const c = glowCanvas(size);
  return c.getContext("2d")!.getImageData(0, 0, size, size);
}

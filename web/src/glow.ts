import * as THREE from "three";

// A soft radial-gradient sprite used as the point texture. White core fading
// to transparent; the warm tint comes from the PointsMaterial color, and
// additive blending makes overlapping points bloom like real light.
export function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.25, "rgba(255,238,200,0.85)");
  grad.addColorStop(0.55, "rgba(255,200,120,0.35)");
  grad.addColorStop(1.0, "rgba(255,180,80,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

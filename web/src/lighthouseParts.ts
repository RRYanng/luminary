import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// The shared lighthouse model as a small set of InstancedMeshes — any number of
// visible lighthouses render in ~7 draw calls. Built in real meters (1u = 1m),
// Y-up, each part pre-translated to its model-space height so one per-instance
// matrix transforms the whole model. Same-material parts are merged into one
// geometry to keep instanced-mesh / draw-call count low.
//
// Red/white bands are done with geometry (red ring bands over a white tower)
// rather than a texture map: solid materials render reliably in the shared
// MapLibre/Three context, whereas a CanvasTexture map came out black.
export interface InstancedLighthouses {
  meshes: THREE.InstancedMesh[];
  capacity: number;
}

// tower shaft taper: radius at height y (model space)
const SHAFT_Y0 = 2.2, SHAFT_H = 16, SHAFT_RBOT = 3.0, SHAFT_RTOP = 2.0;
const shaftR = (y: number) => SHAFT_RBOT + (SHAFT_RTOP - SHAFT_RBOT) * ((y - SHAFT_Y0) / SHAFT_H);

// a red band ring hugging the tapered shaft between y0..y1
function bandGeo(y0: number, y1: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(shaftR(y1) + 0.03, shaftR(y0) + 0.03, y1 - y0, 48, 1, true)
    .translate(0, (y0 + y1) / 2, 0);
}

export function createLighthouseParts(capacity: number): InstancedLighthouses {
  const SEG = 48;
  const white = new THREE.MeshStandardMaterial({ color: 0xeae4d6, roughness: 0.7, metalness: 0.04 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb23a2c, roughness: 0.55, metalness: 0.1 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x565a63, roughness: 0.5, metalness: 0.25 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 2.2, roughness: 0.15, metalness: 0,
    transparent: true, opacity: 0.9,
  });
  const additive = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const glowCore = additive(0xffc46a, 0.5);
  const glowOuter = additive(0xffb86a, 0.15);
  const halo = additive(0xffb347, 0.2);
  halo.side = THREE.DoubleSide;

  const deckY = SHAFT_Y0 + SHAFT_H;        // 18.2
  const lanternH = 3.0;
  const lanternY = deckY + 0.6 + lanternH / 2; // 20.3
  const roofH = 2.6;
  const roofBaseY = deckY + 0.6 + lanternH;    // 21.8
  const apexY = roofBaseY + roofH;             // 24.4

  // ---- white: two-tier base + tapered shaft (one merged geometry)
  const whiteGeo = mergeGeometries([
    new THREE.CylinderGeometry(3.4, 3.6, 1.2, SEG).translate(0, 0.6, 0),
    new THREE.CylinderGeometry(3.0, 3.2, 1.0, SEG).translate(0, 1.7, 0),
    new THREE.CylinderGeometry(SHAFT_RTOP, SHAFT_RBOT, SHAFT_H, SEG).translate(0, SHAFT_Y0 + SHAFT_H / 2, 0),
  ]);

  // ---- red: two band rings on the shaft + conical roof
  const redGeo = mergeGeometries([
    bandGeo(7, 9),
    bandGeo(12, 14),
    new THREE.ConeGeometry(1.95, roofH, SEG).translate(0, roofBaseY + roofH / 2, 0),
  ]);

  // ---- metal: gallery deck, parapet, handrail, glazing bars (mullions), finial
  const metalParts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(2.75, 2.9, 0.6, SEG).translate(0, deckY + 0.3, 0),
    new THREE.CylinderGeometry(2.5, 2.5, 1.0, SEG, 1, true).translate(0, deckY + 0.55, 0),
    new THREE.TorusGeometry(2.5, 0.09, 8, SEG).rotateX(Math.PI / 2).translate(0, deckY + 1.05, 0),
    new THREE.SphereGeometry(0.26, 16, 16).translate(0, apexY + 0.28, 0),
    new THREE.CylinderGeometry(0.045, 0.045, 0.9, 8).translate(0, apexY + 0.8, 0),
  ];
  const bars = 12, barR = 1.78;
  for (let i = 0; i < bars; i++) {
    metalParts.push(
      new THREE.BoxGeometry(0.1, lanternH + 0.2, 0.1).translate(barR, lanternY, 0).rotateY((i / bars) * Math.PI * 2),
    );
  }
  const metalGeo = mergeGeometries(metalParts);

  // ---- lantern glass + glow
  const glassGeo = new THREE.CylinderGeometry(1.7, 1.7, lanternH, 24, 1, true).translate(0, lanternY, 0);
  const glowCoreGeo = new THREE.SphereGeometry(2.0, 18, 18).translate(0, lanternY, 0);
  const glowOuterGeo = new THREE.SphereGeometry(5.0, 18, 18).translate(0, lanternY, 0);
  const haloGeo = new THREE.CircleGeometry(8.5, 48).rotateX(-Math.PI / 2).translate(0, 0.12, 0);

  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, renderOrder = 0) => {
    const im = new THREE.InstancedMesh(geo, mat, capacity);
    im.count = 0;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.renderOrder = renderOrder;
    return im;
  };

  return {
    capacity,
    meshes: [
      make(whiteGeo, white),
      make(redGeo, red),
      make(metalGeo, metal),
      make(glassGeo, glass),
      make(haloGeo, halo, 1),
      make(glowOuterGeo, glowOuter, 1),
      make(glowCoreGeo, glowCore, 1),
    ],
  };
}

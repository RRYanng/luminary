import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Shared lighthouse model as a small set of InstancedMeshes (merged by material).
// Built in real meters (1u = 1m), Y-up, each part pre-translated to model-space
// height so one per-instance matrix transforms the whole model. Relies on the
// scene's IBL environment (set in lighthouseTier) for non-flat shading + metal
// reflections; corner/base shadows are baked into the tower's vertex colors.
export interface InstancedLighthouses {
  meshes: THREE.InstancedMesh[];
  capacity: number;
}

const SHAFT_Y0 = 2.2, SHAFT_H = 16, SHAFT_RBOT = 3.0, SHAFT_RTOP = 2.0;
const SHAFT_TOP = SHAFT_Y0 + SHAFT_H; // 18.2
const shaftR = (y: number) => SHAFT_RBOT + (SHAFT_RTOP - SHAFT_RBOT) * ((y - SHAFT_Y0) / SHAFT_H);

// Bake the barber-pole spiral (red/white) + soft AO into the tower's vertex
// colors. Vertex colors avoid the texture-upload issue in the shared context.
function bakeTowerColors(geo: THREE.BufferGeometry) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const white: [number, number, number] = [0.93, 0.90, 0.84];
  const red: [number, number, number] = [0.70, 0.21, 0.15];
  const TURNS = 3; // diagonal wraps over the shaft height
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let c = white;
    if (y >= SHAFT_Y0 - 0.01) {
      const u = Math.atan2(z, x) / (2 * Math.PI) + 0.5; // 0..1 around
      const hN = (y - SHAFT_Y0) / SHAFT_H;              // 0..1 up
      const s = (((u + hN * TURNS) % 1) + 1) % 1;
      c = s < 0.45 ? red : white;
    }
    // baked AO: darker at ground contact and just under the gallery overhang
    let ao = 1;
    if (y < SHAFT_Y0 + 0.8) ao *= 0.55 + 0.45 * Math.min(1, y / (SHAFT_Y0 + 0.8));
    if (y > SHAFT_TOP - 1.6) ao *= 0.65 + 0.35 * Math.max(0, (SHAFT_TOP - y) / 1.6);
    col[i * 3] = c[0] * ao;
    col[i * 3 + 1] = c[1] * ao;
    col[i * 3 + 2] = c[2] * ao;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

export function createLighthouseParts(capacity: number): InstancedLighthouses {
  // ---- materials (shaded by IBL env from the scene)
  const tower = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.8 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x70757f, roughness: 0.32, metalness: 0.9, envMapIntensity: 1.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.6 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x7d271c, roughness: 0.4, metalness: 0.25, envMapIntensity: 0.7 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xffd98a, emissive: 0xffb347, emissiveIntensity: 3.0, roughness: 0.1, metalness: 0,
    transparent: true, opacity: 0.92,
  });
  const additive = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const glowCore = additive(0xffc46a, 0.5);
  const glowOuter = additive(0xffb86a, 0.15);
  const halo = additive(0xffb347, 0.2);
  halo.side = THREE.DoubleSide;

  const deckY = SHAFT_TOP;          // 18.2
  const lanternH = 3.0;
  const lanternR = 1.7;
  const lanternY = deckY + 0.6 + lanternH / 2; // 20.3
  const roofH = 2.6;
  const roofBaseY = deckY + 0.6 + lanternH;     // 21.8
  const apexY = roofBaseY + roofH;              // 24.4

  // ---- white tower: two-tier base + tapered shaft, smooth, vertex-colored
  const towerGeo = mergeGeometries([
    new THREE.CylinderGeometry(3.4, 3.6, 1.2, 56).translate(0, 0.6, 0),
    new THREE.CylinderGeometry(3.0, 3.2, 1.0, 56).translate(0, 1.7, 0),
    new THREE.CylinderGeometry(SHAFT_RTOP, SHAFT_RBOT, SHAFT_H, 64, 80).translate(0, SHAFT_Y0 + SHAFT_H / 2, 0),
  ]);
  bakeTowerColors(towerGeo);

  // ---- metal: gallery deck, parapet, handrail, vertical + horizontal glazing
  // bars, ventilator ball + spike
  const metalParts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(2.75, 2.9, 0.55, 56).translate(0, deckY + 0.28, 0),
    new THREE.CylinderGeometry(2.5, 2.5, 1.0, 56, 1, true).translate(0, deckY + 0.55, 0),
    new THREE.TorusGeometry(2.5, 0.09, 10, 56).rotateX(Math.PI / 2).translate(0, deckY + 1.05, 0),
    new THREE.SphereGeometry(0.34, 18, 18).translate(0, apexY + 0.34, 0),       // ventilator ball
    new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8).translate(0, apexY + 0.85, 0), // spike
  ];
  const bars = 12, barR = 1.76;
  for (let i = 0; i < bars; i++) {
    metalParts.push(
      new THREE.BoxGeometry(0.09, lanternH + 0.2, 0.09).translate(barR, lanternY, 0).rotateY((i / bars) * Math.PI * 2),
    );
  }
  for (const ry of [lanternY - lanternH / 2 + 0.2, lanternY, lanternY + lanternH / 2 - 0.2]) {
    metalParts.push(new THREE.TorusGeometry(lanternR + 0.02, 0.05, 8, 40).rotateX(Math.PI / 2).translate(0, ry, 0));
  }
  const metalGeo = mergeGeometries(metalParts);

  // ---- dark openings: a door at the base + two windows up the shaft (+X face)
  const door = new THREE.BoxGeometry(0.95, 1.7, 0.35).translate(shaftR(3.0) - 0.02, 3.0, 0);
  const win1 = new THREE.BoxGeometry(0.5, 0.7, 0.3).translate(shaftR(8) - 0.02, 8, 0);
  const win2 = new THREE.BoxGeometry(0.5, 0.7, 0.3).translate(shaftR(12.5) - 0.02, 12.5, 0);
  const darkGeo = mergeGeometries([door, win1, win2]);

  // ---- roof, lantern glass, glow
  const roofGeo = new THREE.ConeGeometry(2.0, roofH, 48).translate(0, roofBaseY + roofH / 2, 0);
  const glassGeo = new THREE.CylinderGeometry(lanternR, lanternR, lanternH, 32, 1, true).translate(0, lanternY, 0);
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
      make(towerGeo, tower),
      make(metalGeo, metal),
      make(darkGeo, dark),
      make(roofGeo, roof),
      make(glassGeo, glass),
      make(haloGeo, halo, 1),
      make(glowOuterGeo, glowOuter, 1),
      make(glowCoreGeo, glowCore, 1),
    ],
  };
}

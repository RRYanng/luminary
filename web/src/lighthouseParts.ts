import * as THREE from "three";

// The shared lighthouse model, expressed as a set of InstancedMeshes so any
// number of visible lighthouses render in a handful of draw calls. Geometry is
// built in real meters (1 unit = 1 m), Y-up, each part pre-translated to its
// height in model space so one per-instance matrix transforms the whole model.
//
// Faithful to the original "hero" model: tapered tower, gallery + railing,
// emissive lantern, conical roof + finial, a layered additive glow (bright core
// + soft outer halo) around the lantern, and a light-pool disc on the ground.
// (The original's per-lantern PointLight is intentionally omitted — 80 real
// lights would tank the framerate; the emissive + additive glow carry the look.)
export interface InstancedLighthouses {
  meshes: THREE.InstancedMesh[];
  capacity: number;
}

export function createLighthouseParts(capacity: number): InstancedLighthouses {
  const white = new THREE.MeshStandardMaterial({ color: 0xede8da, roughness: 0.75, metalness: 0.04 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb23a2c, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262d, roughness: 0.5, metalness: 0.3 });
  const lantern = new THREE.MeshStandardMaterial({
    color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 2.4, roughness: 0.3,
  });
  const additive = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
  const glowCore = additive(0xffc46a, 0.5);
  const glowOuter = additive(0xffb86a, 0.16);
  const halo = additive(0xffb347, 0.2);
  halo.side = THREE.DoubleSide;

  const towerH = 18;
  const lanternH = 3.2;
  const lanternY = towerH + 0.7 + lanternH / 2;
  const roofY = towerH + 0.7 + lanternH + 1.3;

  // Structure
  const towerGeo = new THREE.CylinderGeometry(2.1, 3.0, towerH, 28).translate(0, towerH / 2, 0);
  const galleryGeo = new THREE.CylinderGeometry(3.0, 3.0, 0.7, 28).translate(0, towerH + 0.35, 0);
  const railGeo = new THREE.TorusGeometry(2.85, 0.13, 8, 28).rotateX(Math.PI / 2).translate(0, towerH + 1.3, 0);
  const lanternGeo = new THREE.CylinderGeometry(2.0, 2.0, lanternH, 16).translate(0, lanternY, 0);
  const roofGeo = new THREE.ConeGeometry(2.35, 2.6, 16).translate(0, roofY, 0);
  const finialGeo = new THREE.SphereGeometry(0.32, 12, 12).translate(0, roofY + 1.3, 0);
  // Glow: bright core + soft outer halo at the lantern, plus a ground light pool.
  const glowCoreGeo = new THREE.SphereGeometry(2.2, 16, 16).translate(0, lanternY, 0);
  const glowOuterGeo = new THREE.SphereGeometry(5.5, 18, 18).translate(0, lanternY, 0);
  const haloGeo = new THREE.CircleGeometry(9, 40).rotateX(-Math.PI / 2).translate(0, 0.12, 0);

  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, renderOrder = 0) => {
    const im = new THREE.InstancedMesh(geo, mat, capacity);
    im.count = 0;
    im.frustumCulled = false; // positions come from per-instance matrices
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.renderOrder = renderOrder;
    return im;
  };

  return {
    capacity,
    meshes: [
      make(towerGeo, white),
      make(galleryGeo, dark),
      make(railGeo, dark),
      make(lanternGeo, lantern),
      make(roofGeo, red),
      make(finialGeo, dark),
      make(haloGeo, halo, 1), // additive bits last
      make(glowOuterGeo, glowOuter, 1),
      make(glowCoreGeo, glowCore, 1),
    ],
  };
}

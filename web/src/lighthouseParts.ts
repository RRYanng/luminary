import * as THREE from "three";

// The shared lighthouse model, expressed as a set of InstancedMeshes so any
// number of visible lighthouses render in ~5 draw calls. Geometry is built in
// real meters (1 unit = 1 m), Y-up, with each part pre-translated to its height
// in model space so a single per-instance matrix transforms the whole model.
export interface InstancedLighthouses {
  meshes: THREE.InstancedMesh[];
  capacity: number;
}

export function createLighthouseParts(capacity: number): InstancedLighthouses {
  const white = new THREE.MeshStandardMaterial({ color: 0xede8da, roughness: 0.75, metalness: 0.04 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb23a2c, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262d, roughness: 0.5, metalness: 0.3 });
  // Self-lit lantern + an additive glow orb so each lighthouse glows.
  const lantern = new THREE.MeshStandardMaterial({
    color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 2.6, roughness: 0.3,
  });
  const orb = new THREE.MeshBasicMaterial({
    color: 0xffb86a, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const towerH = 18;
  const lanternH = 3.2;
  const lanternY = towerH + 0.7 + lanternH / 2;

  const towerGeo = new THREE.CylinderGeometry(2.1, 3.0, towerH, 18).translate(0, towerH / 2, 0);
  const galleryGeo = new THREE.CylinderGeometry(3.0, 3.0, 0.7, 18).translate(0, towerH + 0.35, 0);
  const lanternGeo = new THREE.CylinderGeometry(2.0, 2.0, lanternH, 14).translate(0, lanternY, 0);
  const roofGeo = new THREE.ConeGeometry(2.35, 2.6, 14).translate(0, towerH + 0.7 + lanternH + 1.3, 0);
  const orbGeo = new THREE.SphereGeometry(3.4, 12, 12).translate(0, lanternY, 0);

  const make = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const im = new THREE.InstancedMesh(geo, mat, capacity);
    im.count = 0;
    im.frustumCulled = false; // positions come from per-instance matrices
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return im;
  };

  return {
    capacity,
    meshes: [
      make(towerGeo, white),
      make(galleryGeo, dark),
      make(lanternGeo, lantern),
      make(roofGeo, red),
      make(orbGeo, orb),
    ],
  };
}

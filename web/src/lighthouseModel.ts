import * as THREE from "three";
import { glowCanvas } from "./glow";

export interface LighthouseModel {
  group: THREE.Group;
}

// Procedurally-built lighthouse — no external model. Built Y-up in real meters
// (1 unit = 1 m); the custom layer's matrix stands it upright on the map.
// This single model is shared by every lighthouse (instanced in a later task).
export function buildLighthouse(): LighthouseModel {
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xede8da, roughness: 0.75, metalness: 0.04 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb23a2c, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26262d, roughness: 0.5, metalness: 0.3 });
  // Constant glow — no per-frame pulse, so the map needs no continuous repaint
  // loop (that loop dropped street-zoom rendering to 30fps).
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 2.3, roughness: 0.3,
  });

  const towerH = 18;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 3.0, towerH, 28), white);
  tower.position.y = towerH / 2;
  group.add(tower);

  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, 0.7, 28), dark);
  gallery.position.y = towerH + 0.35;
  group.add(gallery);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(2.85, 0.13, 8, 28), dark);
  rail.rotation.x = Math.PI / 2;
  rail.position.y = towerH + 1.3;
  group.add(rail);

  const lanternH = 3.2;
  const lanternY = towerH + 0.7 + lanternH / 2;
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, lanternH, 16), lanternMat);
  lantern.position.y = lanternY;
  group.add(lantern);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.35, 2.6, 16), red);
  roof.position.y = towerH + 0.7 + lanternH + 1.3;
  group.add(roof);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), dark);
  finial.position.y = towerH + 0.7 + lanternH + 2.6;
  group.add(finial);

  const light = new THREE.PointLight(0xffb86a, 900, 140, 2.0);
  light.position.y = lanternY;
  group.add(light);

  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas()),
    color: 0xffc46a, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glowSprite.scale.set(16, 16, 1);
  glowSprite.position.y = lanternY;
  group.add(glowSprite);

  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffb347, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(new THREE.CircleGeometry(10, 40), haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.12;
  group.add(halo);

  return { group };
}

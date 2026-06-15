import maplibregl, { type CustomLayerInterface, type Map as MlMap } from "maplibre-gl";
import * as THREE from "three";
import { createLighthouseParts } from "./lighthouseParts";

export interface LhPoint {
  id: string;
  lng: number;
  lat: number;
}

interface Slot {
  id: string;
  base: THREE.Matrix4; // mercator placement (no grow scale)
  t: number; // 0 = point, 1 = full 3D
  target: number;
}

export interface TierOptions {
  data: LhPoint[];
  sourceId: string; // glow source, for feature-state crossfade
  maxModels: number; // cap on simultaneous 3D models (60fps budget)
  zoomMin: number; // models only appear at/above this zoom
  fadeMs: number;
}

// Builds a custom layer that crossfades the nearest in-view lighthouses from
// glow points into 3D models (capped at maxModels) and back.
export function createLighthouse3DLayer(opts: TierOptions) {
  const { data, sourceId, maxModels, zoomMin, fadeMs } = opts;
  const capacity = maxModels * 2; // headroom for fade-out + fade-in overlap

  const slots: Slot[] = [];
  const idToSlot = new Map<string, Slot>();
  const idToPoint = new Map<string, LhPoint>(data.map((p) => [p.id, p]));
  let lastTime = 0;

  // scratch
  const growScale = new THREE.Matrix4();
  const instanceMat = new THREE.Matrix4();

  function baseMatrixFor(p: LhPoint): THREE.Matrix4 {
    const merc = maplibregl.MercatorCoordinate.fromLngLat([p.lng, p.lat], 0);
    const s = merc.meterInMercatorCoordinateUnits();
    return new THREE.Matrix4()
      .makeTranslation(merc.x, merc.y, merc.z)
      .multiply(new THREE.Matrix4().makeScale(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  }

  const layer: CustomLayerInterface & {
    map?: MlMap;
    camera?: THREE.Camera;
    scene?: THREE.Scene;
    renderer?: THREE.WebGLRenderer;
    meshes?: THREE.InstancedMesh[];
    recompute?: () => void;
  } = {
    id: "lighthouses-3d",
    type: "custom",
    renderingMode: "3d",

    onAdd(m, gl) {
      this.map = m;
      this.camera = new THREE.Camera();
      this.scene = new THREE.Scene();
      this.scene.add(new THREE.AmbientLight(0xc2c8d4, 1.8));
      const dir = new THREE.DirectionalLight(0xffffff, 2.2);
      dir.position.set(30, 60, 40);
      this.scene.add(dir);
      const parts = createLighthouseParts(capacity);
      this.meshes = parts.meshes;
      parts.meshes.forEach((mesh) => this.scene!.add(mesh));
      this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl });
      this.renderer.autoClear = false;

      // Pick the nearest in-view lighthouses (up to the cap) whenever the camera
      // moves; entering ones fade in, leaving ones fade out.
      this.recompute = () => {
        const map = this.map!;
        const desired = new Set<string>();
        const z = map.getZoom();
        if (z >= zoomMin) {
          const c = map.getCenter();
          const kx = Math.cos((c.lat * Math.PI) / 180); // longitude compression
          // Nearest-to-center within a zoom-derived radius. We deliberately avoid
          // map.getBounds(): on globe projection it samples the silhouette and
          // costs ~tens of ms per call, which tanked the framerate.
          const maxDeg = (10 * 180) / Math.pow(2, z);
          const maxD2 = maxDeg * maxDeg;
          const inView: { id: string; d2: number }[] = [];
          for (let i = 0; i < data.length; i++) {
            const p = data[i];
            const dx = (p.lng - c.lng) * kx;
            const dy = p.lat - c.lat;
            const d2 = dx * dx + dy * dy;
            if (d2 <= maxD2) inView.push({ id: p.id, d2 });
          }
          inView.sort((a, z2) => a.d2 - z2.d2);
          for (let i = 0; i < Math.min(maxModels, inView.length); i++) desired.add(inView[i].id);
        }

        // leaving -> fade out
        for (const slot of slots) if (!desired.has(slot.id)) slot.target = 0;
        // entering -> assign slot, fade in
        for (const id of desired) {
          if (idToSlot.has(id)) {
            idToSlot.get(id)!.target = 1;
            continue;
          }
          if (slots.length >= capacity) continue; // safety
          const slot: Slot = { id, base: baseMatrixFor(idToPoint.get(id)!), t: 0, target: 1 };
          slots.push(slot);
          idToSlot.set(id, slot);
        }
        map.triggerRepaint();
      };

      m.on("move", this.recompute);
      this.recompute();

      if (import.meta.env.DEV) {
        (window as unknown as { __tier: () => unknown }).__tier = () => ({
          active: slots.length,
          full: slots.filter((s) => s.t >= 1).length,
          fading: slots.filter((s) => s.t > 0 && s.t < 1).length,
        });
      }
    },

    render(_gl, args) {
      const m = this.map;
      const meshes = this.meshes;
      if (!m || !meshes || !this.renderer || !this.scene || !this.camera) return;

      const now = performance.now();
      const dt = lastTime ? Math.min(now - lastTime, 64) : 16;
      lastTime = now;

      // advance crossfades; free fully-faded-out slots
      let animating = false;
      for (let i = slots.length - 1; i >= 0; i--) {
        const slot = slots[i];
        if (slot.t !== slot.target) {
          const step = (dt / fadeMs) * (slot.target > slot.t ? 1 : -1);
          slot.t = Math.max(0, Math.min(1, slot.t + step));
          if (slot.t !== slot.target) animating = true;
          m.setFeatureState({ source: sourceId, id: slot.id }, { fade: slot.t });
        }
        if (slot.target === 0 && slot.t === 0) {
          m.setFeatureState({ source: sourceId, id: slot.id }, { fade: 0 });
          idToSlot.delete(slot.id);
          slots.splice(i, 1);
        }
      }

      // write instance matrices (base * uniform grow by t)
      let count = 0;
      for (const slot of slots) {
        if (slot.t <= 0) continue;
        growScale.makeScale(slot.t, slot.t, slot.t);
        instanceMat.multiplyMatrices(slot.base, growScale);
        for (const mesh of meshes) mesh.setMatrixAt(count, instanceMat);
        count++;
      }
      for (const mesh of meshes) {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
      }

      const input = args as unknown as { defaultProjectionData?: { mainMatrix: number[] }; matrix?: number[] };
      const proj = input.defaultProjectionData?.mainMatrix ?? input.matrix!;
      this.camera.projectionMatrix = new THREE.Matrix4().fromArray(proj);
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
      if (animating) m.triggerRepaint();
    },
  };

  return layer;
}

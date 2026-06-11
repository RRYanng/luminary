import { useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import * as THREE from "three";
import type { Lighthouse } from "./types";
import { makeGlowTexture } from "./glow";
import { DetailCard } from "./DetailCard";
import "./App.css";

// Lift points just off the surface so they don't z-fight with the globe mesh.
const POINT_ALTITUDE = 0.004;

function useWindowSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

// Lightweight FPS meter so the "smooth at 15k points" criterion is observable.
function useFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      frames++;
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}

export default function App() {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const pointsRef = useRef<THREE.Points | null>(null);
  const { w, h } = useWindowSize();
  const fps = useFps();

  const [data, setData] = useState<Lighthouse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Lighthouse | null>(null);

  // Load the lighthouse dataset (synced from data/lighthouses.json into public/).
  useEffect(() => {
    fetch("/lighthouses.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: Lighthouse[]) => {
        setData(d);
        if (import.meta.env.DEV) (window as unknown as { __data: Lighthouse[] }).__data = d;
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Configure controls: gentle auto-rotation, sane zoom limits, initial framing.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35; // slow idle spin
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 130;
    controls.maxDistance = 600;
    globe.pointOfView({ lat: 25, lng: 10, altitude: 2.6 }, 0);
    // Dev-only handle for verification in the preview browser (stripped from prod builds).
    if (import.meta.env.DEV) (window as unknown as { __globe: GlobeMethods }).__globe = globe;
  }, [data]);

  // Build the glowing point cloud as a single THREE.Points object — one draw
  // call for all ~15k lighthouses, which is what keeps it at 60fps.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !data) return;

    const positions = new Float32Array(data.length * 3);
    for (let i = 0; i < data.length; i++) {
      const lh = data[i];
      const { x, y, z } = globe.getCoords(lh.lat, lh.lng, POINT_ALTITUDE);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const texture = makeGlowTexture();
    const material = new THREE.PointsMaterial({
      size: 1.6,
      map: texture,
      color: 0xffc44d, // warm amber
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false, // don't occlude siblings; globe mesh still hides back-side points
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geometry, material);
    points.renderOrder = 1;
    globe.scene().add(points);
    pointsRef.current = points;

    return () => {
      globe.scene().remove(points);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      pointsRef.current = null;
    };
  }, [data]);

  // Click-to-pick: raycast the point cloud. We roll our own picking because the
  // lighthouses are one THREE.Points object (not react-globe.gl's points layer).
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !data) return;
    const dom = globe.renderer().domElement;
    const camera = globe.camera();
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    // Distinguish a click from a drag-to-rotate gesture.
    let downX = 0;
    let downY = 0;

    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };

    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // was a drag
      const points = pointsRef.current;
      if (!points) return;

      const rect = dom.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);

      // Forgiving hit radius that grows with camera distance.
      const camDist = camera.position.length();
      raycaster.params.Points!.threshold = Math.max(0.6, camDist * 0.01);

      const hits = raycaster.intersectObject(points, false);
      if (!hits.length) {
        setSelected(null);
        return;
      }

      // Keep only front-facing hits (reject points occluded by the globe), then
      // pick the one closest to the cursor ray.
      const camPos = camera.position;
      const candidates = hits.filter((hit) => {
        const p = hit.point;
        // Globe is centered at the origin, so p itself is the outward normal.
        return p.x * (camPos.x - p.x) + p.y * (camPos.y - p.y) + p.z * (camPos.z - p.z) > 0;
      });
      if (!candidates.length) {
        setSelected(null);
        return;
      }
      candidates.sort(
        (a, b) => (a.distanceToRay ?? a.distance) - (b.distanceToRay ?? b.distance),
      );
      const idx = candidates[0].index;
      if (idx != null) setSelected(data[idx]);
    };

    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
    };
  }, [data]);

  // Pause idle spin while a card is open; Esc closes the card.
  useEffect(() => {
    const globe = globeRef.current;
    if (globe) globe.controls().autoRotate = !selected;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const named = useMemo(
    () => (data ? data.filter((d) => d.name).length : 0),
    [data],
  );

  return (
    <div className="app">
      <Globe
        ref={globeRef}
        width={w}
        height={h}
        backgroundImageUrl="/textures/night-sky.png"
        globeImageUrl="/textures/earth-dark.jpg"
        bumpImageUrl="/textures/earth-topology.png"
        showAtmosphere={true}
        atmosphereColor="#7da2c4"
        atmosphereAltitude={0.18}
        animateIn={true}
        ringsData={selected ? [selected] : []}
        ringColor={() => "#ffcf6e"}
        ringMaxRadius={3}
        ringPropagationSpeed={1.4}
        ringRepeatPeriod={900}
        ringAltitude={POINT_ALTITUDE}
      />

      <div className="hud">
        <h1>Luminary</h1>
        <p className="subtitle">Lighthouses of the world</p>
        {data && (
          <p className="stats">
            {data.length.toLocaleString()} lighthouses · {named.toLocaleString()} named
          </p>
        )}
        {!data && !error && <p className="stats">Loading lighthouses…</p>}
        {error && <p className="stats err">Failed to load data: {error}</p>}
      </div>

      {selected && (
        <DetailCard lighthouse={selected} onClose={() => setSelected(null)} />
      )}

      <div className="fps" title="frames per second">
        {fps} fps
      </div>
    </div>
  );
}

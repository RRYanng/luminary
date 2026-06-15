import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createLighthouse3DLayer, type LhPoint } from "./lighthouseTier";
import { makeStarTileDataURL, applyStarTransform } from "./starfield";
import { DetailCard } from "./DetailCard";
import type { Lighthouse } from "./types";
import "./App.css";

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

// Tiering tuning. Cap keeps a stable 60fps even in dense areas; the nearest
// in-view lighthouses (to screen center) are the ones promoted to 3D.
const MAX_3D_MODELS = 80;
const ZOOM_3D_MIN = 14;
const FADE_MS = 350;

const DEFAULT_VIEW = { center: [-20, 25] as [number, number], zoom: 2.4, bearing: 0, pitch: 0 };

// MapLibre's hash:true does NOT apply an existing URL hash over explicit
// center/zoom on init (explicit options win, then it overwrites the hash), so
// deep-links were ignored. Parse the hash ourselves for the initial camera;
// hash:true still keeps the URL in sync as the user moves.
function parseInitialView() {
  const parts = window.location.hash.replace(/^#/, "").split("/").map(Number);
  if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
    const [zoom, lat, lng, bearing = 0, pitch = 0] = parts;
    return { center: [lng, lat] as [number, number], zoom, bearing, pitch };
  }
  return DEFAULT_VIEW;
}

// Captured ONCE at module load — before React 18 StrictMode's double-mount can
// create-then-remove() a map, which (with hash:true) wipes the URL hash and
// would otherwise leave the second mount reading an empty hash.
const INITIAL_VIEW = parseInitialView();

function useFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0, last = performance.now(), raf = 0;
    const tick = (now: number) => {
      frames++;
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0; last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const starsRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const fps = useFps();
  const [zoom, setZoom] = useState(2.4);
  const [mode, setMode] = useState("globe");
  const [count, setCount] = useState("loading…");
  const [selected, setSelected] = useState<Lighthouse | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    const initial = INITIAL_VIEW;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: STYLE_URL,
      center: initial.center,
      zoom: initial.zoom,
      pitch: initial.pitch,
      bearing: initial.bearing,
      maxPitch: 80,
      hash: true, // shareable #zoom/lat/lng/bearing/pitch
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left");
    // Dev-only handle for verification in the preview browser (stripped from prod builds).
    if (import.meta.env.DEV) (window as unknown as { __map: MlMap }).__map = map;

    if (starsRef.current) {
      starsRef.current.style.backgroundImage = `url(${makeStarTileDataURL()})`;
    }

    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
      map.setSky({ "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] });

      // 3D buildings — extrude OpenFreeMap's building layer by real height.
      if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", "none");
      let firstSymbol: string | undefined;
      for (const ly of map.getStyle().layers) {
        if (ly.type === "symbol") { firstSymbol = ly.id; break; }
      }
      map.addLayer(
        {
          id: "building-3d",
          source: "openmaptiles",
          "source-layer": "building",
          type: "fill-extrusion",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": [
              "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
              0, "#2a2b34", 30, "#3a3d49", 80, "#4c5063",
            ],
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 8],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
            "fill-extrusion-opacity": 0.92,
            "fill-extrusion-vertical-gradient": true,
          },
        },
        firstSymbol,
      );

      // All lighthouses as glowing points (far-zoom representation), faded at
      // street zoom. A CIRCLE layer (not symbol) — circles are occluded by the
      // globe per-frame in the shader, whereas symbol occlusion is computed in
      // the throttled placement pass and lags during fast motion, letting the
      // far side bleed through. Circles fix that at any speed.
      type LhProps = Omit<Lighthouse, "lat" | "lng">;
      type LhFeature = { properties: LhProps; geometry: { coordinates: [number, number] } };
      fetch("/lighthouses.geojson")
        .then((r) => r.json())
        .then((geojson: { features: LhFeature[] }) => {
          setCount(`${geojson.features.length.toLocaleString()} lighthouses`);
          // promoteId so each feature's `id` drives feature-state (crossfade).
          map.addSource("lighthouses", { type: "geojson", data: geojson, promoteId: "id" });
          map.addLayer({
            id: "lighthouse-glow",
            type: "circle",
            source: "lighthouses",
            paint: {
              "circle-color": "#ffc44d",
              "circle-blur": 0.6, // soft glow
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 4, 2.2, 8, 3, 14, 3.6, 18, 5],
              // Full brightness at every zoom (no "fade when close"); only fades
              // out per-lighthouse as its 3D model fades in (feature-state).
              "circle-opacity": ["*", 0.9, ["-", 1, ["coalesce", ["feature-state", "fade"], 0]]],
            },
          });

          // Ring marking the selected lighthouse (works for points and 3D models).
          map.addLayer({
            id: "lighthouse-selected",
            type: "circle",
            source: "lighthouses",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 6, 14, 10, 18, 14],
              "circle-color": "rgba(0,0,0,0)",
              "circle-stroke-color": "#ffcf6e",
              "circle-stroke-width": 2,
              "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.95, 0],
            },
          });

          // Full records (with coords) for click selection -> detail card.
          lighthouses = geojson.features.map((f) => ({
            ...f.properties,
            lng: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          }));

          // 3D tiering: nearest in-view lighthouses crossfade glow point -> 3D.
          const data: LhPoint[] = lighthouses.map((p) => ({ id: p.id, lng: p.lng, lat: p.lat }));
          map.addLayer(
            createLighthouse3DLayer({
              data,
              sourceId: "lighthouses",
              maxModels: MAX_3D_MODELS,
              zoomMin: ZOOM_3D_MIN,
              fadeMs: FADE_MS,
            }),
          );
        });
    });

    // Click selection. Works for both glow points and 3D models by finding the
    // nearest lighthouse to the click in *screen* space (the custom 3D layer
    // isn't queryable via MapLibre's feature API). The highlight ring is synced
    // from `selected` in a separate effect.
    let lighthouses: Lighthouse[] = [];
    const HIT_PX = 44;

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!lighthouses.length) return;
      const cl = map.unproject(e.point);
      const kx = Math.cos((cl.lat * Math.PI) / 180);
      let best: Lighthouse | null = null;
      let bestPx = HIT_PX;
      for (const lh of lighthouses) {
        // cheap geo pre-filter before the (pricier) projection
        if (Math.abs(lh.lat - cl.lat) > 1 || Math.abs(lh.lng - cl.lng) * kx > 1) continue;
        const sp = map.project([lh.lng, lh.lat]);
        const d = Math.hypot(sp.x - e.point.x, sp.y - e.point.y);
        if (d < bestPx) { bestPx = d; best = lh; }
      }
      setSelected(best);
    };
    map.on("click", onClick);

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);

    const onMove = () => {
      const z = map.getZoom(), p = map.getPitch(), b = map.getBearing(), c = map.getCenter();
      if (starsRef.current) applyStarTransform(starsRef.current, { bearing: b, pitch: p, lng: c.lng, lat: c.lat });
      setZoom(z);
      setMode(z < 6 ? "globe" : p >= 30 ? `3D street · ${Math.round(p)}° tilt` : "flat (top-down)");
    };
    map.on("move", onMove);
    map.on("load", onMove);

    return () => {
      window.removeEventListener("keydown", onKey);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Sync the highlight ring (feature-state) with the selected lighthouse.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("lighthouses")) return;
    const id = selected?.id ?? null;
    const prev = selectedIdRef.current;
    if (prev && prev !== id) map.setFeatureState({ source: "lighthouses", id: prev }, { selected: false });
    if (id) map.setFeatureState({ source: "lighthouses", id }, { selected: true });
    selectedIdRef.current = id;
  }, [selected]);

  return (
    <div className="app">
      <div ref={starsRef} className="stars" />
      <div ref={mapContainer} className="map" />

      <div className="hud">
        <h1>Luminary</h1>
        <p className="subtitle">Lighthouses of the world</p>
        <p className="stats">
          zoom {zoom.toFixed(2)} · {mode} · {count}
        </p>
      </div>

      {selected && <DetailCard lighthouse={selected} onClose={() => setSelected(null)} />}

      <div className="fps" title="frames per second">{fps} fps</div>
    </div>
  );
}

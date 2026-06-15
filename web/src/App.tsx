import { useEffect, useRef, useState } from "react";
import maplibregl, { type CustomLayerInterface, type Map as MlMap } from "maplibre-gl";
import * as THREE from "three";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildLighthouse, type LighthouseModel } from "./lighthouseModel";
import { glowIconImageData } from "./glow";
import { makeStarTileDataURL, applyStarTransform } from "./starfield";
import "./App.css";

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

// The one lighthouse rendered as a real 3D model for now. A later task instances
// this model for every lighthouse in view at street zoom.
const MODEL = { lng: -9.42097, lat: 38.69039, name: "Farol de Santa Marta (Cascais)" };

// Custom layer carrying the Three.js scene; extra fields stored on `this`.
type ThreeLayer = CustomLayerInterface & {
  camera?: THREE.Camera;
  scene?: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  model?: LighthouseModel;
};

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
  const fps = useFps();
  const [zoom, setZoom] = useState(2.4);
  const [mode, setMode] = useState("globe");
  const [count, setCount] = useState("loading…");

  useEffect(() => {
    if (!mapContainer.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: STYLE_URL,
      center: [-20, 25],
      zoom: 2.4,
      pitch: 0,
      bearing: 0,
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

    const merc = maplibregl.MercatorCoordinate.fromLngLat([MODEL.lng, MODEL.lat], 0);
    const meterScale = merc.meterInMercatorCoordinateUnits();

    const lighthouseLayer: ThreeLayer = {
      id: "lighthouse-3d",
      type: "custom",
      renderingMode: "3d",
      onAdd(m, gl) {
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0xc2c8d4, 1.7));
        const dir = new THREE.DirectionalLight(0xffffff, 2.3);
        dir.position.set(30, 60, 40);
        this.scene.add(dir);
        this.model = buildLighthouse();
        this.scene.add(this.model.group);
        this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
      },
      render(_gl, args) {
        const m = mapRef.current;
        if (!m || !this.renderer || !this.scene || !this.camera) return;
        if (m.getZoom() < 14) return; // model is the street-level representation only
        this.model?.tick(performance.now());
        // v5 globe-aware projection matrix
        const input = args as unknown as { defaultProjectionData?: { mainMatrix: number[] }; matrix?: number[] };
        const proj = input.defaultProjectionData?.mainMatrix ?? input.matrix!;
        const m4 = new THREE.Matrix4().fromArray(proj);
        const l = new THREE.Matrix4()
          .makeTranslation(merc.x, merc.y, merc.z)
          .scale(new THREE.Vector3(meterScale, -meterScale, meterScale))
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        this.camera.projectionMatrix = m4.multiply(l);
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
        m.triggerRepaint();
      },
    };

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

      // All lighthouses as glow symbols (far-zoom representation), faded at street zoom.
      map.addImage("glow", glowIconImageData(), { pixelRatio: 2 });
      fetch("/lighthouses.geojson")
        .then((r) => r.json())
        .then((geojson) => {
          setCount(`${geojson.features.length.toLocaleString()} lighthouses`);
          map.addSource("lighthouses", { type: "geojson", data: geojson });
          map.addLayer({
            id: "lighthouse-glow",
            type: "symbol",
            source: "lighthouses",
            layout: {
              "icon-image": "glow",
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.18, 4, 0.3, 8, 0.45, 14, 0.5],
            },
            paint: {
              "icon-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.9, 16, 0.35, 18, 0.1],
            },
          });
        });

      map.addLayer(lighthouseLayer);
    });

    const onMove = () => {
      const z = map.getZoom(), p = map.getPitch(), b = map.getBearing(), c = map.getCenter();
      if (starsRef.current) applyStarTransform(starsRef.current, { bearing: b, pitch: p, lng: c.lng, lat: c.lat });
      setZoom(z);
      setMode(z < 6 ? "globe" : p >= 30 ? `3D street · ${Math.round(p)}° tilt` : "flat (top-down)");
    };
    map.on("move", onMove);
    map.on("load", onMove);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

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

      <div className="fps" title="frames per second">{fps} fps</div>
    </div>
  );
}

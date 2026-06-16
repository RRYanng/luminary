import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createLighthouse3DLayer, type LhPoint } from "./lighthouseTier";
import { makeStarTileDataURL, applyStarTransform } from "./starfield";
import { DetailCard } from "./DetailCard";
import { SearchBox } from "./SearchBox";
import type { Lighthouse, LighthouseDetail, CardModel, SearchItem, Status } from "./types";
import "./App.css";

function statusOf(base: Lighthouse, detail: LighthouseDetail | undefined): Status {
  if (detail?.category === "lighthouse" && detail.status) return detail.status;
  return base.operational === true ? "operational" : "existing";
}

// Flatten named lighthouses into the search index (merging Phase 3 details).
function buildSearchIndex(lhs: Lighthouse[], details: Map<string, LighthouseDetail>): SearchItem[] {
  const out: SearchItem[] = [];
  for (const l of lhs) {
    if (!l.name) continue;
    const d = details.get(l.id);
    out.push({
      id: l.id,
      name: l.name,
      lower: l.name.toLowerCase(),
      lat: l.lat,
      lng: l.lng,
      status: statusOf(l, d),
      country: d?.category === "lighthouse" ? d.country : null,
      score: d?.score ?? 0,
    });
  }
  return out;
}

// "en:Pigeon Point Lighthouse" -> https://en.wikipedia.org/wiki/Pigeon_Point_Lighthouse
function wikipediaUrl(wp: string | null): string | null {
  if (!wp) return null;
  const idx = wp.indexOf(":");
  const lang = idx === -1 ? "en" : wp.slice(0, idx);
  const title = idx === -1 ? wp : wp.slice(idx + 1);
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

// Merge a clicked lighthouse (OSM base) with its Phase 3 detail into a card model.
function buildCardModel(base: Lighthouse, detail: LighthouseDetail | undefined): CardModel {
  const isLh = detail?.category === "lighthouse";
  const usable = isLh && !detail?.bad_link; // clean detail -> show summary/image/link
  const status = statusOf(base, detail);
  return {
    id: base.id,
    name: base.name,
    status,
    summary: usable ? detail!.summary : null,
    image: usable ? detail!.image : null,
    // facts from Wikidata are about the lighthouse itself even when the article
    // link is wrong (bad_link), so keep them; not_lighthouse falls back to OSM.
    built: isLh ? detail!.built ?? base.start_date : base.start_date,
    height: isLh && detail!.height_m != null ? detail!.height_m : base.height,
    country: isLh ? detail!.country : null,
    learnMore: usable ? detail!.summary_source : detail ? null : wikipediaUrl(base.wikipedia),
  };
}

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
  const detailsRef = useRef<Map<string, LighthouseDetail>>(new Map());
  const lighthousesRef = useRef<Lighthouse[]>([]);
  const fps = useFps();
  const [zoom, setZoom] = useState(2.4);
  const [mode, setMode] = useState("globe");
  const [count, setCount] = useState("loading…");
  const [selected, setSelected] = useState<CardModel | null>(null);
  const [searchIndex, setSearchIndex] = useState<SearchItem[]>([]);

  // Search result -> fly to the lighthouse at street level (3D) and open its card.
  const flyToLighthouse = useCallback((it: SearchItem) => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({ center: [it.lng, it.lat], zoom: 16.5, pitch: 60, bearing: 20, duration: 2600, essential: true });
    const base = lighthousesRef.current.find((l) => l.id === it.id);
    if (base) setSelected(buildCardModel(base, detailsRef.current.get(it.id)));
  }, []);

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
          lighthousesRef.current = geojson.features.map((f) => ({
            ...f.properties,
            lng: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          }));
          // search index (names only) — works now; re-enriched once details load.
          setSearchIndex(buildSearchIndex(lighthousesRef.current, detailsRef.current));

          // 3D tiering: nearest in-view lighthouses crossfade glow point -> 3D.
          const data: LhPoint[] = lighthousesRef.current.map((p) => ({ id: p.id, lng: p.lng, lat: p.lat }));
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
    const HIT_PX = 44;

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const lighthouses = lighthousesRef.current;
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
      setSelected(best ? buildCardModel(best, detailsRef.current.get(best.id)) : null);
    };
    map.on("click", onClick);

    // Phase 3 details (summary / photo / status / facts), loaded once in the
    // background and indexed by id for card lookups.
    fetch("/lighthouse_details.json")
      .then((r) => r.json())
      .then((d: { details: LighthouseDetail[] }) => {
        const idx = new Map<string, LighthouseDetail>();
        for (const rec of d.details) idx.set(rec.id, rec);
        detailsRef.current = idx;
        // re-enrich the search index with status/country/score now available
        if (lighthousesRef.current.length) setSearchIndex(buildSearchIndex(lighthousesRef.current, idx));
      })
      .catch(() => { /* details optional; card falls back to OSM fields */ });

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

      <SearchBox index={searchIndex} onSelect={flyToLighthouse} />

      <div className="hud">
        <h1>Luminary</h1>
        <p className="subtitle">Lighthouses of the world</p>
        <p className="stats">
          zoom {zoom.toFixed(2)} · {mode} · {count}
        </p>
      </div>

      {selected && <DetailCard model={selected} onClose={() => setSelected(null)} />}

      <div className="fps" title="frames per second">{fps} fps</div>
    </div>
  );
}

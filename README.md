# Luminary

**Explore every lighthouse on Earth — from a globe of stars.**

🌍 **Live:** https://luminary-ruddy.vercel.app

Luminary is an interactive 3D map of all **14,804 lighthouses** in the world.
Spin a star-wrapped globe, zoom into any coastline, and watch lighthouses rise
as 3D models on the real streets where they stand. Click one to read its
history, see a photo, and learn whether it still shines today.

---

## Features

- **Star-wrapped 3D globe** — a procedurally generated starfield that moves with
  the camera, not a flat backdrop. Spin the Earth and the stars drift with it.
- **Seamless globe → street zoom** — pull in from orbit and the globe flattens
  into a real 3D street view with extruded buildings, no jarring transitions.
- **3D lighthouses, tiered for performance** — every lighthouse appears as a
  glowing point from afar; zoom to street level and the nearest ones rise into
  shared-model 3D towers. A locked **60 fps** even in the densest clusters.
- **Three states, told honestly** — lighthouses are colour-coded as
  🟢 *Operational*, 🔵 *Standing*, or 🟣 *No longer exists*. The last tier keeps
  history alive — point to the **Lighthouse of Alexandria**, gone for centuries,
  and read its story.
- **Search & fly-to** — type any lighthouse name and the map flies you there,
  detail card and all. Famous lighthouses rank first.
- **Curated detail cards** — name, history summary, photo, build year, height,
  country, and a link to the source. Where sources disagree on a figure, both
  are shown rather than guessing.

---

## How it works

| Layer | Tech |
|-------|------|
| Map engine | [MapLibre GL JS](https://maplibre.org) v5 (globe projection) |
| 3D lighthouses | Three.js custom layer + `InstancedMesh` (one shared model, ~8 draw calls for all visible towers) |
| Base map | [OpenFreeMap](https://openfreemap.org) (OSM data, no API key) |
| Frontend | Vite + React + TypeScript |
| Hosting | Vercel (static) |

### Data pipeline

Lighthouse positions come from **OpenStreetMap** (`man_made=lighthouse`, pulled
via the Overpass API). Names, histories, photos, and build facts are enriched
from **Wikidata + Wikipedia**, with a fame score (Wikipedia language-version
count) used to rank and curate the top entries.

Data quality is taken seriously:
- Summaries are kept to 1–2 sentences with a source link (no scraping of full
  articles).
- A `not_lighthouse` filter (via Wikidata `P31`) removes capes, towns, and other
  mis-tagged entities — without deleting genuine historic lighthouses.
- Conflicting heights/years from different sources are **shown side by side**,
  never silently resolved.
- Missing data is left blank rather than fabricated.

---

## Running locally

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

Data lives in `/data` (regenerate with the scripts in `/scripts`).

---

## Data sources & credits

- Lighthouse locations: © OpenStreetMap contributors
- Base map tiles: OpenFreeMap / OpenMapTiles
- Lighthouse facts, summaries & photos: Wikidata & Wikipedia / Wikimedia Commons

---

*Built with a cognitive-science lens on how people explore and make sense of
the world — one lighthouse at a time.*

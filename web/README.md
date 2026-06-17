# Luminary — web app

Vite + React 18 + TypeScript front-end for the Luminary lighthouse globe
(MapLibre GL globe projection + a self-built Three.js custom layer).

## Develop

```bash
npm install
npm run dev      # predev syncs data/ -> public/, then starts Vite
```

## Build

```bash
npm run build    # prebuild syncs data/, then tsc -b && vite build -> dist/
```

`sync-data` copies `../data/lighthouses.geojson` and `../data/lighthouse_details.json`
into `public/` (they are git-ignored there and regenerated on every build).

## Deploy (Vercel)

This package lives in the `web/` subdirectory of the repo. On Vercel:

- **Root Directory:** `web`
- **Framework Preset:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Include files outside the Root Directory:** enabled (the build reads `../data/`)

No environment variables or API keys are required — the basemap is OpenFreeMap
(key-less) and lighthouse photos are hot-linked from Wikimedia Commons.

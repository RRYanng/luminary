// Mirrors the schema in CLAUDE.md / data/lighthouses.json.
// data/ is the single source of truth — do not edit shape here without
// confirming the data contract first.
export interface Lighthouse {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  country: string | null;
  wikidata: string | null;
  wikipedia: string | null;
  height: number | null;
  start_date: string | null;
  operational: boolean | null;
}

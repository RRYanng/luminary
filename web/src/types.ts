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

export type Status = "operational" | "existing" | "gone";

// One record from data/lighthouse_details.json (Phase 3 pipeline).
export interface LighthouseDetail {
  id: string;
  category: "lighthouse" | "not_lighthouse";
  status: Status | null;
  bad_link?: boolean;
  summary: string | null;
  summary_source: string | null;
  image: string | null;
  built: string | null;
  height_m: number | null;
  country: string | null;
}

// What the detail card renders for a clicked lighthouse (base + details merged).
export interface CardModel {
  id: string;
  name: string | null;
  status: Status;
  summary: string | null;
  image: string | null;
  built: string | null;
  height: number | null;
  country: string | null;
  learnMore: string | null;
}

import type { Lighthouse } from "./types";

// "en:Pigeon Point Lighthouse" -> https://en.wikipedia.org/wiki/Pigeon_Point_Lighthouse
function wikipediaUrl(wp: string | null): string | null {
  if (!wp) return null;
  const idx = wp.indexOf(":");
  const lang = idx === -1 ? "en" : wp.slice(0, idx);
  const title = idx === -1 ? wp : wp.slice(idx + 1);
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function formatCoord(value: number, posLabel: string, negLabel: string): string {
  const hemi = value >= 0 ? posLabel : negLabel;
  return `${Math.abs(value).toFixed(4)}° ${hemi}`;
}

function operationalLabel(op: boolean | null): { text: string; cls: string } {
  if (op === true) return { text: "Operational", cls: "op-on" };
  if (op === false) return { text: "Not operational", cls: "op-off" };
  return { text: "Status unknown", cls: "op-unknown" };
}

export function DetailCard({
  lighthouse,
  onClose,
}: {
  lighthouse: Lighthouse;
  onClose: () => void;
}) {
  const url = wikipediaUrl(lighthouse.wikipedia);
  const op = operationalLabel(lighthouse.operational);

  return (
    <div className="card">
      <button className="card-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h2 className="card-name">{lighthouse.name ?? "Unnamed lighthouse"}</h2>

      <div className={`card-status ${op.cls}`}>
        <span className="dot" /> {op.text}
      </div>

      <dl className="card-fields">
        <div>
          <dt>Latitude</dt>
          <dd>{formatCoord(lighthouse.lat, "N", "S")}</dd>
        </div>
        <div>
          <dt>Longitude</dt>
          <dd>{formatCoord(lighthouse.lng, "E", "W")}</dd>
        </div>
        {lighthouse.height != null && (
          <div>
            <dt>Height</dt>
            <dd>{lighthouse.height} m</dd>
          </div>
        )}
        {lighthouse.start_date && (
          <div>
            <dt>Built</dt>
            <dd>{lighthouse.start_date}</dd>
          </div>
        )}
      </dl>

      {url && (
        <a className="card-link" href={url} target="_blank" rel="noreferrer">
          Learn more →
        </a>
      )}
    </div>
  );
}

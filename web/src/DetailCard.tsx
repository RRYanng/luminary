import { useState } from "react";
import type { CardModel, Status } from "./types";

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  operational: { label: "Operational", cls: "st-operational" },
  existing: { label: "Standing", cls: "st-existing" },
  gone: { label: "No longer exists", cls: "st-gone" },
};

export function DetailCard({ model, onClose }: { model: CardModel; onClose: () => void }) {
  const [imgOk, setImgOk] = useState(true);
  const st = STATUS_META[model.status];
  // a number from the summary that disagrees with the field — surfaced, not adjudicated.
  const facts: Array<{ k: string; v: string; note?: string }> = [];
  if (model.built)
    facts.push({
      k: "Built", v: model.built,
      note: model.yearConflict?.length
        ? `Sources differ — also cited: ${model.yearConflict.join(", ")}`
        : undefined,
    });
  if (model.height != null)
    facts.push({
      k: "Height", v: `${model.height} m`,
      note: model.heightConflict?.length
        ? `Sources differ — also cited: ${model.heightConflict.map((n) => `${n} m`).join(", ")}`
        : undefined,
    });
  if (model.country) facts.push({ k: "Country", v: model.country });

  return (
    <div className="card">
      <button className="card-close" onClick={onClose} aria-label="Close">×</button>

      {model.image && imgOk && (
        <img className="card-img" src={model.image} alt={model.name ?? "lighthouse"} loading="lazy"
          onError={() => setImgOk(false)} />
      )}

      <div className="card-body">
        <h2 className="card-name">{model.name ?? "Unnamed lighthouse"}</h2>

        <div className={`card-status ${st.cls}`}>
          <span className="dot" /> {st.label}
        </div>

        {model.summary && <p className="card-summary">{model.summary}</p>}

        {facts.length > 0 && (
          <dl className="card-fields">
            {facts.map(({ k, v, note }) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
                {note && <span className="card-conflict" title="The summary and the data source give different figures; both are shown.">{note}</span>}
              </div>
            ))}
          </dl>
        )}

        {model.learnMore && (
          <a className="card-link" href={model.learnMore} target="_blank" rel="noreferrer">
            Learn more →
          </a>
        )}
      </div>
    </div>
  );
}

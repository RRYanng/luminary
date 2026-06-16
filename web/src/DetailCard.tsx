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
  const facts: Array<[string, string]> = [];
  if (model.built) facts.push(["Built", model.built]);
  if (model.height != null) facts.push(["Height", `${model.height} m`]);
  if (model.country) facts.push(["Country", model.country]);

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
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
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

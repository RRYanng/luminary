import { useEffect, useRef, useState } from "react";
import type { CardModel, Status } from "./types";

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  operational: { label: "Operational", cls: "st-operational" },
  existing: { label: "Standing", cls: "st-existing" },
  gone: { label: "No longer exists", cls: "st-gone" },
};

const MOBILE_MQ = "(max-width: 640px)";

export function DetailCard({ model, onClose }: { model: CardModel; onClose: () => void }) {
  const [imgOk, setImgOk] = useState(true);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_MQ).matches);
  const [expanded, setExpanded] = useState(false); // mobile sheet snap state
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);

  // Reset transient state whenever a different lighthouse is shown.
  useEffect(() => {
    setImgOk(true);
    setImgLoaded(false);
    setExpanded(false);
  }, [model.id]);

  // Track the mobile breakpoint so the sheet behavior only runs on phones.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // ---- mobile bottom-sheet drag: drag the handle to expand / collapse / close
  const onDown = (e: React.PointerEvent) => {
    const el = sheetRef.current;
    if (!el) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable — drag still works */ }
    drag.current = { y: e.clientY, h: el.offsetHeight, moved: false };
    el.classList.add("dragging");
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, el = sheetRef.current;
    if (!d || !el) return;
    const dy = e.clientY - d.y;
    if (Math.abs(dy) > 4) d.moved = true;
    el.style.height = Math.min(window.innerHeight * 0.92, Math.max(64, d.h - dy)) + "px";
  };
  const onUp = () => {
    const d = drag.current, el = sheetRef.current;
    if (!d || !el) return;
    drag.current = null;
    el.classList.remove("dragging");
    const h = el.offsetHeight, vh = window.innerHeight;
    el.style.height = ""; // hand height back to the CSS snap class (animates)
    if (!d.moved) { setExpanded((v) => !v); return; } // tap toggles peek/expanded
    if (h < vh * 0.3) { onClose(); return; }          // dragged down -> close
    setExpanded(h > vh * 0.66);                        // snap to nearest
  };

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

  const cls = `card${mobile ? " sheet" : ""}${mobile && expanded ? " expanded" : ""}`;

  return (
    <div className={cls} ref={sheetRef}>
      {mobile && (
        <div className="card-handle" aria-label="Drag to resize"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      )}
      <button className="card-close" onClick={onClose} aria-label="Close">×</button>

      {model.image && imgOk && (
        <div className="card-img-wrap">
          {!imgLoaded && (
            <svg className="card-img-ph" viewBox="0 0 48 64" aria-hidden="true">
              <g fill="rgba(255,210,122,0.2)">
                <rect x="19" y="9" width="10" height="9" rx="1.5" />
                <path d="M18 9 L24 3 L30 9 Z" />
                <path d="M20 18 h8 l3 33 h-14 z" />
                <rect x="16" y="50" width="16" height="4" rx="1" />
              </g>
            </svg>
          )}
          <img className="card-img" src={model.image} alt={model.name ?? "lighthouse"} loading="lazy"
            style={{ opacity: imgLoaded ? 1 : 0 }}
            onLoad={() => setImgLoaded(true)} onError={() => setImgOk(false)} />
        </div>
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

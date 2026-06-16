import { useMemo, useState } from "react";
import type { SearchItem, Status } from "./types";

const DOT: Record<Status, string> = {
  operational: "st-operational",
  existing: "st-existing",
  gone: "st-gone",
};

// Name search over the (named) lighthouses. Substring match, famous-first by
// Phase 3 score. ~8k items -> filtering on each keystroke is sub-millisecond.
export function SearchBox({ index, onSelect }: { index: SearchItem[]; onSelect: (it: SearchItem) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const hits = index.filter((it) => it.lower.includes(s));
    // famous first; then prefer shorter names (closer match), then alphabetical
    hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return hits.slice(0, 25);
  }, [q, index]);

  const choose = (it: SearchItem) => {
    onSelect(it);
    setQ("");
    setOpen(false);
  };

  return (
    <div className="search">
      <input
        className="search-input"
        value={q}
        placeholder="Search lighthouses…"
        spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) choose(results[0]);
          else if (e.key === "Escape") { setQ(""); e.currentTarget.blur(); }
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((it) => (
            // onMouseDown (not click) + preventDefault so the input doesn't blur
            // and hide the list before the selection registers.
            <li key={it.id} onMouseDown={(e) => { e.preventDefault(); choose(it); }}>
              <span className={`search-dot ${DOT[it.status]}`} />
              <span className="search-name">{it.name}</span>
              {it.country && <span className="search-country">{it.country}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

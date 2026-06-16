#!/usr/bin/env python3
"""
Luminary Phase 3 (step 1) — 灯塔详情数据管线

读取 data/lighthouses.json，对有 wikidata 或 wikipedia 的灯塔（约 3,849 座），
从 Wikidata + Wikipedia 批量拉取：建成年份、高度、国家、1-2 句维基摘要、
代表图片 URL，并按"知名度分数"(Wikipedia 语言版本数代理) 排序标出 Top 200。

输出 data/lighthouse_details.json（新文件，不动现有数据）。

版权红线：摘要只取前 1-2 句、限长，并始终保存原文链接(summary_source)。
绝不整段照搬维基正文。

用法:
  python scripts/fetch_details.py --sample      # 先用少量著名灯塔测试跑通
  python scripts/fetch_details.py               # 全量（约 3-5 分钟，含限速）
  python scripts/fetch_details.py --limit 50    # 只跑前 50 座（调试）

依赖: pip install requests
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

import requests

# ---------------------------------------------------------------- 配置
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SRC = DATA_DIR / "lighthouses.json"

WD_API = "https://www.wikidata.org/w/api.php"
WD_BATCH = 50          # wbgetentities 单次最多 50 个实体
WP_BATCH = 20          # action=query 单次最多 ~20 个 extract
REQUEST_GAP = 0.6      # 公共 API，请求间最小间隔（秒）
MAX_RETRIES = 4
TIMEOUT = 60
TOP_N = 200

# Wikimedia 要求带可识别的 User-Agent（含联系方式），否则会被封。
USER_AGENT = "Luminary/0.1 (lighthouse explorer; Phase 3 details pipeline; ruiyiyanng@gmail.com)"

# sitelink key 里以 "wiki" 结尾但不是 Wikipedia 语言版的，排除掉
_NON_WP_WIKIS = {
    "commonswiki", "specieswiki", "metawiki", "wikidatawiki", "mediawikiwiki",
    "sourceswiki", "foundationwiki", "outreachwiki", "incubatorwiki", "donatewiki",
}
_OTHER_PROJECT_SUFFIXES = ("wikisource", "wikiquote", "wikinews", "wikivoyage",
                           "wikibooks", "wikiversity", "wiktionary")

# 著名灯塔（用于 --sample 快速验证数据质量），按 name 子串(忽略大小写)匹配
SAMPLE_FRAGMENTS = [
    "tower of hercules", "pigeon point", "cape hatteras", "portland head",
    "bishop rock", "eddystone", "bell rock", "fastnet", "peggy", "les éclaireurs",
    "split point", "cape byron", "slangkop", "lindau", "jeddah",
]

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


# ---------------------------------------------------------------- HTTP
def api_get(url: str, params: dict) -> dict:
    """带退避重试的 GET JSON，尊重 429/503 的 Retry-After。"""
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = session.get(url, params=params, timeout=TIMEOUT)
            if resp.status_code in (429, 503):
                wait = int(resp.headers.get("Retry-After", "0") or 0) or REQUEST_GAP * (2 ** attempt)
                print(f"    限速 {resp.status_code}，{wait:.0f}s 后重试")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except Exception as e:  # noqa: BLE001
            last_err = e
            wait = REQUEST_GAP * (2 ** attempt)
            print(f"    请求失败 ({e})，{wait:.0f}s 后重试")
            time.sleep(wait)
    raise RuntimeError(f"{url} 在 {MAX_RETRIES} 次尝试后失败: {last_err}")


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------- 解析
def parse_year(claims: dict):
    try:
        t = claims["P571"][0]["mainsnak"]["datavalue"]["value"]["time"]
        m = re.match(r"^[+\-](\d{1,4})", t)
        return m.group(1).lstrip("0") or m.group(1) if m else None
    except (KeyError, IndexError, TypeError):
        return None


def parse_height(claims: dict):
    try:
        v = claims["P2048"][0]["mainsnak"]["datavalue"]["value"]
        amount = float(v["amount"])
        if str(v.get("unit", "")).endswith("Q3710"):  # foot -> metre
            amount *= 0.3048
        return round(amount, 1)
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def parse_entity_id(claims: dict, prop: str):
    try:
        return claims[prop][0]["mainsnak"]["datavalue"]["value"]["id"]
    except (KeyError, IndexError, TypeError):
        return None


def parse_image_url(claims: dict):
    try:
        fname = claims["P18"][0]["mainsnak"]["datavalue"]["value"]
        return "https://commons.wikimedia.org/wiki/Special:FilePath/" + urllib.parse.quote(fname.replace(" ", "_"))
    except (KeyError, IndexError, TypeError):
        return None


def wikipedia_sitelinks(sitelinks: dict):
    """返回 (Wikipedia 语言版数量, 选定的 (lang, title)) ，优先英文。"""
    langs = {}
    for key, info in sitelinks.items():
        if not key.endswith("wiki") or key in _NON_WP_WIKIS:
            continue
        if key.endswith(_OTHER_PROJECT_SUFFIXES):
            continue
        lang = key[: -len("wiki")]
        langs[lang] = info.get("title")
    page = None
    if "en" in langs:
        page = ("en", langs["en"])
    elif langs:
        lang = sorted(langs)[0]
        page = (lang, langs[lang])
    return len(langs), page


def trim_summary(text: str, max_sentences: int = 2, max_chars: int = 280) -> str:
    """版权红线：只取前 1-2 句并限长，绝不整段照搬。"""
    text = re.sub(r"\s+", " ", (text or "")).strip()
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?。！？])\s+", text)
    out = " ".join(parts[:max_sentences]).strip()
    if len(out) > max_chars:
        out = out[:max_chars].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return out


def wiki_domain(lang: str) -> str:
    return f"https://{lang.replace('_', '-')}.wikipedia.org"


# ---------------------------------------------------------------- Wikidata
def fetch_wikidata(qids: list) -> dict:
    out = {}
    batches = list(chunks(qids, WD_BATCH))
    for bi, batch in enumerate(batches):
        print(f"  Wikidata 批 {bi + 1}/{len(batches)} ({len(batch)} 个)")
        data = api_get(WD_API, {
            "action": "wbgetentities", "ids": "|".join(batch),
            "props": "claims|sitelinks", "languages": "en", "format": "json",
        })
        for qid, ent in data.get("entities", {}).items():
            if "missing" in ent:
                continue
            claims = ent.get("claims", {})
            lang_count, page = wikipedia_sitelinks(ent.get("sitelinks", {}))
            out[qid] = {
                "built": parse_year(claims),
                "height_m": parse_height(claims),
                "country_q": parse_entity_id(claims, "P17"),
                "image": parse_image_url(claims),
                "wd_lang_count": lang_count,
                "wd_page": page,  # (lang, title) or None
            }
        time.sleep(REQUEST_GAP)
    return out


def fetch_country_labels(qids: list) -> dict:
    labels = {}
    uniq = sorted({q for q in qids if q})
    batches = list(chunks(uniq, WD_BATCH))
    for bi, batch in enumerate(batches):
        print(f"  国家标签批 {bi + 1}/{len(batches)}")
        data = api_get(WD_API, {
            "action": "wbgetentities", "ids": "|".join(batch),
            "props": "labels", "languages": "en", "format": "json",
        })
        for qid, ent in data.get("entities", {}).items():
            try:
                labels[qid] = ent["labels"]["en"]["value"]
            except (KeyError, TypeError):
                pass
        time.sleep(REQUEST_GAP)
    return labels


# ---------------------------------------------------------------- Wikipedia
def _norm_title(t: str) -> str:
    return (t or "").replace("_", " ").strip().lower()


def fetch_wikipedia(by_lang: dict) -> dict:
    """by_lang: {lang: [(title, key)]}  ->  {key: {summary,image,source,langlinks,wikidata}}"""
    result = {}
    for lang, items in by_lang.items():
        domain = wiki_domain(lang)
        # key 索引：归一化标题 -> key
        for batch in chunks(items, WP_BATCH):
            titles = [t for t, _ in batch]
            key_by_title = {_norm_title(t): k for t, k in batch}
            data = api_get(domain + "/w/api.php", {
                "action": "query", "format": "json", "redirects": 1,
                "prop": "extracts|pageimages|langlinks|pageprops",
                "exsentences": 2, "explaintext": 1, "exintro": 1,
                "piprop": "original|thumbnail", "pithumbsize": 800,
                "lllimit": 500, "ppprop": "wikibase_item",
                "titles": "|".join(titles),
            })
            q = data.get("query", {})
            # 跟随 normalized / redirects 把请求标题映射到最终页面标题
            chain = {}
            for n in q.get("normalized", []):
                chain[_norm_title(n["from"])] = _norm_title(n["to"])
            for r in q.get("redirects", []):
                chain[_norm_title(r["from"])] = _norm_title(r["to"])

            def resolve(t):
                seen = set()
                cur = _norm_title(t)
                while cur in chain and cur not in seen:
                    seen.add(cur)
                    cur = chain[cur]
                return cur

            page_by_title = {}
            for page in q.get("pages", {}).values():
                if "missing" in page:
                    continue
                page_by_title[_norm_title(page.get("title", ""))] = page

            for title, key in batch:
                page = page_by_title.get(resolve(title))
                if not page:
                    continue
                img = None
                if page.get("original"):
                    img = page["original"].get("source")
                elif page.get("thumbnail"):
                    img = page["thumbnail"].get("source")
                final_title = page.get("title", title)
                result[key] = {
                    "summary": trim_summary(page.get("extract", "")),
                    "image": img,
                    "source": f"{domain}/wiki/" + urllib.parse.quote(final_title.replace(" ", "_")),
                    "langlinks": len(page.get("langlinks", [])),
                    "wikidata": (page.get("pageprops", {}) or {}).get("wikibase_item"),
                }
            time.sleep(REQUEST_GAP)
    return result


# ---------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser(description="Luminary Phase 3 详情拉取")
    ap.add_argument("--sample", action="store_true", help="只跑著名灯塔样本，验证跑通")
    ap.add_argument("--limit", type=int, default=None, help="只跑前 N 座（调试）")
    ap.add_argument("--out", type=str, default=None, help="输出文件路径")
    args = ap.parse_args()

    lighthouses = json.loads(SRC.read_text(encoding="utf-8"))
    cands = [r for r in lighthouses if r.get("wikidata") or r.get("wikipedia")]

    if args.sample:
        frags = SAMPLE_FRAGMENTS
        cands = [r for r in cands if r.get("name") and any(f in r["name"].lower() for f in frags)]
        print(f"样本模式：匹配到 {len(cands)} 座著名灯塔")
        for r in cands:
            print(f"  · {r['name']}  ({r.get('wikidata')}, {r.get('wikipedia')})")
    if args.limit:
        cands = cands[: args.limit]

    out_path = Path(args.out) if args.out else (
        DATA_DIR / ("lighthouse_details.sample.json" if (args.sample or args.limit) else "lighthouse_details.json"))

    print(f"\n候选灯塔: {len(cands)} 座\n")

    # --- Wikidata: 事实 + 图片 + 语言版数 + 备用维基页 ---
    qids = sorted({r["wikidata"] for r in cands if r.get("wikidata")})
    print(f"[1/3] 拉 Wikidata（{len(qids)} 个实体）")
    wd = fetch_wikidata(qids)

    country_qs = [v["country_q"] for v in wd.values() if v.get("country_q")]
    print(f"\n[2/3] 解析国家标签（{len(set(country_qs))} 个国家）")
    country_labels = fetch_country_labels(country_qs)

    # --- 选定每座灯塔的维基页 (lang, title)：优先 wikipedia 字段，其次 Wikidata sitelink ---
    by_lang = {}
    for idx, r in enumerate(cands):
        wp_field = None
        if r.get("wikipedia") and ":" in r["wikipedia"]:
            lang, title = r["wikipedia"].split(":", 1)
            wp_field = (lang.strip(), title.strip())
        wd_page = wd.get(r.get("wikidata") or "", {}).get("wd_page")  # English-preferred
        # English-first (project rule): use enwiki when the entity has one,
        # else the OSM-tagged wiki, else any other language edition.
        if wd_page and wd_page[0] == "en":
            page = wd_page
        elif wp_field:
            page = wp_field
        else:
            page = wd_page
        if page:
            by_lang.setdefault(page[0], []).append((page[1], idx))

    total_pages = sum(len(v) for v in by_lang.values())
    print(f"\n[3/3] 拉 Wikipedia 摘要（{total_pages} 页，{len(by_lang)} 种语言，每条仅取 1-2 句）")
    wp = fetch_wikipedia(by_lang)

    # --- 合并 ---
    details = []
    for idx, r in enumerate(cands):
        w = wd.get(r.get("wikidata") or "", {})
        p = wp.get(idx, {})
        lang_count = max(w.get("wd_lang_count", 0), (p.get("langlinks", 0) + 1) if p else 0)
        image = (p.get("image") or w.get("image"))
        rec = {
            "id": r["id"],
            "name": r.get("name"),
            "wikidata": r.get("wikidata") or p.get("wikidata"),
            "wikipedia": r.get("wikipedia"),
            "built": w.get("built") or r.get("start_date"),
            "height_m": w.get("height_m") if w.get("height_m") is not None else r.get("height"),
            "country": country_labels.get(w.get("country_q")) if w.get("country_q") else r.get("country"),
            "summary": p.get("summary") or None,
            "summary_source": p.get("source"),
            "image": image,
            "lang_count": lang_count,
            "score": lang_count,
        }
        details.append(rec)

    details.sort(key=lambda d: (d["score"], 1 if d["summary"] else 0), reverse=True)
    for rank, d in enumerate(details[:TOP_N], start=1):
        d["top200_rank"] = rank

    with_summary = sum(1 for d in details if d["summary"])
    with_photo = sum(1 for d in details if d["image"])
    with_facts = sum(1 for d in details if d["built"] or d["height_m"] or d["country"])

    payload = {
        "source": "Wikidata + Wikipedia",
        "license_note": "summary 为 1-2 句摘录，完整正文见 summary_source（Wikipedia, CC BY-SA）。图片版权见 Commons 来源页。",
        "total_candidates": len(cands),
        "with_summary": with_summary,
        "with_photo": with_photo,
        "with_facts": with_facts,
        "top_n": min(TOP_N, len(details)),
        "details": details,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # --- 汇总 ---
    print("\n========== Phase 3 详情拉取汇总 ==========")
    print(f"候选灯塔:        {len(cands):>5}")
    print(f"有摘要:          {with_summary:>5}  ({with_summary / max(len(cands),1):.0%})")
    print(f"有照片:          {with_photo:>5}  ({with_photo / max(len(cands),1):.0%})")
    print(f"有事实(年/高/国): {with_facts:>5}  ({with_facts / max(len(cands),1):.0%})")
    print(f"输出: {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")
    n_prev = min(20 if not (args.sample or args.limit) else len(details), len(details))
    print(f"\n--- Top {n_prev} 预览（按知名度分数）---")
    for d in details[:n_prev]:
        photo = "📷" if d["image"] else "  "
        print(f"  {d.get('top200_rank', '·'):>3}. [{d['score']:>2}langs] {photo} {d['name'] or '(无名)'}"
              f"  — {d['country'] or '?'}, {d['built'] or '?'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

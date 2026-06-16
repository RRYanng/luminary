#!/usr/bin/env python3
"""
Luminary Phase 3 (step 2) — 灯塔分类（不是过滤）

用 Wikidata P31(instance of) + P576(拆除/废止日期) 给 lighthouse_details.json 里
的灯塔分类，而不是删除：

  category = "not_lighthouse"  根本不是灯塔的错挂（海岬/城镇/纯地理实体）
  category = "lighthouse" 且 status ∈ {
     "operational"   在役（OSM operational=true）
     "existing"      现存（停用或状态未知）
     "gone"          已不存在 / 历史遗迹（保留并专门标记，最有历史价值）
  }

"已不存在"只在强信号下判定（P576 拆除日期，或 P31 含 former/ruins/archaeological/
ancient 类），保守优先——分不准宁可归 "existing"，不把还在的误判成消失。

用法:
  python scripts/classify_lighthouses.py --fetch     # 拉 P31/P576 到本地缓存
  python scripts/classify_lighthouses.py             # 分类 + 报告（dry-run，不写）
  python scripts/classify_lighthouses.py --write      # 把分类写回 details 文件
"""

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DETAILS = DATA_DIR / "lighthouse_details.json"
SRC = DATA_DIR / "lighthouses.json"
CACHE = DATA_DIR / "_class_cache.json"  # gitignored

WD_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "Luminary/0.1 (lighthouse explorer; Phase 3 classify; ruiyiyanng@gmail.com)"
BATCH = 50
GAP = 0.6
MAX_RETRIES = 4

# class-label keyword signals (matched against P31 English labels, lowercased),
# tuned to the actual P31 classes present in this dataset (120 distinct).
# Any navigational-light class counts as a lighthouse: lighthouse, sector light,
# leading lights, light station, beacon, upper/lower light, etc.
LIGHTHOUSE_KW = ("light", "beacon", "leuchtturm")
# "gone" only on strong signals (P576 handled separately). Note: NO "ancient"
# (Tower of Hercules is an ancient monument but still standing).
GONE_KW = ("ruin", "destroyed", "demolished", "former", "razed")
# clear geographic-feature / settlement classes — used on the entity's OWN P31
# to detect "this isn't a lighthouse at all" (Cape Horn = cape, etc.).
NONLH_KW = ("cape", "headland", "promontor", "peninsula", "island", "islet", "bay",
            "reef", "settlement", "strait", "fjord", "point", "town", "village")
# stricter set, used on the *article* entity when its id differs from the
# lighthouse, to flag a wrong-article mislink (South Shields = town). Excludes
# island/reef/etc. on purpose: small-island articles usually cover the lighthouse.
BADLINK_PLACE_KW = ("town", "city", "village", "parish", "hamlet", "municipality",
                    "settlement", "borough", "commune", "unparished", "cape",
                    "headland", "promontor", "suburb", "locality")

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def api_get(params: dict) -> dict:
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            r = session.get(WD_API, params=params, timeout=60)
            if r.status_code in (429, 503):
                wait = int(r.headers.get("Retry-After", "0") or 0) or GAP * (2 ** attempt)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(GAP * (2 ** attempt))
    raise RuntimeError(f"failed after {MAX_RETRIES}: {last}")


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _entities_claims(qids, want_p576):
    """batch wbgetentities -> {qid: {p31:[...], demolished:bool}} + set of P31 ids."""
    out, p31_ids = {}, set()
    batches = list(chunks(qids, BATCH))
    for bi, batch in enumerate(batches):
        print(f"  批 {bi + 1}/{len(batches)}")
        data = api_get({"action": "wbgetentities", "ids": "|".join(batch),
                        "props": "claims", "format": "json"})
        for qid, ent in data.get("entities", {}).items():
            if "missing" in ent:
                continue
            claims = ent.get("claims", {})
            p31 = []
            for c in claims.get("P31", []):
                try:
                    p31.append(c["mainsnak"]["datavalue"]["value"]["id"])
                except (KeyError, TypeError):
                    pass
            rec = {"p31": p31}
            if want_p576:
                rec["demolished"] = "P576" in claims
            out[qid] = rec
            p31_ids.update(p31)
        time.sleep(GAP)
    return out, p31_ids


def do_fetch():
    details = json.loads(DETAILS.read_text(encoding="utf-8"))["details"]
    qids = sorted({d["wikidata"] for d in details if d.get("wikidata")})
    print(f"拉取 {len(qids)} 个灯塔实体的 P31 / P576 …")
    ents, p31_ids = _entities_claims(qids, want_p576=True)

    # also fetch P31 of the summary's article entity, but only where it differs
    # from the lighthouse — to tell true mislinks (article is a town/cape) from
    # harmless sibling items (article is the lighthouse under a related id).
    page_qids = sorted({d["summary_wikidata"] for d in details
                        if d.get("summary_wikidata") and d["summary_wikidata"] != d.get("wikidata")})
    print(f"拉取 {len(page_qids)} 个摘要文章实体的 P31 …")
    page_ents, page_p31_ids = _entities_claims(page_qids, want_p576=False)
    p31_ids |= page_p31_ids

    print(f"解析 {len(p31_ids)} 个 P31 类别的标签 …")
    labels = {}
    for bi, batch in enumerate(chunks(sorted(p31_ids), BATCH)):
        data = api_get({"action": "wbgetentities", "ids": "|".join(batch),
                        "props": "labels", "languages": "en", "format": "json"})
        for qid, ent in data.get("entities", {}).items():
            try:
                labels[qid] = ent["labels"]["en"]["value"]
            except (KeyError, TypeError):
                labels[qid] = qid
        time.sleep(GAP)

    CACHE.write_text(json.dumps({"entities": ents, "page_entities": page_ents, "labels": labels},
                                ensure_ascii=False), encoding="utf-8")
    print(f"已缓存 -> {CACHE}")


def classify(write: bool):
    if not CACHE.exists():
        print("缺少缓存，请先运行 --fetch")
        return 1
    cache = json.loads(CACHE.read_text(encoding="utf-8"))
    ents, labels = cache["entities"], cache["labels"]
    page_ents = cache.get("page_entities", {})
    payload = json.loads(DETAILS.read_text(encoding="utf-8"))
    details = payload["details"]
    operational = {r["id"]: r.get("operational") for r in json.loads(SRC.read_text(encoding="utf-8"))}

    def has_kw(p31, kws):
        for q in p31:
            lab = labels.get(q, "").lower()
            if any(k in lab for k in kws):
                return True
        return False

    cnt = Counter()
    gone_list, notlh_list, badlink_list = [], [], []
    examples = {"operational": [], "existing": [], "gone": []}

    for d in details:
        q = d.get("wikidata")
        ent = ents.get(q) if q else None
        p31 = ent["p31"] if ent else []
        is_lh = has_kw(p31, LIGHTHOUSE_KW)
        gone_sig = (ent and ent["demolished"]) or has_kw(p31, GONE_KW)
        nonlh = (not is_lh) and has_kw(p31, NONLH_KW)
        # the linked Wikipedia article is about a different entity. Only a true
        # mislink if that entity is itself a settlement/feature (South Shields ->
        # town); a differing id whose article entity is still a lighthouse/rock
        # is a harmless sibling item (e.g. Skerryvore) — keep its summary.
        sw = d.get("summary_wikidata")
        mismatch = False
        if q and sw and sw != q:
            page_p31 = page_ents.get(sw, {}).get("p31", [])
            page_is_lh = has_kw(page_p31, LIGHTHOUSE_KW)
            page_is_place = has_kw(page_p31, BADLINK_PLACE_KW)
            mismatch = page_is_place and not page_is_lh

        d["bad_link"] = False
        if nonlh:
            d["category"] = "not_lighthouse"
            d["reason"] = "p31_feature"  # Wikidata entity itself is a cape/island/town
            d["status"] = None
            d["top200_rank"] = None
            cnt["not_lighthouse"] += 1
            notlh_list.append(d)
            continue

        d["category"] = "lighthouse"
        if mismatch:
            # real lighthouse (P31), but the article we pulled is the wrong subject.
            # keep the Wikidata facts; drop the off-topic summary/image and fix score.
            d["bad_link"] = True
            d["summary"] = None
            d["summary_source"] = None
            d["image"] = None
            d["score"] = d.get("wd_lang_count", 0)
            d["lang_count"] = d.get("wd_lang_count", 0)
            badlink_list.append(d)

        if gone_sig:
            d["status"] = "gone"
            gone_list.append(d)
        elif operational.get(d["id"]) is True:
            d["status"] = "operational"
        else:
            d["status"] = "existing"
        cnt[d["status"]] += 1
        if not d["bad_link"] and len(examples[d["status"]]) < 6:
            examples[d["status"]].append(d)

    # entities with no wikidata can't be P31-classified -> default by OSM status
    no_wd = [d for d in details if not d.get("wikidata")]

    # Re-rank Top 200 among genuine lighthouses that have usable content
    # (gone ones are eligible — they're valid historical lighthouses).
    for d in details:
        d["top200_rank"] = None
    eligible = [d for d in details if d["category"] == "lighthouse" and not d["bad_link"] and d["summary"]]
    eligible.sort(key=lambda x: x["score"], reverse=True)
    for rank, d in enumerate(eligible[:200], start=1):
        d["top200_rank"] = rank

    if write:
        details.sort(key=lambda d: (d.get("score") or 0), reverse=True)
        payload["categorized"] = True
        payload["category_counts"] = dict(cnt)
        payload["not_lighthouse"] = len(notlh_list)
        payload["bad_link"] = len(badlink_list)
        DETAILS.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---------------- report ----------------
    def line(d):
        why = []
        ent = ents.get(d.get("wikidata") or "")
        if ent and ent["demolished"]:
            why.append("P576拆除日期")
        if ent and has_kw(ent["p31"], GONE_KW):
            cls = [labels.get(q, q) for q in ent["p31"] if any(k in labels.get(q, "").lower() for k in GONE_KW)]
            why.append("类别:" + "/".join(cls))
        return f"  · {d['name'] or '(无名)'}  [{d['wikidata']}] langs={d['lang_count']}  ← {', '.join(why) or '?'}"

    def nl_line(d):
        ent = ents.get(d.get("wikidata") or "")
        cls = [labels.get(q, q) for q in (ent["p31"] if ent else [])]
        return f"  · {d['name'] or '(无名)'}  [{d['wikidata']}]  P31={cls}"

    print("\n========== 分类结果 ==========")
    print(f"真灯塔(category=lighthouse): {cnt['operational'] + cnt['existing'] + cnt['gone']}")
    print(f"  在役 operational : {cnt['operational']}")
    print(f"  现存 existing    : {cnt['existing']}  (停用或状态未知)")
    print(f"  已不存在 gone    : {cnt['gone']}  (保留并标记，历史价值)")
    print(f"非灯塔错挂 not_lighthouse: {cnt['not_lighthouse']}  (P31 是海岬/城镇/岛等)")
    print(f"维基链接错挂 bad_link    : {len(badlink_list)}  (P31 是灯塔，但摘要文章是别的主题→已丢弃摘要)")
    print(f"无 wikidata 无法按 P31 分类: {len(no_wd)} 座")

    print(f"\n--- 已不存在 gone 全表（{len(gone_list)} 座，请核对准确性）---")
    for d in sorted(gone_list, key=lambda x: -(x.get('lang_count') or 0)):
        print(line(d))

    print(f"\n--- 非灯塔错挂 not_lighthouse（{len(notlh_list)} 座，P31 本身就不是灯塔）---")
    for d in sorted(notlh_list, key=lambda x: -(x.get('lang_count') or 0)):
        print(nl_line(d))

    print(f"\n--- 维基链接错挂 bad_link（{len(badlink_list)} 座，灯塔但文章挂错）---")
    for d in sorted(badlink_list, key=lambda x: -(x.get('wd_lang_count') or 0)):
        sw = d.get("summary_wikidata")
        print(f"  · {d['name'] or '(无名)'}  [{d['wikidata']}] ← 文章实体 {sw}（非本灯塔）")

    top = sorted([d for d in details if d.get("top200_rank")], key=lambda x: x["top200_rank"])
    print(f"\n--- 清洗后 Top 200 预览（前 15，已排除错挂）---")
    for d in top[:15]:
        tag = "🏛已不存在" if d["status"] == "gone" else ("🟢在役" if d["status"] == "operational" else "现存")
        print(f"  {d['top200_rank']:>3}. [{d['score']:>2}] {tag}  {d['name'] or '(无名)'} — {d['country'] or '?'}, {d['built'] or '?'}")

    print("\n--- 在役 operational 样例 ---")
    for d in examples["operational"]:
        print(f"  · {d['name']} — {d['country']}, {d['built']}")
    print("--- 现存 existing 样例 ---")
    for d in examples["existing"]:
        print(f"  · {d['name']} — {d['country']}, {d['built']}")
    if write:
        print(f"\n已写回 {DETAILS}")
    else:
        print("\n(dry-run，未写文件；确认无误后加 --write)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="拉 P31/P576 到缓存")
    ap.add_argument("--write", action="store_true", help="把分类写回 details 文件")
    args = ap.parse_args()
    if args.fetch:
        do_fetch()
        return 0
    return classify(write=args.write)


if __name__ == "__main__":
    sys.exit(main())

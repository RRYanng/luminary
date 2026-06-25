#!/usr/bin/env python3
"""
Luminary Phase 3 — 详情修正（基于自动核查清单，只动「确定的改进」）

在 fetch_details + classify 之后跑，对 data/lighthouse_details.json 做后处理：

  1) 摘要清洗      : 去掉维基残留的零宽字符/引用上标残渣，重新判定结尾，
                     修掉一批「像被截断」的假阳性（如 Faro de Melilla）。
  2) 补缺失字段    : 仅当权威源(Wikidata)确实有值时才补；查不到就如实留空，
                     绝不编造（如 Jeddah 有 P2048/P17 → 补；Ryvingen/Pedra 无 → 留空）。
  3) 高度可疑标记  : OSM height 把「海拔/焦距」当成塔高、或源数据明显离谱(<2m)的，
                     打 height_suspect 标记 + 说明；前端不再把这种值当塔高展示。
  4) 来源不一标注  : 摘要里的「塔高 / 建成年」与字段值对不上 → 不裁定谁对，
                     把两个值都存进 height_conflict / year_conflict，前端并列显示
                     「来源说法不一」。只在英文摘要上做（能可靠区分距离/海拔/焦距）。
  5) 古代纪元修正  : 重新拉古代灯塔(建成年<600)的 P571，按正负号正确标注纪元
                     (公元前 → 'c. 280 BC'；世纪精度/极早 AD → 'c. 100 AD')。
                     根因已在 fetch_details.parse_year 修好；本步把现有数据补正。

诚实边界：本脚本不裁定真实世界数值。冲突一律两值并存交给用户判断。
data/ 由脚本生成：本脚本可重复运行(幂等)。

用法:
  python scripts/fix_details.py            # 应用修正并写回 lighthouse_details.json
  python scripts/fix_details.py --dry-run  # 只打印将做的改动，不写文件
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests

# era-aware build-year parser (BC/AD); shared with the pipeline so logic can't drift
from fetch_details import parse_year as era_year

ROOT = Path(__file__).resolve().parent.parent
DETAILS = ROOT / "data" / "lighthouse_details.json"

WD_API = "https://www.wikidata.org/w/api.php"
UA = "Luminary/0.1 (lighthouse explorer; detail fix; ruiyiyanng@gmail.com)"

session = requests.Session()
session.headers["User-Agent"] = UA


def _lead_year(v):
    """Leading 1-4 digit run of a build-year string, e.g. '279'->279, '1 July 1898'->1."""
    m = re.match(r"^\d{1,4}", str(v or ""))
    return int(m.group(0)) if m else None


def fetch_claims(qids):
    """Raw Wikidata claims for a handful of entities (for era-aware P571 re-parse)."""
    out = {}
    for i in range(0, len(qids), 50):
        batch = qids[i:i + 50]
        d = session.get(WD_API, params={
            "action": "wbgetentities", "ids": "|".join(batch),
            "props": "claims", "format": "json"}, timeout=60).json()
        for q, e in d.get("entities", {}).items():
            out[q] = e.get("claims", {})
        time.sleep(0.6)
    return out

# 零宽 / 不可见字符（维基引用上标常残留这些）
_INVISIBLE = re.compile(r"[​‌‍‎‏﻿ ⁠]")

# ---- 高度抽取：上下文感知（区分「塔高」与 距离/海拔/焦距） -------------------
# 数字附近若出现「距离/方位」或「海拔/焦距/悬崖」词，则不是塔身结构高度，跳过。
_DIST = re.compile(
    r"\b(from|off|away|offshore|north|south|east|west|northeast|northwest|"
    r"southeast|southwest|located|situated|placed|long|stands?|miles?|km|kilom)\b",
    re.I,
)
_FOCAL = re.compile(
    r"(focal|above (?:mean )?sea|above the sea|sea level|elevation|altitude|"
    r"perched|escarpment|\bcliff|\bridge|atop|on a hill)",
    re.I,
)
_EN_STOPWORDS = (" the ", " is ", " was ", " of ", " a ", " and ", " in ", " on ",
                 " with ", " by ", " at ", " an ", " are ", " its ")
_BUILD_KW = (r"(?:built|constructed|completed|erected|establish\w*|first lit|"
             r"inaugurat\w*|dates from|opened|rebuilt)")


def clean_summary(text):
    """去零宽/不可见字符并归一空白。不改动句子内容，只清残渣。"""
    if not text:
        return text
    t = _INVISIBLE.sub("", text)
    t = re.sub(r"\s+", " ", t).strip()
    # 末尾遗留的孤立引用括注 / 标点残渣
    t = re.sub(r"\s*[\[\(]\s*[\]\)]\s*$", "", t).strip()
    return t


def is_english(s):
    low = " " + (s or "").lower() + " "
    return sum(1 for w in _EN_STOPWORDS if w in low) >= 2


def structural_heights(text):
    """抽出疑似「塔身结构高度」(米)。距离/海拔/焦距上下文一律排除。"""
    out = []
    for m in re.finditer(r"(\d{1,4}(?:\.\d+)?)\s*(?:m\b|met(?:er|re)s?\b)", text):
        win = text[max(0, m.start() - 42): m.end() + 20]
        if _DIST.search(win) or _FOCAL.search(win):
            continue
        out.append(round(float(m.group(1)), 1))
    for m in re.finditer(r"(\d{1,4}(?:\.\d+)?)\s*(?:ft\b|feet\b|foot\b)", text):
        win = text[max(0, m.start() - 42): m.end() + 20]
        if _DIST.search(win) or _FOCAL.search(win):
            continue
        out.append(round(float(m.group(1)) * 0.3048, 1))
    return out


def build_years_in_summary(text):
    yrs = []
    for m in re.finditer(_BUILD_KW + r"[^.]{0,40}?\b(1\d{3}|20\d{2})\b", text, re.I):
        yrs.append(int(m.group(1)))
    return yrs


def collapse_near(vals, rel=0.05):
    """合并彼此相近(单位换算的同一数值，如 100m 与 330ft=100.6m)，每组留一个。"""
    out = []
    for v in sorted(set(vals)):
        if not any(abs(v - k) <= max(1.0, k * rel) for k in out):
            out.append(round(v, 1))
    return out


def year_int(built):
    if not built:
        return None
    m = re.match(r"^(\d{3,4})", str(built))
    return int(m.group(1)) if m else None


# ---- 仅当 Wikidata 确有值才补缺 ---------------------------------------------
def fetch_wd_fields(qids):
    if not qids:
        return {}
    out = {}
    d = session.get(WD_API, params={
        "action": "wbgetentities", "ids": "|".join(qids),
        "props": "claims", "format": "json"}, timeout=60).json()
    cqs = set()
    for q, e in d.get("entities", {}).items():
        cl = e.get("claims", {})
        rec = {}
        try:
            t = cl["P571"][0]["mainsnak"]["datavalue"]["value"]["time"]
            rec["built"] = re.match(r"^[+\-](\d+)", t).group(1).lstrip("0") or None
        except (KeyError, IndexError, TypeError, AttributeError):
            pass
        try:
            v = cl["P2048"][0]["mainsnak"]["datavalue"]["value"]
            amt = float(v["amount"])
            if str(v.get("unit", "")).endswith("Q3710"):
                amt *= 0.3048
            rec["height_m"] = round(amt, 1)
        except (KeyError, IndexError, TypeError, ValueError):
            pass
        try:
            rec["country_q"] = cl["P17"][0]["mainsnak"]["datavalue"]["value"]["id"]
            cqs.add(rec["country_q"])
        except (KeyError, IndexError, TypeError):
            pass
        out[q] = rec
    labels = {}
    if cqs:
        time.sleep(0.6)
        dl = session.get(WD_API, params={
            "action": "wbgetentities", "ids": "|".join(sorted(cqs)),
            "props": "labels", "languages": "en", "format": "json"}, timeout=60).json()
        for q, e in dl.get("entities", {}).items():
            try:
                labels[q] = e["labels"]["en"]["value"]
            except (KeyError, TypeError):
                pass
    for rec in out.values():
        if rec.get("country_q"):
            rec["country"] = labels.get(rec.pop("country_q"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    payload = json.loads(DETAILS.read_text(encoding="utf-8"))
    details = payload["details"]
    by_id = {d["id"]: d for d in details}

    log = {"cleaned": 0, "filled": [], "unfillable": [], "suspect": [],
           "height_conflict": 0, "year_conflict": 0, "era_fixed": []}

    # ---- 1) 摘要清洗（全量） ----
    for d in details:
        if d.get("summary"):
            c = clean_summary(d["summary"])
            if c != d["summary"]:
                d["summary"] = c
                log["cleaned"] += 1

    # ---- 2) 补缺失字段：仅 Top200 中缺 built/height/country ≥2 的，且 Wikidata 有值 ----
    need = [d for d in details if d.get("top200_rank")
            and sum(1 for k in ("built", "height_m", "country") if not d.get(k)) >= 2]
    qmap = {d["wikidata"]: d for d in need if d.get("wikidata")}
    if qmap and not args.dry_run:
        wd = fetch_wd_fields(sorted(qmap))
    elif qmap:
        wd = fetch_wd_fields(sorted(qmap))  # dry-run 也查，便于看会补什么
    else:
        wd = {}
    for q, d in qmap.items():
        got = wd.get(q, {})
        added = {}
        for k in ("built", "height_m", "country"):
            if not d.get(k) and got.get(k) is not None:
                added[k] = got[k]
                if not args.dry_run:
                    d[k] = got[k]
        if added:
            log["filled"].append((d.get("name"), added))
        still = [k for k in ("built", "height_m", "country") if not (d.get(k) or added.get(k))]
        if still:
            log["unfillable"].append((d.get("name"), still))

    # ---- 3) 高度可疑标记（>150 多为 OSM 海拔/焦距；<2 为源数据离谱） ----
    for d in details:
        h = d.get("height_m")
        if h is None:
            d.pop("height_suspect", None)
            d.pop("height_suspect_note", None)
            continue
        if h > 150:
            note = "源高度疑为海拔/焦距(灯火距海平面)而非塔身高度，已隐藏"
        elif h < 2:
            note = "源高度数值过小、明显存疑，已隐藏"
        else:
            d.pop("height_suspect", None)
            d.pop("height_suspect_note", None)
            continue
        if not args.dry_run:
            d["height_suspect"] = True
            d["height_suspect_note"] = note
        log["suspect"].append((d.get("name"), h, note))

    # ---- 4) 来源不一标注（仅真灯塔的英文摘要；高度可疑/错挂的跳过，与前端展示口径一致） ----
    for d in details:
        for k in ("height_conflict", "year_conflict"):
            d.pop(k, None)
        if d.get("category") != "lighthouse" or d.get("bad_link"):
            continue
        s = d.get("summary")
        if not s or not is_english(s):
            continue
        h = d.get("height_m")
        if h is not None and not d.get("height_suspect"):
            tol = max(3.0, h * 0.1)
            hs = structural_heights(s)
            # 仅当摘要里「没有任何一个高度对得上字段」才算两者不一致；
            # 若摘要同时给出了与字段相符的值，说明字段被佐证，不算冲突。
            if hs and not any(abs(v - h) <= tol for v in hs):
                if not args.dry_run:
                    d["height_conflict"] = {"field": h, "summary": collapse_near(hs)}
                log["height_conflict"] += 1
        yi = year_int(d.get("built"))
        if yi is not None:
            bys = build_years_in_summary(s)
            # 仅当字段年份「不在」摘要给出的建成年里 → 才算两者不一致
            if bys and yi not in bys:
                if not args.dry_run:
                    d["year_conflict"] = {"field": str(d["built"]), "summary": sorted(set(bys))}
                log["year_conflict"] += 1

    # ---- 5) 古代纪元修正：建成年<600 的灯塔重拉 P571，按正负号正确标注纪元 ----
    ancient = [d for d in details if d.get("wikidata") and (_lead_year(d.get("built")) or 9999) < 600]
    if ancient:
        claims_map = fetch_claims(sorted({d["wikidata"] for d in ancient}))
        for d in ancient:
            new = era_year(claims_map.get(d["wikidata"], {}))
            if new and new != d.get("built"):
                log["era_fixed"].append((d.get("name"), d.get("built"), new))
                if not args.dry_run:
                    d["built"] = new

    if not args.dry_run:
        DETAILS.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 汇总 ----
    print("========== 详情修正汇总" + (" [dry-run]" if args.dry_run else "") + " ==========")
    print(f"摘要清洗(去零宽/残渣): {log['cleaned']} 条")
    print(f"\n补上的字段(仅 Wikidata 确有值):")
    for nm, add in log["filled"]:
        print(f"  ✓ {nm}: {add}")
    print(f"\n源头无数据、如实留空(不编造):")
    for nm, miss in log["unfillable"]:
        print(f"  · {nm}: 仍缺 {miss}")
    print(f"\n高度可疑(已标记, 前端隐藏): {len(log['suspect'])} 座")
    for nm, h, note in log["suspect"]:
        print(f"  ⚠ {nm}: {h}m — {note}")
    print(f"\n来源不一标注(两值并存, 不裁定): 高度 {log['height_conflict']} 座 · 年份 {log['year_conflict']} 座")
    print(f"\n古代纪元修正(BC/AD 正确标注): {len(log['era_fixed'])} 座")
    for nm, old, new in log["era_fixed"]:
        print(f"  🏛 {nm}: {old!r} → {new!r}")
    print(f"\n{'(dry-run, 未写文件)' if args.dry_run else '已写回 ' + str(DETAILS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

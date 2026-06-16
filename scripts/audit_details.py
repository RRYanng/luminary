#!/usr/bin/env python3
"""
Luminary Phase 3 — 详情自动核查（只出问题清单，不改数据）

对有详情的灯塔(category=lighthouse)跑一遍自动检查，揪出"数据内部不自洽 / 不完整 /
异常 / 跑题"的，输出问题清单。干净的不列。

诚实边界：本脚本**只核查内部一致性与完整性**，不裁定"真实世界里这座灯塔到底多高/
建于哪年"——那需要权威信源。两个来源说法不一致时，如实把两个值都列出来让你判断。

检查项:
  - height_conflict : 摘要里提到的高度 与 height_m 字段对不上(列出两个值)
  - year_conflict   : 摘要里"建于X年" 与 built 字段对不上
  - height_outlier  : 高度异常(>150m 或 <2m)
  - missing_summary : 该是灯塔却没摘要(排除已知的 bad_link)
  - short_summary   : 摘要过短/像被截断(非正常 1-2 句)
  - non_english     : 摘要混入非拉丁文字(应为英文)
  - off_topic       : 摘要不含任何"灯塔"相关词、也不含名字 → 可能讲的不是这座
  - broken_image    : 照片链接 HTTP 不通
  - missing_fields  : built/height/country 等关键字段为空

用法:
  python scripts/audit_details.py                 # 全部详情灯塔(廉价检查) + Top200 图片检查
  python scripts/audit_details.py --images all    # 同时检查所有图片(慢, ~几分钟)
  python scripts/audit_details.py --images none   # 跳过图片检查
"""

import argparse
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests

# 与 fix_details 共用同一套抽取逻辑，避免两边规则漂移
from fix_details import (build_years_in_summary, clean_summary, is_english,
                         structural_heights)

ROOT = Path(__file__).resolve().parent.parent
DETAILS = ROOT / "data" / "lighthouse_details.json"
OUT_JSON = ROOT / "data" / "audit_report.json"
OUT_MD = ROOT / "data" / "audit_report.md"

UA = "Luminary/0.1 (lighthouse explorer; data audit; ruiyiyanng@gmail.com)"
LH_WORDS = ("lighthouse", "light ", "light.", "light,", "beacon", "faro", "phare",
            "leuchtturm", "fyr", "vuurtoren", "majakka", "tuletorn", "lantern", "light station")

session = requests.Session()
session.headers["User-Agent"] = UA


# ---------------------------------------------------------------- 解析 helpers
def non_latin_ratio(text: str):
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0, set()
    scripts = set()
    nonlatin = 0
    for c in letters:
        try:
            name = unicodedata.name(c)
        except ValueError:
            continue
        fam = name.split(" ")[0]
        if fam != "LATIN":
            nonlatin += 1
            scripts.add(fam)
    return nonlatin / len(letters), scripts


def year_int(built):
    if not built:
        return None
    m = re.match(r"^(\d{3,4})", str(built))
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------- 图片检查
def check_image(url: str) -> str:
    """Returns 'ok' or a failure code. Retries 429/503 (rate limit) with backoff
    so transient throttling isn't mistaken for a broken image."""
    for attempt in range(4):
        try:
            r = session.get(url, timeout=25, stream=True, allow_redirects=True)
            code = r.status_code
            r.close()
            if code == 200:
                return "ok"
            if code in (429, 503):
                wait = int(r.headers.get("Retry-After", "0") or 0) or (2 ** attempt)
                time.sleep(min(wait, 30))
                continue
            return f"http_{code}"
        except Exception as e:  # noqa: BLE001
            time.sleep(2 ** attempt)
            last = type(e).__name__
    return f"rate_limited_or_{last if 'last' in dir() else 'error'}"


# ---------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", choices=["none", "top200", "all"], default="top200",
                    help="图片 HTTP 检查范围（默认只查 Top200）")
    args = ap.parse_args()

    payload = json.loads(DETAILS.read_text(encoding="utf-8"))
    details = payload["details"]
    lh = [d for d in details if d.get("category") == "lighthouse"]
    bad_link = [d for d in lh if d.get("bad_link")]

    problems = {}  # id -> {record fields + issues:[...]}

    def add(d, kind, msg):
        rec = problems.setdefault(d["id"], {
            "id": d["id"], "name": d.get("name"), "rank": d.get("top200_rank"),
            "wikidata": d.get("wikidata"), "issues": [],
        })
        rec["issues"].append({"kind": kind, "detail": msg})

    # ---- 廉价检查（全部 lighthouse 详情） ----
    for d in lh:
        s = d.get("summary")
        h = d.get("height_m")
        built = d.get("built")

        # 高度异常（已标 height_suspect 的视为已处理，不再计为问题）
        if h is not None and (h > 150 or h < 2) and not d.get("height_suspect"):
            add(d, "height_outlier", f"height_m={h} 异常(可能错挂/单位错)")

        # 建成年份异常(未来年；古代小年份不算错，跳过)
        yi = year_int(built)
        if yi is not None and yi > 2027:
            add(d, "year_outlier", f"built={built} 是未来年份")

        # 完整性：摘要
        if s is None:
            if not d.get("bad_link"):  # bad_link 的摘要是故意丢弃的，已知
                add(d, "missing_summary", "无摘要")
        else:
            s = clean_summary(s)  # 去零宽残渣后再判定，避免假「截断」
            # 过短/截断(非正常结尾，且不是有意的 … 截断)
            if len(s) < 45:
                add(d, "short_summary", f"摘要过短({len(s)}字符): {s!r}")
            elif not s.rstrip().endswith(("…", ".", "!", "?", "。", "！", "？", ")")):
                add(d, "short_summary", f"摘要结尾像被截断: …{s[-40:]!r}")

            # 语言 & 跑题
            low = s.lower()
            ratio, scripts = non_latin_ratio(s)
            name_tokens = [t for t in re.split(r"\W+", (d.get("name") or "").lower()) if len(t) > 3]
            has_lh_word = any(w in low for w in LH_WORDS)
            has_name = any(t in low for t in name_tokens)
            # 与 fix_details 共用同一判定（≥2 个英文常用词 → 视为英文，哪怕含母语名括注）
            english = is_english(s)
            if not english:
                if ratio > 0.15:
                    add(d, "non_english", f"摘要是非拉丁文字({ratio:.0%}, {sorted(scripts)}) → 非英文")
                else:
                    add(d, "non_english", f"摘要疑似非英文(无英文常用词标志): {s[:70]!r}")
            elif not has_lh_word and not has_name:
                # 英文但既不含灯塔词也不含名字 → 可能真的讲错对象
                add(d, "off_topic", f"英文摘要但不含灯塔词/名字 → 可能讲的不是这座: {s[:80]!r}")

            # 高度内部矛盾：仅英文摘要、且高度未被标为可疑时才比对
            # (上下文感知抽取：距离/海拔/焦距不会被误当塔高)
            if english and h is not None and not d.get("height_suspect"):
                hs = structural_heights(s)
                tol = max(3.0, h * 0.1)
                if hs and not any(abs(v - h) <= tol for v in hs):
                    vals = ", ".join(f"{v}m" for v in sorted(set(hs)))
                    add(d, "height_conflict",
                        f"摘要提到高度[{vals}]，但 height_m 字段={h}m — 两者不一致(已两值并存交给用户判断)")

            # 年份内部矛盾（仅英文摘要）
            if english and yi is not None:
                bys = build_years_in_summary(s)
                if bys and yi not in bys:
                    add(d, "year_conflict",
                        f"摘要提到建于{sorted(set(bys))}，但 built 字段={built} — 不一致(已两值并存交给用户判断)")

        # 关键字段缺失(仅作信息记一条，避免噪声)
        miss = [k for k in ("built", "height_m", "country") if d.get(k) in (None, "")]
        if len(miss) >= 2:
            add(d, "missing_fields", f"关键字段缺失: {miss}")

    # ---- 图片检查（按 scope） ----
    if args.images != "none":
        targets = lh if args.images == "all" else [d for d in lh if d.get("top200_rank")]
        targets = [d for d in targets if d.get("image")]
        print(f"检查 {len(targets)} 张图片连通性({args.images})…")
        seen = {}
        for i, d in enumerate(targets):
            url = d["image"]
            if url not in seen:
                seen[url] = check_image(url)
                time.sleep(0.4)
            if seen[url] != "ok":
                add(d, "broken_image", f"照片 HTTP 不通({seen[url]}): {url}")
            if (i + 1) % 50 == 0:
                print(f"  …{i + 1}/{len(targets)}")

    # ---- 汇总 ----
    from collections import Counter
    kind_count = Counter()
    for rec in problems.values():
        for iss in rec["issues"]:
            kind_count[iss["kind"]] += 1
    flagged = sorted(problems.values(), key=lambda r: (r["rank"] is None, r["rank"] or 1e9))

    report = {
        "audited_lighthouses": len(lh),
        "image_scope": args.images,
        "flagged_count": len(problems),
        "issue_counts": dict(kind_count),
        "known_bad_link": len(bad_link),
        "problems": flagged,
    }
    OUT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    KIND_LABEL = {
        "height_conflict": "高度矛盾(摘要 vs 字段)", "year_conflict": "年份矛盾(摘要 vs 字段)",
        "height_outlier": "高度异常值", "year_outlier": "年份异常值",
        "missing_summary": "缺摘要", "short_summary": "摘要过短/截断",
        "non_english": "摘要非英文", "off_topic": "摘要疑似跑题", "broken_image": "照片失效",
        "missing_fields": "关键字段缺失(≥2)",
    }
    lines = [f"# Luminary 详情核查报告\n",
             f"- 核查灯塔(category=lighthouse): **{len(lh)}**",
             f"- 有问题: **{len(problems)}** 座 · 干净: {len(lh) - len(problems)} 座",
             f"- 图片检查范围: {args.images}",
             f"- 已知 bad_link(摘要已丢弃, 不计为新问题): {len(bad_link)}\n",
             "## 问题类型计数"]
    for k, n in kind_count.most_common():
        lines.append(f"- {KIND_LABEL.get(k, k)}: **{n}**")
    lines.append("\n## 问题清单（按 Top200 排名）")
    for r in flagged:
        tag = f"#{r['rank']} " if r["rank"] else ""
        lines.append(f"\n### {tag}{r['name'] or '(无名)'}  ({r['id']}, {r['wikidata']})")
        for iss in r["issues"]:
            lines.append(f"- **{KIND_LABEL.get(iss['kind'], iss['kind'])}**: {iss['detail']}")
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")

    # ---- 控制台汇总 ----
    print("\n========== 核查汇总 ==========")
    print(f"核查灯塔: {len(lh)} · 有问题: {len(problems)} · 干净: {len(lh) - len(problems)}")
    print("问题类型计数:")
    for k, n in kind_count.most_common():
        print(f"  {KIND_LABEL.get(k, k):<22} {n}")
    top = [r for r in flagged if r["rank"]]
    print(f"\nTop200 中有问题的: {len(top)} 座（前 25 预览）")
    for r in top[:25]:
        kinds = ",".join(sorted({i["kind"] for i in r["issues"]}))
        print(f"  #{r['rank']:>3} {r['name'] or '(无名)':<32} {kinds}")
    print(f"\n完整清单: {OUT_MD}")
    print(f"结构化: {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

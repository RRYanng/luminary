#!/usr/bin/env python3
"""
Luminary Phase 0 — 全球灯塔数据管线

从 OpenStreetMap Overpass API 拉取所有 man_made=lighthouse 对象，
清洗去重后输出:
  data/lighthouses.json     前端用精简数组 (schema 见 CLAUDE.md)
  data/lighthouses.geojson  标准 GeoJSON 备份
  data/raw/tile_*.json      各分块原始响应缓存（断点续跑用）

用法:
  python scripts/fetch_lighthouses.py            # 全量拉取
  python scripts/fetch_lighthouses.py --tile 3   # 只跑第 3 个分块（连通性测试）
  python scripts/fetch_lighthouses.py --no-cache # 忽略缓存强制重拉

依赖: pip install requests
"""

import argparse
import json
import sys
import time
from pathlib import Path

import requests

# ---------------------------------------------------------------- 配置

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",  # 镜像，主站失败时切换
]

# 全球按纬度带切成 6 个分块，避免单次查询超时。
# 经度统一 -180..180，纬度带划分（南极没有灯塔，从 -60 开始）:
LAT_BANDS = [
    (-60, -20),   # 0: 南半球大部（澳新、南美南部、南非）
    (-20, 15),    # 1: 热带（东南亚、非洲中部、南美北部）
    (15, 35),     # 2: 北纬低段（地中海南、中东、中国南部、墨西哥）
    (35, 47),     # 3: 北纬中段（地中海北、日韩、美国大部）— 灯塔最密集
    (47, 58),     # 4: 北欧南段、英国、加拿大南部
    (58, 84),     # 5: 高纬（挪威、波罗的海北、阿拉斯加）— 挪威灯塔极多
]

REQUEST_GAP_SECONDS = 5      # 公共 API，请求间最小间隔
MAX_RETRIES = 4              # 单分块失败重试次数（指数退避）
TIMEOUT_SECONDS = 300        # Overpass 服务端查询超时

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"

# ---------------------------------------------------------------- 拉取


def build_query(lat_min: float, lat_max: float) -> str:
    bbox = f"{lat_min},-180,{lat_max},180"
    return f"""
[out:json][timeout:{TIMEOUT_SECONDS}];
(
  node["man_made"="lighthouse"]({bbox});
  way["man_made"="lighthouse"]({bbox});
  relation["man_made"="lighthouse"]({bbox});
);
out center tags;
"""


def fetch_tile(tile_idx: int, use_cache: bool = True) -> dict:
    """拉取一个纬度带分块，带缓存与多端点重试。"""
    cache_file = RAW_DIR / f"tile_{tile_idx}.json"
    if use_cache and cache_file.exists():
        print(f"  tile {tile_idx}: 使用缓存 {cache_file.name}")
        return json.loads(cache_file.read_text(encoding="utf-8"))

    lat_min, lat_max = LAT_BANDS[tile_idx]
    query = build_query(lat_min, lat_max)

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            print(f"  tile {tile_idx} (lat {lat_min}..{lat_max}): "
                  f"请求 {endpoint} (尝试 {attempt + 1}/{MAX_RETRIES})")
            resp = requests.post(
                endpoint,
                data={"data": query},
                timeout=TIMEOUT_SECONDS + 30,
                headers={"User-Agent": "Luminary/0.1 (lighthouse explorer; phase 0 pipeline)"},
            )
            if resp.status_code in (429, 504):
                raise RuntimeError(f"HTTP {resp.status_code} (服务端繁忙)")
            resp.raise_for_status()
            data = resp.json()
            cache_file.write_text(
                json.dumps(data, ensure_ascii=False), encoding="utf-8")
            print(f"  tile {tile_idx}: 获得 {len(data.get('elements', []))} 个对象，已缓存")
            return data
        except Exception as e:  # noqa: BLE001 — 网络层任何失败都退避重试
            last_error = e
            wait = REQUEST_GAP_SECONDS * (2 ** attempt)
            print(f"  tile {tile_idx}: 失败 ({e})，{wait}s 后重试")
            time.sleep(wait)

    raise RuntimeError(f"tile {tile_idx} 在 {MAX_RETRIES} 次尝试后仍失败: {last_error}")


# ---------------------------------------------------------------- 清洗


def infer_operational(tags: dict) -> bool | None:
    """从 seamark / disused 标签推断灯塔是否仍在运作。未知返回 None。"""
    if tags.get("disused") == "yes" or "disused:man_made" in tags:
        return False
    seamark = tags.get("seamark:type", "")
    if seamark in ("light_major", "light_minor"):
        return True
    if "seamark:light:character" in tags or "seamark:light:1:character" in tags:
        return True
    return None


def parse_height(tags: dict) -> float | None:
    raw = tags.get("height") or tags.get("seamark:light:height")
    if not raw:
        return None
    try:
        return float(str(raw).lower().replace("m", "").strip())
    except ValueError:
        return None


def element_to_record(el: dict) -> dict | None:
    """单个 OSM 对象 -> CLAUDE.md 约定的 schema。无坐标则丢弃。"""
    if el["type"] == "node":
        lat, lng = el.get("lat"), el.get("lon")
    else:  # way / relation 用 center
        center = el.get("center") or {}
        lat, lng = center.get("lat"), center.get("lon")
    if lat is None or lng is None:
        return None

    tags = el.get("tags", {})
    return {
        "id": f'{el["type"]}/{el["id"]}',
        "name": tags.get("name:en") or tags.get("name"),
        "lat": round(lat, 5),
        "lng": round(lng, 5),
        "country": None,  # Phase 3 反向地理编码补全
        "wikidata": tags.get("wikidata"),
        "wikipedia": tags.get("wikipedia"),
        "height": parse_height(tags),
        "start_date": tags.get("start_date"),
        "operational": infer_operational(tags),
    }


def to_geojson(records: list[dict]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point",
                             "coordinates": [r["lng"], r["lat"]]},
                "properties": {k: v for k, v in r.items()
                               if k not in ("lat", "lng")},
            }
            for r in records
        ],
    }


# ---------------------------------------------------------------- 主流程


def main() -> int:
    parser = argparse.ArgumentParser(description="Luminary Phase 0 数据管线")
    parser.add_argument("--tile", type=int, default=None,
                        help=f"只跑指定分块 0..{len(LAT_BANDS) - 1}（测试用）")
    parser.add_argument("--no-cache", action="store_true",
                        help="忽略 raw 缓存强制重新请求")
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)
    RAW_DIR.mkdir(exist_ok=True)

    tiles = [args.tile] if args.tile is not None else range(len(LAT_BANDS))

    seen: set[str] = set()
    records: list[dict] = []
    for i in tiles:
        data = fetch_tile(i, use_cache=not args.no_cache)
        for el in data.get("elements", []):
            rec = element_to_record(el)
            if rec is None or rec["id"] in seen:
                continue
            seen.add(rec["id"])
            records.append(rec)
        if i != list(tiles)[-1]:
            time.sleep(REQUEST_GAP_SECONDS)

    records.sort(key=lambda r: r["id"])

    out_json = DATA_DIR / "lighthouses.json"
    out_geojson = DATA_DIR / "lighthouses.geojson"
    out_json.write_text(
        json.dumps(records, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    out_geojson.write_text(
        json.dumps(to_geojson(records), ensure_ascii=False), encoding="utf-8")

    named = sum(1 for r in records if r["name"])
    with_wiki = sum(1 for r in records if r["wikidata"] or r["wikipedia"])
    print("\n========== Phase 0 汇总 ==========")
    print(f"灯塔总数:           {len(records):>6}")
    print(f"有名字:             {named:>6}  ({named / max(len(records), 1):.0%})")
    print(f"有 Wikidata/Wiki:   {with_wiki:>6}  ({with_wiki / max(len(records), 1):.0%})")
    print(f"输出: {out_json}  ({out_json.stat().st_size / 1024:.0f} KB)")
    print(f"      {out_geojson}")
    if args.tile is None and len(records) < 10000:
        print("⚠️  总数低于 1 万，可能有分块拉取失败，检查 data/raw/ 缓存后重跑。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

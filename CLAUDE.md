# Luminary — 全球灯塔 3D 地球探索器

## 项目愿景
一个以 3D 地球为中心的 Web 应用：星空背景下，用户旋转/缩放地球，
全球 1.5 万+ 座灯塔以发光点呈现；放大后浮现灯塔虚影，点击查看
名字、历史、是否可参观等信息。先 Web，验证后再考虑移动端封装。

## 技术栈（已锁定，不要替换）
- 前端: Vite + React 18 + TypeScript
- 3D 地球: react-globe.gl (基于 three.js / three-globe)
- 数据管线: Python 3.11+ (requests)，输出静态 JSON，无后端
- 部署: Vercel 或 Cloudflare Pages（纯静态站）

## 目录结构
```
luminary/
├── CLAUDE.md              # 本文件
├── scripts/               # 数据管线 (Python)
│   └── fetch_lighthouses.py
├── data/                  # 脚本输出，不要手改
│   ├── lighthouses.json     # 前端用的精简数组
│   ├── lighthouses.geojson  # 标准 GeoJSON 备份
│   └── raw/                 # 各分块的原始 Overpass 响应缓存
└── web/                   # Phase 1 起的前端项目 (Vite)
```

## 数据约定（重要）
`data/lighthouses.json` 是前端唯一数据源，schema 如下，改动前必须先和我确认：
```json
{
  "id": "node/123456",          // OSM 类型/ID，全局唯一键
  "name": "Pigeon Point Lighthouse",  // name:en 优先，其次 name；可为 null
  "lat": 37.1817,
  "lng": -122.3937,
  "country": null,              // Phase 0 暂为 null，Phase 3 反向地理编码补全
  "wikidata": "Q609896",        // 有则填，Phase 3 用来拉详情
  "wikipedia": "en:Pigeon Point Lighthouse",
  "height": 35.0,               // 米，可为 null
  "start_date": "1871",         // 建成年份字符串，可为 null
  "operational": true           // 由 seamark/light 标签推断，未知为 null
}
```
- 坐标保留 5 位小数（约 1 米精度），控制文件体积。
- 去重键 = OSM `type/id`。way/relation 用 center 坐标。

## 阶段路线
- [x] Phase 0: 数据管线 — Overpass 拉取全球 man_made=lighthouse
- [x] Phase 1: 地球 MVP — 星空 + 旋转地球 + 光点撒点
- [ ] Phase 2: 交互 — 缩放层级切换灯塔虚影、点击详情卡片、视锥剔除
- [ ] Phase 3: 精选内容 — Wikidata 拉取 Top 200 灯塔详情，人工校对
- [ ] Phase 4: 部署 + meetup 演示收集反馈

## 工作守则
1. 每次只做一个 Phase 内的一个明确任务，完成后停下来等验收。
2. Overpass 是公共免费 API：请求间隔 ≥ 5 秒，失败用指数退避重试，
   永远不要并发轰炸它。
3. data/ 下的文件由脚本生成，不要手动编辑。
4. 前端动效以 60fps 为底线，任何视觉效果先在 2 万点的真实数据上测过再合入。
5. 所有面向用户的文案先用英文，i18n 留到 Phase 4 之后。

## 常用命令
```bash
# Phase 0: 拉取数据（全量约 10-20 分钟，含限速等待）
python scripts/fetch_lighthouses.py

# 只测试一个分块（快速验证连通性）
python scripts/fetch_lighthouses.py --tile 0

# Phase 1 起
cd web && npm run dev
```

# Luminary — 全球灯塔 3D 地球探索器

## 项目愿景
一个以"真实地图"体验为核心的 Web 应用：缩到最远是星空中的 3D 地球，
全球 1.5 万+ 座灯塔以发光点呈现；放大后无缝过渡为带海岸线/街道的真实地图，
近处灯塔立成发光 3D 模型，点击查看名字、状态、坐标等信息。
先 Web，验证后再考虑移动端封装。

## 技术栈（已锁定，不要替换）
- 前端: Vite + React 18 + TypeScript
- 地图/3D 地球: MapLibre GL JS v5（globe projection，地球↔街道无缝过渡）
  + 自建 Three.js custom layer（程序化灯塔 3D 模型，InstancedMesh 实例化）
- 底图: OpenFreeMap "dark" 矢量瓦片（免费、无 API key、无限额；数据源同为 OSM）
- 数据管线: Python 3.11+ (requests)，输出静态 JSON，无后端
- 部署: Vercel 或 Cloudflare Pages（纯静态站）

> 注：Phase 1 的早期 react-globe.gl 版本已弃用，但完整保留在 git 分支
> `react-globe-gl`（含其依赖），未删除，可随时 checkout 回看。

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
- [x] Phase 1: 地球 MVP — 星空 + 旋转地球 + 光点撒点（react-globe.gl，已被 Phase 2 取代）
- [x] Phase 2: 地图化交互 — 迁移到 MapLibre globe 产品版（旧版进 `react-globe-gl` 分支）；
      跟随相机朝向的程序化星空；地球↔3D 街景无缝缩放过渡 + fill-extrusion 楼体；
      远 zoom 发光点、近 zoom 就近实例化发光 3D 灯塔（同屏上限 80 保 60fps）、
      点↔3D 无缝淡入淡出（去掉了"近变暗"）；点击灯塔（点或 3D）弹详情卡
      （名字/运营状态/坐标/Learn more）；按帧剔除背面防止快速移动时穿模。
- [x] Phase 3: 精选内容 — Wikidata 拉取详情（lighthouse_details.json）、P31/P576/P5817
      分三层状态、自动核查清单（audit_details.py）、修可修项 + 把"来源不一"两值并存
      交给用户判断（fix_details.py）、详情卡接入。人工逐座校对改成了自动核查。
- [~] Phase 4: 部署 + meetup 演示收集反馈
      已上线 Vercel：https://luminary-ruddy.vercel.app
      （仓库 github.com/RRYanng/luminary，private；Vercel Root Directory=web，
      Framework=Vite，push main 自动部署）。剩：meetup 演示 + 收集反馈。

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

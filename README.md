# 🚇 交互式交通线路图

基于 Leaflet 的交互式交通线路图，使用 SQLite 数据库存储线路与站点数据，支持多路线路同时高亮查看。

## 📁 项目结构

```
routemap/
├── index.html      # 主页面结构
├── script.js       # 核心逻辑（地图、数据、交互）
├── styles.css      # 样式表
└── metro.db        # SQLite 数据文件（路线/站点/换乘/出口）
```

## 🚀 快速开始

直接在浏览器中打开 `index.html` 即可运行。项目通过 CDN 加载 `leaflet` 和 `sql.js`，无需构建工具。

## 🎯 功能特性

| 功能 | 说明 |
|------|------|
| **多选线路** | 点击线路可叠加显示；再次点击取消选中 |
| **分类筛选** | 地铁 / 高铁 / 飞机 / 轮船 / 缆车，支持多分类同时显示 |
| **搜索线路** | 支持按中文名、英文名、全名搜索 |
| **站点详情** | 点击站点查看经过线路和出口信息 |
| **取消选中** | 一键清除所有选中，或按选中顺序逐个撤销 |
| **碰撞检测** | 站名标签智能避让，优先显示换乘站；视窗裁剪 + 帧节流保证流畅 |
| **加载动画** | 加载数据库时显示 Win10 风格旋转点阵动画 |
| **无障碍** | 语义化标签（aside/ul）+ ARIA 属性，适配屏幕阅读器 |
| **缩放重置** | 右下角放大、缩小、重置视图按钮 |
| **地图边界约束** | 最边缘站点始终留在视窗内，可平移到对侧边缘但不会滑出，也无法进入大片空白 |

## ⌨️ 快捷键

| 按键 | 行为 |
|------|------|
| `Esc` | 第一次：取消所有选中线路；第二次：重置为仅显示地铁 |

## 🗺️ 数据来源

- 数据文件：`metro.db`（SQLite）
- 包含表：`routes`、`stations`、`transfers`、`nearby_transfers`、`exits`
- 主站地址：[metro.liyv.me](https://metro.liyv.me)

## 🧱 script.js 架构概览

文件采用 IIFE 模式组织，按功能域分区：

| 模块 | 主要函数 | 职责 |
|------|----------|------|
| **工具函数** | `rowsToObjects`、`rowsToMap`、`setsEqual`、`calcCategory`、`clearSelectionState`、`buildSelectionNameFromIds` | 数据转换、状态管理 |
| **数据加载** | `loadDatabase`（含 `buildIndexes` 预建索引） | 读取 SQLite 并构建内存数据结构 |
| **车站聚合** | `aggregateStations`、`groupStationsByGrid`、`collectGroupRelations` | 按网格合并同名站点 |
| **路径构建** | `buildLinePaths`、`getOrderedStations` | 构建每条线路的坐标路径 |
| **地图初始化** | `initMap`、`createGridLayer`、`fitMapToBounds`、`updateMaxBounds` | Leaflet 地图创建、网格背景、边界约束 |
| **图层创建** | `createAllLayers`、`createPolyline`、`createStationMarker`、`getStationPrimaryColor` | 创建线路折线和站点标记（站点 Canvas / 线路 SVG 分层渲染） |
| **图层可见性** | `applyLayerVisibility`、`computeVisibleLineIds`、`applyPolylineVisibility`、`applyStationVisibility`、`refreshLineStyle` | 控制线路/站点显隐与高亮样式 |
| **标签碰撞** | `scheduleStationLabels`、`updateStationLabels`、`computeLabelRects`、`filterNonOverlappingLabels` | 站名防重叠（视窗裁剪 + rAF 节流 + 网格分桶） |
| **详情面板** | `openDetailPanel`、`buildStationName`、`getStationLines`、`renderLineTagsHTML`、`renderExitsHTML` | 右侧站点信息展示 |
| **筛选逻辑** | `filterByLine`、`filterByStation`、`ensureCategoryActive` | 线路/站点选中处理 |
| **取消选中** | `clearAllSelections`、`clearLastSelection` | 一键/逐个取消选中 |
| **分类切换** | `toggleCategory`、`resetToMetroOnly` | 分类筛选控制 |
| **侧边栏** | `buildSidebarItems`、`createSidebarItemElement`、`rebuildSidebarList` | 线路列表增量更新与搜索（DOM 节点复用，不重建） |
| **事件绑定** | `bindEvents`、`bindCategoryEvents`、`bindSearchEvents`、`bindDeselectEvents`、`bindZoomControls`、`bindSidebarToggle`、`bindDetailPanelEvents`、`bindKeyboardEvents` | 所有 DOM 事件注册 |
| **启动** | `initialize` | 应用入口 |

## 🎨 核心设计

### 多选机制

```
activeLineIds (Set)       ← 当前选中线路 ID 集合
selectedLineOrder (Array) ← 选中顺序记录（支持「取消最近一次选中」）
```

`filterByLine(lineId)` 为单向 toggle：已在集合中则移除，否则添加。

### 图层可见性决策

```
computeVisibleLineIds()
  ├─ 无选中线路 → 显示当前分类下所有线路
  ├─ 有选中线路 → 仅显示选中的线路（同时确保对应分类已激活）
  └─ applyPolylineVisibility / applyStationVisibility 分别处理线/点
```

### 站名碰撞检测

1. 收集**视窗内**可见站点的标签矩形（`map.getBounds().pad(0.15)` 视窗裁剪，跳过屏幕外站点）
2. 按「换乘站优先」排序
3. 贪心算法 + **空间网格分桶**：每个标签仅与落入同一/相邻网格单元的已显示标签比较，将原本 O(n²) 的两两相交判定降为近似 O(n)
4. 结果用 `Set` 判定显示（O(1) 查重，消除 O(n·d) 线性查找）
5. 不在集合中的标签隐藏
6. 重算经 `scheduleStationLabels` 的 **rAF 节流**：连续 `moveend`/`zoomend` 合并为每帧一次，避免交互期重复全量计算

### 地图边界约束（边缘站点常驻视窗）

为避免平移到无数据的空白区域，同时保证**最边缘的站点永远不会滑出视窗**，地图使用动态 `maxBounds`：

- `fitMapToBounds()` 计算所有聚合站点的边界并保存为 `stationBounds`，初始适配视图。
- `updateMaxBounds()` 在每次 `zoomend` / `resize` 时根据**当前视窗尺寸**重算边界：
  - 用 `map.getSize()` + `containerPointToLatLng` 得到视窗在地图坐标下的宽高（viewLatSpan / viewLngSpan）。
  - 仅当视窗比整张地图小（已放大）时，才在站点边界外**向每个方向扩展恰好一个视窗尺寸**。
  - 这样最右侧站点可被一路平移到视窗最左侧仍可见，达到对侧边缘后再往外即被限制；视窗比地图大时不扩展，避免大片空白。
- `maxBoundsViscosity: 1.0` 使边界为硬性限制，平移到极限即时停住、不回弹。
- 内部的其他站点在平移过程中可正常滚出视窗，仅边缘站点被锚定。

## 📐 技术栈

- **Leaflet 1.9.4** — 地图渲染，使用 `CRS.Simple` 平面坐标系；站点走 Canvas 渲染器、线路走 SVG 渲染器（分层渲染，消除海量 marker 的 DOM 节点）
- **sql.js 1.8.0** — 在浏览器中读取 SQLite 数据库
- **原生 JS (IIFE)** — 无框架依赖，单文件模块化

## 📝 重构记录

原始 `script.js` 中部分函数职责过重。重构后将每个函数拆分为职责单一的更小函数：

- `aggregateStations` → `groupStationsByGrid` + `collectGroupRelations`
- `applyLayerVisibility` → `computeVisibleLineIds` + `applyPolylineVisibility` + `applyStationVisibility`
- `openDetailPanel` → `buildStationName` + `getStationLines` + `renderLineTagsHTML` + `renderExitsHTML`
- `bindEvents` → `bindCategoryEvents` + `bindSearchEvents` + ... 等 7 个子函数
- 性能相关抽取：`buildIndexes`（预建 `routeById` / `stationsByRoute` 索引）、`buildStationGrid`（点击命中空间索引）、`buildSidebarItems`（侧边栏一次性构建 + 缓存）、`scheduleStationLabels`（标签更新 rAF 节流）
- 抽取公共模式：`rowsToObjects`、`rowsToMap`、`clearSelectionState`、`buildSelectionNameFromIds`

> 注：`loadDatabase` 目前仍保持为单体函数（一次性读取 SQLite 五张表），未做进一步拆分。

所有函数保持在单文件中，划分明确的功能区域注释。

## ⚡ 性能优化

针对中等规模线路图（数百~数千站）做了分层与算法优化，已对齐地图行业主流做法：

| 优化项 | 实现 | 收益 |
|--------|------|------|
| **分层渲染** | 站点 `preferCanvas: true` 走 Canvas，线路显式用 SVG renderer | 消除海量 circleMarker 的 DOM 节点（从 ~M 个降为 0） |
| **视窗裁剪** | `updateStationLabels` 仅计算视窗内 + 缓冲的站点 | 标签计算基数从全量 M 降为视窗内站数 |
| **帧节流** | `scheduleStationLabels` 用 `requestAnimationFrame` 合并 | 连续缩放/拖动时每帧仅重算一次 |
| **预建索引** | `buildIndexes` 构建 `routeById` / `stationsByRoute` | 消除所有 `routesData.find` 与路径构建的 O(R·S) 全表扫描 |
| **空间网格（标签）** | `filterNonOverlappingLabels` 网格分桶 | 碰撞检测从 O(M²) 降为 ≈O(M) |
| **空间网格（点击）** | `buildStationGrid` + `isClickNearStation` 邻近查询 | 点击命中从 O(M) 全扫降为 O(k) |
| **侧边栏增量更新** | `buildSidebarItems` 一次性创建并缓存，`rebuildSidebarList` 仅切换 class/display | 消除每次筛选的全量 DOM 重建 |
| **极值鲁棒性** | `fitMapToBounds` 循环求极值 | 避免数据暴涨时展开运算符栈溢出 |

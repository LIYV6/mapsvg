# 🚇 线路图 SVG 版

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
| **碰撞检测** | 站名标签智能避让，优先显示换乘站 |
| **缩放重置** | 右下角放大、缩小、重置视图按钮 |

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
| **数据加载** | `loadDatabase`、`loadRoutes`、`loadStations`、`loadRelatedTableAsMap` | 读取 SQLite 并构建内存数据结构 |
| **车站聚合** | `aggregateStations`、`groupStationsByGrid`、`collectGroupRelations` | 按网格合并同名站点 |
| **路径构建** | `buildLinePaths`、`getOrderedStations` | 构建每条线路的坐标路径 |
| **地图初始化** | `initMap`、`createGridLayer`、`fitMapToBounds` | Leaflet 地图创建与网格背景 |
| **图层创建** | `createAllLayers`、`createPolyline`、`createStationMarker`、`getStationPrimaryColor` | 创建线路折线和站点标记 |
| **图层可见性** | `applyLayerVisibility`、`computeVisibleLineIds`、`applyPolylineVisibility`、`applyStationVisibility`、`refreshLineStyle` | 控制线路/站点显隐与高亮样式 |
| **标签碰撞** | `updateStationLabels`、`computeLabelRects`、`filterNonOverlappingLabels` | 站名防重叠 |
| **详情面板** | `openDetailPanel`、`buildStationName`、`getStationLines`、`renderLineTagsHTML`、`renderExitsHTML` | 右侧站点信息展示 |
| **筛选逻辑** | `filterByLine`、`filterByStation`、`ensureCategoryActive` | 线路/站点选中处理 |
| **取消选中** | `clearAllSelections`、`clearLastSelection` | 一键/逐个取消选中 |
| **分类切换** | `toggleCategory`、`resetToMetroOnly` | 分类筛选控制 |
| **侧边栏** | `rebuildSidebarList`、`renderSidebarItems`、`createSidebarItemElement`、`filterRoutesBySearch` | 线路列表渲染与搜索 |
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

1. 收集可见站点的标签矩形
2. 按「换乘站优先」排序
3. 贪心算法：保留第一个不重叠的标签集合
4. 不在集合中的标签隐藏

## 📐 技术栈

- **Leaflet 1.9.4** — 地图渲染，使用 `CRS.Simple` 平面坐标系
- **sql.js 1.8.0** — 在浏览器中读取 SQLite 数据库
- **原生 JS (IIFE)** — 无框架依赖，单文件模块化

## 📝 重构记录

原始 `script.js` 中部分函数职责过重（如 `loadDatabase` 83 行、`aggregateStations` 79 行、`applyLayerVisibility` 58 行）。重构后将每个函数拆分为职责单一的更小函数：

- `loadDatabase` → `loadRoutes` + `loadStations` + `loadRelatedTableAsMap`
- `aggregateStations` → `groupStationsByGrid` + `collectGroupRelations`
- `applyLayerVisibility` → `computeVisibleLineIds` + `applyPolylineVisibility` + `applyStationVisibility`
- `openDetailPanel` → `buildStationName` + `getStationLines` + `renderLineTagsHTML` + `renderExitsHTML`
- `bindEvents` → `bindCategoryEvents` + `bindSearchEvents` + ... 等 7 个子函数
- 抽取公共模式：`rowsToObjects`、`rowsToMap`、`clearSelectionState`、`buildSelectionNameFromIds`

所有函数保持在单文件中，划分明确的功能区域注释。

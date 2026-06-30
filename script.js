(function() {
    // ======================= 全局变量 =======================
    let map;
    let allStationsData = [];
    let routesData = [];
    let transfersMap = {};
    let nearbyTransfersMap = {};
    let exitsMap = {};
    let aggregatedStations = [];
    let linePolylines = {};
    let stationMarkers = {};
    let activeLineIds = new Set();
    let activeCategories = new Set();
    let lineLayerGroup, stationLayerGroup;
    let stationIdToAggregated = {};
    let selectedLineOrder = [];
    let defaultBounds = null;

    let selectionType = 'none';
    let selectionName = '';

    const BASE_RADIUS = 9;
    const TRANSFER_RADIUS = 13;
    const CLICK_IGNORE_DISTANCE = 20;

    const ALL_CATEGORIES = ['metro', 'high_speed', 'airplane', 'boat', 'cable_car'];
    const CATEGORY_CN_MAP = {
        metro: '地铁', high_speed: '高铁', airplane: '飞机',
        boat: '轮船', cable_car: '缆车'
    };

    // ======================= 工具函数 =======================
    /** 将 SQL 查询结果的 columns + rows → 对象数组 */
    function rowsToObjects(columns, rows) {
        return rows.map(row => {
            const obj = {};
            columns.forEach((c, i) => obj[c] = row[i]);
            return obj;
        });
    }

    /** 将 SQL 查询结果的 columns + rows → { keyField: row } 映射表 */
    function rowsToMap(columns, rows, keyField) {
        const map = {};
        rowsToObjects(columns, rows).forEach(obj => {
            const key = obj[keyField];
            if (!map[key]) map[key] = [];
            map[key].push(obj);
        });
        return map;
    }

    function setsEqual(a, b) {
        if (a.size !== b.size) return false;
        for (const item of a) if (!b.has(item)) return false;
        return true;
    }

    function calcCategory(mode, type) {
        const m = String(mode || '').trim().toUpperCase();
        const t = String(type || '').trim().toUpperCase();
        if (m === 'AIRPLANE') return 'airplane';
        if (m === 'BOAT') return 'boat';
        if (m === 'CABLE_CAR') return 'cable_car';
        if (m === 'HIGH_SPEED') return 'high_speed';
        if (m === 'LIGHT_RAIL') return 'metro';
        if (m === 'TRAIN') return t === 'HIGH_SPEED' ? 'high_speed' : 'metro';
        return 'metro';
    }

    /** 清除所有线路选中状态 */
    function clearSelectionState() {
        activeLineIds.clear();
        selectedLineOrder = [];
        selectionType = 'none';
        selectionName = '';
        updateDeselectButtons();
    }

    /** 根据 activeLineIds 构建 selectionName */
    function buildSelectionNameFromIds() {
        const names = [];
        activeLineIds.forEach(id => {
            const r = routesData.find(r => r.id === id);
            if (r) names.push(r.nameCn || r.fullName || `线路${id}`);
        });
        return names.join('、');
    }

    // ======================= 数据加载 =======================
    async function loadDatabase() {
        const loadingEl = document.getElementById('loading-overlay');
        try {
            const SQL = await initSqlJs({
                locateFile: file => `https://unpkg.com/sql.js@1.8.0/dist/${file}`
            });
            const response = await fetch('./metro.db');
            if (!response.ok) throw new Error('无法读取 metro.db');
            const buffer = await response.arrayBuffer();
            const db = new SQL.Database(new Uint8Array(buffer));

            const routesRes = db.exec("SELECT * FROM routes WHERE hidden=0");
            if (!routesRes.length || !routesRes[0].values.length) throw new Error('未找到任何线路');
            routesData = rowsToObjects(routesRes[0].columns, routesRes[0].values).map(obj => {
                obj.category = calcCategory(obj.mode, obj.type);
                return obj;
            });
            const routeIds = routesData.map(r => r.id);
            const routeIdList = routeIds.join(',');

            const stRes = db.exec(`SELECT * FROM stations WHERE route_id IN (${routeIdList})`);
            allStationsData = [];
            if (stRes.length) {
                allStationsData = rowsToObjects(stRes[0].columns, stRes[0].values);
            }

            const stationIds = allStationsData.map(s => s.id);
            if (stationIds.length) {
                const stIdList = stationIds.join(',');

                const trRes = db.exec(`SELECT * FROM transfers WHERE hidden=0 AND station_id IN (${stIdList})`);
                transfersMap = {};
                if (trRes.length) {
                    transfersMap = rowsToMap(trRes[0].columns, trRes[0].values, 'station_id');
                }

                const nrRes = db.exec(`SELECT * FROM nearby_transfers WHERE hidden=0 AND station_id IN (${stIdList})`);
                nearbyTransfersMap = {};
                if (nrRes.length) {
                    nearbyTransfersMap = rowsToMap(nrRes[0].columns, nrRes[0].values, 'station_id');
                }

                const exRes = db.exec(`SELECT * FROM exits WHERE station_id IN (${stIdList})`);
                exitsMap = {};
                if (exRes.length) {
                    exitsMap = rowsToMap(exRes[0].columns, exRes[0].values, 'station_id');
                }
            }

            db.close();
            console.log(`✅ 数据加载完成：${routesData.length} 条线路，${allStationsData.length} 个站台`);
            loadingEl.style.display = 'none';
            return true;
        } catch (error) {
            loadingEl.innerHTML = `<div>❌ 加载失败</div><div style="font-size:0.9rem;">${error.message}</div>`;
            console.error(error);
            return false;
        }
    }

    // ======================= 车站聚合 =======================
    /** 按名称 + 10px 网格将站台分组 */
    function groupStationsByGrid() {
        const groups = new Map();
        allStationsData.forEach(st => {
            const gridX = Math.round(st.x / 10) * 10;
            const gridZ = Math.round(st.z / 10) * 10;
            const key = `${st.nameCn}_${gridX}_${gridZ}`;
            if (!groups.has(key)) {
                groups.set(key, { stations: [], nameCn: st.nameCn,
                    nameEn: st.nameEn || st.nameCn, sumX: 0, sumZ: 0, count: 0 });
            }
            const g = groups.get(key);
            g.stations.push(st);
            g.sumX += st.x; g.sumZ += st.z; g.count++;
        });
        return groups;
    }

    /** 收集分组内关联的换乘/附近/出口信息 */
    function collectGroupRelations(group) {
        const lineIds = new Set(), stationIds = new Set();
        group.stations.forEach(s => { lineIds.add(s.route_id); stationIds.add(s.id); });

        const transferList = [], seenTrans = new Set();
        const nearbyList = [], seenNear = new Set();
        const exitList = [], seenExit = new Set();

        group.stations.forEach(s => {
            (transfersMap[s.id] || []).forEach(t => {
                const uniq = `${t.color}_${t.name}_${t.mode}`;
                if (!seenTrans.has(uniq)) { seenTrans.add(uniq); transferList.push(t); }
            });
            (nearbyTransfersMap[s.id] || []).forEach(n => {
                const uniq = `${n.targetStationCn}_${n.lineName}`;
                if (!seenNear.has(uniq)) { seenNear.add(uniq); nearbyList.push(n); }
            });
            (exitsMap[s.id] || []).forEach(e => {
                if (!seenExit.has(e.exit_name)) { seenExit.add(e.exit_name); exitList.push(e); }
            });
        });

        return { lineIds, stationIds, transferList, nearbyList, exitList };
    }

    function aggregateStations() {
        const groups = groupStationsByGrid();
        aggregatedStations = [];
        stationIdToAggregated = {};

        groups.forEach(group => {
            const { lineIds, stationIds, transferList, nearbyList, exitList } = collectGroupRelations(group);
            const agg = {
                id: `agg_${aggregatedStations.length}`,
                nameCn: group.nameCn, nameEn: group.nameEn,
                x: group.sumX / group.count, z: group.sumZ / group.count,
                lineIds: Array.from(lineIds), stationIds: Array.from(stationIds),
                transfers: transferList, nearby: nearbyList, exits: exitList,
                isTransfer: transferList.length > 0 || nearbyList.length > 0 || lineIds.length > 1
            };
            aggregatedStations.push(agg);
        });

        aggregatedStations.forEach(agg => {
            agg.stationIds.forEach(sid => { stationIdToAggregated[sid] = agg; });
        });
        console.log(`🏙️ 聚合后车站数量：${aggregatedStations.length}`);
    }

    // ======================= 线路路径 =======================
    /** 获取线路的站点顺序数组 */
    function getOrderedStations(routeId) {
        let ordered = allStationsData
            .filter(s => s.route_id === routeId && s.direction === 'forward')
            .sort((a, b) => a.station_index - b.station_index);
        if (ordered.length === 0) {
            ordered = allStationsData
                .filter(s => s.route_id === routeId && s.direction === 'reverse')
                .sort((a, b) => b.station_index - a.station_index);
        }
        return ordered;
    }

    function buildLinePaths() {
        const linePaths = {};
        routesData.forEach(route => {
            const orderedStations = getOrderedStations(route.id);
            if (orderedStations.length === 0) return;

            const pathCoords = [];
            orderedStations.forEach(st => {
                const agg = stationIdToAggregated[st.id];
                if (!agg) return;
                const last = pathCoords[pathCoords.length - 1];
                if (!last || last.x !== agg.x || last.z !== agg.z) {
                    pathCoords.push({ x: agg.x, z: agg.z });
                }
            });
            if (pathCoords.length > 1) linePaths[route.id] = pathCoords;
        });
        return linePaths;
    }

    // ======================= 地图初始化 =======================
    function createGridLayer() {
        const gridLayer = L.gridLayer({ tileSize: 256 });
        gridLayer.createTile = function(coords) {
            const tile = L.DomUtil.create('canvas', 'leaflet-tile');
            const size = this.getTileSize();
            tile.width = size.x; tile.height = size.y;
            const ctx = tile.getContext('2d');
            ctx.strokeStyle = '#e8ecf2'; ctx.lineWidth = 0.5;
            for (let x = 0; x < size.x; x += 64) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.y); ctx.stroke();
            }
            for (let y = 0; y < size.y; y += 64) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.x, y); ctx.stroke();
            }
            return tile;
        };
        return gridLayer;
    }

    /** 计算所有车站的经纬度边界并适配视图 */
    function fitMapToBounds() {
        const allX = aggregatedStations.map(s => s.x);
        const allZ = aggregatedStations.map(s => s.z);
        if (!allX.length) return;
        const bounds = L.latLngBounds(
            L.latLng(-Math.max(...allZ), Math.min(...allX)),
            L.latLng(-Math.min(...allZ), Math.max(...allX))
        );
        map.fitBounds(bounds, { padding: [30, 30] });
        defaultBounds = bounds;
    }

    function initMap() {
        map = L.map('map', {
            crs: L.CRS.Simple, center: [0, 0], zoom: 0,
            minZoom: -4, maxZoom: 8,
            zoomControl: false, attributionControl: false,
        });

        createGridLayer().addTo(map);
        lineLayerGroup = L.layerGroup().addTo(map);
        stationLayerGroup = L.layerGroup().addTo(map);

        fitMapToBounds();
        map.on('moveend zoomend', updateStationLabels);
    }

    // ======================= 创建图层 =======================
    /** 为单条线路创建 polyline */
    function createPolyline(route, path) {
        const latlngs = path.map(p => L.latLng(-p.z, p.x));
        const polyline = L.polyline(latlngs, {
            color: route.color || '#888', weight: 5, opacity: 0.9,
            lineCap: 'round', lineJoin: 'round',
            interactive: true, zIndexOffset: 0,
        });
        polyline._lineId = route.id;
        polyline.on('click', (e) => {
            if (isClickNearStation(e.latlng)) return;
            L.DomEvent.stopPropagation(e);
            filterByLine(route.id);
        });
        linePolylines[route.id] = polyline;
    }

    /** 获取站点主色 */
    function getStationPrimaryColor(agg) {
        if (agg.lineIds.length !== 1) return '#ffffff';
        const route = routesData.find(r => r.id === agg.lineIds[0]);
        return (route || {}).color || '#888';
    }

    /** 为单个聚合站台创建 marker */
    function createStationMarker(agg) {
        const latlng = L.latLng(-agg.z, agg.x);
        const radius = agg.isTransfer ? TRANSFER_RADIUS : BASE_RADIUS;

        const marker = L.circleMarker(latlng, {
            radius: radius,
            fillColor: agg.isTransfer ? '#ffffff' : getStationPrimaryColor(agg),
            fillOpacity: 1,
            color: agg.isTransfer ? '#2c3e50' : '#333',
            weight: agg.isTransfer ? 2.5 : 1.5,
            interactive: true, zIndexOffset: 500,
        });

        const labelText = agg.nameCn + (agg.nameEn !== agg.nameCn ? ' / ' + agg.nameEn : '');
        marker.bindTooltip(labelText, {
            permanent: true, direction: 'top',
            offset: L.point(0, -radius - 6), className: 'station-label',
        });

        marker._stationData = agg;
        marker.on('click', function(e) {
            L.DomEvent.stopPropagation(e);
            filterByStation(agg);
            openDetailPanel(agg);
        });
        stationMarkers[agg.id] = marker;
    }

    function createAllLayers(linePaths) {
        routesData.forEach(route => {
            const path = linePaths[route.id];
            if (path && path.length >= 2) createPolyline(route, path);
        });
        aggregatedStations.forEach(agg => createStationMarker(agg));
    }

    function isClickNearStation(latlng) {
        const clickPoint = map.latLngToContainerPoint(latlng);
        let minDist = Infinity;
        Object.values(stationMarkers).forEach(marker => {
            if (!stationLayerGroup.hasLayer(marker)) return;
            const dist = clickPoint.distanceTo(map.latLngToContainerPoint(marker.getLatLng()));
            if (dist < minDist) minDist = dist;
        });
        return minDist < CLICK_IGNORE_DISTANCE;
    }

    // ======================= UI 状态更新 =======================
    function updateStatusBar() {
        const bar = document.getElementById('statusBar');
        if (activeLineIds.size > 0) {
            const prefix = selectionType === 'station' ? '已选中站点：' : '已选中线路：';
            bar.textContent = prefix + selectionName;
            bar.classList.remove('empty');
        } else {
            bar.textContent = '未选中任何内容';
            bar.classList.add('empty');
        }
    }

    function updateDeselectButtons() {
        const hasSelection = activeLineIds.size > 0;
        document.getElementById('deselectAllBtn').disabled = !hasSelection;
        document.getElementById('deselectLastBtn').disabled = !hasSelection;
    }

    function updateCategoryButtons() {
        document.querySelectorAll('.category-btn').forEach(btn => {
            const cat = btn.dataset.category;
            btn.classList.toggle('active',
                cat === 'all'
                    ? activeCategories.size === ALL_CATEGORIES.length
                    : activeCategories.has(cat)
            );
        });
    }

    // ======================= 图层可见性 =======================
    /** 更新单条线路的样式（高亮/普通） */
    function refreshLineStyle(poly, isHighlighted) {
        if (isHighlighted) {
            poly.setStyle({ weight: 9, opacity: 1 });
            if (poly._path) poly._path.classList.add('line-highlighted');
            poly.bringToFront();
        } else {
            poly.setStyle({ weight: 5, opacity: 0.7 });
            if (poly._path) poly._path.classList.remove('line-highlighted');
        }
    }

    /** 根据分类与选中状态计算最终应显示的线路 ID */
    function computeVisibleLineIds() {
        const allowedLineIds = new Set();
        routesData.forEach(r => {
            if (activeCategories.has(r.category)) allowedLineIds.add(r.id);
        });

        if (activeLineIds.size === 0) return allowedLineIds;

        const selectedInCategory = new Set(
            [...activeLineIds].filter(id => allowedLineIds.has(id))
        );
        if (selectedInCategory.size > 0) return selectedInCategory;

        // 选中线路不在当前分类中，自动添加该分类
        const firstId = [...activeLineIds][0];
        const route = routesData.find(r => r.id === firstId);
        if (route) {
            activeCategories.add(route.category);
            updateCategoryButtons();
            rebuildSidebarList();
            return computeVisibleLineIds(); // 递归重试
        }
        return allowedLineIds;
    }

    /** 更新所有 polyline 的显示/隐藏及样式 */
    function applyPolylineVisibility(finalLineIds) {
        Object.values(linePolylines).forEach(poly => {
            const visible = finalLineIds.has(poly._lineId);
            if (visible && !lineLayerGroup.hasLayer(poly)) lineLayerGroup.addLayer(poly);
            else if (!visible && lineLayerGroup.hasLayer(poly)) lineLayerGroup.removeLayer(poly);
            if (visible) {
                refreshLineStyle(poly, activeLineIds.size > 0 && activeLineIds.has(poly._lineId));
            }
        });
    }

    /** 更新所有站点 marker 的显示/隐藏 */
    function applyStationVisibility(finalLineIds) {
        Object.values(stationMarkers).forEach(marker => {
            const agg = marker._stationData;
            const visible = agg.lineIds.some(lid => finalLineIds.has(lid));
            if (visible && !stationLayerGroup.hasLayer(marker)) stationLayerGroup.addLayer(marker);
            else if (!visible && stationLayerGroup.hasLayer(marker)) stationLayerGroup.removeLayer(marker);
        });
    }

    function applyLayerVisibility() {
        const finalLineIds = computeVisibleLineIds();
        applyPolylineVisibility(finalLineIds);
        applyStationVisibility(finalLineIds);
        updateStationLabels();
        updateStatusBar();
        updateDeselectButtons();
        rebuildSidebarList();
    }

    // ======================= 站名碰撞检测 =======================
    /** 计算可见站点的标签矩形 */
    function computeLabelRects(visibleMarkers) {
        return visibleMarkers
            .filter(m => m.getTooltip() && m.getTooltip().getElement())
            .map(marker => {
                const point = map.latLngToContainerPoint(marker.getLatLng());
                const text = marker._stationData.nameCn;
                const w = text.length * 14 + 32, h = 28;
                const x = point.x - w / 2, y = point.y - 28;
                return { marker, rect: L.bounds([x, y], [x + w, y + h]) };
            });
    }

    /** 从标签矩形列表中筛选互不重叠的标签（优先显示换乘站） */
    function filterNonOverlappingLabels(labelRects) {
        labelRects.sort((a, b) =>
            (b.marker._stationData.isTransfer ? 1 : 0) -
            (a.marker._stationData.isTransfer ? 1 : 0)
        );
        const displayed = [];
        labelRects.forEach(item => {
            if (!displayed.some(d => d.rect.intersects(item.rect))) displayed.push(item);
        });
        return displayed;
    }

    function updateStationLabels() {
        const visibleMarkers = Object.values(stationMarkers).filter(m => stationLayerGroup.hasLayer(m));
        const labelRects = computeLabelRects(visibleMarkers);
        const displayed = filterNonOverlappingLabels(labelRects);

        Object.values(stationMarkers).forEach(marker => {
            const tooltip = marker.getTooltip();
            if (!tooltip) return;
            const el = tooltip.getElement();
            if (!el) return;
            el.style.display = displayed.some(d => d.marker === marker) ? '' : 'none';
        });
    }

    // ======================= 详情面板 =======================
    /** 构建站名显示文本 */
    function buildStationName(nameCn, nameEn) {
        return nameCn + (nameEn !== nameCn ? ' / ' + nameEn : '');
    }

    /** 获取站点经过的线路信息 */
    function getStationLines(lineIds) {
        return lineIds.map(lid => {
            const route = routesData.find(r => r.id === lid);
            return route ? { id: route.id, color: route.color || '#888',
                name: route.nameCn || route.fullName || `线路${lid}` } : null;
        }).filter(Boolean);
    }

    /** 渲染线路标签 HTML */
    function renderLineTagsHTML(lines) {
        if (!lines.length) return '';
        return `<div class="section">
            <h3>经过线路（点击可高亮）</h3>
            <div class="line-tags">${lines.map(l =>
                `<span class="line-tag" style="background:${l.color};" data-line-id="${l.id}">● ${l.name}</span>`
            ).join('')}</div>
        </div>`;
    }

    /** 渲染出口信息 HTML */
    function renderExitsHTML(exits) {
        if (!exits || !exits.length) return '<div class="section"><em>暂无出口数据</em></div>';
        return `<div class="section">
            <h3>出口信息</h3>
            <div class="exits-list">${exits.map(e =>
                `<div class="exit-item"><span class="exit-name">${e.exit_name}</span><span class="exit-dest">${e.destination || ''}</span></div>`
            ).join('')}</div>
        </div>`;
    }

    function openDetailPanel(stationData) {
        document.getElementById('detail-panel').classList.remove('hidden');

        const name = buildStationName(stationData.nameCn, stationData.nameEn);
        document.getElementById('detailName').innerHTML = `<h3>🚉 ${name}</h3>`;

        const lines = getStationLines(stationData.lineIds);
        document.getElementById('detailLines').innerHTML = renderLineTagsHTML(lines);
        document.getElementById('detailExits').innerHTML = renderExitsHTML(stationData.exits);
    }

    function closeDetailPanel() {
        document.getElementById('detail-panel').classList.add('hidden');
    }

    // ======================= 筛选逻辑 =======================
    /** 确保线路所属分类已激活 */
    function ensureCategoryActive(route) {
        if (!activeCategories.has(route.category)) {
            activeCategories.add(route.category);
            updateCategoryButtons();
            rebuildSidebarList();
        }
    }

    function filterByLine(lineId) {
        const route = routesData.find(r => r.id === lineId);
        if (!route) return;
        ensureCategoryActive(route);

        if (activeLineIds.has(lineId)) {
            activeLineIds.delete(lineId);
            selectedLineOrder = selectedLineOrder.filter(id => id !== lineId);
        } else {
            activeLineIds.add(lineId);
            selectedLineOrder.push(lineId);
        }

        if (activeLineIds.size === 0) {
            selectionType = 'none'; selectionName = '';
        } else {
            selectionType = 'line';
            selectionName = buildSelectionNameFromIds();
        }
        updateDeselectButtons();
        applyLayerVisibility();
    }

    function filterByStation(agg) {
        const newSet = new Set(agg.lineIds);
        if (setsEqual(activeLineIds, newSet) && activeLineIds.size > 0) {
            clearSelectionState();
        } else {
            activeLineIds = newSet;
            selectedLineOrder = Array.from(newSet);
            selectionType = 'station';
            selectionName = buildStationName(agg.nameCn, agg.nameEn);
        }
        applyLayerVisibility();
    }

    // ======================= 取消选中 =======================
    function clearAllSelections() {
        clearSelectionState();
        applyLayerVisibility();
    }

    function clearLastSelection() {
        if (selectedLineOrder.length === 0) return;
        const lastId = selectedLineOrder.pop();
        activeLineIds.delete(lastId);
        if (activeLineIds.size === 0) {
            selectionType = 'none'; selectionName = '';
        } else {
            selectionName = buildSelectionNameFromIds();
        }
        updateDeselectButtons();
        applyLayerVisibility();
    }

    // ======================= 分类切换 =======================
    function toggleCategory(category) {
        if (category === 'all') {
            activeCategories = activeCategories.size === ALL_CATEGORIES.length
                ? new Set() : new Set(ALL_CATEGORIES);
        } else {
            if (activeCategories.has(category)) activeCategories.delete(category);
            else activeCategories.add(category);
        }
        clearSelectionState();
        updateCategoryButtons();
        applyLayerVisibility();
    }

    /** 重置为仅显示地铁 */
    function resetToMetroOnly() {
        activeCategories = new Set(['metro']);
        clearSelectionState();
        updateCategoryButtons();
        applyLayerVisibility();
    }

    // ======================= 侧边栏列表 =======================
    /** 根据搜索词过滤线路列表 */
    function filterRoutesBySearch(list, query) {
        if (!query) return list;
        return list.filter(r => {
            const cn = (r.nameCn || '').toLowerCase();
            const en = (r.nameEn || '').toLowerCase();
            const full = (r.fullName || '').toLowerCase();
            return cn.includes(query) || en.includes(query) || full.includes(query);
        });
    }

    /** 创建单个侧边栏线路项 DOM */
    function createSidebarItemElement(route) {
        const div = document.createElement('div');
        div.className = 'line-item';
        if (activeLineIds.has(route.id)) div.classList.add('active');
        div.dataset.lineId = route.id;
        div.style.setProperty('--line-color', route.color || '#888');
        const name = route.nameCn || route.fullName || `线路 ${route.id}`;
        div.innerHTML = `
            <div class="line-dot" style="background:${route.color || '#888'};"></div>
            <div class="line-info">
                <div class="line-name">${name}</div>
                <div class="line-meta"><span>${CATEGORY_CN_MAP[route.category] || route.mode}</span></div>
            </div>
            <span class="line-badge">${route.type || ''}</span>`;
        div.addEventListener('click', () => { filterByLine(route.id); });
        return div;
    }

    function renderSidebarItems(list) {
        const container = document.getElementById('linesList');
        container.innerHTML = '';
        list.forEach(route => container.appendChild(createSidebarItemElement(route)));
    }

    function rebuildSidebarList() {
        const query = document.getElementById('searchInput').value.trim().toLowerCase();
        let filtered = routesData.filter(r => activeCategories.has(r.category));
        renderSidebarItems(filterRoutesBySearch(filtered, query));
    }

    // ======================= 事件绑定 =======================
    function bindCategoryEvents() {
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleCategory(btn.dataset.category));
        });
    }

    function bindSearchEvents() {
        document.getElementById('searchInput').addEventListener('input', () => rebuildSidebarList());
    }

    function bindDeselectEvents() {
        document.getElementById('deselectAllBtn').addEventListener('click', clearAllSelections);
        document.getElementById('deselectLastBtn').addEventListener('click', clearLastSelection);
    }

    function bindZoomControls() {
        document.getElementById('ctrlZoomIn').addEventListener('click', () => map.zoomIn());
        document.getElementById('ctrlZoomOut').addEventListener('click', () => map.zoomOut());
        document.getElementById('ctrlReset').addEventListener('click', () => {
            if (defaultBounds) map.fitBounds(defaultBounds, { padding: [30, 30] });
        });
    }

    function bindSidebarToggle() {
        const sidebar = document.getElementById('sidebar');
        const toggleBtn = document.getElementById('toggle-sidebar');
        let visible = true;
        toggleBtn.addEventListener('click', () => {
            visible = !visible;
            sidebar.classList.toggle('collapsed', !visible);
            toggleBtn.classList.toggle('shifted', visible);
        });
    }

    function bindDetailPanelEvents() {
        document.getElementById('closeDetailBtn').addEventListener('click', closeDetailPanel);
        document.getElementById('detailContent').addEventListener('click', (e) => {
            const tag = e.target.closest('.line-tag');
            if (tag) {
                const lineId = parseInt(tag.dataset.lineId);
                if (!isNaN(lineId)) filterByLine(lineId);
            }
        });
    }

    function bindKeyboardEvents() {
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (activeLineIds.size > 0) {
                clearAllSelections();
            } else {
                resetToMetroOnly();
                map.closePopup();
            }
        });
    }

    function bindEvents() {
        bindCategoryEvents();
        bindSearchEvents();
        bindDeselectEvents();
        bindZoomControls();
        bindSidebarToggle();
        bindDetailPanelEvents();
        bindKeyboardEvents();
    }

    // ======================= 启动 =======================
    async function initialize() {
        const success = await loadDatabase();
        if (!success) return;
        aggregateStations();
        const linePaths = buildLinePaths();
        initMap();
        createAllLayers(linePaths);

        activeCategories = new Set(['metro']);
        selectionType = 'none'; selectionName = '';
        updateCategoryButtons();
        applyLayerVisibility();
        bindEvents();
        console.log('🚇 初始化完成');
    }

    window.addEventListener('load', initialize);
})();

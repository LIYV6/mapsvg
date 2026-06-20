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

    let selectionType = 'none';
    let selectionName = '';

    const BASE_RADIUS = 9;
    const TRANSFER_RADIUS = 13;
    const CLICK_IGNORE_DISTANCE = 20;

    const ALL_CATEGORIES = ['metro', 'high_speed', 'airplane', 'boat', 'cable_car'];
    const CATEGORY_CN_MAP = {
        metro: '地铁',
        high_speed: '高铁',
        airplane: '飞机',
        boat: '轮船',
        cable_car: '缆车'
    };

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
            const cols = routesRes[0].columns;
            routesData = routesRes[0].values.map(row => {
                const obj = {};
                cols.forEach((c, i) => obj[c] = row[i]);
                obj.category = calcCategory(obj.mode, obj.type);
                return obj;
            });
            const routeIds = routesData.map(r => r.id);
            const routeIdList = routeIds.join(',');

            const stRes = db.exec(`SELECT * FROM stations WHERE route_id IN (${routeIdList})`);
            allStationsData = [];
            if (stRes.length) {
                const stCols = stRes[0].columns;
                allStationsData = stRes[0].values.map(row => {
                    const obj = {};
                    stCols.forEach((c, i) => obj[c] = row[i]);
                    return obj;
                });
            }

            const stationIds = allStationsData.map(s => s.id);
            if (stationIds.length) {
                const stIdList = stationIds.join(',');
                const trRes = db.exec(`SELECT * FROM transfers WHERE hidden=0 AND station_id IN (${stIdList})`);
                transfersMap = {};
                if (trRes.length) {
                    const trCols = trRes[0].columns;
                    trRes[0].values.forEach(row => {
                        const obj = {};
                        trCols.forEach((c, i) => obj[c] = row[i]);
                        if (!transfersMap[obj.station_id]) transfersMap[obj.station_id] = [];
                        transfersMap[obj.station_id].push(obj);
                    });
                }

                const nrRes = db.exec(`SELECT * FROM nearby_transfers WHERE hidden=0 AND station_id IN (${stIdList})`);
                nearbyTransfersMap = {};
                if (nrRes.length) {
                    const nrCols = nrRes[0].columns;
                    nrRes[0].values.forEach(row => {
                        const obj = {};
                        nrCols.forEach((c, i) => obj[c] = row[i]);
                        if (!nearbyTransfersMap[obj.station_id]) nearbyTransfersMap[obj.station_id] = [];
                        nearbyTransfersMap[obj.station_id].push(obj);
                    });
                }

                const exRes = db.exec(`SELECT * FROM exits WHERE station_id IN (${stIdList})`);
                exitsMap = {};
                if (exRes.length) {
                    const exCols = exRes[0].columns;
                    exRes[0].values.forEach(row => {
                        const obj = {};
                        exCols.forEach((c, i) => obj[c] = row[i]);
                        if (!exitsMap[obj.station_id]) exitsMap[obj.station_id] = [];
                        exitsMap[obj.station_id].push(obj);
                    });
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

    function calcCategory(mode, type) {
        const m = String(mode || '').trim().toUpperCase();
        const t = String(type || '').trim().toUpperCase();
        if (m === 'AIRPLANE') return 'airplane';
        if (m === 'BOAT') return 'boat';
        if (m === 'CABLE_CAR') return 'cable_car';
        if (m === 'HIGH_SPEED') return 'high_speed';
        if (m === 'LIGHT_RAIL') return 'metro';
        if (m === 'TRAIN') {
            if (t === 'HIGH_SPEED') return 'high_speed';
            return 'metro';
        }
        return 'metro';
    }

    // ======================= 车站聚合 =======================
    function aggregateStations() {
        const groups = new Map();
        allStationsData.forEach(st => {
            const gridX = Math.round(st.x / 10) * 10;
            const gridZ = Math.round(st.z / 10) * 10;
            const key = `${st.nameCn}_${gridX}_${gridZ}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    stations: [],
                    nameCn: st.nameCn,
                    nameEn: st.nameEn || st.nameCn,
                    sumX: 0, sumZ: 0, count: 0
                });
            }
            const group = groups.get(key);
            group.stations.push(st);
            group.sumX += st.x;
            group.sumZ += st.z;
            group.count++;
        });

        aggregatedStations = [];
        stationIdToAggregated = {};

        groups.forEach(group => {
            const avgX = group.sumX / group.count;
            const avgZ = group.sumZ / group.count;
            const lineIds = new Set();
            const stationIds = new Set();
            group.stations.forEach(s => {
                lineIds.add(s.route_id);
                stationIds.add(s.id);
            });

            const transferList = [], seenTrans = new Set();
            group.stations.forEach(s => {
                (transfersMap[s.id] || []).forEach(t => {
                    const uniq = `${t.color}_${t.name}_${t.mode}`;
                    if (!seenTrans.has(uniq)) { seenTrans.add(uniq); transferList.push(t); }
                });
            });

            const nearbyList = [], seenNear = new Set();
            group.stations.forEach(s => {
                (nearbyTransfersMap[s.id] || []).forEach(n => {
                    const uniq = `${n.targetStationCn}_${n.lineName}`;
                    if (!seenNear.has(uniq)) { seenNear.add(uniq); nearbyList.push(n); }
                });
            });

            const exitList = [], seenExit = new Set();
            group.stations.forEach(s => {
                (exitsMap[s.id] || []).forEach(e => {
                    if (!seenExit.has(e.exit_name)) {
                        seenExit.add(e.exit_name);
                        exitList.push(e);
                    }
                });
            });

            aggregatedStations.push({
                id: `agg_${aggregatedStations.length}`,
                nameCn: group.nameCn,
                nameEn: group.nameEn,
                x: avgX,
                z: avgZ,
                lineIds: Array.from(lineIds),
                stationIds: Array.from(stationIds),
                transfers: transferList,
                nearby: nearbyList,
                exits: exitList,
                isTransfer: transferList.length > 0 || nearbyList.length > 0 || lineIds.length > 1
            });
        });

        aggregatedStations.forEach(agg => {
            agg.stationIds.forEach(sid => { stationIdToAggregated[sid] = agg; });
        });
        console.log(`🏙️ 聚合后车站数量：${aggregatedStations.length}`);
    }

    // ======================= 线路路径 =======================
    function buildLinePaths() {
        const linePaths = {};
        routesData.forEach(route => {
            const lineId = route.id;
            let orderedStations = allStationsData
                .filter(s => s.route_id === lineId && s.direction === 'forward')
                .sort((a, b) => a.station_index - b.station_index);
            if (orderedStations.length === 0) {
                orderedStations = allStationsData
                    .filter(s => s.route_id === lineId && s.direction === 'reverse')
                    .sort((a, b) => b.station_index - a.station_index);
            }
            if (orderedStations.length === 0) return;

            const pathCoords = [];
            orderedStations.forEach(st => {
                const agg = stationIdToAggregated[st.id];
                if (agg) {
                    const last = pathCoords[pathCoords.length - 1];
                    if (!last || last.x !== agg.x || last.z !== agg.z) {
                        pathCoords.push({ x: agg.x, z: agg.z });
                    }
                }
            });
            if (pathCoords.length > 1) linePaths[lineId] = pathCoords;
        });
        return linePaths;
    }

    // ======================= 地图初始化 =======================
    function initMap() {
        map = L.map('map', {
            crs: L.CRS.Simple,
            center: [0, 0],
            zoom: 0,
            minZoom: -4,
            maxZoom: 8,
            zoomControl: false,
            attributionControl: false,
        });
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        const gridLayer = L.gridLayer({ tileSize: 256 });
        gridLayer.createTile = function(coords) {
            const tile = L.DomUtil.create('canvas', 'leaflet-tile');
            const size = this.getTileSize();
            tile.width = size.x;
            tile.height = size.y;
            const ctx = tile.getContext('2d');
            ctx.strokeStyle = '#e8ecf2';
            ctx.lineWidth = 0.5;
            const step = 64;
            for (let x = 0; x < size.x; x += step) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.y); ctx.stroke();
            }
            for (let y = 0; y < size.y; y += step) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.x, y); ctx.stroke();
            }
            return tile;
        };
        gridLayer.addTo(map);

        lineLayerGroup = L.layerGroup().addTo(map);
        stationLayerGroup = L.layerGroup().addTo(map);

        const allX = aggregatedStations.map(s => s.x);
        const allZ = aggregatedStations.map(s => s.z);
        if (allX.length) {
            const bounds = L.latLngBounds(
                L.latLng(-Math.max(...allZ), Math.min(...allX)),
                L.latLng(-Math.min(...allZ), Math.max(...allX))
            );
            map.fitBounds(bounds, { padding: [30, 30] });
        }

        map.on('moveend zoomend', updateStationLabels);
        // 注意：不再监听地图空白点击关闭右侧面板
    }

    // ======================= 创建图层 =======================
    function createAllLayers(linePaths) {
        routesData.forEach(route => {
            const path = linePaths[route.id];
            if (!path || path.length < 2) return;
            const latlngs = path.map(p => L.latLng(-p.z, p.x));
            const polyline = L.polyline(latlngs, {
                color: route.color || '#888',
                weight: 5,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
                interactive: true,
                zIndexOffset: 0,
            });
            polyline._lineId = route.id;
            polyline.on('click', (e) => {
                if (isClickNearStation(e.latlng)) return;
                L.DomEvent.stopPropagation(e);
                filterByLine(route.id);
            });
            linePolylines[route.id] = polyline;
        });

        aggregatedStations.forEach(agg => {
            const latlng = L.latLng(-agg.z, agg.x);
            const radius = agg.isTransfer ? TRANSFER_RADIUS : BASE_RADIUS;
            const primaryColor = agg.lineIds.length === 1 ?
                (routesData.find(r => r.id === agg.lineIds[0]) || {}).color || '#888' : '#ffffff';

            const marker = L.circleMarker(latlng, {
                radius: radius,
                fillColor: agg.isTransfer ? '#ffffff' : primaryColor,
                fillOpacity: 1,
                color: agg.isTransfer ? '#2c3e50' : '#333',
                weight: agg.isTransfer ? 2.5 : 1.5,
                interactive: true,
                zIndexOffset: 500,
            });

            const labelText = agg.nameCn + (agg.nameEn !== agg.nameCn ? ' / ' + agg.nameEn : '');
            marker.bindTooltip(labelText, {
                permanent: true,
                direction: 'top',
                offset: L.point(0, -radius - 6),
                className: 'station-label',
            });

            marker._stationData = agg;
            marker.on('click', function(e) {
                L.DomEvent.stopPropagation(e);
                filterByStation(agg);
                openDetailPanel(agg);
            });
            stationMarkers[agg.id] = marker;
        });
    }

    function isClickNearStation(latlng) {
        const clickPoint = map.latLngToContainerPoint(latlng);
        let minDist = Infinity;
        Object.values(stationMarkers).forEach(marker => {
            if (!stationLayerGroup.hasLayer(marker)) return;
            const markerPoint = map.latLngToContainerPoint(marker.getLatLng());
            const dist = clickPoint.distanceTo(markerPoint);
            if (dist < minDist) minDist = dist;
        });
        return minDist < CLICK_IGNORE_DISTANCE;
    }

    // ======================= 状态提示条更新 =======================
    function updateStatusBar() {
        const bar = document.getElementById('statusBar');
        if (activeLineIds.size > 0) {
            if (selectionType === 'line') {
                bar.textContent = '已选中线路：' + selectionName;
                bar.classList.remove('empty');
            } else if (selectionType === 'station') {
                bar.textContent = '已选中站点：' + selectionName;
                bar.classList.remove('empty');
            }
        } else {
            bar.textContent = '未选中任何内容';
            bar.classList.add('empty');
        }
    }

    // ======================= 图层可见性 =======================
    function applyLayerVisibility() {
        const allowedLineIds = new Set();
        routesData.forEach(route => {
            if (activeCategories.has(route.category)) allowedLineIds.add(route.id);
        });

        let finalLineIds;
        if (activeLineIds.size > 0) {
            finalLineIds = new Set([...activeLineIds].filter(id => allowedLineIds.has(id)));
            if (finalLineIds.size === 0 && activeLineIds.size > 0) {
                const lineId = [...activeLineIds][0];
                const route = routesData.find(r => r.id === lineId);
                if (route) {
                    activeCategories.add(route.category);
                    updateCategoryButtons();
                    rebuildSidebarList();
                    applyLayerVisibility();
                    return;
                }
            }
        } else {
            finalLineIds = allowedLineIds;
        }

        Object.values(linePolylines).forEach(poly => {
            const shouldBeVisible = finalLineIds.has(poly._lineId);
            if (shouldBeVisible && !lineLayerGroup.hasLayer(poly)) {
                lineLayerGroup.addLayer(poly);
            } else if (!shouldBeVisible && lineLayerGroup.hasLayer(poly)) {
                lineLayerGroup.removeLayer(poly);
            }
            if (shouldBeVisible) {
                const isHighlighted = activeLineIds.size > 0 && activeLineIds.has(poly._lineId);
                poly.setStyle({ weight: isHighlighted ? 7 : 5, opacity: 0.9 });
                if (isHighlighted) poly.bringToFront();
            }
        });

        Object.values(stationMarkers).forEach(marker => {
            const agg = marker._stationData;
            const shouldBeVisible = agg.lineIds.some(lid => finalLineIds.has(lid));
            if (shouldBeVisible && !stationLayerGroup.hasLayer(marker)) {
                stationLayerGroup.addLayer(marker);
            } else if (!shouldBeVisible && stationLayerGroup.hasLayer(marker)) {
                stationLayerGroup.removeLayer(marker);
            }
        });

        updateStationLabels();
        updateStatusBar();
    }

    // ======================= 站名碰撞检测 =======================
    function updateStationLabels() {
        const visibleMarkers = Object.values(stationMarkers).filter(m => stationLayerGroup.hasLayer(m));
        const labelRects = [];
        visibleMarkers.forEach(marker => {
            const tooltip = marker.getTooltip();
            if (!tooltip) return;
            const el = tooltip.getElement();
            if (!el) return;
            const point = map.latLngToContainerPoint(marker.getLatLng());
            const text = marker._stationData.nameCn;
            const estimatedWidth = text.length * 14 + 32;
            const estimatedHeight = 28;
            const x = point.x - estimatedWidth / 2;
            const y = point.y - 28;
            labelRects.push({ marker, rect: L.bounds([x, y], [x + estimatedWidth, y + estimatedHeight]) });
        });
        labelRects.sort((a, b) => (b.marker._stationData.isTransfer ? 1 : 0) - (a.marker._stationData.isTransfer ? 1 : 0));

        const displayed = [];
        labelRects.forEach(item => {
            if (!displayed.some(d => d.rect.intersects(item.rect))) displayed.push(item);
        });

        Object.values(stationMarkers).forEach(marker => {
            const tooltip = marker.getTooltip();
            if (!tooltip) return;
            const el = tooltip.getElement();
            if (!el) return;
            const shouldShow = displayed.some(d => d.marker === marker);
            el.style.display = shouldShow ? '' : 'none';
        });
    }

    // ======================= 右侧固定详情面板 =======================
    function openDetailPanel(stationData) {
        const panel = document.getElementById('detail-panel');
        // 确保面板可见（如果之前被手动隐藏，则重新显示）
        panel.classList.remove('hidden');

        const nameDiv = document.getElementById('detailName');
        const linesDiv = document.getElementById('detailLines');
        const exitsDiv = document.getElementById('detailExits');

        const stationName = stationData.nameCn + (stationData.nameEn !== stationData.nameCn ? ' / ' + stationData.nameEn : '');
        nameDiv.innerHTML = `<h3>🚉 ${stationName}</h3>`;

        const lines = stationData.lineIds.map(lid => {
            const route = routesData.find(r => r.id === lid);
            return route ? { id: route.id, color: route.color || '#888', name: route.nameCn || route.fullName || `线路${lid}` } : null;
        }).filter(Boolean);
        linesDiv.innerHTML = lines.length ? `
            <div class="section">
                <h3>经过线路（点击可高亮）</h3>
                <div class="line-tags">
                    ${lines.map(l => `<span class="line-tag" style="background:${l.color};" data-line-id="${l.id}">● ${l.name}</span>`).join('')}
                </div>
            </div>` : '';

        const exits = stationData.exits || [];
        exitsDiv.innerHTML = exits.length ? `
            <div class="section">
                <h3>出口信息</h3>
                <div class="exits-list">
                    ${exits.map(e => `<div class="exit-item"><span class="exit-name">${e.exit_name}</span><span class="exit-dest">${e.destination || ''}</span></div>`).join('')}
                </div>
            </div>` : '<div class="section"><em>暂无出口数据</em></div>';
    }

    function closeDetailPanel() {
        document.getElementById('detail-panel').classList.add('hidden');
    }

    // 详情面板中线路标签点击事件委托
    document.getElementById('detailContent').addEventListener('click', (e) => {
        const tag = e.target.closest('.line-tag');
        if (tag) {
            const lineId = parseInt(tag.dataset.lineId);
            if (!isNaN(lineId)) filterByLine(lineId);
        }
    });

    // ======================= 筛选逻辑 =======================
    function filterByLine(lineId) {
        const route = routesData.find(r => r.id === lineId);
        if (!route) return;
        if (!activeCategories.has(route.category)) {
            activeCategories.add(route.category);
            updateCategoryButtons();
            rebuildSidebarList();
        }
        if (activeLineIds.size === 1 && activeLineIds.has(lineId)) {
            activeLineIds.clear();
            selectionType = 'none';
            selectionName = '';
        } else {
            activeLineIds = new Set([lineId]);
            selectionType = 'line';
            selectionName = route.nameCn || route.fullName || `线路${lineId}`;
        }
        applyLayerVisibility();
    }

    function filterByStation(agg) {
        const newSet = new Set(agg.lineIds);
        if (setsEqual(activeLineIds, newSet) && activeLineIds.size > 0) {
            activeLineIds.clear();
            selectionType = 'none';
            selectionName = '';
        } else {
            activeLineIds = newSet;
            selectionType = 'station';
            selectionName = agg.nameCn + (agg.nameEn !== agg.nameCn ? ' / ' + agg.nameEn : '');
        }
        applyLayerVisibility();
    }

    function setsEqual(a, b) {
        if (a.size !== b.size) return false;
        for (const item of a) if (!b.has(item)) return false;
        return true;
    }

    // ======================= 分类切换 =======================
    function toggleCategory(category) {
        if (category === 'all') {
            if (activeCategories.size === ALL_CATEGORIES.length) {
                activeCategories.clear();
            } else {
                activeCategories = new Set(ALL_CATEGORIES);
            }
        } else {
            if (activeCategories.has(category)) {
                activeCategories.delete(category);
            } else {
                activeCategories.add(category);
            }
        }
        activeLineIds.clear();
        selectionType = 'none';
        selectionName = '';
        updateCategoryButtons();
        applyLayerVisibility();
        rebuildSidebarList();
    }

    function updateCategoryButtons() {
        document.querySelectorAll('.category-btn').forEach(btn => {
            const cat = btn.dataset.category;
            if (cat === 'all') {
                btn.classList.toggle('active', activeCategories.size === ALL_CATEGORIES.length);
            } else {
                btn.classList.toggle('active', activeCategories.has(cat));
            }
        });
    }

    // ======================= 侧边栏列表 =======================
    function rebuildSidebarList() {
        const listContainer = document.getElementById('linesList');
        const searchInput = document.getElementById('searchInput');
        let filtered = routesData.filter(r => activeCategories.has(r.category));
        const query = searchInput.value.trim().toLowerCase();
        if (query) {
            filtered = filtered.filter(r => {
                const cn = (r.nameCn || '').toLowerCase();
                const en = (r.nameEn || '').toLowerCase();
                const full = (r.fullName || '').toLowerCase();
                return cn.includes(query) || en.includes(query) || full.includes(query);
            });
        }
        renderSidebarItems(filtered);
    }

    function renderSidebarItems(list) {
        const listContainer = document.getElementById('linesList');
        listContainer.innerHTML = '';
        list.forEach(route => {
            const div = document.createElement('div');
            div.className = 'line-item';
            div.dataset.lineId = route.id;
            div.style.setProperty('--line-color', route.color || '#888');
            const name = route.nameCn || route.fullName || `线路 ${route.id}`;
            div.innerHTML = `
                <div class="line-dot" style="background:${route.color||'#888'};"></div>
                <div class="line-info">
                    <div class="line-name">${name}</div>
                    <div class="line-meta"><span>${CATEGORY_CN_MAP[route.category] || route.mode}</span></div>
                </div>
                <span class="line-badge">${route.type||''}</span>
            `;
            div.addEventListener('click', () => filterByLine(route.id));
            listContainer.appendChild(div);
        });
    }

    // ======================= 事件绑定 =======================
    function bindEvents() {
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.dataset.category;
                toggleCategory(cat);
            });
        });

        document.getElementById('searchInput').addEventListener('input', () => rebuildSidebarList());

        document.getElementById('showAllBtn').addEventListener('click', (e) => {
            e.preventDefault();
            window.open('https://metro.liyv.me', '_blank');
        });

        const sidebar = document.getElementById('sidebar');
        const toggleBtn = document.getElementById('toggle-sidebar');
        let sidebarVisible = true;
        toggleBtn.addEventListener('click', () => {
            sidebarVisible = !sidebarVisible;
            sidebar.classList.toggle('collapsed', !sidebarVisible);
            toggleBtn.classList.toggle('shifted', sidebarVisible);
        });

        // 关闭右侧面板按钮
        document.getElementById('closeDetailBtn').addEventListener('click', closeDetailPanel);

        // Esc 行为：第一次取消选中，第二次重置为仅地铁
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (activeLineIds.size > 0) {
                    // 有选中状态：清除选中
                    activeLineIds.clear();
                    selectionType = 'none';
                    selectionName = '';
                    applyLayerVisibility();
                } else {
                    // 无选中状态：重置为仅地铁
                    activeCategories = new Set(['metro']);
                    activeLineIds.clear();
                    selectionType = 'none';
                    selectionName = '';
                    updateCategoryButtons();
                    applyLayerVisibility();
                    rebuildSidebarList();
                    map.closePopup();
                }
            }
        });
    }

    // ======================= 启动 =======================
    window.addEventListener('load', async () => {
        const success = await loadDatabase();
        if (!success) return;
        aggregateStations();
        const linePaths = buildLinePaths();
        initMap();
        createAllLayers(linePaths);

        // 默认只选中地铁
        activeCategories = new Set(['metro']);
        selectionType = 'none';
        selectionName = '';
        updateCategoryButtons();
        applyLayerVisibility();
        rebuildSidebarList();
        bindEvents();
        console.log('🚇 固定侧边栏 + 优化Esc逻辑 初始化完成');
    });
})();
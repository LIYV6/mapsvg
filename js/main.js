/**
 * 轨道交通线路图 - 主模块
 * SVG 渲染、交互、初始化
 */

// ========== 常量 ==========

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.3;
const MAX_SCALE = 8;
const VIEWBOX_MAX = 5000;

const STATION_TYPES = [
    "shmetro-basic", "shmetro-basic-2020",
    "shmetro-int", "bjsubway-basic", "mtr"
];

// ========== 全局状态 ==========

let svgElement = null;
let containerElement = null;
let currentMapData = null;
let nodesMap = new Map();
let tooltipDiv = null;

let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let viewStartX = 0, viewStartY = 0;
let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
let initialVB = { x: 0, y: 0, w: 0, h: 0 };

// ========== 工具函数 ==========

/** 从样式对象中提取颜色值，如 ["other","other","#ff00ff","#fff"] → #ff00ff */
function extractColor(styleObj) {
    if (!styleObj) return "#888888";
    const c = styleObj.color;
    if (Array.isArray(c) && c.length >= 3) return c[2];
    if (typeof c === "string") return c;
    return "#888888";
}

/** 根据节点类型获取车站名称 [中文名, 英文名] 或 null */
function getStationNames(node) {
    const attr = node.attributes;
    const type = attr.type;
    const data = attr[type];
    if (data && data.names) return data.names;
    return null;
}

/** 解析所有节点：标准站点 + misc_node 辅助节点 */
function buildNodesMap(jsonData) {
    const map = new Map();
    const nodes = jsonData.graph.nodes || [];

    for (const node of nodes) {
        if (!node.attributes) continue;
        if (typeof node.attributes.x !== "number" || typeof node.attributes.y !== "number") continue;

        const isMisc = node.key && node.key.startsWith("misc_node");
        map.set(node.key, {
            key: node.key,
            x: node.attributes.x,
            y: node.attributes.y,
            type: node.attributes.type || "unknown",
            rawData: node,
            isVirtual: node.attributes.type === "virtual",
            isStation: !isMisc
        });
    }
    return map;
}

/** 解析所有边 */
function buildEdges(jsonData) {
    return (jsonData.graph.edges || []).map(edge => ({
        sourceKey: edge.source,
        targetKey: edge.target,
        attrs: edge.attributes,
        style: edge.attributes?.style,
        colorStyle: edge.attributes?.["single-color"]
                 || edge.attributes?.["mtr-race-days"]
                 || edge.attributes?.["shinkansen"]
    }));
}

/** 计算整体视口范围 */
function getViewBoxBounds(nodesMap) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodesMap.values()) {
        if (node.x < minX) minX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.x > maxX) maxX = node.x;
        if (node.y > maxY) maxY = node.y;
    }
    if (!isFinite(minX)) return { minX: -200, minY: -200, maxX: 800, maxY: 800 };
    const pad = 60;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** 创建 SVG 元素并设置属性 */
function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    return el;
}

// ========== Tooltip ==========

function initTooltip() {
    if (!tooltipDiv) {
        tooltipDiv = document.createElement("div");
        tooltipDiv.className = "tooltip-dive";
        document.body.appendChild(tooltipDiv);
    }
}

function showTooltip(chnName, engName, x, y) {
    if (!tooltipDiv) initTooltip();
    if (!chnName) { tooltipDiv.style.display = "none"; return; }

    const svg = document.getElementById("railSvg");
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const ctm = svg.getScreenCTM();
    if (!ctm) { tooltipDiv.style.display = "none"; return; }

    const sp = pt.matrixTransform(ctm);
    tooltipDiv.style.left = (sp.x + 15) + "px";
    tooltipDiv.style.top = (sp.y - 25) + "px";
    tooltipDiv.style.display = "block";
    tooltipDiv.textContent = engName ? `${chnName}  ·  ${engName}` : chnName;
}

// ========== 渲染函数 ==========

function renderEdges(svg, nodesMap, edges) {
    const group = svgEl("g", { class: "edges-layer" });

    for (const edge of edges) {
        const src = nodesMap.get(edge.sourceKey);
        const tgt = nodesMap.get(edge.targetKey);
        if (!src || !tgt) continue;
        if (edge.attrs?.visible === false) continue;

        let color = "#aaa";
        if (edge.colorStyle) color = extractColor(edge.colorStyle);
        else if (edge.attrs?.["single-color"]) color = extractColor(edge.attrs["single-color"]);

        let width = 2.5;
        const st = edge.attrs?.style;
        if (st === "shinkansen") width = 3.2;
        else if (st === "mtr-race-days") width = 2.8;

        group.appendChild(svgEl("line", {
            x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y,
            stroke: color, "stroke-width": width,
            "stroke-linecap": "round", "stroke-linejoin": "round",
            opacity: "0.85"
        }));
    }
    svg.appendChild(group);
}

/** 为站点绑定交互事件 */
function bindStationEvents(shape, chnName, engName, x, y, tooltipCallback) {
    shape.classList.add("station-circle");
    shape.addEventListener("mouseenter", () => tooltipCallback(chnName, engName, x, y));
    shape.addEventListener("mouseleave", () => tooltipCallback(null));
    shape.addEventListener("click", () => {
        if (window.confirmInfo) {
            window.confirmInfo(`车站: ${chnName}\n英文: ${engName || "无"}`);
        } else {
            alert(`🚉 ${chnName} ${engName ? "(" + engName + ")" : ""}`);
        }
    });
}

/** 渲染站点标签（中英文） */
function renderStationLabel(group, cx, cy, chnName, engName, rawAttr) {
    const typeKey = rawAttr.type;
    const typeData = rawAttr[typeKey] || {};
    const nameOffsetX = typeData.nameOffsetX;
    const nameOffsetY = typeData.nameOffsetY;

    let labelX = cx, textAnchor = "middle", dyOffset = 0;
    if (nameOffsetX === "left") { labelX = cx - 12; textAnchor = "end"; }
    else if (nameOffsetX === "right") { labelX = cx + 12; textAnchor = "start"; }
    if (nameOffsetY === "top") dyOffset = -12;
    else if (nameOffsetY === "bottom") dyOffset = 14;

    const hasEng = engName && engName.trim();
    const baseDy = hasEng ? (nameOffsetY === "bottom" ? 4 : -5) : 0;
    const chnDy = dyOffset + baseDy;

    let displayName = chnName;
    if (chnName && chnName.length > 8) displayName = chnName.slice(0, 8) + "..";

    group.appendChild(svgEl("text", {
        x: labelX, y: cy + chnDy, "text-anchor": textAnchor,
        class: "station-label", "font-size": "11",
        fill: "#1f2d3d", "font-weight": "500"
    })).textContent = displayName;

    if (hasEng) {
        group.appendChild(svgEl("text", {
            x: labelX, y: cy + chnDy + 11, "text-anchor": textAnchor,
            class: "station-label station-label-en", "font-size": "8",
            fill: "#6b7c8d", "font-weight": "normal"
        })).textContent = engName.trim();
    }
}

function renderStations(svg, nodesMap, tooltipCallback) {
    const group = svgEl("g", { class: "stations-layer" });

    const stationNodes = Array.from(nodesMap.values()).filter(
        node => STATION_TYPES.includes(node.rawData?.attributes?.type)
    );

    for (const node of stationNodes) {
        const rawAttr = node.rawData.attributes;
        const isInt = rawAttr.type === "shmetro-int";
        const names = getStationNames(node.rawData);
        const chnName = names ? names[0] : node.key.slice(0, 12);
        const engName = names?.[1] || "";
        const cx = node.x, cy = node.y;

        if (isInt) {
            // 换乘站：同心圆
            group.appendChild(svgEl("circle", {
                cx, cy, r: "9", fill: "#ffffff",
                stroke: "#5a6c7e", "stroke-width": "1.8"
            }));
            const inner = svgEl("circle", {
                cx, cy, r: "5", fill: "#5a6c7e"
            });
            bindStationEvents(inner, chnName, engName, cx, cy, tooltipCallback);
            group.appendChild(inner);
        } else {
            // 普通站：白底圆
            const circle = svgEl("circle", {
                cx, cy, r: "6", fill: "#f8f9fa",
                stroke: "#5a6c7e", "stroke-width": "1.8"
            });
            bindStationEvents(circle, chnName, engName, cx, cy, tooltipCallback);
            group.appendChild(circle);
        }

        renderStationLabel(group, cx, cy, chnName, engName, rawAttr);
    }
    svg.appendChild(group);
}

function renderMiscElements(svg, nodesMap) {
    const group = svgEl("g", { class: "misc-layer" });

    const miscTypes = new Set(["text", "facilities", "shmetro-text-line-badge", "london-arrow"]);
    const miscEntries = Array.from(nodesMap.entries()).filter(
        ([, node]) => miscTypes.has(node.rawData?.attributes?.type)
    );

    for (const [, node] of miscEntries) {
        const attrs = node.rawData.attributes;
        const type = attrs.type;
        const x = node.x, y = node.y;

        if (type === "text" && attrs.text) {
            const t = attrs.text;
            let fillColor = "#333";
            if (Array.isArray(t.color)) fillColor = t.color[2] || "#333";
            const txt = svgEl("text", {
                x, y, "text-anchor": t.textAnchor || "middle",
                "dominant-baseline": t.dominantBaseline || "middle",
                "font-size": t.fontSize || "12", fill: fillColor,
                "font-style": t.italic != null ? t.italic : "normal",
                "font-weight": t.bold != null ? t.bold : "normal"
            });
            txt.classList.add("misc-text");
            txt.textContent = t.content || "";
            group.appendChild(txt);
        }
        else if (type === "shmetro-text-line-badge" && attrs["shmetro-text-line-badge"]) {
            const badge = attrs["shmetro-text-line-badge"];
            const names = badge.names || ["线路", "Line"];
            const bgColor = Array.isArray(badge.color) ? badge.color[2] : "#ccc";
            const textColor = Array.isArray(badge.color) && badge.color[3] ? badge.color[3] : "#fff";

            group.appendChild(svgEl("rect", {
                x: x - 20, y: y - 10, width: "40", height: "18",
                rx: "9", fill: bgColor
            }));
            group.appendChild(svgEl("text", {
                x, y: y + 2, "text-anchor": "middle",
                fill: textColor, "font-size": "10", "font-weight": "bold"
            })).textContent = names[0] || names[1] || "LINE";
        }
        else if (type === "london-arrow" && attrs["london-arrow"]) {
            group.appendChild(svgEl("polygon", {
                points: `${x - 6},${y - 4} ${x + 4},${y} ${x - 6},${y + 4}`,
                fill: extractColor(attrs["london-arrow"]),
                opacity: "0.8"
            }));
        }
        else if (type === "facilities" && attrs.facilities) {
            const facType = attrs.facilities.type;
            let symbol = "📍", color = "#4b6e8a";
            if (facType === "airport_hk") { symbol = "✈️"; color = "#2c7a4d"; }
            else if (facType === "railway_suzhou") { symbol = "🚉"; color = "#b45f2e"; }
            else if (facType === "river_craft") { symbol = "⛴️"; color = "#2a7f8a"; }

            group.appendChild(svgEl("circle", {
                cx: x, cy: y, r: "12", fill: "white",
                "fill-opacity": "0.6", stroke: color, "stroke-width": "1"
            }));
            const txtSym = svgEl("text", {
                x, y, "text-anchor": "middle", "dominant-baseline": "middle",
                "font-size": "20"
            });
            txtSym.classList.add("facility-icon");
            txtSym.textContent = symbol;
            group.appendChild(txtSym);
        }
    }
    svg.appendChild(group);
}

// ========== 视口控制 ==========

function readViewBox() {
    const parts = svgElement.getAttribute("viewBox").split(" ").map(Number);
    vbX = parts[0]; vbY = parts[1]; vbW = parts[2]; vbH = parts[3];
}

function applyViewBox() {
    if (vbW > VIEWBOX_MAX) vbW = VIEWBOX_MAX;
    if (vbH > VIEWBOX_MAX) vbH = VIEWBOX_MAX;
    svgElement.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
}

function resetView() {
    const rect = containerElement.getBoundingClientRect();
    const fitScale = Math.max(initialVB.w / rect.width, initialVB.h / rect.height);
    const cx = initialVB.x + initialVB.w / 2;
    const cy = initialVB.y + initialVB.h / 2;

    vbW = initialVB.w;
    vbH = initialVB.h;
    vbX = cx - (rect.width / 2) * fitScale;
    vbY = cy - (rect.height / 2) * fitScale;
    applyViewBox();
}

function zoomAtPoint(clientX, clientY, factor) {
    const rect = containerElement.getBoundingClientRect();
    const ratioX = (clientX - rect.left) / rect.width;
    const ratioY = (clientY - rect.top) / rect.height;

    const newW = vbW * factor;
    const newH = vbH * factor;
    const scale = initialVB.w / newW;
    if (scale < MIN_SCALE || scale > MAX_SCALE) return;

    vbX += (vbW - newW) * ratioX;
    vbY += (vbH - newH) * ratioY;
    vbW = newW;
    vbH = newH;
    applyViewBox();
}

function zoomCenter(factor) {
    const rect = containerElement.getBoundingClientRect();
    zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

// ========== 主渲染 ==========

function renderMap(jsonData) {
    if (!jsonData?.graph) {
        alert("无效的JSON结构，缺少 graph 字段");
        return false;
    }

    const svg = svgElement;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    nodesMap = buildNodesMap(jsonData);
    const edges = buildEdges(jsonData);

    const bounds = getViewBoxBounds(nodesMap);
    vbX = bounds.minX; vbY = bounds.minY;
    vbW = bounds.maxX - bounds.minX;
    vbH = bounds.maxY - bounds.minY;
    initialVB = { x: vbX, y: vbY, w: vbW, h: vbH };
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);

    renderEdges(svg, nodesMap, edges);
    renderStations(svg, nodesMap, (chn, eng, x, y) => showTooltip(chn, eng, x, y));
    renderMiscElements(svg, nodesMap);

    const stationCount = Array.from(nodesMap.values()).filter(n => n.isStation).length;
    const curFile = document.getElementById("mapSelector").value.replace(".json", "");
    document.getElementById("statusMsg").innerHTML = `✅ ${curFile} · 站点: ${stationCount}`;
    return true;
}

// ========== 交互事件 ==========

function bindInteraction() {
    // --- 鼠标事件 ---
    containerElement.addEventListener("mousedown", function (e) {
        if (e.target.closest("button, input, select, textarea, .zoom-controls")) return;
        isDragging = true;
        readViewBox();
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        viewStartX = vbX;
        viewStartY = vbY;
        svgElement.style.cursor = "grabbing";
        e.preventDefault();
    });

    window.addEventListener("mousemove", function (e) {
        if (!isDragging) return;
        const rect = containerElement.getBoundingClientRect();
        const dx = (e.clientX - dragStartX) * (vbW / rect.width);
        const dy = (e.clientY - dragStartY) * (vbH / rect.height);
        vbX = viewStartX - dx;
        vbY = viewStartY - dy;
        applyViewBox();
    });

    window.addEventListener("mouseup", function () {
        if (isDragging) {
            isDragging = false;
            svgElement.style.cursor = "grab";
        }
    });

    containerElement.addEventListener("wheel", function (e) {
        if (e.target.closest("select, input, textarea")) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        zoomAtPoint(e.clientX, e.clientY, delta);
    }, { passive: false });

    // --- 触摸事件（移动端拖拽 + 双指缩放） ---
    let lastTouchDist = 0;
    let lastTouchCenter = null;

    function getTouchDist(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function getTouchCenter(touches) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2
        };
    }

    containerElement.addEventListener("touchstart", function (e) {
        if (e.target.closest("button, input, select, textarea, .zoom-controls, .clock-widget")) return;
        if (e.touches.length === 1) {
            isDragging = true;
            readViewBox();
            dragStartX = e.touches[0].clientX;
            dragStartY = e.touches[0].clientY;
            viewStartX = vbX;
            viewStartY = vbY;
        } else if (e.touches.length === 2) {
            isDragging = false;
            lastTouchDist = getTouchDist(e.touches);
            lastTouchCenter = getTouchCenter(e.touches);
            readViewBox();
        }
    }, { passive: true });

    containerElement.addEventListener("touchmove", function (e) {
        if (e.target.closest("button, input, select, textarea, .zoom-controls, .clock-widget")) return;
        e.preventDefault();
        if (e.touches.length === 1 && isDragging) {
            const rect = containerElement.getBoundingClientRect();
            const dx = (e.touches[0].clientX - dragStartX) * (vbW / rect.width);
            const dy = (e.touches[0].clientY - dragStartY) * (vbH / rect.height);
            vbX = viewStartX - dx;
            vbY = viewStartY - dy;
            applyViewBox();
        } else if (e.touches.length === 2) {
            const newDist = getTouchDist(e.touches);
            const center = getTouchCenter(e.touches);
            if (lastTouchDist > 0) {
                const factor = lastTouchDist / newDist;
                zoomAtPoint(center.x, center.y, factor);
            }
            lastTouchDist = newDist;
            lastTouchCenter = center;
        }
    }, { passive: false });

    containerElement.addEventListener("touchend", function () {
        isDragging = false;
        lastTouchDist = 0;
        lastTouchCenter = null;
    }, { passive: true });

    window.addEventListener("keydown", function (e) {
        if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT") return;

        const PAN = 0.1;
        switch (e.key) {
            case "+": case "=": e.preventDefault(); zoomCenter(1 / 1.15); break;
            case "-": case "_": e.preventDefault(); zoomCenter(1.15); break;
            case "ArrowUp":    e.preventDefault(); readViewBox(); vbY -= vbH * PAN; applyViewBox(); break;
            case "ArrowDown":  e.preventDefault(); readViewBox(); vbY += vbH * PAN; applyViewBox(); break;
            case "ArrowRight": e.preventDefault(); readViewBox(); vbX += vbW * PAN; applyViewBox(); break;
            case "ArrowLeft":  e.preventDefault(); readViewBox(); vbX -= vbW * PAN; applyViewBox(); break;
            case "Escape":     e.preventDefault(); resetView(); break;
        }
    });

    document.getElementById("zoomIn").addEventListener("click", () => zoomCenter(1 / 1.2));
    document.getElementById("zoomOut").addEventListener("click", () => zoomCenter(1.2));
    document.getElementById("resetViewBtn").addEventListener("click", () => resetView());

    window.addEventListener("resize", function () {
        if (currentMapData) resetView();
    });
}

// ========== 初始化 ==========

async function loadMap(fileName) {
    const statusEl = document.getElementById("statusMsg");
    statusEl.innerHTML = "⏳ 加载中...";

    const svg = svgElement;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute("viewBox", "0 0 800 200");

    const loadingText = svgEl("text", {
        x: "400", y: "100", "text-anchor": "middle",
        "dominant-baseline": "middle", "font-size": "18",
        fill: "#999"
    });
    loadingText.textContent = "正在加载地图数据...";
    svg.appendChild(loadingText);

    try {
        const resp = await fetch("./data/" + fileName);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        currentMapData = await resp.json();
        renderMap(currentMapData);
        setTimeout(() => resetView(), 50);
    } catch (err) {
        console.warn("加载JSON失败:", err);
        statusEl.innerHTML = "❌ 加载失败";
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const errText = svgEl("text", {
            x: "400", y: "100", "text-anchor": "middle",
            "dominant-baseline": "middle", "font-size": "16",
            fill: "#c0392b"
        });
        errText.textContent = "地图数据加载失败";
        svg.appendChild(errText);
    }
}

window.onload = async function () {
    svgElement = document.getElementById("railSvg");
    containerElement = document.getElementById("container");
    initTooltip();
    bindInteraction();

    const selector = document.getElementById("mapSelector");
    selector.addEventListener("change", function () {
        loadMap(this.value);
    });

    await loadMap(selector.value);

    window.confirmInfo = function (msg) {
        const el = document.getElementById("statusMsg");
        el.innerHTML = `ℹ️ ${msg}`;
        setTimeout(function () {
            if (currentMapData) {
                const cur = document.getElementById("mapSelector").value.replace(".json", "");
                el.innerHTML = `✅ ${cur}`;
            }
        }, 2000);
    };
};

// ==================== 统一调试配置 ====================
const MAP_DEBUG_CONFIG = {
    // 全局调试开关：true 启用所有调试日志，false 关闭
    enabled: false,
    
    // 模块级开关
    modules: {
        data: true           // 数据加载相关日志
    }
};

/**
 * 统一调试日志函数
 * @param {string} module - 模块名称 ('data')
 * @param {...*} args - 日志内容
 */
function debugLog(module, ...args) {
    if (!MAP_DEBUG_CONFIG.enabled) return;
    if (!MAP_DEBUG_CONFIG.modules[module]) return;
    
    const prefix = `[Map-${module}]`;
    console.log(prefix, ...args);
}
// ================================================
// DOM加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否在 route.html 中（线路图在 tab 内）
    const isRoutePage = document.getElementById('route-map-content') !== null;
    
    // 如果在 route.html 中，只有当线路图 tab 被激活时才初始化
    if (isRoutePage) {
        const routeMapTab = document.querySelector('[data-tab="route-map"]');
        const routeMapContent = document.getElementById('route-map-content');
        
        // 监听 tab 切换事件
        if (routeMapTab && routeMapContent) {
            let initialized = false;
            
            routeMapTab.addEventListener('click', function() {
                if (!initialized) {
                    // 延迟初始化，等待 tab 内容显示
                    setTimeout(() => {
                        initLinemap();
                        initialized = true;
                    }, 100);
                }
            });
            
            // 如果线路图 tab 默认是 active，立即初始化
            if (routeMapTab.classList.contains('active')) {
                setTimeout(() => {
                    initLinemap();
                    initialized = true;
                }, 100);
            }
        }
    } else {
        // 在 linemap.html 中，直接初始化
        initLinemap();
    }
});

// 将 linemap 初始化逻辑封装为函数
function initLinemap() {
    // 不再需要调用adjustMapContainerPosition，CSS已直接定位
    
    // ========== 核心变量定义 ==========
    const mapContainer = document.getElementById('mapContainer');
    const subwayMap = document.getElementById('subwayMap');
    const zoomInBtn = document.getElementById('zoomIn');
    const zoomOutBtn = document.getElementById('zoomOut');
    const resetBtn = document.getElementById('reset');
    const infoBtn = document.getElementById('infoBtn');
    const infoModal = document.getElementById('infoModal');
    const closeBtn = document.getElementById('closeBtn');
    const infoText = document.getElementById('info-text');
    
    // 地图导航按钮（支持旧的wrapper结构和新的sub-nav结构）
    const mapNavItems = document.querySelectorAll('.map-nav-item[data-map]');

    // 图片状态变量
    let scale = 1; // 缩放比例
    let posX = 0;  // 图片X偏移
    let posY = 0;  // 图片Y偏移
    let isDragging = false; // 是否拖拽中（鼠标）
    let startX, startY; // 拖拽起始坐标
    let startPosX, startPosY; // 拖拽起始偏移

    // 触摸状态变量（移动端适配）
    let touchStartX, touchStartY;       // 触摸起始坐标
    let touchStartPosX, touchStartPosY; // 触摸起始偏移

    // 缩放限制：增大最大放大倍数，允许更小最小值
    const MIN_SCALE = 0.3;
    const MAX_SCALE = 6;
    // fit 时不将图片缩放得过小，避免视觉上变得很小
    const MIN_FIT_SCALE = 0.6;

    // 线路说明文本：尝试从外部文件 linemap.json 加载（见项目根目录），若失败回退为内置默认文本
    const defaultLineInfo = {
        "全图": { zh: "服务器轨道交通全图，包含所有已开通线路及规划线路。", },
        "鲤湖湾州及鲤城": { zh: "鲤湖湾州及鲤城片区轨道交通线路，覆盖核心城区主要站点。",},
        "大都会区": { zh: "大都会区轨道交通线路，连接周边卫星城与核心区。", },
        "第三城": { zh: "第三城片区轨道交通线路，以通勤线路为主。", },
        "铜钿城": { zh: "铜钿城片区轨道交通线路，覆盖商业及居住区。", },
        "铁路": { zh: "仅显示铁路干线，不含城市轨道交通。", }
    };
     let lineInfo = {};
    // 保存 promise，以便在用户点击时等待数据就绪
    // data 位于 assets/data/ 下，使用相对于站点根或当前路径的路径以避免 /views/ 下的 404
    // 使用以站点根为基准的绝对路径，避免在 /views/ 子路径下请求错误
    const lineInfoPromise = fetch('/assets/data/linemap.json')
        .then(r => r.json())
        .then(data => { lineInfo = data || {}; return lineInfo; })
        .catch(err => {
            debugLog('data', '无法加载 linemap.json, 已使用内置默认文本:', err);
            lineInfo = defaultLineInfo;
            return lineInfo;
        });

    // ========== 信息按钮功能 ==========
    // 打开弹窗（注入对应线路说明），使用 class 控制显示以配合 CSS
    infoBtn.addEventListener('click', function(e) {
        e.preventDefault();
        // 查找当前激活的地图按钮（可能在sub-nav中）
        const currentMap = document.querySelector('#route-map-subnav .map-nav-item.active[data-map]') || 
                          document.querySelector('.map-nav-item.active[data-map]');
        const selectedValue = currentMap ? currentMap.dataset.map : '全图';
        
        // 如果是地图说明按钮，直接显示通用说明
        if (selectedValue === 'info') {
            infoText.textContent = '服务器轨道交通线路图，点击左上角按钮切换不同区域视图。';
            document.getElementById('modal-title').textContent = '地图说明';
            infoModal.classList.add('show');
            return;
        }
        
        const item = lineInfo[selectedValue];
        // 若数据尚未加载，显示加载提示并在加载完成后更新中文
        if (!item) {
            infoText.textContent = '正在加载...';
            document.getElementById('modal-title').textContent = '线路说明';
            infoModal.classList.add('show');
            lineInfoPromise.then(() => {
                const loaded = lineInfo[selectedValue] || { zh: '' };
                infoText.textContent = loaded.zh || '';
            });
            return;
        }
        //数据已就绪，直接显示中文
        infoText.textContent = item.zh || '';
        document.getElementById('modal-title').textContent = '线路说明';
        infoModal.classList.add('show');
    });

    // 关闭弹窗
    closeBtn.addEventListener('click', function() {
        infoModal.classList.remove('show');
    });

    // 点击弹窗外区域关闭
    window.addEventListener('click', function(e) {
        if (e.target === infoModal) {
            infoModal.classList.remove('show');
        }
    });

// ========== 图片拖拽功能 ==========
// 鼠标按下：开始拖拽（允许在顶部导航下的任意位置触发）
    document.addEventListener('mousedown', function(e) {
        // 仅当交互起点在图片容器内时开始（可随后拖出容器）
        const containerRect = mapContainer.getBoundingClientRect();
        const withinContainer = e.clientX >= containerRect.left && e.clientX <= containerRect.right && e.clientY >= containerRect.top && e.clientY <= containerRect.bottom;
        if (!withinContainer) return;
        // 避免在点击容器内的按钮/链接/表单控件时触发拖拽
        if (e.target.closest('button, a, input, select, textarea, .control-btn, .info-btn, .map-select')) return;

        isDragging = true;
        // 记录起始坐标（相对于容器左上角）
        startX = e.clientX - containerRect.left;
        startY = e.clientY - containerRect.top;
        // 记录当前图片偏移
        startPosX = posX;
        startPosY = posY;
        // 阻止默认行为（避免选中页面或触发其他默认交互）
        e.preventDefault();
    });

    // 鼠标移动：执行拖拽（即使超出容器也生效）
    window.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        
        // 计算鼠标移动距离
        const currentX = e.clientX - mapContainer.getBoundingClientRect().left;
        const currentY = e.clientY - mapContainer.getBoundingClientRect().top;
        const dx = currentX - startX;
        const dy = currentY - startY;

        // 更新图片偏移
        posX = startPosX + dx;
        posY = startPosY + dy;

        // 应用偏移和缩放
        updateMapTransform();
    });

    // 鼠标松开：结束拖拽
    window.addEventListener('mouseup', function() {
        isDragging = false;
    });

// ========== 触摸拖拽（移动端适配） ==========
    mapContainer.addEventListener('touchstart', function(e) {
        if (e.target.closest('button, a, input, select, textarea, .control-btn, .info-btn, .map-select')) return;
        if (e.touches.length !== 1) return;

        isDragging = true;
        const rect = mapContainer.getBoundingClientRect();
        touchStartX = e.touches[0].clientX - rect.left;
        touchStartY = e.touches[0].clientY - rect.top;
        touchStartPosX = posX;
        touchStartPosY = posY;
    }, { passive: true });

    window.addEventListener('touchmove', function(e) {
        if (!isDragging || e.touches.length !== 1) return;
        const rect = mapContainer.getBoundingClientRect();
        const currentX = e.touches[0].clientX - rect.left;
        const currentY = e.touches[0].clientY - rect.top;
        posX = touchStartPosX + (currentX - touchStartX);
        posY = touchStartPosY + (currentY - touchStartY);
        updateMapTransform();
    }, { passive: true });

    window.addEventListener('touchend', function(e) {
        if (e.touches.length === 0) {
            isDragging = false;
        }
    });

// ========== 图片缩放功能（滚轮+按钮） ==========
// 滚轮缩放：在顶部导航下任意位置都可用，保持鼠标点不动
    document.addEventListener('wheel', function(e) {
// 仅在交互起点位于图片容器内时触发缩放
        const rect = mapContainer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const withinContainer = mouseX >= 0 && mouseX <= rect.width && mouseY >= 0 && mouseY <= rect.height;
        if (!withinContainer) return;

        // 避免在容器内对控件滚轮操作时触发（例如下拉框）
        if (e.target.closest('select, input, textarea, .map-select')) return;

        // 阻止页面默认滚动
        e.preventDefault();

        // 计算目标缩放比例并保持鼠标点不动
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const oldScale = scale;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale + delta));

        // 如果缩放受限（未发生变化），直接返回，避免滚轮造成位置漂移
        if (newScale === oldScale) return;

        // 计算鼠标点在图片坐标系中的位置（未变换前）
        const imgX = (mouseX - (rect.width / 2 + posX)) / oldScale;
        const imgY = (mouseY - (rect.height / 2 + posY)) / oldScale;

        // 应用新的缩放并调整偏移，使鼠标下的图片点保持不动
        scale = newScale;
        posX = mouseX - rect.width / 2 - imgX * newScale;
        posY = mouseY - rect.height / 2 - imgY * newScale;

        updateMapTransform();
    }, { passive: false });

    // 放大按钮
    zoomInBtn.addEventListener('click', function() {
        scale = Math.min(MAX_SCALE, scale + 0.2); // 增加步长与最大放大倍数
        updateMapTransform();
    });

    // 缩小按钮
    zoomOutBtn.addEventListener('click', function() {
        scale = Math.max(MIN_SCALE, scale - 0.2); // 增加步长
        updateMapTransform();
    });

    // 重置按钮：重置并使图片整体适配容器
    resetBtn.addEventListener('click', function() {
    // 清除任何拖拽偏移、重置缩放
        posX = 0;
        posY = 0;
    // 使用 contain 模式展示整张图片（确保不被裁切）
    // 临时关闭过渡以避免闪烁
    const prevTransition = subwayMap.style.transition;
    subwayMap.style.transition = 'none';
    fitImageToContainer(false);
    // 强制回流，确保 transform 已应用
    // eslint-disable-next-line no-unused-expressions
    subwayMap.getBoundingClientRect();
    subwayMap.style.transition = prevTransition || 'transform 0.05s ease';
    });

    // ========== 地图导航按钮切换功能 ==========
    let isSwitchingMap = false; // 标志位：是否正在切换地图
    
    mapNavItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            const mapValue = this.dataset.map;
            
            // 如果是地图说明按钮，不切换地图
            if (mapValue === 'info') {
                return;
            }
            
            // 移除所有按钮的 active 类（包括sub-nav中的）
            document.querySelectorAll('.map-nav-item[data-map]').forEach(nav => nav.classList.remove('active'));
            // 添加当前按钮的 active 类
            this.classList.add('active');
            
            // 设置切换标志
            isSwitchingMap = true;
            
            // 重置缩放和偏移，避免切换后位置错乱
            scale = 1;
            posX = 0;
            posY = 0;
            
            // 切换图片
            const selectedValue = mapValue;
            // 检查是否是完整路径或相对路径
            const imgPath = selectedValue === '全图' ? '../assets/images/全图.png' : `../assets/images/${selectedValue}.png`;
            
            // 临时移除全局 load 事件，避免冲突
            subwayMap.onload = null;
            
            subwayMap.src = imgPath;
            
            // 等待图片加载完成后调整大小（使用 contain 模式确保图片整体可见）
            subwayMap.onload = function() {
                // 重置标志
                isSwitchingMap = false;
                
                setTimeout(() => {
                    // 临时关闭 transition，避免闪烁
                    const prevTransition = subwayMap.style.transition;
                    subwayMap.style.transition = 'none';
                    
                    // 使用 contain 模式，确保图片上下边完全可见
                    fitImageToContainer(false);
                    
                    // 强制回流，确保 transform 已应用
                    subwayMap.getBoundingClientRect();
                    
                    // 恢复过渡
                    subwayMap.style.transition = prevTransition || 'transform 0.05s ease';
                }, 100); // 增加延迟时间，确保图片完全加载
            };
        });
    });

    // ========== 图片加载失败处理 ==========
    subwayMap.addEventListener('error', function() {
        // 加载默认图片（全图）
        this.src = '../assets/images/全图.png';
        // 提示用户
        alert('当前线路图加载失败，已自动切换为全图，请刷新页面重试');
        // 重置选中状态为全图
        document.querySelectorAll('.map-nav-item[data-map]').forEach(nav => nav.classList.remove('active'));
        const fullMapBtn = document.querySelector('#route-map-subnav .map-nav-item[data-map="全图"]') || 
                          document.querySelector('.map-nav-item[data-map="全图"]');
        if (fullMapBtn) fullMapBtn.classList.add('active');
        const defaultItem = lineInfo['全图'] || { zh: '' };
        infoText.textContent = defaultItem.zh || '';
    });

    // 防止重复触发 fit 的标志（首次稳定布局后做一次 fit）
    let initialFitDone = false;
    function scheduleInitialFit() {
        if (initialFitDone) return;
        initialFitDone = true;
        // 在下一个帧执行，确保布局完成
        requestAnimationFrame(() => {
            // 小延迟再调用，减少样式/布局抖动引起的二次 fit
            setTimeout(() => {
                // 在首次 fit 时临时关闭 transition，避免图片先放大再缩小的闪烁
                const prevTransition = subwayMap.style.transition;
                subwayMap.style.transition = 'none';
                // 使用 contain（默认）以保证首次加载时图片整体可见
                fitImageToContainer(false);
                // 强制回流，确保 transform 已应用
                // eslint-disable-next-line no-unused-expressions
                subwayMap.getBoundingClientRect();
                // 恢复过渡（保守设置为短时过渡），允许后续交互有平滑感
                subwayMap.style.transition = prevTransition || 'transform 0.05s ease';
            }, 20);
        });
    }

    // 当图片加载完成时，自动调整使图片整体可见（并 schedule 初次 fit）
    subwayMap.addEventListener('load', function() {
        // 如果正在切换地图，跳过（由按钮点击事件处理）
        if (isSwitchingMap) {
            return;
        }
        scheduleInitialFit();
    });

    // 如果图片已缓存并已加载完毕，安排一次初始 fit
    if (subwayMap.complete && subwayMap.naturalWidth && subwayMap.naturalHeight) {
        scheduleInitialFit();
    }

    // 在 window load 后再安排一次初始 fit，以确保样式/资源稳定
    window.addEventListener('load', function() {
        scheduleInitialFit();
    });

    // ========== 辅助函数：更新图片变换 ==========
    function updateMapTransform() {
    // 使用 transform-origin 保持缩放以图片中心为基准
    subwayMap.style.transformOrigin = '50% 50%';
    subwayMap.style.transform = `translate(-50%, -50%) translate(${posX}px, ${posY}px) scale(${scale})`;
    }

    // 将图片等比缩放并居中。
    // 参数 fillCover: true => 使用 cover（充满容器，可能裁切），false => 使用 contain（整体可见）
    function fitImageToContainer(fillCover = false) {
        // 如果图片尚未加载自然尺寸则跳过
        if (!subwayMap.naturalWidth || !subwayMap.naturalHeight) {
            // 若图片未加载，稍后 load 事件会触发
            return;
        }

        const containerRect = mapContainer.getBoundingClientRect();
        const cw = containerRect.width;
        const ch = containerRect.height;

        // 为了正确计算（考虑 CSS 对图片的影响），先读取图片在无 transform 下的布局尺寸
        const prevTransform = subwayMap.style.transform;
        subwayMap.style.transform = 'none';
        const baseRect = subwayMap.getBoundingClientRect();
        const baseW = baseRect.width;
        const baseH = baseRect.height;
        // 恢复之前的 transform（不应用 scale yet）
        subwayMap.style.transform = prevTransform || '';

        if (!baseW || !baseH) {
            // 若布局尺寸不可用，退回到使用 naturalWidth/naturalHeight 的保守计算
            const iw = subwayMap.naturalWidth;
            const ih = subwayMap.naturalHeight;
            const scaleX = cw / iw;
            const scaleY = ch / ih;
            let fitScale = fillCover ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
            if (!fillCover) fitScale = Math.max(fitScale, MIN_FIT_SCALE);
            scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));
        } else {
            // 基于布局尺寸计算目标 scale（layout size * scale => 实际显示大小）
            const scaleX = cw / baseW;
            const scaleY = ch / baseH;
            let fitScale = fillCover ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
            if (!fillCover) fitScale = Math.max(fitScale, MIN_FIT_SCALE);
            scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));
        }

        // 重置偏移为居中
        posX = 0;
        posY = 0;
        updateMapTransform();
    }

// ====键盘控制缩放/移动====
    window.addEventListener('keydown', function(e) {
        // 避免输入框等场景触发，仅在非焦点状态生效
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
            switch(e.key) {
                case '+': // 放大
                    scale = Math.min(MAX_SCALE, scale + 0.2);
                    updateMapTransform();
                    break;
                case '-': // 缩小
                    scale = Math.max(MIN_SCALE, scale - 0.2);
                    updateMapTransform();
                    break;
                case 'ArrowUp': // 上移
                    posY -= 20;
                    updateMapTransform();
                    break;
                case 'ArrowDown': // 下移
                    posY += 20;
                    updateMapTransform();
                    break;
                case 'ArrowRight': // 右移
                    posX += 20;
                    updateMapTransform();
                    break;
                case 'ArrowLeft': // 左移
                    posX -= 20;
                    updateMapTransform();
                    break;
                case 'Escape': // 重置
                    posX = 0;
                    posY = 0;
                    fitImageToContainer();
                    break;
            }
        }
    });
    debugLog('data', '线网示意页面脚本加载完成');
}
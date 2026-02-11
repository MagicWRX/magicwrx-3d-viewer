// Theme system - controls all UI/UX
export const defaultTheme = {
    name: 'dark',
    
    colors: {
        background: '#1a1a2e',
        surface: '#16213e',
        surfaceHover: '#1f3460',
        primary: '#0f3460',
        accent: '#e94560',
        accentAlt: '#4a9eff',
        text: '#eaeaea',
        textMuted: '#888888',
        grid: '#333355',
        gridSub: '#222244',
        selection: '#00ff88',
        multiSelect: '#ffaa00',
        axisX: '#ff4444',
        axisY: '#44ff44',
        axisZ: '#4444ff',
        objectDefault: '#00ff88',
        camera: '#ffcc00',
        keyframe: '#ff6b6b',
        timeline: '#1e2a3a'
    },
    
    layout: {
        toolbarPosition: 'top',
        toolbarHeight: '48px',
        sidebarPosition: 'right',
        sidebarWidth: '280px',
        statusBarHeight: '28px',
        timelineHeight: '120px',
        borderRadius: '6px',
        spacing: '8px'
    },
    
    toolbar: {
        buttons: [
            { id: 'save', icon: '💾', label: 'Save', action: 'save', shortcut: 'Ctrl+S' },
            { id: 'load', icon: '📂', label: 'Load', action: 'load' },
            { id: 'export', icon: '📤', label: 'Export', action: 'export', shortcut: 'Ctrl+E' },
            { id: 'sep1', type: 'separator' },
            { id: 'undo', icon: '↩️', label: 'Undo', action: 'undo', shortcut: 'Ctrl+Z' },
            { id: 'redo', icon: '↪️', label: 'Redo', action: 'redo', shortcut: 'Ctrl+Y' },
            { id: 'sep2', type: 'separator' },
            { id: 'copy', icon: '📋', label: 'Copy', action: 'copy', shortcut: 'Ctrl+C' },
            { id: 'paste', icon: '📄', label: 'Paste', action: 'paste', shortcut: 'Ctrl+V' },
            { id: 'duplicate', icon: '🔁', label: 'Duplicate', action: 'duplicate', shortcut: 'Ctrl+D' },
            { id: 'delete', icon: '🗑️', label: 'Delete', action: 'delete', shortcut: 'Del' },
            { id: 'sep3', type: 'separator' },
            { id: 'addQuad', icon: '⬜', label: 'Quad', action: 'addQuad' },
            { id: 'addCube', icon: '📦', label: 'Cube', action: 'addCube' },
            { id: 'addCamera', icon: '🎥', label: 'Camera', action: 'addCamera' }
        ]
    },
    
    sidebar: {
        panels: [
            { id: 'grid', title: 'Grid', type: 'gridControl' },
            { id: 'objects', title: 'Objects', type: 'objectList' },
            { id: 'transform', title: 'Transform', type: 'transform' },
            { id: 'camera', title: 'Camera View', type: 'cameraPreview' }
        ]
    },
    
    viewport: {
        defaultView: 'top',
        showGrid: true,
        showAxes: true,
        gridSize: 10,
        gridDivisions: 20,
        defaultGridPlane: 'xz'
    },
    
    controls: {
        snapKey: 'Shift',
        altDragSnap: true,
        snapAngle: 15,
        snapPosition: 0.5,
        multiSelectKey: 'Shift',
        undoLimit: 50
    },
    
    timeline: {
        show: true,
        fps: 30,
        defaultDuration: 300, // frames (10 seconds at 30fps)
        snapToFrame: true
    },
    
    statusBar: {
        show: true,
        items: ['mode', 'selection', 'position', 'snap', 'grid', 'frame']
    }
};

export function applyTheme(theme) {
    const root = document.documentElement;
    const { colors, layout } = theme;
    
    Object.entries(colors).forEach(([key, value]) => {
        root.style.setProperty(`--color-${key}`, value);
    });
    
    Object.entries(layout).forEach(([key, value]) => {
        root.style.setProperty(`--layout-${key}`, value);
    });
    
    buildToolbar(theme);
    buildSidebar(theme);
    buildStatusBar(theme);
    buildTimeline(theme);
}

function buildToolbar(theme) {
    const toolbar = document.getElementById('toolbar');
    toolbar.innerHTML = '';
    toolbar.className = `toolbar toolbar-${theme.layout.toolbarPosition}`;
    
    theme.toolbar.buttons.forEach(btn => {
        if (btn.type === 'separator') {
            const sep = document.createElement('div');
            sep.className = 'toolbar-separator';
            toolbar.appendChild(sep);
        } else {
            const button = document.createElement('button');
            button.className = 'toolbar-btn';
            button.id = `btn-${btn.id}`;
            button.dataset.action = btn.action;
            button.title = btn.shortcut ? `${btn.label} (${btn.shortcut})` : btn.label;
            button.innerHTML = `<span class="icon">${btn.icon}</span><span class="label">${btn.label}</span>`;
            toolbar.appendChild(button);
        }
    });
}

function buildSidebar(theme) {
    const sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = '';
    sidebar.className = `sidebar sidebar-${theme.layout.sidebarPosition}`;
    
    theme.sidebar.panels.forEach(panel => {
        const panelEl = document.createElement('div');
        panelEl.className = 'panel';
        panelEl.id = `panel-${panel.id}`;
        
        const header = document.createElement('div');
        header.className = 'panel-header';
        header.innerHTML = `<span>${panel.title}</span><span class="panel-toggle">▼</span>`;
        header.addEventListener('click', () => {
            panelEl.classList.toggle('collapsed');
        });
        panelEl.appendChild(header);
        
        const content = document.createElement('div');
        content.className = 'panel-content';
        content.id = `panel-content-${panel.id}`;
        panelEl.appendChild(content);
        
        sidebar.appendChild(panelEl);
    });
}

function buildStatusBar(theme) {
    const statusBar = document.getElementById('status-bar');
    statusBar.innerHTML = '';
    
    if (!theme.statusBar.show) {
        statusBar.style.display = 'none';
        return;
    }
    
    theme.statusBar.items.forEach(item => {
        const span = document.createElement('span');
        span.className = 'status-item';
        span.id = `status-${item}`;
        statusBar.appendChild(span);
    });
}

function buildTimeline(theme) {
    const timeline = document.getElementById('timeline');
    if (!theme.timeline.show) {
        timeline.style.display = 'none';
        return;
    }
    
    timeline.innerHTML = `
        <div class="timeline-controls">
            <button id="tl-play" class="tl-btn">▶</button>
            <button id="tl-stop" class="tl-btn">⏹</button>
            <button id="tl-keyframe" class="tl-btn" title="Add Keyframe">◆</button>
            <span id="tl-time">0:00 / 0:10</span>
        </div>
        <div class="timeline-ruler" id="timeline-ruler"></div>
        <div class="timeline-tracks" id="timeline-tracks"></div>
        <div class="timeline-playhead" id="timeline-playhead"></div>
    `;
}

export function mergeTheme(base, overrides) {
    return JSON.parse(JSON.stringify({
        ...base,
        ...overrides,
        colors: { ...base.colors, ...overrides?.colors },
        layout: { ...base.layout, ...overrides?.layout },
        toolbar: { ...base.toolbar, ...overrides?.toolbar },
        sidebar: { ...base.sidebar, ...overrides?.sidebar },
        viewport: { ...base.viewport, ...overrides?.viewport },
        controls: { ...base.controls, ...overrides?.controls },
        timeline: { ...base.timeline, ...overrides?.timeline },
        statusBar: { ...base.statusBar, ...overrides?.statusBar }
    }));
}

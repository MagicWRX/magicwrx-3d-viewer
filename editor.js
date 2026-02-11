import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { defaultTheme, applyTheme } from './theme.js';

class MeshEditor {
    constructor() {
        this.theme = defaultTheme;
        this.objects = [];
        this.selectedObjects = []; // Multi-select support
        this.clipboard = null;
        this.undoStack = [];
        this.redoStack = [];
        this.isShiftHeld = false;
        this.isAltHeld = false;
        this.isCtrlHeld = false;
        this.gridSnapEnabled = false;
        this.objectIdCounter = 0;
        this.currentGridPlane = 'xz';
        this.grids = {};
        
        // Camera/Animation
        this.sceneCameras = [];
        this.activeSceneCamera = null;
        this.currentFrame = 0;
        this.totalFrames = this.theme.timeline.defaultDuration;
        this.isPlaying = false;
        this.clips = {}; // { objectId: { property: [{ frame, value }] } }
        this.cameraTrackTargets = {}; // { cameraId: targetObjectId }
        
        this.init();
    }
    
    init() {
        applyTheme(this.theme);
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.theme.colors.background);
        
        // Main camera
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.setTopDownView();
        
        // Renderer
        const canvas = document.getElementById('viewport');
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.updateRendererSize();
        
        // Controls
        this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.08;
        
        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.addEventListener('dragging-changed', (e) => {
            this.orbitControls.enabled = !e.value;
        });
        this.transformControls.addEventListener('objectChange', () => {
            this.updateTransformPanel();
            this.updateStatus();
        });
        this.transformControls.addEventListener('mouseUp', () => this.saveState());
        this.scene.add(this.transformControls);
        
        // Lights
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(5, 10, 5);
        this.scene.add(dirLight);
        
        // Grids
        this.createGrids();
        this.setGridPlane(this.theme.viewport.defaultGridPlane);
        
        // Axes
        if (this.theme.viewport.showAxes) {
            this.scene.add(new THREE.AxesHelper(2));
        }
        
        // Raycaster
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        
        // Setup
        this.setupEventListeners();
        this.buildGridPanel();
        this.setupTimeline();
        this.setupCameraPreview();
        
        // Initial object
        this.addQuad();
        this.saveState();
        
        this.animate();
    }
    
    // ==================== UNDO/REDO ====================
    
    saveState() {
        const state = {
            objects: this.objects.map(o => this.serializeObject(o)),
            clips: JSON.parse(JSON.stringify(this.clips))
        };
        this.undoStack.push(JSON.stringify(state));
        if (this.undoStack.length > this.theme.controls.undoLimit) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    }
    
    undo() {
        if (this.undoStack.length <= 1) return;
        const current = this.undoStack.pop();
        this.redoStack.push(current);
        const prev = this.undoStack[this.undoStack.length - 1];
        this.restoreState(JSON.parse(prev));
    }
    
    redo() {
        if (this.redoStack.length === 0) return;
        const state = this.redoStack.pop();
        this.undoStack.push(state);
        this.restoreState(JSON.parse(state));
    }
    
    serializeObject(o) {
        return {
            id: o.id,
            name: o.name,
            type: o.type,
            position: o.mesh.position.toArray(),
            rotation: [o.mesh.rotation.x, o.mesh.rotation.y, o.mesh.rotation.z],
            scale: o.mesh.scale.toArray(),
            trackTarget: this.cameraTrackTargets[o.id] || null
        };
    }
    
    restoreState(state) {
        // Clear current objects
        this.deselectAll();
        this.objects.forEach(o => {
            this.scene.remove(o.mesh);
            o.mesh.geometry?.dispose();
            o.mesh.material?.dispose();
        });
        this.objects = [];
        this.sceneCameras = [];
        this.cameraTrackTargets = {};
        
        // Restore objects
        state.objects.forEach(data => {
            this.createObjectFromData(data);
            if (data.trackTarget) {
                this.cameraTrackTargets[data.id] = data.trackTarget;
            }
        });
        
        this.clips = state.clips || {};
        this.objectIdCounter = Math.max(0, ...this.objects.map(o => o.id));
        this.updateObjectList();
        this.updateTimeline();
    }
    
    createObjectFromData(data) {
        let mesh;
        
        if (data.type === 'quad') {
            mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.createObjectMaterial());
        } else if (data.type === 'cube') {
            mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.createObjectMaterial());
        } else if (data.type === 'camera') {
            mesh = this.createCameraHelper();
        } else {
            return;
        }
        
        mesh.position.fromArray(data.position);
        mesh.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
        mesh.scale.fromArray(data.scale);
        
        const objData = { id: data.id, name: data.name, type: data.type, mesh };
        this.scene.add(mesh);
        this.objects.push(objData);
        
        if (data.type === 'camera') {
            this.sceneCameras.push(objData);
        }
    }
    
    // ==================== COPY/PASTE ====================
    
    copy() {
        if (this.selectedObjects.length === 0) return;
        this.clipboard = this.selectedObjects.map(o => this.serializeObject(o));
    }
    
    paste() {
        if (!this.clipboard) return;
        this.deselectAll();
        
        this.clipboard.forEach(data => {
            const newData = { ...data };
            newData.id = ++this.objectIdCounter;
            newData.name = `${data.name}_paste`;
            newData.position = [data.position[0] + 0.5, data.position[1], data.position[2] + 0.5];
            this.createObjectFromData(newData);
            
            const newObj = this.objects.find(o => o.id === newData.id);
            if (newObj) this.addToSelection(newObj);
        });
        
        this.saveState();
        this.updateObjectList();
    }
    
    // ==================== MULTI-SELECT ====================
    
    selectObject(objData, additive = false) {
        if (!additive) {
            this.deselectAll();
        }
        
        if (this.selectedObjects.includes(objData)) {
            // Toggle off if already selected
            if (additive) {
                this.removeFromSelection(objData);
                return;
            }
        }
        
        this.addToSelection(objData);
    }
    
    addToSelection(objData) {
        if (this.selectedObjects.includes(objData)) return;
        
        this.selectedObjects.push(objData);
        if (objData.mesh.material) {
            objData.mesh.material.emissive = new THREE.Color(
                this.selectedObjects.length > 1 ? this.theme.colors.multiSelect : this.theme.colors.selection
            );
            objData.mesh.material.emissiveIntensity = 0.3;
        }
        
        // Attach transform to last selected
        if (this.selectedObjects.length === 1) {
            this.transformControls.attach(objData.mesh);
        }
        
        this.updateObjectList();
        this.updateTransformPanel();
        this.updateStatus();
    }
    
    removeFromSelection(objData) {
        const idx = this.selectedObjects.indexOf(objData);
        if (idx === -1) return;
        
        if (objData.mesh.material) {
            objData.mesh.material.emissiveIntensity = 0;
        }
        this.selectedObjects.splice(idx, 1);
        
        if (this.selectedObjects.length > 0) {
            this.transformControls.attach(this.selectedObjects[this.selectedObjects.length - 1].mesh);
        } else {
            this.transformControls.detach();
        }
        
        this.updateObjectList();
        this.updateTransformPanel();
        this.updateStatus();
    }
    
    deselectAll() {
        this.selectedObjects.forEach(o => {
            if (o.mesh.material) o.mesh.material.emissiveIntensity = 0;
        });
        this.selectedObjects = [];
        this.transformControls.detach();
        this.updateObjectList();
        this.updateTransformPanel();
        this.updateStatus();
    }
    
    // ==================== OBJECTS ====================
    
    createObjectMaterial() {
        return new THREE.MeshStandardMaterial({
            color: this.theme.colors.objectDefault,
            side: THREE.DoubleSide,
            roughness: 0.7
        });
    }
    
    createCameraHelper() {
        const group = new THREE.Group();
        
        // Camera body
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.2, 0.4),
            new THREE.MeshStandardMaterial({ color: this.theme.colors.camera })
        );
        group.add(body);
        
        // Lens
        const lens = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.1, 0.15, 8),
            new THREE.MeshStandardMaterial({ color: '#333' })
        );
        lens.rotation.x = Math.PI / 2;
        lens.position.z = -0.25;
        group.add(lens);
        
        // Direction arrow
        const arrow = new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -0.4),
            0.5, this.theme.colors.camera, 0.15, 0.1
        );
        group.add(arrow);
        
        // View cone
        const coneGeo = new THREE.ConeGeometry(0.4, 0.8, 4);
        const coneMat = new THREE.MeshBasicMaterial({ 
            color: this.theme.colors.camera, 
            wireframe: true, 
            opacity: 0.3, 
            transparent: true 
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.rotation.x = Math.PI / 2;
        cone.position.z = -0.8;
        group.add(cone);
        
        // Store camera for preview
        const previewCam = new THREE.PerspectiveCamera(60, 16/9, 0.1, 100);
        group.userData.camera = previewCam;
        group.add(previewCam);
        
        return group;
    }
    
    addQuad() {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.createObjectMaterial());
        mesh.rotation.x = -Math.PI / 2;
        
        const objData = {
            id: ++this.objectIdCounter,
            name: `Quad_${this.objectIdCounter}`,
            type: 'quad',
            mesh
        };
        
        this.scene.add(mesh);
        this.objects.push(objData);
        this.selectObject(objData);
        this.saveState();
    }
    
    addCube() {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.createObjectMaterial());
        mesh.position.y = 0.5;
        
        const objData = {
            id: ++this.objectIdCounter,
            name: `Cube_${this.objectIdCounter}`,
            type: 'cube',
            mesh
        };
        
        this.scene.add(mesh);
        this.objects.push(objData);
        this.selectObject(objData);
        this.saveState();
    }
    
    addCamera() {
        const mesh = this.createCameraHelper();
        mesh.position.set(2, 2, 2);
        mesh.lookAt(0, 0, 0);
        
        const objData = {
            id: ++this.objectIdCounter,
            name: `Camera_${this.objectIdCounter}`,
            type: 'camera',
            mesh
        };
        
        this.scene.add(mesh);
        this.objects.push(objData);
        this.sceneCameras.push(objData);
        this.selectObject(objData);
        this.saveState();
        this.updateCameraList();
    }
    
    duplicateSelected() {
        if (this.selectedObjects.length === 0) return;
        
        const toDuplicate = [...this.selectedObjects];
        this.deselectAll();
        
        toDuplicate.forEach(orig => {
            const data = this.serializeObject(orig);
            data.id = ++this.objectIdCounter;
            data.name = `${orig.name}_copy`;
            data.position[0] += 1;
            this.createObjectFromData(data);
            
            const newObj = this.objects.find(o => o.id === data.id);
            if (newObj) this.addToSelection(newObj);
        });
        
        this.saveState();
        this.updateObjectList();
    }
    
    deleteSelected() {
        if (this.selectedObjects.length === 0) return;
        
        this.selectedObjects.forEach(obj => {
            this.scene.remove(obj.mesh);
            obj.mesh.traverse?.(child => {
                child.geometry?.dispose();
                child.material?.dispose();
            });
            this.objects = this.objects.filter(o => o !== obj);
            this.sceneCameras = this.sceneCameras.filter(c => c !== obj);
            delete this.clips[obj.id];
        });
        
        this.deselectAll();
        this.saveState();
        this.updateObjectList();
        this.updateCameraList();
    }
    
    renameObject(objData, newName) {
        objData.name = newName;
        this.updateObjectList();
        this.saveState();
    }
    
    // ==================== GRID ====================
    
    createGrids() {
        const size = this.theme.viewport.gridSize;
        const divisions = this.theme.viewport.gridDivisions;
        const color1 = this.theme.colors.grid;
        const color2 = this.theme.colors.gridSub;
        
        this.grids.xz = new THREE.GridHelper(size, divisions, color1, color2);
        this.grids.xz.visible = false;
        this.scene.add(this.grids.xz);
        
        this.grids.xy = new THREE.GridHelper(size, divisions, color1, color2);
        this.grids.xy.rotation.x = Math.PI / 2;
        this.grids.xy.visible = false;
        this.scene.add(this.grids.xy);
        
        this.grids.yz = new THREE.GridHelper(size, divisions, color1, color2);
        this.grids.yz.rotation.z = Math.PI / 2;
        this.grids.yz.visible = false;
        this.scene.add(this.grids.yz);
    }
    
    setGridPlane(plane) {
        Object.values(this.grids).forEach(g => g.visible = false);
        if (this.grids[plane]) {
            this.grids[plane].visible = true;
            this.currentGridPlane = plane;
        }
        this.updateGridPanel();
        this.updateStatus();
    }
    
    buildGridPanel() {
        const container = document.getElementById('panel-content-grid');
        if (!container) return;
        
        container.innerHTML = `
            <div class="grid-controls">
                <label>View Plane:</label>
                <div class="grid-buttons">
                    <button class="grid-btn" data-plane="xz">XZ (Ground)</button>
                    <button class="grid-btn" data-plane="xy">XY (Front)</button>
                    <button class="grid-btn" data-plane="yz">YZ (Side)</button>
                </div>
                <div class="snap-controls">
                    <label><input type="checkbox" id="grid-snap-toggle"> Grid Snap (G)</label>
                    <div class="snap-size">
                        <label>Snap:</label>
                        <input type="number" id="snap-size-input" value="${this.theme.controls.snapPosition}" min="0.1" max="2" step="0.1">
                    </div>
                </div>
            </div>
        `;
        
        container.querySelectorAll('.grid-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setGridPlane(btn.dataset.plane));
        });
        
        container.querySelector('#grid-snap-toggle')?.addEventListener('change', (e) => {
            this.gridSnapEnabled = e.target.checked;
            this.updateSnapping();
        });
        
        container.querySelector('#snap-size-input')?.addEventListener('change', (e) => {
            this.theme.controls.snapPosition = parseFloat(e.target.value);
            this.updateSnapping();
        });
        
        this.updateGridPanel();
    }
    
    updateGridPanel() {
        const container = document.getElementById('panel-content-grid');
        if (!container) return;
        
        container.querySelectorAll('.grid-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.plane === this.currentGridPlane);
        });
    }
    
    // ==================== TIMELINE/ANIMATION ====================
    
    setupTimeline() {
        const ruler = document.getElementById('timeline-ruler');
        const tracks = document.getElementById('timeline-tracks');
        if (!ruler || !tracks) return;
        
        // Build ruler
        ruler.innerHTML = '';
        for (let i = 0; i <= this.totalFrames; i += 30) {
            const mark = document.createElement('div');
            mark.className = 'ruler-mark';
            mark.style.left = `${(i / this.totalFrames) * 100}%`;
            mark.textContent = `${Math.floor(i / 30)}s`;
            ruler.appendChild(mark);
        }
        
        // Timeline click to seek
        document.getElementById('timeline')?.addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const rulerRect = ruler.getBoundingClientRect();
            if (e.clientY < rulerRect.bottom) {
                const pct = (e.clientX - rulerRect.left) / rulerRect.width;
                this.currentFrame = Math.round(pct * this.totalFrames);
                this.updatePlayhead();
                this.applyFrame();
            }
        });
        
        // Controls
        document.getElementById('tl-play')?.addEventListener('click', () => this.togglePlay());
        document.getElementById('tl-stop')?.addEventListener('click', () => this.stopPlayback());
        document.getElementById('tl-keyframe')?.addEventListener('click', () => this.addKeyframe());
        
        this.updateTimeline();
    }
    
    updateTimeline() {
        const tracks = document.getElementById('timeline-tracks');
        if (!tracks) return;
        
        tracks.innerHTML = '';
        this.sceneCameras.forEach(cam => {
            const track = document.createElement('div');
            track.className = 'timeline-track';
            track.innerHTML = `<span class="track-label">${cam.name}</span><div class="track-keyframes" data-id="${cam.id}"></div>`;
            tracks.appendChild(track);
            
            // Render keyframes
            const kfContainer = track.querySelector('.track-keyframes');
            const camClips = this.clips[cam.id];
            if (camClips?.position) {
                camClips.position.forEach(kf => {
                    const marker = document.createElement('div');
                    marker.className = 'keyframe-marker';
                    marker.style.left = `${(kf.frame / this.totalFrames) * 100}%`;
                    marker.title = `Frame ${kf.frame}`;
                    kfContainer.appendChild(marker);
                });
            }
        });
        
        this.updatePlayhead();
    }
    
    updatePlayhead() {
        const playhead = document.getElementById('timeline-playhead');
        const timeDisplay = document.getElementById('tl-time');
        if (playhead) {
            playhead.style.left = `${(this.currentFrame / this.totalFrames) * 100}%`;
        }
        if (timeDisplay) {
            const secs = Math.floor(this.currentFrame / 30);
            const totalSecs = Math.floor(this.totalFrames / 30);
            timeDisplay.textContent = `${Math.floor(secs/60)}:${(secs%60).toString().padStart(2,'0')} / ${Math.floor(totalSecs/60)}:${(totalSecs%60).toString().padStart(2,'0')}`;
        }
        this.updateStatus();
    }
    
    addKeyframe() {
        this.selectedObjects.forEach(obj => {
            if (obj.type !== 'camera') return;
            
            if (!this.clips[obj.id]) this.clips[obj.id] = {};
            if (!this.clips[obj.id].position) this.clips[obj.id].position = [];
            if (!this.clips[obj.id].rotation) this.clips[obj.id].rotation = [];
            
            // Remove existing keyframe at this frame
            this.clips[obj.id].position = this.clips[obj.id].position.filter(k => k.frame !== this.currentFrame);
            this.clips[obj.id].rotation = this.clips[obj.id].rotation.filter(k => k.frame !== this.currentFrame);
            
            // Add new keyframes
            this.clips[obj.id].position.push({
                frame: this.currentFrame,
                value: obj.mesh.position.toArray()
            });
            this.clips[obj.id].rotation.push({
                frame: this.currentFrame,
                value: [obj.mesh.rotation.x, obj.mesh.rotation.y, obj.mesh.rotation.z]
            });
            
            // Sort by frame
            this.clips[obj.id].position.sort((a, b) => a.frame - b.frame);
            this.clips[obj.id].rotation.sort((a, b) => a.frame - b.frame);
        });
        
        this.saveState();
        this.updateTimeline();
    }
    
    togglePlay() {
        this.isPlaying = !this.isPlaying;
        const btn = document.getElementById('tl-play');
        if (btn) btn.textContent = this.isPlaying ? '⏸' : '▶';
    }
    
    stopPlayback() {
        this.isPlaying = false;
        this.currentFrame = 0;
        const btn = document.getElementById('tl-play');
        if (btn) btn.textContent = '▶';
        this.updatePlayhead();
        this.applyFrame();
    }
    
    applyFrame() {
        // Interpolate camera positions/rotations
        this.sceneCameras.forEach(cam => {
            const camClips = this.clips[cam.id];
            if (!camClips) return;
            
            if (camClips.position?.length > 0) {
                const pos = this.interpolateKeyframes(camClips.position, this.currentFrame);
                cam.mesh.position.fromArray(pos);
            }
            if (camClips.rotation?.length > 0) {
                const rot = this.interpolateKeyframes(camClips.rotation, this.currentFrame);
                cam.mesh.rotation.set(rot[0], rot[1], rot[2]);
            }
        });
    }
    
    interpolateKeyframes(keyframes, frame) {
        if (keyframes.length === 0) return [0, 0, 0];
        if (keyframes.length === 1) return keyframes[0].value;
        
        // Find surrounding keyframes
        let before = keyframes[0];
        let after = keyframes[keyframes.length - 1];
        
        for (let i = 0; i < keyframes.length - 1; i++) {
            if (keyframes[i].frame <= frame && keyframes[i + 1].frame >= frame) {
                before = keyframes[i];
                after = keyframes[i + 1];
                break;
            }
        }
        
        if (frame <= before.frame) return before.value;
        if (frame >= after.frame) return after.value;
        
        // Linear interpolation
        const t = (frame - before.frame) / (after.frame - before.frame);
        return before.value.map((v, i) => v + (after.value[i] - v) * t);
    }
    
    // ==================== CAMERA PREVIEW ====================
    
    setupCameraPreview() {
        const container = document.getElementById('panel-content-camera');
        if (!container) return;
        
        container.innerHTML = `
            <div class="camera-preview-container">
                <canvas id="camera-preview" width="240" height="135"></canvas>
                <div class="camera-select">
                    <select id="camera-select"><option value="">No Camera</option></select>
                </div>
            </div>
        `;
        
        const previewCanvas = document.getElementById('camera-preview');
        this.previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
        this.previewRenderer.setSize(240, 135);
        
        document.getElementById('camera-select')?.addEventListener('change', (e) => {
            const camId = parseInt(e.target.value);
            this.activeSceneCamera = this.sceneCameras.find(c => c.id === camId) || null;
        });
        
        this.updateCameraList();
    }
    
    updateCameraList() {
        const select = document.getElementById('camera-select');
        if (!select) return;
        
        select.innerHTML = '<option value="">No Camera</option>';
        this.sceneCameras.forEach(cam => {
            const opt = document.createElement('option');
            opt.value = cam.id;
            opt.textContent = cam.name;
            if (this.activeSceneCamera === cam) opt.selected = true;
            select.appendChild(opt);
        });
    }
    
    renderCameraPreview() {
        if (!this.activeSceneCamera || !this.previewRenderer) return;
        
        const previewCam = this.activeSceneCamera.mesh.userData.camera;
        if (!previewCam) return;
        
        // Sync preview camera to camera object
        previewCam.position.copy(this.activeSceneCamera.mesh.position);
        previewCam.rotation.copy(this.activeSceneCamera.mesh.rotation);
        
        this.previewRenderer.render(this.scene, previewCam);
    }
    
    // ==================== UI UPDATES ====================
    
    updateObjectList() {
        const container = document.getElementById('panel-content-objects');
        if (!container) return;
        
        container.innerHTML = '';
        this.objects.forEach(o => {
            const item = document.createElement('div');
            item.className = 'object-item' + (this.selectedObjects.includes(o) ? ' selected' : '');
            
            let trackingHtml = '';
            if (o.type === 'camera') {
                const trackTarget = this.cameraTrackTargets[o.id];
                const nonCameraObjs = this.objects.filter(obj => obj.type !== 'camera');
                trackingHtml = `
                    <select class="obj-track" data-cam-id="${o.id}" title="Track target">
                        <option value="">No tracking</option>
                        ${nonCameraObjs.map(obj => `<option value="${obj.id}" ${trackTarget === obj.id ? 'selected' : ''}>${obj.name}</option>`).join('')}
                    </select>
                `;
            }
            
            item.innerHTML = `
                <span class="obj-icon">${o.type === 'camera' ? '🎥' : o.type === 'cube' ? '📦' : '⬜'}</span>
                <input type="text" class="obj-name" value="${o.name}" data-id="${o.id}">
                ${trackingHtml}
            `;
            
            item.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
                    this.selectObject(o, this.isShiftHeld);
                }
            });
            
            item.querySelector('.obj-name')?.addEventListener('change', (e) => {
                this.renameObject(o, e.target.value);
            });
            
            item.querySelector('.obj-track')?.addEventListener('change', (e) => {
                this.setCameraTrackTarget(o.id, e.target.value ? parseInt(e.target.value) : null);
            });
            
            container.appendChild(item);
        });
    }
    
    setCameraTrackTarget(cameraId, targetId) {
        if (targetId) {
            this.cameraTrackTargets[cameraId] = targetId;
        } else {
            delete this.cameraTrackTargets[cameraId];
        }
        this.saveState();
    }
    
    updateCameraTracking() {
        // Make cameras look at their track targets
        Object.entries(this.cameraTrackTargets).forEach(([camId, targetId]) => {
            const cam = this.objects.find(o => o.id === parseInt(camId));
            const target = this.objects.find(o => o.id === targetId);
            if (cam && target) {
                cam.mesh.lookAt(target.mesh.position);
            }
        });
    }
    
    updateTransformPanel() {
        const container = document.getElementById('panel-content-transform');
        if (!container) return;
        
        if (this.selectedObjects.length === 0) {
            container.innerHTML = '<div class="empty">No selection</div>';
            return;
        }
        
        const obj = this.selectedObjects[this.selectedObjects.length - 1];
        const m = obj.mesh;
        
        container.innerHTML = `
            <div class="transform-group">
                <label>Position</label>
                <div class="transform-row">
                    <span class="axis-label" style="color:var(--color-axisX)">X</span>
                    <input type="number" step="0.1" value="${m.position.x.toFixed(2)}" data-prop="position.x">
                    <span class="axis-label" style="color:var(--color-axisY)">Y</span>
                    <input type="number" step="0.1" value="${m.position.y.toFixed(2)}" data-prop="position.y">
                    <span class="axis-label" style="color:var(--color-axisZ)">Z</span>
                    <input type="number" step="0.1" value="${m.position.z.toFixed(2)}" data-prop="position.z">
                </div>
            </div>
            <div class="transform-group">
                <label>Rotation (°)</label>
                <div class="transform-row">
                    <span class="axis-label" style="color:var(--color-axisX)">X</span>
                    <input type="number" step="5" value="${THREE.MathUtils.radToDeg(m.rotation.x).toFixed(0)}" data-prop="rotation.x">
                    <span class="axis-label" style="color:var(--color-axisY)">Y</span>
                    <input type="number" step="5" value="${THREE.MathUtils.radToDeg(m.rotation.y).toFixed(0)}" data-prop="rotation.y">
                    <span class="axis-label" style="color:var(--color-axisZ)">Z</span>
                    <input type="number" step="5" value="${THREE.MathUtils.radToDeg(m.rotation.z).toFixed(0)}" data-prop="rotation.z">
                </div>
            </div>
            <div class="transform-group">
                <label>Scale</label>
                <div class="transform-row">
                    <span class="axis-label" style="color:var(--color-axisX)">X</span>
                    <input type="number" step="0.1" value="${m.scale.x.toFixed(2)}" data-prop="scale.x">
                    <span class="axis-label" style="color:var(--color-axisY)">Y</span>
                    <input type="number" step="0.1" value="${m.scale.y.toFixed(2)}" data-prop="scale.y">
                    <span class="axis-label" style="color:var(--color-axisZ)">Z</span>
                    <input type="number" step="0.1" value="${m.scale.z.toFixed(2)}" data-prop="scale.z">
                </div>
            </div>
        `;
        
        container.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', (e) => {
                const [prop, axis] = e.target.dataset.prop.split('.');
                let val = parseFloat(e.target.value);
                if (prop === 'rotation') val = THREE.MathUtils.degToRad(val);
                this.selectedObjects.forEach(o => { o.mesh[prop][axis] = val; });
                this.saveState();
            });
        });
    }
    
    updateStatus() {
        const mode = document.getElementById('status-mode');
        const selection = document.getElementById('status-selection');
        const position = document.getElementById('status-position');
        const snap = document.getElementById('status-snap');
        const grid = document.getElementById('status-grid');
        const frame = document.getElementById('status-frame');
        
        if (mode) mode.textContent = `Mode: ${this.transformControls.mode}`;
        if (selection) {
            const count = this.selectedObjects.length;
            selection.textContent = count === 0 ? 'No selection' : 
                count === 1 ? `Selected: ${this.selectedObjects[0].name}` : `Selected: ${count} objects`;
        }
        if (position && this.selectedObjects.length > 0) {
            const p = this.selectedObjects[0].mesh.position;
            position.textContent = `Pos: ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
        } else if (position) {
            position.textContent = '';
        }
        
        let snapText = '';
        if (this.gridSnapEnabled) snapText = '🔒 Grid';
        else if (this.isAltHeld && this.isShiftHeld) snapText = '🔒 Fine';
        else if (this.isAltHeld) snapText = '🔒 Alt';
        else if (this.isShiftHeld) snapText = '🔒 Axis';
        if (snap) snap.textContent = snapText;
        
        const planeLabels = { xz: 'XZ', xy: 'XY', yz: 'YZ' };
        if (grid) grid.textContent = `Grid: ${planeLabels[this.currentGridPlane]}`;
        if (frame) frame.textContent = `Frame: ${this.currentFrame}`;
    }
    
    // ==================== EVENT HANDLING ====================
    
    setupEventListeners() {
        window.addEventListener('resize', () => this.updateRendererSize());
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));
        this.renderer.domElement.addEventListener('click', (e) => this.onClick(e));
        
        document.querySelectorAll('.toolbar-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleAction(btn.dataset.action));
        });
    }
    
    onKeyDown(e) {
        if (e.key === 'Shift') { this.isShiftHeld = true; this.updateSnapping(); }
        if (e.key === 'Alt') { e.preventDefault(); this.isAltHeld = true; this.updateSnapping(); }
        if (e.key === 'Control') this.isCtrlHeld = true;
        
        if (e.key === 'g' && !e.ctrlKey) { this.gridSnapEnabled = !this.gridSnapEnabled; this.updateSnapping(); this.updateGridPanel(); }
        if (e.key === '1') this.setGridPlane('xz');
        if (e.key === '2') this.setGridPlane('xy');
        if (e.key === '3') this.setGridPlane('yz');
        if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
        
        if (e.ctrlKey) {
            if (e.key === 'z') { e.preventDefault(); this.undo(); }
            if (e.key === 'y') { e.preventDefault(); this.redo(); }
            if (e.key === 'c') { e.preventDefault(); this.copy(); }
            if (e.key === 'v') { e.preventDefault(); this.paste(); }
            if (e.key === 'd') { e.preventDefault(); this.duplicateSelected(); }
            if (e.key === 's') { e.preventDefault(); this.save(); }
            if (e.key === 'e') { e.preventDefault(); this.export(); }
            if (e.key === 'a') { e.preventDefault(); this.selectAll(); }
        }
        
        if (e.key === 't') { this.transformControls.setMode('translate'); this.updateStatus(); }
        if (e.key === 'r' && !e.ctrlKey) { this.transformControls.setMode('rotate'); this.updateStatus(); }
        if (e.key === 's' && !e.ctrlKey) { this.transformControls.setMode('scale'); this.updateStatus(); }
        if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
        
        // Timeline keybindings
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this.currentFrame = Math.max(0, this.currentFrame - (this.isShiftHeld ? 10 : 1));
            this.updatePlayhead();
            this.applyFrame();
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            this.currentFrame = Math.min(this.totalFrames, this.currentFrame + (this.isShiftHeld ? 10 : 1));
            this.updatePlayhead();
            this.applyFrame();
        }
        if (e.key === 'Home') { e.preventDefault(); this.currentFrame = 0; this.updatePlayhead(); this.applyFrame(); }
        if (e.key === 'End') { e.preventDefault(); this.currentFrame = this.totalFrames; this.updatePlayhead(); this.applyFrame(); }
        if (e.key === 'k' || e.key === 'K') { this.addKeyframe(); } // K for keyframe
        if (e.key === '[') { this.prevKeyframe(); }
        if (e.key === ']') { this.nextKeyframe(); }
    }
    
    prevKeyframe() {
        // Jump to previous keyframe
        let prevFrame = 0;
        this.sceneCameras.forEach(cam => {
            const camClips = this.clips[cam.id];
            if (camClips?.position) {
                camClips.position.forEach(kf => {
                    if (kf.frame < this.currentFrame && kf.frame > prevFrame) {
                        prevFrame = kf.frame;
                    }
                });
            }
        });
        this.currentFrame = prevFrame;
        this.updatePlayhead();
        this.applyFrame();
    }
    
    nextKeyframe() {
        // Jump to next keyframe
        let nextFrame = this.totalFrames;
        this.sceneCameras.forEach(cam => {
            const camClips = this.clips[cam.id];
            if (camClips?.position) {
                camClips.position.forEach(kf => {
                    if (kf.frame > this.currentFrame && kf.frame < nextFrame) {
                        nextFrame = kf.frame;
                    }
                });
            }
        });
        this.currentFrame = nextFrame;
        this.updatePlayhead();
        this.applyFrame();
    }
    
    onKeyUp(e) {
        if (e.key === 'Shift') { this.isShiftHeld = false; this.updateSnapping(); }
        if (e.key === 'Alt') { this.isAltHeld = false; this.updateSnapping(); }
        if (e.key === 'Control') this.isCtrlHeld = false;
    }
    
    onClick(e) {
        if (this.transformControls.dragging) return;
        
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const meshes = this.objects.map(o => o.mesh);
        const intersects = this.raycaster.intersectObjects(meshes, true);
        
        if (intersects.length > 0) {
            let obj = intersects[0].object;
            while (obj.parent && !this.objects.find(o => o.mesh === obj)) {
                obj = obj.parent;
            }
            const objData = this.objects.find(o => o.mesh === obj);
            if (objData) this.selectObject(objData, this.isShiftHeld);
        } else if (!this.isShiftHeld) {
            this.deselectAll();
        }
    }
    
    selectAll() {
        this.deselectAll();
        this.objects.forEach(o => this.addToSelection(o));
    }
    
    updateSnapping() {
        const shouldSnap = this.gridSnapEnabled || this.isAltHeld;
        const fineSnap = this.isShiftHeld && this.isAltHeld;
        
        if (shouldSnap) {
            const snapVal = fineSnap ? this.theme.controls.snapPosition / 4 : this.theme.controls.snapPosition;
            this.transformControls.setTranslationSnap(snapVal);
            this.transformControls.setRotationSnap(THREE.MathUtils.degToRad(this.theme.controls.snapAngle));
        } else if (this.isShiftHeld) {
            this.transformControls.setTranslationSnap(this.theme.controls.snapPosition);
            this.transformControls.setRotationSnap(THREE.MathUtils.degToRad(this.theme.controls.snapAngle));
        } else {
            this.transformControls.setTranslationSnap(null);
            this.transformControls.setRotationSnap(null);
        }
        this.updateStatus();
    }
    
    handleAction(action) {
        const actions = {
            save: () => this.save(),
            load: () => this.load(),
            export: () => this.export(),
            undo: () => this.undo(),
            redo: () => this.redo(),
            copy: () => this.copy(),
            paste: () => this.paste(),
            duplicate: () => this.duplicateSelected(),
            delete: () => this.deleteSelected(),
            addQuad: () => this.addQuad(),
            addCube: () => this.addCube(),
            addCamera: () => this.addCamera()
        };
        actions[action]?.();
    }
    
    // ==================== SAVE/LOAD/EXPORT ====================
    
    save() {
        const data = {
            version: 2,
            gridPlane: this.currentGridPlane,
            objects: this.objects.map(o => this.serializeObject(o)),
            clips: this.clips,
            totalFrames: this.totalFrames
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'scene.json';
        a.click();
    }
    
    load() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (data.gridPlane) this.setGridPlane(data.gridPlane);
                    if (data.totalFrames) this.totalFrames = data.totalFrames;
                    this.restoreState(data);
                } catch (err) {
                    console.error('Load failed:', err);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
    
    export() {
        const exporter = new GLTFExporter();
        const exportScene = new THREE.Scene();
        
        this.objects.filter(o => o.type !== 'camera').forEach(o => {
            const clone = o.mesh.clone();
            if (clone.material) {
                clone.material = clone.material.clone();
                clone.material.emissiveIntensity = 0;
            }
            exportScene.add(clone);
        });
        
        exporter.parse(exportScene, (result) => {
            const blob = new Blob([result], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'scene.glb';
            a.click();
        }, (err) => console.error('Export failed:', err), { binary: true });
    }
    
    // ==================== RENDER ====================
    
    setTopDownView() {
        this.camera.position.set(0, 8, 0);
        this.camera.lookAt(0, 0, 0);
    }
    
    updateRendererSize() {
        const toolbar = document.getElementById('toolbar');
        const sidebar = document.getElementById('sidebar');
        const statusBar = document.getElementById('status-bar');
        const timeline = document.getElementById('timeline');
        
        const width = window.innerWidth - (sidebar?.offsetWidth || 0);
        const height = window.innerHeight - (toolbar?.offsetHeight || 0) - (statusBar?.offsetHeight || 0) - (timeline?.offsetHeight || 0);
        
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        // Playback
        if (this.isPlaying) {
            this.currentFrame++;
            if (this.currentFrame >= this.totalFrames) {
                this.currentFrame = 0;
            }
            this.updatePlayhead();
            this.applyFrame();
        }
        
        // Update camera tracking
        this.updateCameraTracking();
        
        this.orbitControls.update();
        this.renderer.render(this.scene, this.camera);
        this.renderCameraPreview();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.editor = new MeshEditor();
});

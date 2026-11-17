// wwwroot/js/mapMonitor.js
// Карта моніторингу TransportIn (Leaflet, завантажується динамічно з CDN)

const COLORS = { free: '#10b981', moving: '#3b82f6', loading: '#f59e0b', blocked: '#ef4444' };
const ZONE_COLORS = { danger: '#ef4444', warning: '#f59e0b' };

let leafletPromise = null;
let map = null;
let dotNet = null;
let drawing = false;
let selectedId = null;

let vehicleLayer = null;
let routeLayer = null;
let zoneLayer = null;

const markers = {};   // id -> { marker, status, visible }
const routeLines = {}; // id -> polyline

function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(css);

        const s = document.createElement('script');
        s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        s.onload = () => resolve();
        s.onerror = () => { leafletPromise = null; reject(new Error('Leaflet не завантажився (перевірте інтернет)')); };
        document.head.appendChild(s);
    });
    return leafletPromise;
}

function injectStyles() {
    if (document.getElementById('tm-map-styles')) return;
    const st = document.createElement('style');
    st.id = 'tm-map-styles';
    st.textContent = `
        .tm-marker{width:30px;height:30px;border-radius:50%;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.55);transition:transform .2s}
        .tm-free{background:${COLORS.free}} .tm-moving{background:${COLORS.moving}}
        .tm-loading{background:${COLORS.loading}} .tm-blocked{background:${COLORS.blocked};animation:tm-pulse 1.2s infinite}
        .tm-selected{transform:scale(1.3);box-shadow:0 0 0 4px rgba(255,255,255,.35),0 2px 8px rgba(0,0,0,.55)}
        @keyframes tm-pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.7)}70%{box-shadow:0 0 0 14px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
        .tm-drawing{cursor:crosshair !important}
        .leaflet-container{background:#0f172a;font-family:inherit}
        .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.9) contrast(.85) saturate(.7)}
        .leaflet-control-attribution{background:rgba(15,23,42,.7) !important;color:#94a3b8 !important}
        .leaflet-control-attribution a{color:#60a5fa !important}
    `;
    document.head.appendChild(st);
}

function iconFor(status, selected) {
    return L.divIcon({
        className: '',
        html: `<div class="tm-marker tm-${status}${selected ? ' tm-selected' : ''}">🚚</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
}

export async function init(el, dotNetRef) {
    await loadLeaflet();
    injectStyles();
    dotNet = dotNetRef;

    if (map) { map.remove(); map = null; }

    map = L.map(el, { zoomControl: true }).setView([50.4501, 30.5234], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    zoneLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    vehicleLayer = L.layerGroup().addTo(map);

    map.on('click', (e) => {
        if (drawing && dotNet) dotNet.invokeMethodAsync('OnMapClicked', e.latlng.lat, e.latlng.lng);
    });

    setTimeout(() => map && map.invalidateSize(), 200);
    return true;
}

// Дорожня геометрія через публічний OSRM. Якщо недоступний — повертає null (C# використає прямі лінії)
export async function getRoadRoute(points) {
    try {
        const coords = points.map(p => `${p[1]},${p[0]}`).join(';');
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
            { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return null;
        const j = await r.json();
        if (j.code !== 'Ok' || !j.routes || !j.routes.length) return null;
        return j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    } catch {
        return null;
    }
}

export function setRoutes(list) {
    if (!map) return;
    routeLayer.clearLayers();
    for (const k of Object.keys(routeLines)) delete routeLines[k];
    for (const r of list) {
        const line = L.polyline(r.points, { color: '#3b82f6', weight: 4, opacity: 0.5, dashArray: '8 8' });
        line.addTo(routeLayer);
        routeLines[r.id] = line;
    }
    restyleRoutes();
}

function restyleRoutes() {
    for (const id of Object.keys(routeLines)) {
        const sel = id === selectedId;
        routeLines[id].setStyle({
            color: sel ? '#60a5fa' : '#3b82f6',
            weight: sel ? 6 : 4,
            opacity: sel ? 0.95 : 0.45
        });
        if (sel) routeLines[id].bringToFront();
    }
}

export function updateVehicles(list) {
    if (!map) return;
    for (const v of list) {
        let m = markers[v.id];
        if (!m) {
            const marker = L.marker([v.lat, v.lng], { icon: iconFor(v.status, v.id === selectedId) });
            marker.bindTooltip(`${v.model} · ${v.id}`, { direction: 'top', offset: [0, -14] });
            marker.on('click', () => dotNet && dotNet.invokeMethodAsync('OnVehicleClicked', v.id));
            m = markers[v.id] = { marker, status: v.status, visible: false };
        } else {
            m.marker.setLatLng([v.lat, v.lng]);
            if (m.status !== v.status) {
                m.status = v.status;
                m.marker.setIcon(iconFor(v.status, v.id === selectedId));
            }
        }
        if (v.visible && !m.visible) { vehicleLayer.addLayer(m.marker); m.visible = true; }
        if (!v.visible && m.visible) { vehicleLayer.removeLayer(m.marker); m.visible = false; }
    }
}

export function selectVehicle(id, fly) {
    selectedId = id;
    for (const k of Object.keys(markers)) {
        markers[k].marker.setIcon(iconFor(markers[k].status, k === id));
    }
    restyleRoutes();
    if (id && fly && markers[id]) {
        map.flyTo(markers[id].marker.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.8 });
    }
}

export function setZones(list) {
    if (!map) return;
    zoneLayer.clearLayers();
    for (const z of list) {
        const color = ZONE_COLORS[z.level] || ZONE_COLORS.danger;
        const c = L.circle([z.lat, z.lng], {
            radius: z.radius, color, weight: 2, fillColor: color, fillOpacity: 0.2
        });
        c.bindTooltip(`${z.level === 'danger' ? '⛔' : '⚠️'} ${z.title} (${z.radius} м)`, { sticky: true });
        c.addTo(zoneLayer);
    }
}

export function setLayerVisible(name, visible) {
    if (!map) return;
    const layer = name === 'routes' ? routeLayer : name === 'zones' ? zoneLayer : null;
    if (!layer) return;
    if (visible) map.addLayer(layer); else map.removeLayer(layer);
}

export function setDrawing(on) {
    drawing = on;
    if (!map) return;
    const c = map.getContainer();
    if (on) c.classList.add('tm-drawing'); else c.classList.remove('tm-drawing');
}

export function flyTo(lat, lng, zoom) {
    if (map) map.flyTo([lat, lng], zoom || 14, { duration: 0.8 });
}

export function resetView() {
    if (map) map.flyTo([50.4501, 30.5234], 11, { duration: 0.8 });
}

export function dispose() {
    try { if (map) map.remove(); } catch { }
    map = null; dotNet = null; selectedId = null;
    for (const k of Object.keys(markers)) delete markers[k];
    for (const k of Object.keys(routeLines)) delete routeLines[k];
}

/* =============================================================================
 *  Facturas de Proveedores — Lucciano's (frontend)
 *  Vanilla JS, sin build. Habla con el Worker (window.FACTURAS_API).
 *  Rutas por hash: #/tablero, #/bandeja, #/facturas, #/factura/ID, #/shares,
 *                  #/proveedores, #/admin, #/cuenta, #/propuestas, #/pago/ID
 * ============================================================================= */
'use strict';

// ---------------------------------------------------------------------------
//  Estado y utilidades
// ---------------------------------------------------------------------------
const API = (() => {
  // ?api=http://localhost:8787 permite apuntar a otro Worker (pruebas)
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) localStorage.setItem('facturas_api', q);
    return (localStorage.getItem('facturas_api') || window.FACTURAS_API).replace(/\/$/, '');
  } catch { return String(window.FACTURAS_API).replace(/\/$/, ''); }
})();

const S = { token: null, user: null, arca: 'off', cuentas: null, pdfUrl: null, vista: null };
try { S.token = localStorage.getItem('facturas_token'); } catch { /* sin storage */ }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NIVEL = { carga: 1, aprobador: 2, admin: 3 };
const puede = (rol) => S.user && NIVEL[S.user.rol] >= NIVEL[rol];

const fmtNum = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Formateadores a prueba de datos raros: nunca devuelven "undefined", "NaN" ni "Invalid Date".
const $$m = (n) => { if (n === null || n === undefined || n === '') return '—'; const x = Number(n); return Number.isFinite(x) ? '$ ' + fmtNum.format(x) : '—'; };
// Fechas: acepta AAAA-MM-DD (nuestra base) y DD/MM/AAAA (Shares); cualquier otra cosa se muestra tal cual
const fmtF = (v) => {
  if (!v) return '—';
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/))) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
};
const fmtFH = (s) => {
  if (!s) return '—';
  const t = String(s);
  const d = new Date(t.replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/.test(t) || !/\d{2}:\d{2}/.test(t) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? fmtF(t) : d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
};
const nroCbte = (f) => (f.pto_vta != null && f.numero != null) ? `${String(f.pto_vta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}` : '—';
const fmtCuit = (c) => { c = String(c || ''); return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : (c || '—'); };
const TIPOS = { 1: 'FA', 2: 'ND A', 3: 'NC A', 6: 'FB', 7: 'ND B', 8: 'NC B', 11: 'FC', 12: 'ND C', 13: 'NC C', 51: 'FM', 52: 'ND M', 53: 'NC M', 201: 'FCE A', 202: 'ND FCE A', 203: 'NC FCE A', 206: 'FCE B', 207: 'ND FCE B', 208: 'NC FCE B', 211: 'FCE C', 212: 'ND FCE C', 213: 'NC FCE C', 17: 'LSP A', 18: 'LSP B', 81: 'TFA', 82: 'TFB', 83: 'Tique' };
const ESTADOS = { recibida: 'En cola de lectura', leyendo: 'Leyendo', excepcion: 'En excepción', lista: 'Lista para Shares', en_cola: 'En cola para Shares', enviando: 'Enviando a Shares', cargada: 'Cargada en Shares', error_shares: 'Error Shares', rechazada: 'Rechazada' };
const METODOS = { plantilla: 'Configuración del proveedor', plantilla_pendiente: 'Configuración pendiente', reglas: 'Reglas generales (sin IA)', ia: 'Gemini (IA)', manual: 'Carga manual' };
const badgeMetodo = (m) => m ? `<span class="badge ${m === 'ia' ? 'b-normal' : m === 'plantilla' ? 'b-ok' : 'b-aviso'}">${esc(METODOS[m] || m)}</span>` : '';
const badgeEstado = (e) => `<span class="badge b-${esc(e)}">${esc(ESTADOS[e] || e)}</span>`;
const JURIS = ['BUENOS AIRES', 'CABA', 'CORDOBA', 'SANTA FE', 'MENDOZA', 'NEUQUEN', 'SALTA', 'TUCUMAN', 'CHACO', 'MISIONES', 'RIO NEGRO', 'CORRIENTES', 'CHUBUT', 'LA PAMPA', 'TIERRA DEL FUEGO'];

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'ver' + (error ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, error ? 6000 : 3000);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  // "Failed to fetch" = no llegó ninguna respuesta (corte de red, el Worker se reinició o se pasó de tiempo).
  // Las consultas (GET) se reintentan solas 2 veces; las que modifican datos no, para no duplicar nada.
  let res;
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (method === 'GET' && [502, 503, 504].includes(res.status) && intento < 2) throw new TypeError('HTTP ' + res.status);
      break;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (method !== 'GET' || intento >= 2) throw new Error(method === 'GET' ? 'No hay conexión con el servidor. Probá de nuevo en unos segundos.' : 'Se cortó la conexión y no sé si se guardó. Recargá la factura antes de volver a intentar.');
      await new Promise(r => setTimeout(r, 700 * (intento + 1)));
    }
  }
  if (res.status === 401 && S.token && !path.startsWith('/api/login')) {
    salir(false);
    throw new Error('La sesión venció. Volvé a ingresar.');
  }
  if (raw) { if (!res.ok) throw new Error('HTTP ' + res.status); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// Envuelve un botón: lo deshabilita con spinner mientras corre la acción
async function conBoton(btn, fn) {
  const txt = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cargando"></span>'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = txt; } }
}

function modal(html, { ancho = false, alMontar } = {}) {
  const m = $('#modal');
  $('.modal-box', m).classList.toggle('ancho', ancho);
  $('.modal-cuerpo', m).innerHTML = html;
  m.hidden = false;
  const cerrar = () => { m.hidden = true; $('.modal-cuerpo', m).innerHTML = ''; };
  $('.modal-cerrar', m).onclick = cerrar;
  m.onclick = (e) => { if (e.target === m) cerrar(); };
  if (alMontar) alMontar($('.modal-cuerpo', m), cerrar);
  const primero = $('input, textarea, select', m);
  if (primero) setTimeout(() => primero.focus(), 30);
  return cerrar;
}

// Confirmación propia (en vez de confirm() del navegador, que Chrome puede bloquear en silencio
// si alguna vez se tildó "no permitir más diálogos": ahí el botón parece no hacer nada)
function confirmar(texto, { boton = 'Sí, seguir', peligro = false } = {}) {
  return new Promise((resolve) => {
    let hecho = false;
    modal(`<h2 style="margin-bottom:6px">¿Confirmás?</h2><p class="muted" style="white-space:pre-line;margin:0 0 18px">${esc(texto)}</p>
      <div class="acciones" style="justify-content:flex-end"><button class="btn" data-no>Cancelar</button><button class="btn ${peligro ? 'btn-rojo' : 'btn-acento'}" data-si>${esc(boton)}</button></div>`, {
      alMontar: (el, cerrar) => {
        const fin = (v) => { if (hecho) return; hecho = true; cerrar(); resolve(v); };
        $('[data-si]', el).onclick = () => fin(true);
        $('[data-no]', el).onclick = () => fin(false);
        setTimeout(() => $('[data-si]', el)?.focus(), 0);
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!hecho) { hecho = true; resolve(false); } } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

function pedirTexto({ titulo, ayuda = '', etiqueta = 'Comentario', boton = 'Confirmar', minimo = 5, valor = '' }) {
  return new Promise((resolve) => {
    let listo = false;
    modal(`<h2>${esc(titulo)}</h2>${ayuda ? `<p class="muted">${esc(ayuda)}</p>` : ''}
      <div class="campo"><label>${esc(etiqueta)}</label><textarea id="pt-txt">${esc(valor)}</textarea></div>
      <div class="acciones"><button class="btn btn-negro" id="pt-ok">${esc(boton)}</button><button class="btn" id="pt-no">Cancelar</button></div>`, {
      alMontar: (el, cerrar) => {
        $('#pt-ok', el).onclick = () => {
          const v = $('#pt-txt', el).value.trim();
          if (v.length < minimo) { toast(`Escribí al menos ${minimo} caracteres.`, true); return; }
          listo = true; cerrar(); resolve(v);
        };
        $('#pt-no', el).onclick = () => { cerrar(); resolve(null); };
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

async function cuentas(forzar = false) {
  if (!S.cuentas || forzar) S.cuentas = (await api('/api/cuentas')).cuentas;
  return S.cuentas;
}
function nombreCuenta(cod) {
  const c = (S.cuentas || []).find(x => String(x.codigo_concepto) === String(cod));
  return c ? c.denominacion : '';
}
function datalistCuentas() {
  return `<datalist id="dl-cuentas">${(S.cuentas || []).map(c => `<option value="${c.codigo_concepto}">${esc(c.denominacion)}</option>`).join('')}</datalist>`;
}

// Lee un Excel/CSV con SheetJS → array de filas (array de arrays)
async function leerPlanilla(file) {
  if (!window.XLSX) throw new Error('No cargó la librería de Excel. Revisá la conexión.');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
}
function descargarCsv(nombre, filas) {
  const csv = filas.map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
//  Sesión
// ---------------------------------------------------------------------------
function guardarToken(t) { S.token = t; try { t ? localStorage.setItem('facturas_token', t) : localStorage.removeItem('facturas_token'); } catch { } }
async function salir(llamarApi = true) {
  if (llamarApi) await api('/api/logout', { method: 'POST' }).catch(() => null);
  guardarToken(null); S.user = null; S.cuentas = null;
  location.hash = '';
  vistaLogin();
}

// ---------------------------------------------------------------------------
//  Íconos (trazo de 2px, estilo feather) y avatares
// ---------------------------------------------------------------------------
const svgI = (p) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  home: svgI('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  inbox: svgI('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  doc: svgI('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  send: svgI('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  users: svgI('<path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M17 11a3 3 0 1 0 0-6M21 21v-2a4 4 0 0 0-3-3.87"/>'),
  gear: svgI('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  upload: svgI('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  refresh: svgI('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  logout: svgI('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  check: svgI('<path d="M20 6 9 17l-5-5"/>'),
  arrow: svgI('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svgI('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
  user: svgI('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>'),
  copy: svgI('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  shield: svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  calc: svgI('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h8"/>'),
  x: svgI('<path d="M6 6l12 12M18 6 6 18"/>'),
  mail: svgI('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
  sparkle: svgI('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  sun: svgI('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svgI('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  info: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  alert: svgI('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  coin: svgI('<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2a2.6 2.6 0 0 1-2.5-1.5M12 6.5V8M12 16v1.5"/>'),
  ojo: svgI('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  ojoNo: svgI('<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>'),
  clock: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  calendar: svgI('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
  chart: svgI('<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-8"/>'),
  chat: svgI('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>'),
  phone: svgI('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  sliders: svgI('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  book: svgI('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
};
const COLORES_AV = ['#b0254a', '#2d5bba', '#1f7a45', '#a85a07', '#6b4bb8', '#0f7d86', '#7a4a2e', '#c0392b'];
const iniciales = (s) => String(s || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(SRL|SAS|S\.?A\.?|SA|SOCIEDAD|ANONIMA)$/i.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase() || String(s || '?').slice(0, 1).toUpperCase();
const colorDe = (s) => COLORES_AV[[...String(s || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORES_AV.length];
const cuad = (s) => `<span class="cuad" style="background:${colorDe(s)}" aria-hidden="true">${esc(iniciales(s))}</span>`;
const nombreProv = (f) => f.razon_social_emisor || (f.mail_from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || f.archivo_nombre || 'Sin identificar';
const $$corto = (n) => { n = Number(n) || 0; return Math.abs(n) >= 1e6 ? '$ ' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M' : $$m(n); };

// ---------------------------------------------------------------------------
//  Tiempo ahorrado (minutos por factura). Ajustalos cuando midas con cronómetro.
//  MANUAL (alguien con práctica): abrir mail y bajar PDF 0,5 · constatar en ARCA 1
//          · buscar proveedor y tipear cabecera 1,5 · netos/IVA/percepciones 1
//          · elegir cuenta, controlar y grabar 1  →  5 min
//  AUTO: entró sola, solo se mira y se aprueba en lote → 0,5 min
//  REVISADA: necesitó una persona (proveedor nuevo, cuenta, importes) → 3 min
// ---------------------------------------------------------------------------
const TIEMPOS = { manual: 5, auto: 0.5, revisada: 3 };
// Minutos ahorrados por un grupo de facturas cargadas: cada una según cómo entró (sola o revisada). No cambia después.
function ahorro(n, solas) { n = Number(n) || 0; solas = Math.min(Number(solas) || 0, n); return solas * (TIEMPOS.manual - TIEMPOS.auto) + (n - solas) * (TIEMPOS.manual - TIEMPOS.revisada); }
function minutosSistema(pctAuto) { const p = pctAuto == null ? 0.5 : pctAuto / 100; return p * TIEMPOS.auto + (1 - p) * TIEMPOS.revisada; }
function fmtDuracion(min) { min = Math.round(min); if (min < 60) return min + ' min'; const h = Math.floor(min / 60), m = min % 60; return h + ' h' + (m ? ' ' + m + ' min' : ''); }

// Ojito para ver la contraseña: se agrega solo a cualquier campo de contraseña que aparezca (login, Mi cuenta, modales)
function ojosClave(root = document) {
  $$('input[type="password"]:not([data-ojo])', root).forEach(inp => {
    inp.dataset.ojo = '1';
    const caja = document.createElement('span');
    caja.className = 'clave-caja';
    inp.parentNode.insertBefore(caja, inp);
    caja.appendChild(inp);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'clave-ojo'; b.tabIndex = -1;
    b.setAttribute('aria-label', 'Mostrar contraseña'); b.title = 'Mostrar contraseña';
    b.innerHTML = ICO.ojo;
    b.onclick = () => {
      const ver = inp.type === 'password';
      inp.type = ver ? 'text' : 'password';
      b.innerHTML = ver ? ICO.ojoNo : ICO.ojo;
      const t = ver ? 'Ocultar contraseña' : 'Mostrar contraseña';
      b.setAttribute('aria-label', t); b.title = t;
      inp.focus();
    };
    caja.appendChild(b);
  });
}
new MutationObserver(() => ojosClave()).observe(document.documentElement, { childList: true, subtree: true });

// Tema claro/oscuro (lo inicializa index.html antes de pintar)
function temaActual() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function alternarTema() {
  const nuevo = temaActual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('facturas_tema', nuevo); } catch { }
  const b = $('#b-tema'); if (b) b.innerHTML = nuevo === 'dark' ? ICO.sun : ICO.moon;
}

// ---------------------------------------------------------------------------
//  Motivos en criollo: cada código de excepción → grupo, título y tono
// ---------------------------------------------------------------------------
const GRUPOS = {
  nuevo: { t: 'Proveedor nuevo', ico: 'user', tono: 'acc', orden: 2 },
  duplicado: { t: 'Ya cargada', ico: 'copy', tono: 'neg', orden: 1 },
  cuenta: { t: 'Falta la cuenta', ico: 'coin', tono: 'acc', orden: 3 },
  importes: { t: 'Revisar importes', ico: 'calc', tono: 'warn', orden: 4 },
  arca: { t: 'ARCA', ico: 'shield', tono: 'info', orden: 5 },
  manual: { t: 'Cargar a mano', ico: 'doc', tono: 'warn', orden: 6 },
  lectura: { t: 'Leyendo', ico: 'clock', tono: 'info', orden: 7 },
};
const MOTIVOS = {
  PROVEEDOR_NUEVO: ['nuevo', 'Proveedor nuevo', 'Primera factura: confirmá el desglose y la cuenta. Las próximas se leen solas.'],
  FORMATO_CAMBIO: ['nuevo', 'Cambió el formato', 'El proveedor cambió su factura: confirmá que se leyó bien.'],
  PROVEEDOR_DESCONOCIDO: ['nuevo', 'No está en el maestro', 'Dalo de alta para poder cargarla en Shares.'],
  PROVEEDOR_COND_IVA: ['nuevo', 'Falta condición de IVA', 'Completala en la ficha del proveedor.'],
  YA_EN_SHARES: ['duplicado', 'Ya está en Shares', 'Alguien la cargó antes: la app la rechaza sola como duplicada.'],
  DUPLICADO: ['duplicado', 'Posible duplicado', 'Ya entró otra igual por la casilla.'],
  IMPUTACION: ['cuenta', 'Confirmar la cuenta', 'Elegí o confirmá la cuenta contable.'],
  CUENTA_INEXISTENTE: ['cuenta', 'Cuenta fuera del plan', 'La cuenta no existe en el plan de Shares.'],
  FISCAL_MAPEO: ['cuenta', 'Percepción sin cuenta', 'Hay una percepción que no sabemos dónde imputar.'],
  ARITMETICA: ['importes', 'Los importes no cierran', 'La suma de los componentes no da el total.'],
  QR_INCONSISTENTE: ['importes', 'No coincide con el QR', 'Lo leído no coincide con el QR de ARCA.'],
  MONEDA: ['importes', 'Moneda extranjera', 'Revisá el tipo de cambio: a Shares va en pesos.'],
  FECHA: ['importes', 'Fecha rara', 'La fecha está fuera del rango esperado.'],
  CBU: ['importes', 'CBU distinto', 'El CBU no es el del maestro: ojo antes de pagar.'],
  CBU_NUEVO: ['importes', 'CBU nuevo', 'Primera vez que vemos este CBU.'],
  ARCA_RECHAZADO: ['arca', 'ARCA no valida el CAE', 'El comprobante no figura en ARCA como emitido.'],
  ARCA_ERROR: ['arca', 'ARCA no respondió', 'Se reintenta sola cada 15 minutos.'],
  ARCA_PENDIENTE: ['arca', 'Falta constatar en ARCA', 'Se reintenta sola cada 15 minutos.'],
  ARCA_OFF: ['arca', 'ARCA apagado', 'La constatación está desactivada.'],
  PROVEEDOR_NO_EN_SHARES: ['nuevo', 'Falta darlo de alta en Shares', 'Shares no crea proveedores: hay que darlo de alta allá antes de enviar.'],
  ARCA_NO_APLICA: ['arca', 'Sin constatación ARCA', 'Servicio público (C.E.S.P.) o tique de controlador fiscal: ARCA no permite constatarlo por web service.'],
  LECTURA: ['manual', 'No se pudo leer', 'Completá los datos mirando el PDF.'],
  NO_ES_FACTURA: ['manual', 'No parece una factura', 'Puede ser un remito, un resumen o publicidad.'],
  TIPO_NO_SOPORTADO: ['manual', 'Tipo no contemplado', 'Este tipo de comprobante no se carga automático.'],
  FACTURA_B: ['manual', 'Factura B', 'Nos facturaron B: revisá si corresponde.'],
  DESTINATARIO: ['manual', 'Emitida a otro CUIT', 'No está a nombre de una empresa del grupo.'],
  SHARES_CONSULTA: ['manual', 'No se pudo consultar Shares', 'No pudimos chequear si ya estaba cargada.'],
};
const motivo = (cod) => { const m = MOTIVOS[cod] || ['manual', cod, '']; return { ...GRUPOS[m[0]], grupoT: GRUPOS[m[0]].t, g: m[0], t: m[1], d: m[2], titulo: m[1] }; };
// DESC_EXC se mantiene para compatibilidad (tablas viejas, CSV)
const DESC_EXC = Object.fromEntries(Object.entries(MOTIVOS).map(([k, v]) => [k, v[1]]));
const TONO_BADGE = { acc: 'b-acc', warn: 'b-warn', neg: 'b-critica', info: 'b-recibida' };

// Motivo principal de una factura (el más grave / prioritario)
function motivoPrincipal(f) {
  if (['recibida', 'leyendo'].includes(f.estado)) return { ...GRUPOS.lectura, g: 'lectura', titulo: 'Leyendo', d: f.error_proceso ? 'Último error: ' + f.error_proceso : 'El lector la procesa en minutos.' };
  const cods = (f.excepciones || '').split(',').filter(Boolean).map(x => { const [c, sev] = x.split(':'); return { c, sev, m: motivo(c) }; });
  if (!cods.length) return { ...GRUPOS.manual, g: 'manual', titulo: 'Revisar', d: f.error_proceso || 'Abrila para ver el detalle.' };
  cods.sort((a, b) => (a.sev === 'critica' ? 0 : 1) - (b.sev === 'critica' ? 0 : 1) || a.m.orden - b.m.orden);
  const p = cods[0].m;
  return { ...p, extra: cods.length - 1, codigos: cods.map(x => x.c) };
}

// ---------------------------------------------------------------------------
//  Login
// ---------------------------------------------------------------------------
// Color de la barra del navegador en el celu (pistacho en el login, el normal adentro)
function colorBarra(c) {
  $$('meta[name="theme-color"]').forEach(m => { if (!m.dataset.orig) m.dataset.orig = m.content; m.content = c || m.dataset.orig; });
}

async function vistaLogin() {
  let setup = false;
  try { setup = (await api('/api/estado')).setup_requerido; } catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><div></div></div>
      <div class="login-form"><div class="caja"><h1>Sin conexión</h1><p>No pude conectar con el servidor (${esc(API)}).<br>${esc(e.message)}</p><button class="btn btn-acento btn-grande" onclick="location.reload()">${ICO.refresh}Reintentar</button></div></div></div>`;
    return;
  }
  $('#app').innerHTML = `<div class="login">
    <div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><p class="login-sub">Facturas de proveedores</p>
      <div class="login-txt"><h2>Las facturas de proveedores, sin tipear.</h2><p>Llegan por mail, se leen solas, se validan contra ARCA y quedan listas para Shares. Vos solo mirás lo que necesita una persona.</p></div>
      <div class="pasos"><span>${ICO.mail}Llega por mail</span><span>${ICO.sparkle}Se lee sola</span><span>${ICO.shield}ARCA la valida</span><span>${ICO.send}Va a Shares</span></div></div>
    <div class="login-form"><form id="f-login">
      <h1>${setup ? 'Primer ingreso' : 'Ingresar'}</h1>
      <p>${setup ? 'Creá el usuario administrador.' : "Usá tu mail de Lucciano's."}</p>
      ${setup ? '<div class="campo"><label for="lg-n">Nombre</label><input id="lg-n" name="nombre" required autocomplete="name"></div>' : ''}
      <div class="campo"><label for="lg-u">Mail</label><input id="lg-u" name="email" type="email" required autocomplete="username"></div>
      <div class="campo"><label for="lg-p">Contraseña</label><input id="lg-p" name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}"></div>
      <div class="campo hidden" id="c-totp"><label for="lg-t">Código de verificación</label><input id="lg-t" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" class="mono"></div>
      <button class="btn btn-acento btn-grande" type="submit">${setup ? 'Crear y entrar' : 'Entrar'} ${ICO.arrow}</button>
    </form></div></div>`;
  colorBarra('#A8C686');
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await conBoton($('button[type=submit]', e.target), async () => {
      const r = await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: fd });
      if (r.requiere_totp) { $('#c-totp').classList.remove('hidden'); $('#c-totp input').focus(); toast('Ingresá el código de tu app autenticadora.'); return; }
      colorBarra(null); guardarToken(r.token); S.user = r.usuario;
      if (!location.hash) location.hash = '#/tablero';
      iniciar();
    });
  };
}

// ---------------------------------------------------------------------------
//  Shell (barra lateral + barra superior + menú inferior en celular) y router
// ---------------------------------------------------------------------------
const RUTAS = [
  { re: /^#\/tablero$/, v: vistaTablero, nav: 'tablero', miga: '<b>Inicio</b>' },
  { re: /^#\/bandeja$/, v: vistaBandeja, nav: 'bandeja', miga: 'Trabajo / <b>Para revisar</b>' },
  { re: /^#\/facturas$/, v: vistaFacturas, nav: 'facturas', miga: 'Trabajo / <b>Todas las facturas</b>' },
  { re: /^#\/factura\/(\d+)$/, v: vistaFactura, nav: 'bandeja', miga: 'Trabajo / <b>Factura</b>' },
  { re: /^#\/shares$/, v: vistaShares, nav: 'shares', miga: 'Trabajo / <b>Enviar a Shares</b>' },
  { re: /^#\/proveedores$/, v: vistaProveedores, nav: 'proveedores', miga: 'Datos / <b>Proveedores</b>' },
  { re: /^#\/proveedor\/(\d{11})$/, v: vistaFicha, nav: 'proveedores', miga: 'Datos / Proveedores / <b>Ficha</b>' },
  { re: /^#\/pagos$/, v: vistaPagos, nav: 'pagos', miga: 'Trabajo / <b>Agenda de pagos</b>' },
  { re: /^#\/propuestas$/, v: vistaPropuestas, nav: 'propuestas', miga: 'Pagos / <b>Propuestas</b>' },
  { re: /^#\/propuesta\/nueva$/, v: vistaPropuestaEditar, nav: 'propuestas', miga: 'Pagos / <b>Nueva propuesta</b>' },
  { re: /^#\/propuesta\/(\d+)\/editar$/, v: vistaPropuestaEditar, nav: 'propuestas', miga: 'Pagos / <b>Editar propuesta</b>' },
  { re: /^#\/pagos-ajustes$/, v: vistaAjustesPagos, nav: 'propuestas', miga: 'Pagos / <b>Ajustes</b>' },
  { re: /^#\/pago\/(\d+)$/, v: vistaLote, nav: 'propuestas', miga: 'Pagos / <b>Propuesta</b>' },
  { re: /^#\/analisis$/, v: vistaAnalisis, nav: 'analisis', miga: 'Datos / <b>Análisis de compras</b>' },
  { re: /^#\/guia$/, v: vistaGuia, nav: 'guia', miga: '<b>Guía de uso</b>' },
  { re: /^#\/admin$/, v: vistaAdmin, nav: 'admin', miga: 'Datos / <b>Configuración</b>' },
  { re: /^#\/cuenta$/, v: vistaMiCuenta, nav: '', miga: '<b>Mi cuenta</b>' },
];

function shell(ruta) {
  const a = ruta.nav;
  const it = (k, ic, t, cnt = '') => `<a href="#/${k}" class="${k === a ? 'activo' : ''}" ${k === a ? 'aria-current="page"' : ''}>${ICO[ic]}<span>${t}</span>${cnt}</a>`;
  const rol = { admin: 'Administrador', aprobador: 'Aprobador', carga: 'Carga', director: 'Director' }[S.user.rol] || S.user.rol;
  const dir = esDirector();
  const arcaOk = S.arca && S.arca !== 'off';
  return `<div class="app">
    <aside class="side">
      <a class="brand" href="#/tablero"><img src="logo-negro.png" alt="Lucciano's"><span>Facturas de proveedores</span></a>
      <nav class="nav" aria-label="Secciones">
        ${dir ? `${it('propuestas', 'coin', 'Aprobar pagos', '<span class="cnt hot" data-cnt="pagos"></span>')}<div class="grp-t">Ayuda</div>${it('guia', 'book', 'Cómo aprobar')}` : `
        ${it('tablero', 'home', 'Inicio')}
        <div class="grp-t">Trabajo</div>
        ${it('bandeja', 'inbox', 'Para revisar', '<span class="cnt hot" data-cnt="revisar"></span>')}
        ${puede('aprobador') ? it('shares', 'send', 'Enviar a Shares', '<span class="cnt" data-cnt="lista"></span>') : ''}
        ${it('facturas', 'doc', 'Todas las facturas')}
        ${it('pagos', 'calendar', 'Agenda de pagos')}
        ${puede('aprobador') ? it('propuestas', 'coin', 'Propuestas de pago', '<span class="cnt" data-cnt="pagos"></span>') : ''}
        <div class="grp-t">Datos</div>
        ${it('proveedores', 'users', 'Proveedores')}
        ${it('analisis', 'chart', 'Análisis de compras')}
        ${puede('admin') ? it('admin', 'gear', 'Configuración') : ''}
        <div class="grp-t">Ayuda</div>
        ${it('guia', 'book', 'Guía de uso')}`}
      </nav>
      <div class="me"><a class="av" href="#/cuenta" title="Mi cuenta">${esc(iniciales(S.user.nombre))}</a>
        <a class="who" href="#/cuenta"><b>${esc(S.user.nombre)}</b><small>${esc(rol)}</small></a>
        <div class="ibtns"><button class="ibtn" id="b-tema" title="Claro / oscuro" aria-label="Cambiar tema">${temaActual() === 'dark' ? ICO.sun : ICO.moon}</button><button class="ibtn" id="b-salir" title="Salir" aria-label="Salir">${ICO.logout}</button></div></div>
    </aside>
    <div style="min-width:0">
      <header class="top"><img class="marca-m" src="logo-negro.png" alt="Lucciano's"><div class="crumbs">${ruta.miga}</div>
        ${dir ? '<span style="flex:1"></span>' : `<label class="buscar">${ICO.search}<input id="buscar-global" placeholder="Buscar factura, proveedor o CUIT…" aria-label="Buscar"><kbd>Ctrl K</kbd></label>
        <div class="estado-sis" title="Constatación de ARCA"><i style="${arcaOk ? '' : 'background:var(--warn);box-shadow:0 0 0 3px var(--warn-bg)'}"></i>${arcaOk ? 'ARCA ' + esc(S.arca === 'produccion' ? 'en producción' : S.arca) : 'ARCA apagado'}</div>`}<button class="ibtn" id="b-actualizar" title="Actualizar" aria-label="Actualizar">${ICO.refresh}</button></header>
      <main id="vista" class="entra"><div class="vacio"><span class="cargando"></span></div></main>
    </div></div>
    <nav class="mnav" aria-label="Secciones">${dir ? `
      <a href="#/propuestas" class="${a === 'propuestas' ? 'activo' : ''}">${ICO.coin}Aprobar<span class="cnt hot" data-cnt="pagos"></span></a>
      <a href="#/guia" class="${a === 'guia' ? 'activo' : ''}">${ICO.book}Ayuda</a>` : `
      <a href="#/tablero" class="${a === 'tablero' ? 'activo' : ''}">${ICO.home}Inicio</a>
      <a href="#/bandeja" class="${a === 'bandeja' ? 'activo' : ''}">${ICO.inbox}Revisar<span class="cnt hot" data-cnt="revisar"></span></a>
      ${puede('aprobador') ? `<a href="#/shares" class="${a === 'shares' ? 'activo' : ''}">${ICO.send}Shares</a>` : ''}
      <a href="#/facturas" class="${a === 'facturas' ? 'activo' : ''}">${ICO.doc}Facturas</a>
      <a href="#/proveedores" class="${a === 'proveedores' ? 'activo' : ''}">${ICO.users}Proveed.</a>`}
    </nav>`;
}

// Contadores de la barra lateral (se cachean 60 s para no gastar lecturas de D1)
async function contadores(t = null) {
  try {
    if (esDirector()) {
      if (S.cnt && Date.now() - S.cnt.at < 60000) return pintarContadores(S.cnt);
      const r = await api('/api/pagos/resumen');
      S.cnt = { at: Date.now(), pagos: r.esperando || 0 };
      return pintarContadores(S.cnt);
    }
    if (!t) {
      if (S.cnt && Date.now() - S.cnt.at < 60000) return pintarContadores(S.cnt);
      t = await api('/api/tablero');
    }
    const rp = puede('aprobador') ? await api('/api/pagos/resumen').catch(() => ({})) : {};
    S.cnt = { at: Date.now(), revisar: t.por_estado?.excepcion?.n || 0, lista: (t.por_estado?.lista?.n || 0) + (t.por_estado?.error_shares?.n || 0), pagos: rp.por_pagar || 0 };
    pintarContadores(S.cnt);
  } catch { /* no es crítico */ }
}
function pintarContadores(c) { $$('[data-cnt]').forEach(x => { const n = c[x.dataset.cnt]; x.textContent = n ? n : ''; }); }

async function router() {
  if (!S.token) return vistaLogin();
  if (S.pdfUrl) { URL.revokeObjectURL(S.pdfUrl); S.pdfUrl = null; S.pdfBytes = null; }
  const h = location.hash || (esDirector() ? '#/propuestas' : '#/tablero');
  const r = RUTAS.find(x => x.re.test(h)) || RUTAS[0];
  // El Director solo ve aprobación de pagos, facturas (lectura), la guía y su cuenta
  if (esDirector() && (!['propuestas', 'guia', ''].includes(r.nav) || /^#\/(propuesta\/|pagos-ajustes)/.test(h))) { location.replace('#/propuestas'); return; }
  const m = h.match(r.re) || [];
  $('#app').innerHTML = shell(r);
  $('#b-salir').onclick = () => salir();
  $('#b-actualizar').onclick = actualizar;
  $('#b-tema').onclick = alternarTema;
  const bg = $('#buscar-global');
  if (bg) bg.onkeydown = (e) => {
    if (e.key !== 'Enter' || !bg.value.trim()) return;
    const q = bg.value.trim();
    if (/^#?\d{1,6}$/.test(q)) { location.hash = '#/factura/' + q.replace('#', ''); return; }
    sessionStorage.setItem('facturas_q', q);
    if (location.hash === '#/facturas') router(); else location.hash = '#/facturas';
  };
  S.vista = h;
  window.scrollTo(0, 0);
  if (r.nav !== 'tablero' || esDirector()) contadores();
  try { await r.v($('#vista'), ...m.slice(1)); }
  catch (e) { if (S.token && $('#vista')) { $('#vista').innerHTML = `<div class="panel panel-pad"><h2>No se pudo cargar</h2><p class="muted">${esc(e.message)}</p><button class="btn btn-acento" id="b-reint">${ICO.refresh}Reintentar</button></div>`; $('#b-reint').onclick = router; } }
}

// ---- Actualizar: trae datos frescos y, si hay una versión nueva de la app, la carga ----
async function actualizar() {
  const b = $('#b-actualizar');
  if (b) b.classList.add('girando');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update().catch(() => null);
      if (reg.waiting || reg.installing) { location.reload(); return; }
    }
    S.cnt = null; S.cuentas = null;
    await router();
    toast('Actualizado');
  } finally { const x = $('#b-actualizar'); if (x) x.classList.remove('girando'); }
}

// ---- App instalable (celular) ----
const esStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; $$('[data-instalar]').forEach(x => pintarInstalar(x)); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('Listo: la app quedó en tu pantalla de inicio'); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => null));
}
// Tarjeta "Instalar en el celular" (Mi cuenta, guía y aviso del Director)
function pintarInstalar(el) {
  if (esStandalone()) { el.innerHTML = `<p class="con-ico">${ICO.check}Ya la estás usando como app instalada.</p>`; return; }
  if (S.instalar) {
    el.innerHTML = `<p class="muted">Queda con el logo de Lucciano's en tu pantalla de inicio y abre directo, sin el navegador.</p><button class="btn btn-acento" data-btn-instalar>${ICO.phone}Instalar la app</button>`;
    $('[data-btn-instalar]', el).onclick = async () => { const p = S.instalar; S.instalar = null; p.prompt(); await p.userChoice.catch(() => null); pintarInstalar(el); };
    return;
  }
  el.innerHTML = esIOS()
    ? `<p class="muted">En el iPhone, abrí la app en <b>Safari</b>, tocá el botón <b>Compartir</b> (el cuadrado con la flecha para arriba) y elegí <b>“Agregar a inicio”</b>.</p>`
    : `<p class="muted">Abrí la app en <b>Chrome</b> desde el celular, tocá el menú <b>⋮</b> y elegí <b>“Instalar app”</b> o <b>“Agregar a la pantalla principal”</b>.</p>`;
}
const bloqueInstalar = () => `<div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:8px">Instalar en el celular</h2><div data-instalar></div></div>`;
function montarInstalar(root = document) { $$('[data-instalar]', root).forEach(x => pintarInstalar(x)); }

async function iniciar() {
  if (!S.token) return vistaLogin();
  try {
    const r = await api('/api/yo');
    S.user = r.usuario; S.arca = r.arca_modo;
  } catch { return vistaLogin(); }
  cuentas().catch(() => null);
  await router();
  if (!esDirector()) bienvenida();
}
window.addEventListener('hashchange', router);
let _pdfResize;
window.addEventListener('resize', () => { clearTimeout(_pdfResize); _pdfResize = setTimeout(() => { if ($('#pdf-paginas') && S.pdfBytes) mostrarPdf(); }, 250); });
document.addEventListener('DOMContentLoaded', iniciar);

// Atajos: Ctrl K busca; en "Para revisar" J/K se mueven, Enter abre, / busca
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const b = $('#buscar-global'); if (b) { e.preventDefault(); b.focus(); b.select(); } return; }
  if (location.hash !== '#/bandeja' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || !$('#modal').hidden) return;
  const filas = $$('.cola .qi');
  if (!filas.length) return;
  let i = filas.findIndex(x => x.classList.contains('sel'));
  if (e.key === 'j' || e.key === 'ArrowDown') i = Math.min(filas.length - 1, i + 1);
  else if (e.key === 'k' || e.key === 'ArrowUp') i = Math.max(0, i - 1);
  else if (e.key === 'Enter' && i >= 0) { location.hash = filas[i].getAttribute('href'); return; }
  else if (e.key === '/') { e.preventDefault(); $('#q')?.focus(); return; }
  else return;
  e.preventDefault();
  filas.forEach((x, k) => x.classList.toggle('sel', k === i));
  filas[i].scrollIntoView({ block: 'nearest' });
});

// ---------------------------------------------------------------------------
//  Inicio
// ---------------------------------------------------------------------------
async function vistaTablero(el) {
  const [t, ult, exc] = await Promise.all([api('/api/tablero'), api('/api/facturas?limite=6&orden=id').catch(() => ({ facturas: [] })),
    api('/api/facturas?estado=excepcion&limite=500&orden=id').catch(() => ({ facturas: [] }))]);
  contadores(t);
  const pe = (k) => t.por_estado[k] || { n: 0, monto: 0 };
  const pct = t.automatico_mes.pct;
  const nRev = pe('excepcion').n, nLeyendo = pe('recibida').n + pe('leyendo').n, nErr = pe('error_shares').n;
  const hora = new Date().getHours();
  const saludo = hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const hoyTxt = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  // Motivos agrupados en criollo: cada factura cuenta UNA vez, por su motivo principal (igual que en "Para revisar")
  const grupos = {};
  for (const f of exc.facturas || []) {
    const m = motivoPrincipal(f);
    if (m.g === 'lectura') continue;
    const g = grupos[m.g] = grupos[m.g] || { ...m, t: m.grupoT || GRUPOS[m.g]?.t || m.t, n: 0, cods: [] };
    g.n++;
    const c = (m.codigos || [])[0];
    if (c && !g.cods.includes(c)) g.cods.push(c);
  }
  const lg = Object.entries(grupos).sort((a, b) => b[1].n - a[1].n);
  const maxG = Math.max(1, ...lg.map(([, g]) => g.n));
  const lect = t.lectura_mes || {};
  const totLect = Object.values(lect).reduce((a, b) => a + b, 0) || 1;
  const pLect = (k) => Math.round(100 * (lect[k] || 0) / totLect);
  const tonoVar = (tono) => tono === 'acc' ? ['accent-soft', 'accent-ink', 'accent'] : [tono + '-bg', tono, tono];

  el.innerHTML = `
    <div class="encabezado">
      <div><h1>${saludo}, ${esc(String(S.user.nombre).split(' ')[0])}</h1><p>${esc(hoyTxt.charAt(0).toUpperCase() + hoyTxt.slice(1))} · el mail se revisa solo cada 15 minutos</p></div>
      <div class="acciones"><button class="btn" id="b-procesar" title="Revisa la casilla en el momento y lee lo que haya entrado">${ICO.mail}Revisar el mail</button><button class="btn btn-negro" id="b-subir">${ICO.upload}Subir factura</button></div>
    </div>
    <section class="hero ${nRev ? '' : 'tranqui'}">
      <div><span class="et">Para revisar ahora</span>
        <h2>${nRev ? `${nRev} ${nRev === 1 ? 'factura espera' : 'facturas esperan'} una persona` : 'No hay nada para revisar'}</h2>
        <p>${nRev ? 'Todo lo demás entró solo. Arrancá por los proveedores nuevos: al confirmarlos, sus próximas facturas se cargan sin intervención.' : 'Todas las facturas que entraron pasaron los controles. Podés revisar las que están listas para Shares.'}</p>
        ${lg.length ? `<div class="motivos">${lg.map(([, g]) => `<span>${g.n} · ${esc(g.t.toLowerCase())}</span>`).join('')}</div>` : ''}</div>
      <div class="lado"><span class="grande">${nRev}</span>${nRev ? `<a class="btn btn-acento btn-grande" href="#/bandeja">Empezar a revisar ${ICO.arrow}</a>` : puede('aprobador') && pe('lista').n ? `<a class="btn btn-acento btn-grande" href="#/shares">Ver listas para Shares ${ICO.arrow}</a>` : ''}</div>
    </section>
    <nav class="panel recorrido" aria-label="Recorrido de las facturas">
      <a href="#/facturas"><h3>Recibidas hoy</h3><div class="v">${t.recibidas_hoy}</div><div class="s">${t.recibidas_mes} en el mes</div></a>
      <a href="#/facturas" data-estado="recibida"><h3>Leyendo</h3><div class="v">${nLeyendo}</div><div class="s">tardan 1–2 minutos</div></a>
      <a href="#/bandeja" class="${nRev ? 'act' : ''}"><h3>Para revisar</h3><div class="v">${nRev}</div><div class="s">${$$corto(pe('excepcion').monto)}</div></a>
      <a href="${puede('aprobador') ? '#/shares' : '#/facturas'}" class="bien"><h3>Listas para Shares</h3><div class="v">${pe('lista').n}</div><div class="s">${$$corto(pe('lista').monto)}</div></a>
      <a href="${nErr ? '#/shares' : '#/facturas'}" class="${nErr ? 'mal' : ''}"><h3>Cargadas en el mes</h3><div class="v">${t.cargadas_mes}</div><div class="s">${nErr ? `${nErr} con error de Shares` : `${pe('cargada').n} en total`}</div></a>
    </nav>
    <div class="kpis">
      <div class="kpi"><div class="et">Sin intervención</div><div class="val">${pct === null ? '—' : pct + '%'}</div><div class="sub">${t.automatico_mes.ok} de ${t.automatico_mes.total} en el mes · meta 80–90%<br><a href="#/proveedores" style="color:inherit">${t.proveedores_configurados} proveedores se leen solos</a></div>
        <div class="medidor"><i style="width:${pct || 0}%;background:var(--accent)"></i><b style="left:80%"></b><b style="left:90%"></b></div></div>
      <div class="kpi" title="Cada factura cargada suma según cómo entró: sola ${String(TIEMPOS.manual - TIEMPOS.auto).replace('.', ',')} min ahorrados (${TIEMPOS.manual} manual − ${String(TIEMPOS.auto).replace('.', ',')}) · revisada ${TIEMPOS.manual - TIEMPOS.revisada} min (${TIEMPOS.manual} − ${TIEMPOS.revisada})"><div class="et">Tiempo ahorrado</div><div class="val">${fmtDuracion(ahorro(t.cargadas_mes, t.cargadas_solas_mes))}</div>
        <div class="sub">este mes · ${fmtDuracion(ahorro(t.cargadas_total ?? pe('cargada').n, t.cargadas_solas_total))} desde el inicio<br>~${t.cargadas_mes ? String(+(ahorro(t.cargadas_mes, t.cargadas_solas_mes) / t.cargadas_mes).toFixed(1)).replace('.', ',') : '—'} min por factura cargada</div></div>
      <a class="kpi" href="#/facturas" data-orden="vto"><div class="et">Vencen en 7 días</div><div class="val">${$$corto(t.vencen_7_dias.monto)}</div><div class="sub">${t.vencen_7_dias.n} factura(s)</div></a>
      <div class="kpi"><div class="et">Lectura del mes</div><div class="val">${Object.values(lect).reduce((a, b) => a + b, 0)}</div><div class="sub">${lect.plantilla || 0} por configuración · ${lect.reglas || 0} reglas · ${lect.ia || 0} IA</div>
        <div class="medidor"><i style="width:${pLect('plantilla')}%;background:var(--accent)"></i><i style="width:${pLect('reglas')}%;background:var(--info)"></i><i style="width:${pLect('ia')}%;background:var(--warn)"></i></div></div>
    </div>
    <div class="dos">
      <div class="panel"><div class="panel-titulo"><h2>Qué está trabando</h2><span class="ayuda">tocá un motivo para ver esas facturas</span></div>
        ${lg.length ? `<ul class="traba">${lg.map(([k, g]) => { const [bg, fg, bar] = tonoVar(g.tono); return `<li data-grupo="${k}" tabindex="0"><span class="ico" style="background:var(--${bg});color:var(--${fg})">${ICO[g.ico]}</span>
          <div><div class="t">${esc(g.t)}</div><div class="d">${esc(g.cods.map(c => motivo(c).t).join(' · '))}</div><div class="barrita"><i style="width:${Math.round(100 * g.n / maxG)}%;background:var(--${bar})"></i></div></div><span class="n">${g.n}</span></li>`; }).join('')}</ul>`
        : `<div class="vacio"><span class="grande">Nada trabado</span>No hay excepciones abiertas.</div>`}</div>
      <div class="panel"><div class="panel-titulo"><h2>Últimas que entraron</h2><a class="btn btn-ghost btn-chico" href="#/facturas">Ver todas</a></div>
        ${ult.facturas.length ? `<ul class="feed">${ult.facturas.map(f => `<li data-id="${f.id}" tabindex="0">${cuad(nombreProv(f))}<div style="min-width:0"><div class="t">${esc(nombreProv(f))}</div><div class="d">${esc(TIPOS[f.tipo_cbte_arca] || '')} ${nroCbte(f)} · ${esc(METODOS[f.lector_metodo] || 'sin leer')}</div></div>
          <div class="r"><b>${f.total != null ? $$m(f.total) : '—'}</b>${badgeEstado(f.estado)}</div></li>`).join('')}</ul>` : '<div class="vacio">Todavía no entró ninguna factura.</div>'}</div>
    </div>`;
  $('#b-subir').onclick = modalSubir;
  if (puede('aprobador')) api('/api/pagos/resumen').then(rp => {
    const txt = [rp.esperando ? `${rp.esperando} propuesta(s) esperando al Director` : '', rp.por_pagar ? `${rp.por_pagar} pago(s) aprobados para hacer` : '', rp.borradores ? `${rp.borradores} borrador(es)` : ''].filter(Boolean);
    const hero = $('.hero', el);
    if (txt.length && hero && !$('.aviso-pagos', el)) hero.insertAdjacentHTML('afterend', `<a class="panel panel-pad aviso-pagos" href="#/propuestas">${ICO.coin}<span><b>Pagos:</b> ${esc(txt.join(' · '))}</span>${ICO.arrow}</a>`);
  }).catch(() => null);
  const bp = $('#b-procesar');
  bp.onclick = () => conBoton(bp, async () => { const r = await api('/api/lector/disparar', { method: 'POST' }); toast(r.mensaje, !r.ok); if (r.nuevas) { S.cnt = null; setTimeout(() => { if (location.hash === '#/tablero' || !location.hash) router(); }, 1500); } });
  $$('.traba li', el).forEach(li => li.onclick = li.onkeydown = (e) => { if (e.type === 'keydown' && e.key !== 'Enter') return; sessionStorage.setItem('bandeja_grupo', li.dataset.grupo); location.hash = '#/bandeja'; });
  $$('.feed li', el).forEach(li => li.onclick = li.onkeydown = (e) => { if (e.type === 'keydown' && e.key !== 'Enter') return; location.hash = '#/factura/' + li.dataset.id; });
  $$('[data-orden]', el).forEach(a => a.onclick = () => sessionStorage.setItem('facturas_orden', a.dataset.orden));
  $$('[data-estado]', el).forEach(a => a.onclick = () => sessionStorage.setItem('facturas_estado', a.dataset.estado));
}

function modalSubir() {
  modal(`<h2>Subir factura</h2><p class="muted">Para facturas que no llegaron por mail. Entran al mismo circuito: lectura, ARCA y controles.</p>
    <label class="drop" id="drop"><input type="file" accept="application/pdf" multiple hidden id="f-pdf">${ICO.upload}<span>Arrastrá los PDF acá o <u>elegilos</u></span><small class="muted">Hasta 15 MB cada uno</small></label>
    <div id="sub-res" class="small" style="margin-top:12px;display:flex;flex-direction:column;gap:6px"></div>`, {
    alMontar: (el) => {
      const drop = $('#drop', el), inp = $('#f-pdf', el), res = $('#sub-res', el);
      const subir = async (files) => {
        for (const file of files) {
          if (file.type !== 'application/pdf') { res.insertAdjacentHTML('beforeend', `<div class="linea-res mal">${ICO.x}${esc(file.name)}: no es PDF</div>`); continue; }
          if (file.size > 15e6) { res.insertAdjacentHTML('beforeend', `<div class="linea-res mal">${ICO.x}${esc(file.name)}: supera 15 MB</div>`); continue; }
          const linea = document.createElement('div');
          linea.innerHTML = `<span class="cargando"></span> ${esc(file.name)} — subiendo…`;
          res.appendChild(linea);
          try {
            const b64 = await new Promise((ok, err) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = err; fr.readAsDataURL(file); });
            const r = await api('/api/facturas/subir', { method: 'POST', body: { archivo_nombre: file.name, pdf_base64: b64 } });
            linea.className = 'linea-res bien'; linea.innerHTML = `${ICO.check}${esc(file.name)} → <a href="#/factura/${r.id}">#${r.id}</a> ${badgeEstado(r.estado)} <span class="muted">${esc(r.lector?.ok ? 'el lector ya arrancó' : 'se lee en el próximo ciclo del lector')}</span>`;
          } catch (e) { linea.className = 'linea-res mal'; linea.innerHTML = `${ICO.x}${esc(file.name)}: ${esc(e.message)}`; }
        }
      };
      inp.onchange = () => subir([...inp.files]);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('sobre'); };
      drop.ondragleave = () => drop.classList.remove('sobre');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('sobre'); subir([...e.dataTransfer.files]); };
    },
  });
}

// ---------------------------------------------------------------------------
//  Para revisar (cola de trabajo) y listado de facturas
// ---------------------------------------------------------------------------
function chipsExc(s, max = 2) {
  if (!s) return '';
  const vistos = new Set(), lista = [];
  for (const x of s.split(',')) { const [c, sev] = x.split(':'); if (vistos.has(c)) continue; vistos.add(c); lista.push({ c, sev, m: motivo(c) }); }
  lista.sort((a, b) => (a.sev === 'critica' ? 0 : 1) - (b.sev === 'critica' ? 0 : 1) || a.m.orden - b.m.orden);
  const ver = lista.slice(0, max), resto = lista.slice(max);
  return `<div class="chips">${ver.map(({ c, sev, m }) => `<span class="badge ${sev === 'critica' ? 'b-critica' : TONO_BADGE[m.tono]}" title="${esc(c + ' · ' + m.d)}">${esc(m.t)}</span>`).join('')}${resto.length ? `<span class="tag" title="${esc(resto.map(x => x.m.t).join(' · '))}">+${resto.length}</span>` : ''}</div>`;
}
function filasFacturas(lista, { conExc = true } = {}) {
  if (!lista.length) return `<tr><td colspan="8" class="vacio">No hay facturas para mostrar.</td></tr>`;
  return lista.map(f => `<tr class="click" data-id="${f.id}">
    <td><div class="prov">${cuad(nombreProv(f))}<div><b>${esc(nombreProv(f))}</b><small class="mono">${f.cuit_emisor ? fmtCuit(f.cuit_emisor) + ' · ' : ''}#${f.id}</small></div></div></td>
    <td>${badgeEstado(f.estado)}<small class="sub-celda">recibida ${fmtFH(f.recibido_at)}</small></td>
    <td class="mono">${esc(TIPOS[f.tipo_cbte_arca] || '')} ${nroCbte(f)}</td>
    <td class="mono">${fmtF(f.fecha_emision)}${f.fecha_vto ? `<small class="sub-celda">vence ${fmtF(f.fecha_vto)}</small>` : ''}</td>
    <td class="num"><b>${f.moneda && f.moneda !== 'PES' ? esc(f.moneda) + ' ' : ''}${$$m(f.total)}</b></td>
    ${conExc ? `<td class="celda-motivos">${f.estado === 'rechazada' && f.rechazo_motivo ? `<div class="small muted con-ico motivo-rech">${ICO.info}${esc(f.rechazo_motivo)}</div>` : chipsExc(f.excepciones)}${!f.excepciones && f.error_proceso && !['lista', 'cargada'].includes(f.estado) ? `<div class="small muted" title="${esc(f.error_proceso)}">${esc(String(f.error_proceso).slice(0, 60))}…</div>` : ''}</td>` : ''}
  </tr>`).join('');
}
function encabezadoFacturas(conExc = true) {
  return `<tr><th>Proveedor</th><th>Estado</th><th>Comprobante</th><th>Emisión</th><th class="num">Total</th>${conExc ? '<th>Motivos</th>' : ''}</tr>`;
}
function guardarCola(ids) { try { sessionStorage.setItem('cola_ids', JSON.stringify(ids)); } catch { } }
function leerCola() { try { return JSON.parse(sessionStorage.getItem('cola_ids') || '[]'); } catch { return []; } }

async function vistaBandeja(el) {
  let grupo = sessionStorage.getItem('bandeja_grupo') || 'todas';
  el.innerHTML = `<div class="encabezado"><div><h1>Para revisar</h1><p>Cada fila dice qué falta. Abrila, resolvé lo marcado y pasá a la siguiente.</p></div>
    <div class="acciones">${puede('aprobador') ? `<button class="btn" id="b-reval">${ICO.refresh}Revalidar todas</button>` : ''}<button class="btn btn-negro" id="b-subir">${ICO.upload}Subir factura</button></div></div>
    <div class="seg" role="tablist" id="seg"></div>
    <div class="panel">
      <div class="cola-bar"><label class="campo-buscar">${ICO.search}<input id="q" placeholder="Buscar proveedor, CUIT, número o #id" aria-label="Buscar"></label>
        <div class="teclas"><span><kbd>J</kbd><kbd>K</kbd>moverse</span><span><kbd>Enter</kbd>abrir</span><span><kbd>/</kbd>buscar</span></div></div>
      <div class="cola" id="cola"><div class="vacio"><span class="cargando"></span></div></div>
      <div class="paginacion" id="pg"></div></div>`;
  let todas = [];
  const pintar = () => {
    const q = $('#q').value.trim().toLowerCase();
    const conM = todas.map(f => ({ f, m: motivoPrincipal(f) }));
    const cuenta = {};
    conM.forEach(x => { cuenta[x.m.g] = (cuenta[x.m.g] || 0) + 1; });
    const nExc = conM.filter(x => x.m.g !== 'lectura').length;
    if (grupo !== 'todas' && !cuenta[grupo]) grupo = 'todas';
    const segs = [['todas', 'Todas', nExc], ...Object.entries(GRUPOS).filter(([k]) => cuenta[k]).sort((a, b) => a[1].orden - b[1].orden).map(([k, g]) => [k, g.t, cuenta[k]])];
    $('#seg').innerHTML = segs.map(([k, t, n]) => `<button class="${grupo === k ? 'on' : ''}" data-g="${k}" role="tab" aria-selected="${grupo === k}">${esc(t)}<b>${n}</b></button>`).join('');
    $$('#seg button').forEach(b => b.onclick = () => { grupo = b.dataset.g; sessionStorage.setItem('bandeja_grupo', grupo); pintar(); });
    const lista = conM.filter(x => (grupo === 'todas' ? x.m.g !== 'lectura' : x.m.g === grupo))
      .filter(({ f }) => !q || [nombreProv(f), f.cuit_emisor, String(f.numero ?? ''), '#' + f.id, String(f.id)].some(v => String(v || '').toLowerCase().includes(q.replace(/-/g, ''))));
    guardarCola(lista.map(x => x.f.id));
    $('#cola').innerHTML = lista.length ? lista.map(({ f, m }, i) => `<a class="qi ${i === 0 ? 'sel' : ''}" href="#/factura/${f.id}">
      <span class="sev ${m.tono}"></span>${cuad(nombreProv(f))}
      <div style="min-width:0"><div class="t">${esc(nombreProv(f))}</div><div class="d mono">${esc(TIPOS[f.tipo_cbte_arca] || '')} ${nroCbte(f)} · ${fmtCuit(f.cuit_emisor)}</div></div>
      <div class="porque"><span class="badge ${TONO_BADGE[m.tono]}">${esc(m.titulo)}${m.extra ? ` +${m.extra}` : ''}</span><small>${esc(m.d)}</small></div>
      <div class="monto">${f.total != null ? (f.moneda && f.moneda !== 'PES' ? esc(f.moneda) + ' ' : '') + $$m(f.total) : '—'}<small>${f.fecha_emision ? 'emitida ' + fmtF(f.fecha_emision) : 'recibida ' + fmtFH(f.recibido_at)}</small></div>
      <span class="btn btn-chico ir">Revisar ${ICO.arrow}</span></a>`).join('')
      : `<div class="vacio"><span class="grande">${q ? 'Sin resultados' : '¡Bandeja limpia!'}</span>${q ? 'Probá con otro texto.' : 'No hay facturas esperando una persona.'}</div>`;
    const tot = lista.reduce((a, x) => a + (Number(x.f.total) || 0), 0);
    $('#pg').innerHTML = `<span>${lista.length} factura(s) · ${$$m(tot)}</span>${cuenta.lectura && grupo !== 'lectura' ? `<span>${cuenta.lectura} todavía leyéndose</span>` : ''}`;
  };
  const cargar = async () => {
    const r = await api('/api/facturas?' + new URLSearchParams({ estado: 'excepcion,recibida,leyendo', limite: 500, orden: 'id' }));
    todas = r.facturas;
    pintar();
  };
  let deb;
  $('#q').oninput = () => { clearTimeout(deb); deb = setTimeout(pintar, 120); };
  $('#b-subir').onclick = modalSubir;
  const br = $('#b-reval');
  if (br) br.onclick = () => conBoton(br, async () => {
    // De a 4 facturas por pedido, mostrando el avance (cada una consulta ARCA y Shares)
    let desde = 0, hechas = 0, total = null;
    const txt = br.innerHTML;
    try {
      for (;;) {
        const r = await api('/api/facturas/revalidar', { method: 'POST', body: { desde_id: desde, lote: 4 } });
        hechas += r.revalidadas; desde = r.siguiente_id;
        total = total ?? hechas + r.quedan;
        br.innerHTML = `${ICO.refresh}Revalidando ${hechas} de ${total}…`;
        if (!r.quedan || !r.revalidadas) break;
      }
      toast(`Revalidadas: ${hechas}`);
    } finally { br.innerHTML = txt; }
    S.cnt = null; contadores(); await cargar();
  });
  await cargar();
}

async function vistaFacturas(el) {
  const q0 = sessionStorage.getItem('facturas_q') || '', ord0 = sessionStorage.getItem('facturas_orden') || 'id', est0 = sessionStorage.getItem('facturas_estado') || '';
  ['facturas_q', 'facturas_orden', 'facturas_estado'].forEach(k => sessionStorage.removeItem(k));
  el.innerHTML = `<div class="encabezado"><div><h1>Todas las facturas</h1><p>Historial completo, con el PDF original a un clic.</p></div>
    <div class="acciones"><button class="btn" id="b-csv">${ICO.doc}Exportar CSV</button><button class="btn btn-negro" id="b-subir">${ICO.upload}Subir factura</button></div></div>
    <div class="panel"><div class="filtros">
      <div class="campo ancho"><label for="q">Buscar</label><input id="q" placeholder="Proveedor, CUIT, número, #id, remitente" value="${esc(q0)}"></div>
      <div class="campo"><label for="est">Estado</label><select id="est"><option value="">Todos</option>${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}" ${k === est0 ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="campo"><label for="desde">Emisión desde</label><input type="date" id="desde"></div>
      <div class="campo"><label for="hasta">Hasta</label><input type="date" id="hasta"></div>
      <div class="campo"><label for="ord">Orden</label><select id="ord"><option value="id">Más recientes</option><option value="vto" ${ord0 === 'vto' ? 'selected' : ''}>Por vencimiento</option></select></div>
    </div><div class="tabla-wrap"><table><thead>${encabezadoFacturas()}</thead><tbody id="tb"></tbody></table></div>
    <div class="paginacion"><span id="pg-info"></span><span class="acciones"><button class="btn btn-chico" id="ant">${ICO.back}Anterior</button><button class="btn btn-chico" id="sig">Siguiente ${ICO.arrow}</button></span></div></div>`;
  let pagina = 1;
  const params = (lim = 50) => {
    const p = new URLSearchParams({ limite: lim, pagina, orden: $('#ord').value });
    for (const [k, id] of [['q', 'q'], ['estado', 'est'], ['desde', 'desde'], ['hasta', 'hasta']]) if ($('#' + id).value.trim()) p.set(k, $('#' + id).value.trim());
    return p;
  };
  const cargar = async () => {
    const r = await api('/api/facturas?' + params());
    $('#tb').innerHTML = filasFacturas(r.facturas);
    guardarCola(r.facturas.map(f => f.id));
    const hasta = Math.min(r.pagina * r.limite, r.total);
    $('#pg-info').textContent = `${r.total ? (r.pagina - 1) * r.limite + 1 : 0}–${hasta} de ${r.total} · ${$$m(r.monto)}`;
    $('#ant').disabled = r.pagina <= 1; $('#sig').disabled = hasta >= r.total;
    $$('#tb tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = '#/factura/' + tr.dataset.id; });
  };
  let deb;
  const reset = () => { pagina = 1; cargar(); };
  $('#q').oninput = () => { clearTimeout(deb); deb = setTimeout(reset, 300); };
  ['est', 'desde', 'hasta', 'ord'].forEach(id => $('#' + id).onchange = reset);
  $('#ant').onclick = () => { pagina--; cargar(); };
  $('#sig').onclick = () => { pagina++; cargar(); };
  $('#b-subir').onclick = modalSubir;
  $('#b-csv').onclick = () => conBoton($('#b-csv'), async () => {
    const pAnt = pagina; pagina = 1;
    const r = await api('/api/facturas?' + params(500)); pagina = pAnt;
    descargarCsv(`facturas_${new Date().toISOString().slice(0, 10)}.csv`, [
      ['ID', 'Estado', 'CUIT', 'Proveedor', 'Tipo', 'Comprobante', 'Emisión', 'Vencimiento', 'Moneda', 'Total', 'Motivos', 'Recibida', 'Ref. Shares'],
      ...r.facturas.map(f => [f.id, ESTADOS[f.estado] || f.estado, f.cuit_emisor, f.razon_social_emisor, TIPOS[f.tipo_cbte_arca] || f.tipo_cbte_arca, nroCbte(f), f.fecha_emision, f.fecha_vto, f.moneda, String(f.total ?? '').replace('.', ','), f.excepciones, f.recibido_at, f.shares_ref]),
    ]);
    if (r.total > 500) toast('Se exportaron las primeras 500. Filtrá por fechas para el resto.');
  });
  await cargar();
}

// ---------------------------------------------------------------------------
//  Detalle de una factura (PDF a la izquierda, datos editables a la derecha)
// ---------------------------------------------------------------------------
async function vistaFactura(el, id) {
  await cuentas().catch(() => null);
  const r = await api('/api/facturas/' + id);
  if (!r || !r.factura) throw new Error(`No existe la factura #${id}.`);
  pintarFactura(el, r);
  cargarPdf(id);
}

// ---------------------------------------------------------------------------
//  Visor de PDF propio (pdf.js): páginas a lo ancho, sin la barra lateral del navegador,
//  con zoom, abrir en pestaña nueva y descargar. Si pdf.js no carga, usa el visor del navegador.
// ---------------------------------------------------------------------------
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let _pdfjsCarga = null;
function cargarPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!_pdfjsCarga) _pdfjsCarga = new Promise((ok, mal) => {
    const sc = document.createElement('script');
    sc.src = PDFJS + 'pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    sc.onerror = () => { _pdfjsCarga = null; mal(new Error('no cargó pdf.js')); };
    document.head.appendChild(sc);
  });
  return _pdfjsCarga;
}

async function cargarPdf(id) {
  if (!$('#visor')) return;
  try {
    const res = await api(`/api/facturas/${id}/pdf`, { raw: true });
    const blob = await res.blob();
    if (S.pdfUrl) URL.revokeObjectURL(S.pdfUrl);
    S.pdfUrl = URL.createObjectURL(blob);
    S.pdfBytes = new Uint8Array(await blob.arrayBuffer());
    await mostrarPdf();
  } catch (e) {
    if ($('#visor')) $('#visor').innerHTML = `<div class="vacio">No se pudo cargar el PDF: ${esc(e.message)}</div>`;
  }
}

async function mostrarPdf() {
  const visor = $('#visor');
  if (!visor || !S.pdfUrl) return;
  S.pdfZoom = S.pdfZoom || 1;
  visor.innerHTML = `<div class="pdf-barra">
      <button class="ibtn" data-z="-" title="Alejar" aria-label="Alejar">${svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>')}</button>
      <span class="pdf-zoom">${Math.round(S.pdfZoom * 100)}%</span>
      <button class="ibtn" data-z="+" title="Acercar" aria-label="Acercar">${svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>')}</button>
      <button class="ibtn" data-z="1" title="Ajustar al ancho" aria-label="Ajustar al ancho">${svgI('<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>')}</button>
      <span style="flex:1"></span>
      <a class="ibtn" href="${S.pdfUrl}" target="_blank" rel="noopener" title="Abrir en pestaña nueva" aria-label="Abrir en pestaña nueva">${svgI('<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>')}</a>
      <a class="ibtn" href="${S.pdfUrl}" download="factura.pdf" title="Descargar" aria-label="Descargar">${svgI('<path d="M12 3v12M8 11l4 4 4-4M4 21h16"/>')}</a>
    </div><div class="pdf-paginas" id="pdf-paginas"><div class="vacio"><span><span class="cargando"></span> Abriendo PDF…</span></div></div>`;
  $$('[data-z]', visor).forEach(b => b.onclick = () => {
    S.pdfZoom = b.dataset.z === '1' ? 1 : Math.min(3, Math.max(0.5, S.pdfZoom + (b.dataset.z === '+' ? 0.25 : -0.25)));
    mostrarPdf();
  });
  const cont = $('#pdf-paginas', visor);
  let pdfjs;
  try { pdfjs = await cargarPdfjs(); }
  catch { cont.innerHTML = `<iframe src="${S.pdfUrl}#view=FitH&navpanes=0" title="PDF de la factura"></iframe>`; cont.classList.add('con-iframe'); return; }
  try {
    const doc = await pdfjs.getDocument({ data: S.pdfBytes.slice() }).promise;
    if (!cont.isConnected) return;
    cont.innerHTML = '';
    const ancho = Math.max(280, cont.clientWidth - 24) * S.pdfZoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (let n = 1; n <= doc.numPages; n++) {
      const pag = await doc.getPage(n);
      const base = pag.getViewport({ scale: 1 });
      const vp = pag.getViewport({ scale: (ancho / base.width) * dpr });
      const cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      cv.style.width = Math.floor(vp.width / dpr) + 'px';
      cv.title = 'Doble clic: abrir en pestaña nueva';
      cv.ondblclick = () => window.open(S.pdfUrl, '_blank', 'noopener');
      if (!cont.isConnected) return;
      cont.appendChild(cv);
      await pag.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    if (doc.numPages > 1) cont.insertAdjacentHTML('beforeend', `<div class="pdf-pie">${doc.numPages} páginas</div>`);
  } catch (e) {
    cont.innerHTML = `<iframe src="${S.pdfUrl}#view=FitH&navpanes=0" title="PDF de la factura"></iframe>`; cont.classList.add('con-iframe');
  }
}

function posCola(id) {
  const cola = leerCola(), i = cola.indexOf(Number(id));
  return { i, n: cola.length, ant: i > 0 ? cola[i - 1] : null, sig: i >= 0 && i < cola.length - 1 ? cola[i + 1] : null };
}
const ORIGEN_CUENTA = { regla: 'Regla de imputación', shares: 'La que usa en Shares', proveedor: 'Cuenta habitual del proveedor', ia: 'Sugerida por Gemini', manual: 'Elegida por una persona' };

function bloqueCuenta(r, d, editable) {
  const cod = d.imputacion?.codigo_concepto;
  return `<div class="sugerida"><span class="ico">${ICO.sparkle}</span><div style="min-width:0"><div class="cod">${esc(cod || 'Sin cuenta')}</div><div class="small">${esc(r.cuenta?.denominacion || nombreCuenta(cod) || 'Elegí una cuenta del plan')}</div></div>
    <div class="src">${esc(ORIGEN_CUENTA[d.imputacion?.origen] || 'Sin definir')}${d.imputacion?.detalle ? `<br><b>${esc(d.imputacion.detalle)}</b>` : ''}</div></div>
    ${editable ? `<button type="button" class="btn btn-ghost btn-chico" id="b-otra-cuenta" style="align-self:flex-start">Elegir otra cuenta</button>` : ''}`;
}

// Estado de pago leído de Shares (solo lectura: los pagos se hacen en Shares)
const EST_PAGO_SH = { pagada: ['Pagada en Shares', 'b-cargada'], parcial: ['Pagada en parte', 'b-warn'], pendiente: ['Impaga en Shares', 'b-aviso'], sin_confirmar: ['Sin aprobar en Shares', 'b-aviso'], error: ['No se pudo consultar', 'b-critica'], sin_datos: ['Sin datos para consultar', 'b-aviso'] };
function bloquePagoShares(ps) {
  if (!ps) return `<div class="pago-sh"><p class="small muted">Todavía no se consultó en Shares si está paga. Se revisa sola varias veces por día.</p>${puede('aprobador') ? `<button class="btn btn-chico" id="b-pago-sh">${ICO.refresh}Consultar ahora</button>` : ''}</div>`;
  const e = EST_PAGO_SH[ps.estado] || [ps.estado, 'b-aviso'];
  const imp = safeJsonF(ps.imputaciones_json) || {};
  const filas = [
    ...(imp.ordenes_pago || []).map(o => ({ f: o.fecha, t: `Orden de pago ${o.nro_orden || o.numero || ''}`, a: o.importe_aplicado, det: (o.medios_pago || []).map(mp => `${mp.descripcion}${mp.detalle ? ' (' + mp.detalle + ')' : ''}${mp.nro_cheque ? ' cheque ' + mp.nro_cheque : ''}: ${$$m(mp.importe)}`).join(' · ') })),
    ...(imp.notas_credito || []).map(n => ({ f: n.fecha, t: `Nota de crédito ${n.numero || ''}`, a: n.importe_aplicado, det: n.observaciones || '' })),
    ...(imp.ajustes || []).map(a => ({ f: a.fecha, t: `Ajuste ${a.numero || ''}`, a: a.importe_aplicado, det: a.observaciones || '' })),
  ];
  return `<div class="pago-sh">
    <div class="pago-sh-top"><span class="badge ${e[1]}">${esc(e[0])}</span>
      ${ps.importe_pendiente != null && ps.estado !== 'pagada' ? `<span>Falta pagar <b>${$$m(ps.importe_pendiente)}</b>${ps.importe_total ? ` de ${$$m(ps.importe_total)}` : ''}</span>` : ''}
      ${ps.estado === 'sin_confirmar' ? '<span class="small muted">Todavía está en "Agente IA": cuando se apruebe en Shares, se ve si se pagó.</span>' : ''}
      ${ps.error ? `<span class="small txt-neg">${esc(ps.error)}</span>` : ''}
      <span class="small muted" style="margin-left:auto">consultado ${fmtFH(ps.consultado_at)}</span>
      ${puede('aprobador') && ps.estado !== 'pagada' ? `<button class="btn btn-chico" id="b-pago-sh">${ICO.refresh}Consultar ahora</button>` : ''}</div>
    ${filas.length ? `<table class="pago-sh-t"><tbody>${filas.map(x => `<tr><td class="mono">${esc(x.f || '')}</td><td><b>${esc(x.t)}</b>${x.det ? `<small class="sub-celda">${esc(x.det)}</small>` : ''}</td><td class="num">${$$m(x.a)}</td></tr>`).join('')}</tbody></table>` : ''}
  </div>`;
}
function safeJsonF(t) { try { return t ? JSON.parse(t) : null; } catch { return null; } }

function pintarFactura(el, r) {
  const f = r.factura, d = r.datos || vacioDatos(), c = d.comprobante || {}, im = d.importes || {};
  const editable = !esDirector() && ['recibida', 'excepcion', 'lista', 'error_shares'].includes(f.estado);
  const abiertas = r.excepciones.filter(e => !e.resuelta && e.severidad !== 'aviso');
  const dis = editable ? '' : 'disabled';
  const inp = (name, val, extra = '') => `<input name="${name}" value="${esc(val ?? '')}" ${dis} ${extra}>`;
  const pc = posCola(f.id);
  const nombre = d.emisor?.razon_social || f.razon_social_emisor || f.archivo_nombre || 'Factura';
  const tot = im.total || f.total;
  const mon = (c.moneda || f.moneda) && (c.moneda || f.moneda) !== 'PES' ? (c.moneda || f.moneda) + ' ' : '';
  const hay = (cod) => abiertas.some(e => e.codigo === cod);
  const yAseguir = pc.sig && f.estado === 'excepcion' ? ' y seguir' : '';

  // ---- Qué falta (tarea) ----
  let tarea = '';
  if (['recibida', 'leyendo'].includes(f.estado) && !r.datos) {
    tarea = `<section class="tarea"><div class="panel-titulo"><h2>Se está leyendo</h2><span class="badge b-recibida">En cola</span></div><div class="cuerpo"><p>El lector (QR + configuración del proveedor) la procesa en su próximo ciclo, en 1–2 minutos.${f.error_proceso ? ' Último error: ' + esc(f.error_proceso) : ''}</p></div></section>`;
  } else if (f.estado === 'rechazada') {
    tarea = `<section class="tarea critica"><div class="panel-titulo"><h2>Rechazada</h2></div><div class="cuerpo"><p>${esc(f.rechazo_motivo || 'Sin motivo registrado.')}</p></div></section>`;
  } else if (['en_cola', 'enviando'].includes(f.estado)) {
    tarea = `<section class="tarea"><div class="panel-titulo"><h2>${f.estado === 'enviando' ? 'Enviándose a Shares' : 'En cola para Shares'}</h2><span class="badge b-${f.estado}">${esc(ESTADOS[f.estado])}</span></div><div class="cuerpo"><p>Se manda sola, en segundo plano, con todos los controles en vivo. Si Shares está saturado, espera y se reintenta. No hace falta hacer nada.</p></div></section>`;
  } else if (f.estado === 'error_shares' && r.shares_respuesta) {
    tarea = `<section class="tarea critica"><div class="panel-titulo"><h2>Shares no la aceptó</h2>${r.shares_respuesta.http_status ? `<span class="badge b-critica">HTTP ${esc(r.shares_respuesta.http_status)}</span>` : ''}</div><div class="cuerpo"><p>${esc(r.shares_respuesta.error || r.shares_respuesta.body?.message || JSON.stringify(r.shares_respuesta.body || {}).slice(0, 300))}</p></div></section>`;
  } else if (abiertas.length) {
    const critica = abiertas.some(e => e.severidad === 'critica');
    const verSug = !!r.datos;   // la cuenta se muestra siempre: es lo que más se mira antes de mandar a Shares
    tarea = `<section class="tarea ${critica ? 'critica' : ''}"><div class="panel-titulo"><h2>${abiertas.length === 1 ? 'Lo único que falta: ' + esc(motivo(abiertas[0].codigo).t.toLowerCase()) : `Faltan ${abiertas.length} cosas`}</h2><span class="badge ${critica ? 'b-critica' : 'b-acc'}">${critica ? 'Importante' : 'Para resolver'}</span></div>
      <div class="cuerpo">
        ${abiertas.map(e => { const m = motivo(e.codigo); return `<div class="excepcion ${e.severidad}" data-cod="${esc(e.codigo)}"><div class="txt"><div class="vivo-ok">${ICO.check}<span></span></div><div><b>${esc(m.t)}</b> <span class="cod muted">${esc(e.codigo)}</span></div><div class="small">${esc(String(e.mensaje || '').replace(/“Confirmar proveedor”/g, '“Confirmar”'))}</div>${m.d && m.d !== e.mensaje ? `<div class="small muted">${esc(m.d)}</div>` : ''}</div>
          ${editable && !['IMPUTACION', 'PROVEEDOR_NUEVO'].includes(e.codigo) && (e.severidad !== 'critica' || puede('admin')) ? `<button class="btn btn-chico" data-aceptar="${esc(e.codigo)}">Aceptar igual</button>` : ''}
          ${e.codigo === 'PROVEEDOR_DESCONOCIDO' && puede('aprobador') ? `<button class="btn btn-chico btn-negro" id="b-alta-prov">Dar de alta</button>` : ''}</div>`; }).join('')}
        ${verSug ? bloqueCuenta(r, d, editable) : ''}
      </div></section>`;
  } else if (f.estado === 'lista') {
    tarea = `<section class="tarea bien"><div class="panel-titulo"><h2>Todo en orden</h2><span class="badge b-ok">Lista para Shares</span></div><div class="cuerpo"><p>Pasó todos los controles. Revisá la cuenta: ${puede('aprobador') ? 'después la enviás desde acá o junto con las demás desde “Enviar a Shares”.' : 'un aprobador la envía a Shares.'}</p>
      ${r.datos ? bloqueCuenta(r, d, editable) : ''}</div></section>`;
  } else if (f.estado === 'cargada') {
    tarea = `<section class="tarea bien"><div class="panel-titulo"><h2>Cargada en Shares</h2>${f.shares_ref ? `<span class="badge b-ok">Ref. ${esc(f.shares_ref)}</span>` : ''}</div><div class="cuerpo"><p>No hay nada más que hacer con esta factura. Cargarla a mano llevaba unos ${TIEMPOS.manual} minutos; con el sistema, ${f.auto_ok ? 'entró sola: ~' + TIEMPOS.auto : '~' + TIEMPOS.revisada} min. <b>Ahorro: ${String(TIEMPOS.manual - (f.auto_ok ? TIEMPOS.auto : TIEMPOS.revisada)).replace('.', ',')} min.</b></p>
      <h3 style="margin:14px 0 6px">Pago</h3>${bloquePagoShares(r.pago_shares)}</div></section>`;
  }

  // ---- Controles (checklist) ----
  const items = [];
  if (r.datos) items.push(['ok', ICO.check, 'Leída del PDF', METODOS[f.lector_metodo] || 'Datos cargados']);
  if (r.qr) items.push(['ok', ICO.check, 'Tiene QR de ARCA', 'CUIT, número, fecha y total para cruzar']);
  if (r.arca?.resultado === 'A') items.push(['ok', ICO.shield, 'ARCA aprobó el CAE', 'Constatado ' + fmtFH(r.arca.consultado_at)]);
  for (const e of r.excepciones) {
    const m = motivo(e.codigo);
    if (e.resuelta) items.push(['acep', ICO.check, m.t + ' · aceptada', `${e.resuelta_por}: “${e.resolucion}”`]);
    else if (e.severidad === 'aviso') items.push(['aviso', ICO.info, m.t, e.mensaje]);
    else if (e.severidad === 'critica') items.push(['mal', ICO.x, m.t, e.mensaje]);
    else items.push(['falta', ICO[m.ico] || ICO.info, m.t, e.mensaje]);
  }
  const nOk = items.filter(x => x[0] === 'ok' || x[0] === 'acep').length;

  // ---- Botones: solo tres. Confirmar (guarda lo corregido + confirma), Volver a leer, Rechazar ----
  const bots = [];
  if (editable) bots.push(['b-ok', `${ICO.check}Confirmar${yAseguir}`, 1]);
  if (f.estado === 'lista' && puede('aprobador')) bots.push(['b-enviar', `${ICO.send}Enviar a Shares`, 2, 'btn-negro']);
  if (f.estado === 'error_shares' && puede('aprobador')) bots.push(['b-enviar', `${ICO.send}Reintentar envío`, 2, 'btn-negro']);
  if (editable) bots.push(['b-ia', `${ICO.refresh}Volver a leer`, 9]);
  if (editable) bots.push(['b-rechazar', 'Rechazar', 10, 'btn-rojo']);
  if (f.estado === 'rechazada' && puede('aprobador')) bots.push(['b-reabrir', `${ICO.refresh}Reabrir`, 1]);
  bots.sort((a, b) => a[2] - b[2]);

  el.innerHTML = `
  <div class="encabezado" style="margin-bottom:16px">
    <div class="navfact"><a class="btn btn-ghost btn-chico" href="#/bandeja">${ICO.back}Para revisar</a><span class="tag mono">#${f.id}</span>${pc.i >= 0 ? `<span class="tag">${pc.i + 1} de ${pc.n}</span>` : ''}</div>
    ${pc.i >= 0 ? `<div class="acciones"><button class="btn btn-chico" id="b-ant" ${pc.ant ? '' : 'disabled'}>${ICO.back}Anterior</button><button class="btn btn-chico" id="b-sig" ${pc.sig ? '' : 'disabled'}>Siguiente ${ICO.arrow}</button></div>` : ''}
  </div>
  <div class="detalle">
    <div class="visor" id="visor" aria-label="PDF de la factura"><div class="vacio"><span><span class="cargando"></span> Cargando PDF…</span></div></div>
    <div class="lado" id="lado">
      <section class="panel ficha">
        <div class="fila1">${badgeEstado(f.estado)}${f.lector_metodo ? `<span class="tag">${ICO.sparkle}${esc(METODOS[f.lector_metodo] || f.lector_metodo)}</span>` : ''}</div>
        <h2>${esc(nombre)}</h2>
        <div class="meta"><span class="mono">${fmtCuit(d.emisor?.cuit || f.cuit_emisor)}</span><span>${esc(TIPOS[c.tipo_arca] || 'Comprobante')} ${c.pto_vta != null ? nroCbte({ pto_vta: c.pto_vta, numero: c.numero }) : ''}</span>${c.fecha_emision ? `<span>Emitida ${fmtF(c.fecha_emision)}</span>` : ''}
          <span>${esc(f.origen === 'mail' ? 'Por mail de ' + (f.mail_from || '?').replace(/<.*>/, '').replace(/"/g, '').trim() : f.mail_from || 'Carga manual')} · ${fmtFH(f.recibido_at)}</span>${f.shares_ref ? `<span>Ref. Shares <b class="mono">${esc(f.shares_ref)}</b></span>` : ''}</div>
        <div class="total"><b>${tot != null && tot !== '' ? esc(mon) + $$m(tot) : '—'}</b>${c.fecha_vto_pago ? `<span class="tag">${ICO.clock}Vence ${fmtF(c.fecha_vto_pago)}</span>` : ''}</div>
      </section>
      ${tarea}
      ${items.length ? `<section class="panel"><div class="panel-titulo"><h2>Controles</h2><span class="ayuda">${nOk} de ${items.length} bien</span></div>
        <ul class="controles">${items.map(([k, ic, t, dsc]) => `<li class="${k}"><span class="ck ${k}">${ic}</span><div><div class="t">${esc(t)}</div><div class="d">${esc(dsc || '')}</div></div></li>`).join('')}</ul></section>` : ''}
      <section class="panel">
      <div class="tabs" id="tabs"><button class="activo" data-tab="datos">Datos</button><button data-tab="shares">Cómo va a Shares</button><button data-tab="arca">Lectura y ARCA</button><button data-tab="hist">Historial</button></div>
      <form id="f-datos" class="tab" data-tab="datos" autocomplete="off">
        <div class="seccion"><h3>Comprobante</h3>
          <div class="fila">
            <div class="campo"><label>Tipo ARCA</label><select name="comprobante.tipo_arca" ${dis}><option value="">—</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${String(c.tipo_arca) === k ? 'selected' : ''}>${k} · ${v}</option>`).join('')}</select></div>
            <div class="campo"><label>Punto de venta</label>${inp('comprobante.pto_vta', c.pto_vta, 'inputmode="numeric" class="mono"')}</div>
            <div class="campo"><label>Número</label>${inp('comprobante.numero', c.numero, 'inputmode="numeric" class="mono"')}</div>
          </div>
          <div class="fila">
            <div class="campo"><label>Fecha emisión</label><input type="date" name="comprobante.fecha_emision" value="${esc(c.fecha_emision || '')}" ${dis}></div>
            <div class="campo"><label>Vto. de pago</label><input type="date" name="comprobante.fecha_vto_pago" value="${esc(c.fecha_vto_pago || '')}" ${dis}></div>
            <div class="campo"><label>Moneda</label><select name="comprobante.moneda" ${dis}>${['PES', 'DOL', 'EUR'].map(m => `<option ${c.moneda === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
          </div>
          <div class="fila">
            <div class="campo"><label>Autorización</label><select name="comprobante.tipo_autorizacion" ${dis}>${['CAE', 'CAEA', 'CAI'].map(m => `<option ${c.tipo_autorizacion === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
            <div class="campo" style="grid-column: span 2"><label>CAE</label>${inp('comprobante.cae', c.cae, 'class="mono" inputmode="numeric"')}</div>
          </div>
        </div>
        <div class="seccion"><h3>Partes</h3>
          <div class="fila">
            <div class="campo"><label>CUIT emisor</label>${inp('emisor.cuit', d.emisor?.cuit, 'class="mono" inputmode="numeric"')}</div>
            <div class="campo" style="grid-column: span 2"><label>Razón social emisor</label>${inp('emisor.razon_social', d.emisor?.razon_social)}</div>
          </div>
          <div class="fila">
            <div class="campo"><label>CUIT receptor</label>${inp('receptor.cuit', d.receptor?.cuit, 'class="mono" inputmode="numeric"')}</div>
            <div class="campo" style="grid-column: span 2"><label>Razón social receptor</label>${inp('receptor.razon_social', d.receptor?.razon_social)}</div>
          </div>
          <div class="fila">
            <div class="campo"><label>CBU en la factura</label>${inp('pago.cbu', d.pago?.cbu, 'class="mono"')}</div>
            <div class="campo"><label>Alias</label>${inp('pago.alias', d.pago?.alias)}</div>
          </div>
          ${r.proveedor ? `<p class="ayuda">Maestro: ${esc(r.proveedor.razon_social)} · cond. IVA ${esc(r.proveedor.condicion_iva ?? '—')} · CBU ${esc(r.proveedor.cbu || '—')} · cuenta ${esc(r.proveedor.cuenta_default || '—')}</p>` : ''}
        </div>
        <div class="seccion"><h3>Importes</h3>
          <div class="grid-items small muted"><span>Alícuota</span><span>Neto gravado</span><span>IVA</span><span></span></div>
          <div id="gravado">${(im.gravado || []).map(filaGravado).join('')}</div>
          ${editable ? '<button type="button" class="btn btn-ghost btn-chico" id="add-grav">+ Alícuota</button>' : ''}
          <div class="fila" style="margin-top:12px">
            <div class="campo"><label>Sin IVA discriminado (B/C)</label>${inp('importes.sin_discriminar', im.sin_discriminar || '', 'class="num"')}</div>
            <div class="campo"><label>No gravado</label>${inp('importes.no_gravado', im.no_gravado || '', 'class="num"')}</div>
            <div class="campo"><label>Exento</label>${inp('importes.exento', im.exento || '', 'class="num"')}</div>
            <div class="campo"><label>Otros tributos</label>${inp('importes.otros_tributos', im.otros_tributos || '', 'class="num"')}</div>
          </div>
          <h3 style="margin:8px 0">Percepciones</h3>
          <div class="grid-perc small muted"><span>Tipo</span><span>Jurisdicción</span><span>Importe</span><span></span></div>
          <div id="percepciones">${(d.percepciones || []).map(filaPercepcion).join('')}</div>
          ${editable ? '<button type="button" class="btn btn-ghost btn-chico" id="add-perc">+ Percepción</button>' : ''}
          <div class="fila" style="margin-top:12px"><div class="campo"><label>TOTAL del comprobante</label>${inp('importes.total', im.total || '', 'class="num" style="font-weight:700"')}</div></div>
          <div id="cuadre"></div>
        </div>
        <div class="seccion" id="sec-imputacion"><h3>Imputación</h3>
          ${datalistCuentas()}
          <div class="fila">
            <div class="campo"><label>Cuenta (codigo_concepto)</label><input name="imputacion.codigo_concepto" list="dl-cuentas" class="mono" value="${esc(d.imputacion?.codigo_concepto || '')}" ${dis}></div>
            <div class="campo" style="grid-column: span 2"><label>Denominación</label><input id="den-cuenta" disabled value="${esc(r.cuenta?.denominacion || nombreCuenta(d.imputacion?.codigo_concepto))}"></div>
          </div>
          <p class="ayuda">Origen: <b>${esc({ regla: 'regla de imputación', shares: 'la que usa en Shares', proveedor: 'cuenta por defecto del proveedor', ia: 'sugerida por Gemini — confirmala', manual: 'elegida por una persona' }[d.imputacion?.origen] || 'sin definir')}</b>${d.imputacion?.detalle ? ' · ' + esc(d.imputacion.detalle) : ''}${d.ia?.motivo_cuenta && d.imputacion?.origen === 'ia' ? ' · ' + esc(d.ia.motivo_cuenta) : ''}</p>
          ${d.local_detectado || d.detalle_resumen ? `<p class="small">${d.detalle_resumen ? `<b>Detalle:</b> ${esc(d.detalle_resumen)} ` : ''}${d.local_detectado ? `<b>Local:</b> ${esc(d.local_detectado)}` : ''}</p>` : ''}
          ${editable ? `<label class="check"><input type="checkbox" id="chk-regla"> Guardar como regla para este proveedor</label>
          <div class="campo hidden" id="c-palabra"><label>…solo cuando el detalle/local contenga (opcional)</label><input id="palabra" placeholder="ej. UNICENTER — vacío = siempre"></div>` : ''}
        </div>
      </form>
      <div class="tab hidden" data-tab="shares"><div class="seccion">
        ${r.shares_enviado ? `<h3>Enviado a Shares</h3><pre class="json">${esc(JSON.stringify(r.shares_enviado, null, 2))}</pre><h3 style="margin-top:12px">Respuesta</h3><pre class="json">${esc(JSON.stringify(r.shares_respuesta, null, 2))}</pre>`
        : r.shares_preview ? `<h3>Así se va a enviar</h3>${r.shares_preview.problemas.length ? `<div class="excepcion normal"><div class="txt">${r.shares_preview.problemas.map(esc).join('<br>')}</div></div>` : ''}<pre class="json">${esc(JSON.stringify(r.shares_preview.payload, null, 2))}</pre>` : '<p class="muted">Sin datos.</p>'}
      </div></div>
      <div class="tab hidden" data-tab="arca"><div class="seccion">
        <h3>Constatación ARCA (WSCDC)</h3>${r.arca ? `<dl class="kv"><dt>Resultado</dt><dd>${esc(r.arca.resultado)} ${r.arca.resultado === 'A' ? '(aprobado)' : r.arca.resultado === 'R' ? '(rechazado)' : ''}</dd><dt>Consultado</dt><dd>${fmtFH(r.arca.consultado_at)}</dd><dt>Ambiente</dt><dd>${esc(r.arca.modo || '')}</dd><dt>Observaciones</dt><dd>${esc((r.arca.observaciones || []).join(' | ') || '—')}</dd></dl>` : `<p class="muted">${S.arca === 'off' ? 'ARCA está desactivado (falta configurar el certificado).' : 'Sin consulta todavía.'}</p>`}
        <h3 style="margin-top:16px">QR de ARCA embebido en el PDF</h3>${r.qr ? `<pre class="json">${esc(JSON.stringify(r.qr, null, 2))}</pre>` : '<p class="muted">No se encontró el link del QR dentro del PDF (puede estar solo como imagen).</p>'}
        <h3 style="margin-top:16px">Cómo se leyó</h3><dl class="kv"><dt>Método</dt><dd>${esc(METODOS[f.lector_metodo] || '—')}</dd><dt>QR ARCA</dt><dd>${esc(r.lector?.qr ? 'leído (' + r.lector.qr + ')' : 'no encontrado')}</dd>
          <dt>Configuración</dt><dd>${r.plantilla ? 'v' + esc(r.plantilla.version) + ' activa · ' + esc(r.plantilla.usos) + ' usos · aprobada por ' + esc(r.plantilla.aprobada_por || '—') : 'sin configuración activa'}</dd>
          ${r.lector?.modelo ? `<dt>Modelo IA</dt><dd>${esc(r.lector.modelo)}</dd>` : ''}${d.ia?.observaciones ? `<dt>Observaciones IA</dt><dd>${esc(d.ia.observaciones)}</dd>` : ''}
          ${(r.lector?.problemas_previos || []).length ? `<dt>Problemas resueltos</dt><dd>${esc(r.lector.problemas_previos.join(' '))}</dd>` : ''}</dl>
        ${r.lector?.texto ? `<details style="margin-top:12px"><summary class="small">Ver el texto que leyó del PDF</summary><pre class="json">${esc(r.lector.texto)}</pre></details>` : ''}
      </div></div>
      <div class="tab hidden" data-tab="hist"><div class="tabla-wrap"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Campo</th><th>Antes → Después</th></tr></thead><tbody>
        ${r.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(a.campo || '')}</td><td class="small mono">${esc(a.valor_anterior ?? '')} → ${esc(a.valor_nuevo ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="vacio">Sin movimientos.</td></tr>'}
      </tbody></table></div></div>
      </section>
      ${bots.length ? `<div class="barra-acciones">${bots.map(([id, html, , cls], i) => `<button class="btn ${i === 0 && !cls ? 'btn-acento principal' : cls || ''}" id="${id}">${html}</button>`).join('')}</div>` : ''}
    </div>
  </div>`;
  conectarFactura(el, r);
}

function vacioDatos() {
  return { emisor: {}, receptor: {}, comprobante: { moneda: 'PES', tipo_autorizacion: 'CAE' }, importes: { gravado: [] }, percepciones: [], pago: {}, imputacion: {} };
}
function filaGravado(g = {}) {
  return `<div class="grid-items" data-grav>
    <select data-k="alicuota">${[21, 10.5, 27, 5, 2.5].map(a => `<option value="${a}" ${Number(g.alicuota) === a ? 'selected' : ''}>${String(a).replace('.', ',')}%</option>`).join('')}</select>
    <input data-k="neto" class="num" value="${esc(g.neto ?? '')}"><input data-k="iva" class="num" value="${esc(g.iva ?? '')}">
    <button type="button" class="btn btn-chico" data-quitar title="Quitar">×</button></div>`;
}
function filaPercepcion(p = {}) {
  return `<div class="grid-perc" data-perc>
    <select data-k="tipo">${['IVA', 'IIBB', 'GANANCIAS', 'MUNICIPAL', 'OTRO'].map(t => `<option ${p.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <select data-k="jurisdiccion"><option value="">—</option>${JURIS.map(j => `<option ${p.jurisdiccion === j ? 'selected' : ''}>${j}</option>`).join('')}</select>
    <input data-k="importe" class="num" value="${esc(p.importe ?? '')}">
    <button type="button" class="btn btn-chico" data-quitar title="Quitar">×</button></div>`;
}
const numAR = (v) => { let s = String(v ?? '').trim().replace(/[$\s]/g, ''); if (!s) return 0; if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, ''); return Number(s) || 0; };

function leerFormulario(base) {
  const f = $('#f-datos');
  const d = JSON.parse(JSON.stringify(base || vacioDatos()));
  for (const el of $$('[name]', f)) {
    const [a, b] = el.name.split('.');
    d[a] = d[a] || {};
    d[a][b] = el.value === '' ? null : el.value;
  }
  d.importes.gravado = $$('[data-grav]', f).map(row => ({ alicuota: Number($('[data-k=alicuota]', row).value), neto: numAR($('[data-k=neto]', row).value), iva: numAR($('[data-k=iva]', row).value) }));
  for (const k of ['sin_discriminar', 'no_gravado', 'exento', 'otros_tributos', 'total']) d.importes[k] = numAR(d.importes[k]);
  d.percepciones = $$('[data-perc]', f).map(row => ({ tipo: $('[data-k=tipo]', row).value, jurisdiccion: $('[data-k=jurisdiccion]', row).value || null, importe: numAR($('[data-k=importe]', row).value) }));
  return d;
}

function actualizarCuadre() {
  const box = $('#cuadre');
  if (!box) return;
  const d = leerFormulario();
  let s = 0;
  for (const g of d.importes.gravado) s += g.neto + g.iva;
  s += d.importes.sin_discriminar + d.importes.no_gravado + d.importes.exento + d.importes.otros_tributos;
  for (const p of d.percepciones) s += p.importe;
  s = Math.round(s * 100) / 100;
  const dif = Math.round((s - d.importes.total) * 100) / 100;
  box.innerHTML = `<div class="cuadre ${Math.abs(dif) <= 0.05 ? 'ok' : 'mal'}"><span>Suma de componentes ${$$m(s)}</span><span>${Math.abs(dif) <= 0.05 ? 'Cierra ✓' : 'Diferencia ' + $$m(dif)}</span></div>`;
}

function conectarFactura(el, r) {
  const id = r.factura.id;
  const bps = $('#b-pago-sh', el);
  if (bps) bps.onclick = () => conBoton(bps, async () => {
    const x = await api(`/api/facturas/${id}/pago-shares`, { method: 'POST' });
    toast(x.pago_shares ? `Shares: ${(EST_PAGO_SH[x.pago_shares.estado] || [x.pago_shares.estado])[0]}` : 'Consultado');
    const n = await api('/api/facturas/' + id); pintarFactura(el, n); conectarFactura(el, n);
  });
  const pc = posCola(id);
  const recargar = (nuevo) => {
    S.cnt = null;
    // Si estaba para revisar y quedó resuelta, pasa sola a la siguiente de la cola
    if (r.factura.estado === 'excepcion' && nuevo.factura.estado !== 'excepcion' && pc.sig) { location.hash = '#/factura/' + pc.sig; return; }
    pintarFactura(el, nuevo); if (S.pdfUrl) mostrarPdf(); else cargarPdf(id);
  };
  const bAnt = $('#b-ant'), bSig = $('#b-sig');
  if (bAnt) bAnt.onclick = () => { if (pc.ant) location.hash = '#/factura/' + pc.ant; };
  if (bSig) bSig.onclick = () => { if (pc.sig) location.hash = '#/factura/' + pc.sig; };
  const bOtra = $('#b-otra-cuenta');
  if (bOtra) bOtra.onclick = () => { $('#tabs button[data-tab=datos]').click(); $('#sec-imputacion').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('[name="imputacion.codigo_concepto"]').focus(), 300); };
  // Tabs
  $$('#tabs button', el).forEach(b => b.onclick = () => {
    $$('#tabs button', el).forEach(x => x.classList.toggle('activo', x === b));
    $$('.tab', el).forEach(t => t.classList.toggle('hidden', t.dataset.tab !== b.dataset.tab));
  });
  // Filas dinámicas
  const form = $('#f-datos');
  form.addEventListener('click', (e) => { if (e.target.matches('[data-quitar]')) { e.target.parentElement.remove(); actualizarCuadre(); } });
  form.addEventListener('input', (e) => {
    actualizarCuadre();
    setTimeout(controlEnVivo, 0);
    if (e.target.name === 'imputacion.codigo_concepto') $('#den-cuenta').value = nombreCuenta(e.target.value);
    // IVA automático al tipear el neto
    if (e.target.dataset.k === 'neto') {
      const row = e.target.closest('[data-grav]');
      const iva = $('[data-k=iva]', row);
      if (!iva.dataset.tocado) iva.value = (numAR(e.target.value) * Number($('[data-k=alicuota]', row).value) / 100).toFixed(2);
    }
    if (e.target.dataset.k === 'iva') e.target.dataset.tocado = '1';
  });
  const ag = $('#add-grav'), ap = $('#add-perc');
  if (ag) ag.onclick = () => $('#gravado').insertAdjacentHTML('beforeend', filaGravado({ alicuota: 21 }));
  if (ap) ap.onclick = () => { $('#percepciones').insertAdjacentHTML('beforeend', filaPercepcion({ tipo: 'IIBB' })); controlEnVivo(); };
  form.addEventListener('change', () => controlEnVivo());
  form.addEventListener('click', (e) => { if (e.target.closest('[data-quitar]')) setTimeout(controlEnVivo, 0); });

  // Mientras se corrige, cada cartel muestra si lo que se cambió ya lo resuelve (se confirma de verdad al tocar Confirmar)
  function controlEnVivo() {
    const box = $('.tarea'); if (!box) return;
    const d = leerFormulario(r.datos), o = r.datos || vacioDatos(), im = d.importes;
    let suma = 0; for (const g of im.gravado) suma += g.neto + g.iva;
    suma += im.sin_discriminar + im.no_gravado + im.exento + im.otros_tributos; for (const p of d.percepciones) suma += p.importe;
    const cierra = im.total > 0 && Math.abs(Math.round((suma - im.total) * 100) / 100) <= 0.05;
    const cambio = (a, b) => String(a ?? '') !== String(b ?? '');
    const oc = o.comprobante || {}, dc = d.comprobante || {};
    const tocoArca = cambio(numAR(o.importes?.total), im.total) || ['pto_vta', 'numero', 'fecha_emision', 'cae', 'tipo_arca'].some(k => cambio(oc[k], dc[k])) || cambio(o.emisor?.cuit, d.emisor?.cuit) || cambio(o.receptor?.cuit, d.receptor?.cuit);
    const cuenta = d.imputacion?.codigo_concepto;
    const cuentaOk = !!cuenta && (!S.cuentas?.length || S.cuentas.some(c => String(c.codigo_concepto) === String(cuenta)));
    const iibbOk = d.percepciones.filter(p => p.tipo === 'IIBB').every(p => p.jurisdiccion);
    const reglas = {
      ARITMETICA: cierra && 'Ahora los importes cierran.',
      LECTURA: cierra && dc.numero && dc.cae && d.emisor?.cuit && 'Datos completos y los importes cierran.',
      QR_INCONSISTENTE: cierra && tocoArca && 'Corregiste los datos: se vuelven a controlar al confirmar.',
      ARCA_RECHAZADO: tocoArca && '!Cambiaste datos: ARCA se vuelve a consultar al tocar Confirmar.',
      ARCA_ERROR: tocoArca && '!Cambiaste datos: ARCA se vuelve a consultar al tocar Confirmar.',
      PROVEEDOR_NUEVO: '!Se resuelve al tocar Confirmar (si el desglose y la cuenta están bien).',
      FORMATO_CAMBIO: '!Se resuelve al tocar Confirmar (si los datos están bien).',
      FISCAL_MAPEO: iibbOk && 'Todas las percepciones de IIBB tienen jurisdicción.',
      IMPUTACION: cuentaOk && 'Cuenta elegida.',
      CUENTA_INEXISTENTE: cuentaOk && 'La cuenta existe en el plan.',
    };
    let listas = 0, total = 0;
    $$('.excepcion[data-cod]', box).forEach(card => {
      total++;
      const ok = reglas[card.dataset.cod];
      card.classList.toggle('vivo', !!ok);
      if (ok) { listas++; $('.vivo-ok span', card).textContent = ok.startsWith('!') ? ok.slice(1) : 'Corregido: ' + ok; }
    });
    if (!total) return;   // sin pendientes (ej. ya cargada): no se toca el título
    const h = $('.panel-titulo h2', box);
    if (h && !h.dataset.orig) h.dataset.orig = h.textContent;
    if (h) h.textContent = listas === total ? 'Todo listo: tocá Confirmar' : listas ? `${h.dataset.orig} · ${listas} de ${total} en orden` : h.dataset.orig;
    box.classList.toggle('lista-vivo', listas === total);
  }
  controlEnVivo();
  const chk = $('#chk-regla');
  if (chk) chk.onchange = () => $('#c-palabra').classList.toggle('hidden', !chk.checked);
  actualizarCuadre();

  const guardar = (extra = {}) => api('/api/facturas/' + id, {
    method: 'PUT',
    body: { datos: leerFormulario(r.datos), guardar_regla: chk?.checked ? { palabra_clave: $('#palabra').value.trim() || null } : null, ...extra },
  });
  // Confirmar: guarda lo que se haya corregido y confirma lo que haga falta (proveedor nuevo / formato / cuenta)
  const bok = $('#b-ok');
  if (bok) bok.onclick = () => conBoton(bok, async () => {
    const abiertas = r.excepciones.filter(e => !e.resuelta && e.severidad !== 'aviso').map(e => e.codigo);
    let n;
    if (abiertas.includes('PROVEEDOR_NUEVO') || abiertas.includes('FORMATO_CAMBIO')) {
      try { n = await guardar({ confirmar_proveedor: true }); }
      catch (e) { if (!/lectura automática/i.test(e.message)) throw e; n = await guardar({ confirmar_imputacion: true }); }
    } else n = await guardar({ confirmar_imputacion: true });
    const quedan = (n.excepciones || []).filter(e => !e.resuelta && e.severidad !== 'aviso');
    if (n.factura.estado === 'lista') toast('Confirmada: pasó a "Enviar a Shares"');
    else if (quedan.length) toast(`Guardada. Todavía falta: ${quedan.map(e => motivo(e.codigo).t.toLowerCase()).join(', ')}`, true);
    else toast('Confirmada');
    recargar(n);
  });
  const bg = $('#b-guardar');
  if (bg) bg.onclick = () => conBoton(bg, async () => { const n = await guardar(); toast(n.factura.estado === 'lista' ? '✓ Guardada: lista para Shares' : 'Guardada y revalidada'); recargar(n); });
  const bc = $('#b-confirmar');
  if (bc) bc.onclick = () => conBoton(bc, async () => { const n = await guardar({ confirmar_imputacion: true }); toast('Cuenta confirmada'); recargar(n); });
  const bia = $('#b-ia');
  if (bia) bia.onclick = () => modal(`<h2>Volver a leer el PDF</h2><p class="muted">Se descartan los datos editados y la factura vuelve a la cola del lector.</p>
      <label class="check"><input type="radio" name="modo" value="0" checked> Con la configuración del proveedor (o reglas generales si no tiene)</label>
      ${puede('aprobador') ? '<label class="check"><input type="radio" name="modo" value="1"> Forzar lectura con Gemini (IA)</label>' : ''}
      <div class="acciones" style="margin-top:12px"><button class="btn btn-negro" id="b-rel">Volver a leer</button></div>`, {
    alMontar: (m, cerrar) => { $('#b-rel', m).onclick = () => conBoton($('#b-rel', m), async () => {
      const forzar = $('input[name=modo]:checked', m).value === '1';
      const n = await api(`/api/facturas/${id}/releer`, { method: 'POST', body: { forzar_ia: forzar } });
      cerrar(); toast(n.lector_disparo?.ok ? 'En cola: el lector ya arrancó' : 'En cola: se lee en el próximo ciclo del lector'); recargar(n);
    }); },
  });
  const bcp = $('#b-conf-prov');
  if (bcp) bcp.onclick = () => conBoton(bcp, async () => {
    if (!await confirmar('Confirmás que el desglose y la cuenta están bien? Con esta factura se guarda cómo leer las próximas de este proveedor.')) return;
    const n = await guardar({ confirmar_proveedor: true });
    const av = n.confirmacion?.avisos || [];
    toast(`Proveedor configurado (v${n.confirmacion?.version}). ${av.length ? av[0] : 'Sus próximas facturas se leen solas.'}`);
    recargar(n);
  });
  const brz = $('#b-rechazar');
  if (brz) brz.onclick = async () => {
    const motivo = await pedirTexto({ titulo: 'Rechazar factura', ayuda: 'No se borra: queda registrada como rechazada con este motivo.', etiqueta: 'Motivo', boton: 'Rechazar' });
    if (motivo) conBoton(brz, async () => { recargar(await api(`/api/facturas/${id}/rechazar`, { method: 'POST', body: { motivo } })); toast('Factura rechazada'); });
  };
  const bre = $('#b-reabrir');
  if (bre) bre.onclick = () => conBoton(bre, async () => recargar(await api(`/api/facturas/${id}/reabrir`, { method: 'POST' })));
  const bac = $('#b-aclar');
  if (bac) bac.onclick = async () => {
    const msj = await pedirTexto({ titulo: 'Pedir aclaración al proveedor', ayuda: 'Se responde el mismo hilo de mail desde la casilla de facturas.', etiqueta: 'Mensaje', boton: 'Enviar mail', minimo: 10,
      valor: `Hola, recibimos la factura ${TIPOS[r.datos?.comprobante?.tipo_arca] || ''} ${r.datos ? nroCbte({ pto_vta: r.datos.comprobante?.pto_vta, numero: r.datos.comprobante?.numero }) : ''}. Necesitamos que nos confirmen: ` });
    if (msj) conBoton(bac, async () => { recargar(await api(`/api/facturas/${id}/aclaracion`, { method: 'POST', body: { mensaje: msj } })); toast('Mail enviado'); });
  };
  const ben = $('#b-enviar');
  if (ben) ben.onclick = () => conBoton(ben, async () => {
    if (!await confirmar('¿Enviar este comprobante a Shares? Queda en cola y se manda solo en segundo plano.')) return;
    const res = await api('/api/shares/encolar', { method: 'POST', body: { ids: [id] } });
    if (res.encoladas.length) toast('En cola: se envía sola en segundo plano');
    else toast(res.rechazadas[0]?.message || 'No se pudo encolar', true);
    recargar(await api('/api/facturas/' + id));
  });
  $$('[data-aceptar]', el).forEach(b => b.onclick = async () => {
    const comentario = await pedirTexto({ titulo: `Aceptar ${b.dataset.aceptar}`, ayuda: 'La factura sigue el circuito con esta excepción aceptada. Queda registrado quién y por qué.', boton: 'Aceptar excepción' });
    if (comentario) conBoton(b, async () => recargar(await api(`/api/facturas/${id}/aceptar`, { method: 'POST', body: { codigo: b.dataset.aceptar, comentario } })));
  });
  const balta = $('#b-alta-prov');
  if (balta) balta.onclick = () => modalProveedor({
    cuit: r.datos?.emisor?.cuit, razon_social: r.datos?.emisor?.razon_social,
    condicion_iva: ['A', 'M'].includes(r.datos?.comprobante?.letra) ? 73 : '',
    cuenta_default: r.datos?.imputacion?.codigo_concepto || '',
  }, true, async () => recargar(await api(`/api/facturas/${id}/validar`, { method: 'POST' })));
}

// ---------------------------------------------------------------------------
//  Envío a Shares (aprobador)
// ---------------------------------------------------------------------------
async function vistaShares(el) {
  const [r] = await Promise.all([api('/api/facturas?estado=lista,error_shares&limite=500&orden=vto'), cuentas().catch(() => [])]);
  const ORIG = { manual: 'elegida', regla: 'regla', shares: 'Shares', proveedor: 'maestro', ia: 'Gemini' };
  const celdaCuenta = (f) => `<td class="td-cuenta"><input class="in-cuenta mono" list="dl-cuentas" data-cta="${f.id}" value="${esc(f.cuenta ?? '')}" placeholder="Cuenta" aria-label="Cuenta de la factura #${f.id}">
    <small class="sub-celda" data-den="${f.id}">${esc(f.cuenta_denominacion || nombreCuenta(f.cuenta) || 'Sin cuenta')}${f.imputacion_origen ? ` · ${esc(ORIG[f.imputacion_origen] || f.imputacion_origen)}` : ''}</small></td>`;
  el.innerHTML = `<div class="encabezado"><div><h1>Enviar a Shares</h1><p>Facturas que pasaron todos los controles. Revisá la cuenta de cada una: la cambiás ahí mismo. Nada se carga sin tu aprobación.</p></div>
    <div class="acciones"><span class="muted" id="sel-info"></span>
      <span class="lote-cuenta hidden" id="lote"><input class="in-cuenta mono" list="dl-cuentas" id="lote-cta" placeholder="Cuenta para las elegidas"><button class="btn btn-chico" id="b-lote">Cambiar cuenta</button></span>
      <button class="btn btn-acento" id="b-env" disabled>${ICO.send}Aprobar y enviar</button></div></div>
    ${datalistCuentas()}
    <div id="cola" style="margin-bottom:16px"></div>
    <div class="panel"><div class="tabla-wrap"><table><thead><tr><th><input type="checkbox" id="todas"></th>${encabezadoFacturas(false).replace('<tr>', '').replace('</tr>', '')}<th>Cuenta</th></tr></thead>
    <tbody>${r.facturas.length ? r.facturas.map(f => `<tr data-id="${f.id}"><td><input type="checkbox" data-sel="${f.id}" data-total="${f.total || 0}"></td>${filasFacturas([f], { conExc: false }).replace(/^<tr[^>]*>/, '').replace(/<\/tr>$/, '')}${celdaCuenta(f)}</tr>`).join('') : '<tr><td colspan="9" class="vacio">No hay nada listo para enviar.</td></tr>'}</tbody></table></div></div>
    <div id="resultado"></div>`;
  const existe = (v) => !S.cuentas?.length || S.cuentas.some(c => String(c.codigo_concepto) === String(v).trim());
  const cambiar = async (ids, cod) => {
    const res = await api('/api/facturas/cuenta', { method: 'POST', body: { ids, codigo_concepto: Number(cod) } });
    const mal = res.resultados.filter(x => !x.ok || x.estado !== 'lista');
    toast(mal.length ? `Cuenta ${cod} guardada. ${mal.length} quedaron con algo para revisar.` : `✓ Cuenta ${cod} en ${ids.length} factura(s)`, !!mal.length);
    if (mal.some(x => x.estado && x.estado !== 'lista')) await vistaShares(el);
    else ids.forEach(id => { const s = $(`[data-den="${id}"]`); if (s) s.textContent = `${res.cuenta?.denominacion || nombreCuenta(cod)} · elegida`; const i = $(`[data-cta="${id}"]`); if (i) i.value = cod; });
  };
  $$('[data-cta]').forEach(inp => {
    inp.onclick = (e) => e.stopPropagation();
    inp.onfocus = () => { inp.dataset.ant = inp.value; };
    inp.onchange = async () => {
      const v = inp.value.trim();
      if (!v || v === inp.dataset.ant) return;
      if (!existe(v)) { toast(`La cuenta ${v} no está en el plan`, true); inp.value = inp.dataset.ant || ''; return; }
      inp.disabled = true;
      try { await cambiar([Number(inp.dataset.cta)], v); inp.dataset.ant = v; } catch (e) { toast(e.message, true); inp.value = inp.dataset.ant || ''; }
      inp.disabled = false;
    };
    inp.oninput = () => { const s = $(`[data-den="${inp.dataset.cta}"]`); if (s && existe(inp.value) && inp.value) s.textContent = nombreCuenta(inp.value); };
  });
  $('#b-lote').onclick = () => conBoton($('#b-lote'), async () => {
    const v = $('#lote-cta').value.trim();
    const ids = $$('[data-sel]:checked').map(c => Number(c.dataset.sel));
    if (!v || !existe(v)) return toast('Elegí una cuenta del plan', true);
    await cambiar(ids, v);
  });
  const info = () => {
    const sel = $$('[data-sel]:checked');
    const tot = sel.reduce((a, x) => a + Number(x.dataset.total), 0);
    $('#sel-info').textContent = sel.length ? `${sel.length} seleccionadas · ${$$m(tot)}` : '';
    $('#b-env').disabled = !sel.length;
    $('#lote').classList.toggle('hidden', sel.length < 2);
  };
  $('#todas').onchange = (e) => { $$('[data-sel]').forEach(c => { c.checked = e.target.checked; }); info(); };
  $$('[data-sel]').forEach(c => c.onchange = info);
  $$('tr[data-id] td:not(:first-child):not(.td-cuenta)').forEach(td => { td.style.cursor = 'pointer'; td.onclick = () => { location.hash = '#/factura/' + td.parentElement.dataset.id; }; });
  $('#b-env').onclick = () => conBoton($('#b-env'), async () => {
    const ids = $$('[data-sel]:checked').map(c => Number(c.dataset.sel));
    if (!await confirmar(`¿Enviar ${ids.length} comprobante(s) a Shares?\n\nQuedan en cola y se mandan solas en segundo plano, a ritmo tranquilo. Podés seguir trabajando o cerrar la pestaña.`)) return;
    const res = await api('/api/shares/encolar', { method: 'POST', body: { ids } });
    toast(`${res.encoladas.length} en cola para Shares${res.rechazadas.length ? ` · ${res.rechazadas.length} no se pudieron encolar` : ''}`, !!res.rechazadas.length && !res.encoladas.length);
    await vistaShares(el);
    if (res.rechazadas.length) {
      const nombre = (id) => (r.facturas.find(f => f.id === id)?.razon_social_emisor) || '';
      modal(`<h2 style="margin-bottom:4px">${res.rechazadas.length} no se pudieron encolar</h2><p class="muted" style="margin:0 0 14px">Las demás ya están en cola.</p>
        <div class="tabla-wrap"><table><tbody>${res.rechazadas.map(x => `<tr><td class="mono"><a href="#/factura/${x.id}">#${x.id}</a></td><td>${esc(nombre(x.id))}</td><td class="small">${esc(x.message)}</td></tr>`).join('')}</tbody></table></div>
        <div class="acciones" style="justify-content:flex-end;margin-top:14px"><button class="btn btn-acento" data-ok>Entendido</button></div>`, { ancho: true, alMontar: (m, c) => { $('[data-ok]', m).onclick = c; } });
    }
  });
  montarPanelCola(el, () => vistaShares(el));
}

// Panel "Cola de envío": muestra cuántas faltan, si Shares está en pausa y los últimos resultados.
// Mientras la pantalla está abierta, cada 15 s le da un empujón a la cola (además del cron cada 5 min).
async function montarPanelCola(el, alTerminar) {
  const caja = $('#cola', el); if (!caja) return;
  let antes = null;
  const pintar = (c) => {
    const activas = (c.en_cola || 0) + (c.enviando || 0);
    const rec = c.recientes || [];
    const ok = rec.filter(x => x.ok).length, mal = rec.filter(x => !x.ok);
    if (!activas && !rec.length) { caja.innerHTML = ''; return activas; }
    caja.innerHTML = `<div class="panel panel-pad cola ${activas ? 'activa' : ''}">
      <div class="cola-top">${activas ? '<span class="cargando"></span>' : ICO.check}
        <div><b>${activas ? `Enviando a Shares en segundo plano: ${activas} en cola` : 'Cola vacía: no queda nada por enviar'}</b>
        <div class="small muted">${c.pausa_hasta ? `Shares nos frenó: se retoma sola a las ${esc(c.pausa_hasta)}. No se pierde nada.` : activas ? 'Se mandan de a una con todos los controles. Podés seguir trabajando o cerrar la pestaña.' : 'Últimas 6 horas'} · ${ok} cargadas${mal.length ? ` · <b>${mal.length} con error</b>` : ''}</div></div></div>
      ${mal.length ? `<details class="cola-err"><summary>Ver las que dieron error</summary><table><tbody>${mal.slice(0, 30).map(x => `<tr><td class="mono"><a href="#/factura/${x.id}">#${x.id}</a></td><td>${esc(x.proveedor || '')}</td><td class="small">${esc(x.message || '')}</td></tr>`).join('')}</tbody></table></details>` : ''}
    </div>`;
    return activas;
  };
  const tick = async () => {
    if (!caja.isConnected) return;
    let c; try { c = await api('/api/shares/cola/procesar', { method: 'POST' }); } catch { c = null; }
    if (!caja.isConnected) return;
    if (c) {
      const activas = pintar(c);
      if (antes !== null && activas < antes && alTerminar && !activas) { alTerminar(); return; }
      antes = activas;
      if (!activas) return;
    }
    setTimeout(tick, 15000);
  };
  tick();
}

// ---------------------------------------------------------------------------
//  Proveedores
// ---------------------------------------------------------------------------
async function vistaProveedores(el) {
  await cuentas().catch(() => null);
  el.innerHTML = `<div class="encabezado"><div><h1>Proveedores</h1><p>Maestro: CUIT, condición IVA, CBU y cuenta habitual. Tocá uno para ver su ficha.</p></div>
    <div class="acciones">${puede('aprobador') ? `<button class="btn" id="b-nuevo">${ICO.user}Nuevo proveedor</button>` : ''}${puede('admin') ? `<button class="btn" id="b-sh">${ICO.refresh}Traer cuentas desde Shares</button><button class="btn btn-negro" id="b-imp">${ICO.upload}Importar Excel</button>` : ''}</div></div>
    <div class="panel"><div class="filtros"><div class="campo ancho"><label>Buscar</label><input id="q" placeholder="Razón social, CUIT o código Shares"></div></div>
    <div class="tabla-wrap"><table class="tabla-provs"><thead><tr><th>Proveedor</th><th>CUIT</th><th>Cód. Shares</th><th>Cond. IVA</th><th>Cuenta por defecto</th><th>CBU</th><th>Lectura</th><th class="num">Facturas</th><th>Estado</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  const cargar = async () => {
    const r = await api('/api/proveedores?q=' + encodeURIComponent($('#q').value.trim()));
    $('#tb').innerHTML = r.proveedores.length ? r.proveedores.map(p => `<tr class="click" data-cuit="${p.cuit}">
      <td><div class="prov">${cuad(p.razon_social)}<div><b>${esc(p.razon_social)}</b></div></div></td><td class="mono">${fmtCuit(p.cuit)}</td><td class="mono">${esc(p.codigo_shares || '—')}</td><td class="mono">${esc(p.condicion_iva ?? '—')}</td>
      <td class="celda-cuenta"><span class="mono">${esc(p.cuenta_default || '—')}</span>${p.cuenta_denominacion ? `<small>${esc(p.cuenta_denominacion)}</small>` : ''}</td>
      <td class="mono small">${p.cbu ? '···' + esc(p.cbu.slice(-6)) : '—'}</td><td>${p.config_version ? `<span class="badge b-ok">config v${p.config_version}</span>` : '<span class="badge b-aviso">sin configurar</span>'}</td><td class="num">${p.facturas}</td>
      <td>${p.activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">inactivo</span>'}</td></tr>`).join('')
      : '<tr><td colspan="9" class="vacio">No hay proveedores. Importá el maestro desde un Excel exportado de Shares.</td></tr>';
    $$('#tb tr[data-cuit]').forEach(tr => tr.onclick = () => { location.hash = '#/proveedor/' + tr.dataset.cuit; });
  };
  let deb;
  $('#q').oninput = () => { clearTimeout(deb); deb = setTimeout(cargar, 300); };
  const bn = $('#b-nuevo'); if (bn) bn.onclick = () => modalProveedor({}, true, cargar);
  const bi = $('#b-imp'); if (bi) bi.onclick = () => modalImportar('proveedores', cargar);
  const bs = $('#b-sh'); if (bs) bs.onclick = () => modalCuentasShares(cargar);
  await cargar();
}

// Recorre el maestro y deja como cuenta por defecto la que cada proveedor tiene más usada en Shares (solo lectura en Shares)
function modalCuentasShares(alTerminar) {
  modal(`<h2>Traer cuentas desde Shares</h2>
    <p class="muted">Para cada proveedor del maestro se consultan sus últimas facturas registradas en Shares (solo lectura, no se carga nada) y se deja como <b>cuenta por defecto</b> la que más usó. Los proveedores sin facturas en Shares quedan como están. También aprende qué cuentas usa Shares para cada percepción.</p>
    <p class="small muted">Puede tardar un rato con todo el maestro: dejá esta ventana abierta. Si se corta, volvé a tocar "Empezar" y sigue desde donde quedó.</p>
    <div class="acciones"><button class="btn btn-negro" id="cs-ir">Empezar</button><button class="btn" id="cs-stop" disabled>Pausar</button></div>
    <div id="cs-prog" class="small" style="margin-top:12px"></div><div id="cs-res" class="small" style="margin-top:8px;max-height:300px;overflow:auto"></div>`, {
    ancho: true,
    alMontar: (el) => {
      const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
      const guardar = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(v)); } catch { /* sin storage */ } };
      // Avance: último CUIT procesado (y, por compatibilidad, el número viejo)
      let parar = false, desde = Number(leer('cs_desde') || 0), despues = leer('cs_despues') || '', total = Number(leer('cs_total') || 0);
      const cambios = [];
      let sinHist = 0, iguales = 0, errores = [], esperas = 0;
      // Ritmo (criterio de Juan): lotes de 5 con 5 s de pausa hasta juntar 30; después 1 minuto de espera y vuelta a empezar
      const TANDA = 30, PAUSA_LOTE = 5, ESPERA_TANDA = 60;
      let usadas = 0;
      // Reloj en un Web Worker: Chrome frena los timers de las pestañas en segundo plano (hasta 1 por minuto),
      // pero no los de un worker. Así el ritmo se mantiene aunque estés en otra pestaña.
      let reloj = null;
      try {
        reloj = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
      } catch { reloj = null; }
      const esperando = new Map(); let idEspera = 0;
      if (reloj) reloj.onmessage = (e) => { const ok = esperando.get(e.data); esperando.delete(e.data); ok && ok(); };
      const dormir = (ms) => new Promise(ok => {
        if (!reloj) return setTimeout(ok, ms);
        const id = ++idEspera; esperando.set(id, ok); reloj.postMessage({ id, ms });
      });
      // Espera con texto: un solo timer (no uno por segundo) y el contador se calcula con la hora real
      const esperar = async (seg, nodoId, texto) => {
        const fin = Date.now() + seg * 1000;
        while (!parar) {
          const falta = Math.ceil((fin - Date.now()) / 1000);
          if (falta <= 0) break;
          const n = $('#' + nodoId, el); if (n) n.textContent = texto(falta);
          await dormir(Math.min(1000, falta * 1000));
        }
      };
      const pintar = (r) => {
        $('#cs-prog', el).innerHTML = `<b>${Math.min(r.siguiente, r.total)} de ${r.total}</b> proveedores revisados · ${cambios.length} cuentas actualizadas · ${iguales} ya estaban bien · ${sinHist} sin facturas en Shares${errores.length ? ` · <span style="color:#b42318">${errores.length} con error</span>` : ''}`;
        const tipos = [...new Set(errores.map(e => e.replace(/^\d+:\s*/, '')))].slice(0, 5);
        $('#cs-res', el).innerHTML = (tipos.length ? `<div style="color:#b42318;margin-bottom:8px"><b>Errores de Shares:</b><br>${tipos.map(esc).join('<br>')}</div>` : '') + cambios.slice(-200).reverse().map(c => `<div>${esc(c.razon_social)} <span class="mono">${fmtCuit(c.cuit)}</span>: ${esc(c.antes ?? '—')} → <b class="mono">${esc(c.ahora)}</b> <span class="muted">(${c.veces} de ${c.de})</span></div>`).join('');
      };
      $('#cs-stop', el).onclick = () => { parar = true; };
      $('#cs-ir', el).onclick = async () => {
        $('#cs-ir', el).disabled = true; $('#cs-stop', el).disabled = false; parar = false;
        try {
          while (!parar) {
            let r;
            for (let intento = 0; ; intento++) {
              try { r = await api('/api/proveedores/sincronizar-shares', { method: 'POST', body: { desde, despues, total, hechos: desde, lote: 5 } }); break; }
              catch (e) { if (intento >= 2) throw e; await dormir(3000); }
            }
            const hay429 = r.errores.some(e => /HTTP 429/.test(e));
            if (hay429 && esperas < 20) {
              // Límite de consultas de Shares: se guarda lo que salió bien, se espera un minuto y se repite el lote
              cambios.push(...r.actualizados);
              esperas++;
              $('#cs-prog', el).insertAdjacentHTML('beforeend', '<p id="cs-espera" class="muted"></p>');
              await esperar(ESPERA_TANDA, 'cs-espera', (s) => `Shares cortó en la consulta ${usadas + 1} de la tanda: espero ${s} s y arranco una tanda nueva…`);
              usadas = 0;
              $('#cs-espera', el).remove();
              continue;
            }
            cambios.push(...r.actualizados); sinHist += r.sin_historial; iguales += r.iguales; errores.push(...r.errores);
            const loteEntero = r.errores.length && r.errores.length >= (r.siguiente - r.desde);
            if (!loteEntero) { desde = r.siguiente; despues = r.ultimo || despues; total = r.total; guardar('cs_desde', desde); guardar('cs_despues', despues); guardar('cs_total', total); }
            pintar(r);
            if (!r.errores.length) esperas = 0;
            usadas += Math.max(1, r.siguiente - r.desde);
            if (!r.fin) {
              const espera = usadas >= TANDA ? ESPERA_TANDA : PAUSA_LOTE;
              $('#cs-prog', el).insertAdjacentHTML('beforeend', '<p id="cs-ritmo" class="muted"></p>');
              await esperar(espera, 'cs-ritmo', (s) => usadas >= TANDA ? `Tanda de ${TANDA} lista: sigo en ${s} s` : `Llevo ${usadas} de ${TANDA} en esta tanda · próximo lote en ${s} s`);
              $('#cs-ritmo', el).remove();
              if (usadas >= TANDA) usadas = 0;
            }
            if (loteEntero) {   // falló todo el lote: algo pasa con Shares → se pausa en vez de seguir de largo
              $('#cs-prog', el).insertAdjacentHTML('beforeend', '<p style="color:#b42318">Shares rechazó todo el lote: pausado. Mirá el error abajo; en un rato tocá "Empezar" y retoma desde acá.</p>');
              break;
            }
            if (r.fin) {
              guardar('cs_desde', null); guardar('cs_despues', null); guardar('cs_total', null);
              const fis = Object.entries(r.fiscal || {});
              $('#cs-prog', el).insertAdjacentHTML('beforeend', `<p><b>¡Listo!</b>${fis.length ? ` Cuentas de percepciones aprendidas: ${fis.map(([id, c]) => `id ${esc(id)} → <span class="mono">${esc(c)}</span>`).join(' · ')}` : ''}</p>`);
              toast('Cuentas actualizadas desde Shares');
              alTerminar && alTerminar();
              break;
            }
          }
        } catch (e) { toast(e.message, true); }
        $('#cs-ir', el).disabled = false; $('#cs-stop', el).disabled = true;
        if (parar) $('#cs-prog', el).insertAdjacentHTML('beforeend', '<p class="muted">Pausado. Tocá "Empezar" para seguir desde acá.</p>');
      };
    },
  });
}

function modalProveedor(p, nuevo, alGuardar, extra = null) {
  const edit = puede('aprobador');
  const dis = edit ? '' : 'disabled';
  modal(`<h2>${nuevo ? 'Nuevo proveedor' : esc(p.razon_social)}</h2>${datalistCuentas()}
    <form id="f-prov">
      <div class="fila"><div class="campo"><label>CUIT</label><input name="cuit" class="mono" value="${esc(p.cuit || '')}" ${nuevo ? '' : 'disabled'} required></div>
        <div class="campo"><label>Código en Shares</label><input name="codigo_shares" value="${esc(p.codigo_shares || '')}" ${dis}></div></div>
      <div class="campo"><label>Razón social</label><input name="razon_social" value="${esc(p.razon_social || '')}" ${dis} required></div>
      <div class="fila"><div class="campo"><label>Condición IVA (código Shares)</label><input name="condicion_iva" class="mono" value="${esc(p.condicion_iva ?? '')}" ${dis} placeholder="73 = Resp. Inscripto"></div>
        <div class="campo"><label>Días de pago</label><input name="dias_pago" class="mono" value="${esc(p.dias_pago ?? '')}" ${dis}></div></div>
      <div class="fila"><div class="campo"><label>Cuenta por defecto</label><input name="cuenta_default" list="dl-cuentas" class="mono" value="${esc(p.cuenta_default ?? '')}" ${dis}></div>
        <div class="campo"><label>Estado</label><select name="activo" ${dis}><option value="1" ${p.activo !== 0 ? 'selected' : ''}>Activo</option><option value="0" ${p.activo === 0 ? 'selected' : ''}>Inactivo</option></select></div></div>
      <div class="fila"><div class="campo"><label>CBU ${puede('admin') ? '' : '(solo admin)'}</label><input name="cbu" class="mono" value="${esc(p.cbu || '')}" ${puede('admin') ? '' : 'disabled'}></div>
        <div class="campo"><label>Alias</label><input name="alias_cbu" value="${esc(p.alias_cbu || '')}" ${dis}></div></div>
      ${puede('admin') ? '<label class="check"><input type="checkbox" name="cbu_validado_por_telefono"> Si cambié el CBU: lo validé por teléfono con el proveedor</label>' : ''}
      <div class="campo"><label>Notas</label><textarea name="notas" ${dis}>${esc(p.notas || '')}</textarea></div>
      ${edit ? '<div class="acciones"><button class="btn btn-negro" type="submit">Guardar</button></div>' : ''}
    </form>
    ${extra ? `<h3 style="margin:20px 0 8px">Configuración de lectura</h3>
      ${(extra.plantillas || []).length ? (extra.plantillas || []).map(pl => `<div class="excepcion ${pl.estado === 'activa' ? '' : 'aceptada'}"><div class="txt">
        <div class="cod">v${pl.version} · ${esc(pl.estado)} · ${esc(pl.config.modo === 'cuadre' ? 'por cuadre aritmético' : 'por etiquetas')}${pl.config.sin_iva ? ' · sin IVA discriminado' : ''}</div>
        <div class="small">${[...(pl.config.gravado || []).map(g => `IVA ${g.alicuota}% ← “${esc(g.etiqueta_iva || g.clave_iva)}”${g.etiqueta_neto ? ` · neto ← “${esc(g.etiqueta_neto)}”` : ''}`),
          ...(pl.config.etiqueta_neto_total ? [`Neto ← “${esc(pl.config.etiqueta_neto_total)}”`] : []),
          ...(pl.config.extras || []).map(e => `${esc(e.cls)}${e.jurisdiccion ? ' ' + esc(e.jurisdiccion) : ''} ← “${esc(e.etiqueta || e.clave)}”`),
          ...(pl.config.vto_clave ? [`Vencimiento ← “${esc(pl.config.vto_clave)}”`] : [])].join('<br>') || 'Sin campos'}</div>
        <div class="small muted">${esc(pl.usos)} usos · ${esc(pl.fallos)} con cambio de formato · aprobada por ${esc(pl.aprobada_por || '—')} ${fmtFH(pl.aprobada_at)} · aprendida de la factura <a href="#/factura/${pl.factura_origen_id}">#${pl.factura_origen_id}</a></div></div>
        ${pl.estado === 'activa' && puede('admin') ? `<button class="btn btn-chico btn-rojo" data-desact="${pl.id}">Desactivar</button>` : ''}</div>`).join('')
      : '<p class="muted small">Todavía no tiene. Se crea al confirmar su primera factura.</p>'}
      <h3 style="margin:20px 0 8px">Reglas de imputación</h3>
      <table><tbody>${(extra.reglas || []).map(rg => `<tr><td>${rg.palabra_clave ? `si contiene “${esc(rg.palabra_clave)}”` : '<i>siempre</i>'}</td><td class="mono">${rg.codigo_concepto}</td><td class="small muted">${esc(rg.denominacion || '')}</td><td>${puede('aprobador') ? `<button class="btn btn-chico btn-rojo" data-borrar-regla="${rg.id}">Borrar</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">Sin reglas. Se crean desde la factura al confirmar la cuenta.</td></tr>'}</tbody></table>
      <h3 style="margin:20px 0 8px">Historial</h3><div class="small">${(extra.auditoria || []).slice(0, 15).map(a => `<div>${fmtFH(a.ts)} · ${esc(a.usuario)} · ${esc(a.accion)} ${esc(a.campo || '')}: ${esc(a.valor_anterior ?? '')} → ${esc(a.valor_nuevo ?? '')}</div>`).join('') || '<span class="muted">—</span>'}</div>` : ''}`, {
    ancho: !!extra,
    alMontar: (el, cerrar) => {
      $('#f-prov', el).onsubmit = (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        const cuit = String(fd.cuit || p.cuit || '').replace(/\D/g, '');
        const body = { ...fd, activo: fd.activo === '1', cbu_validado_por_telefono: !!fd.cbu_validado_por_telefono };
        delete body.cuit;
        if (!puede('admin')) delete body.cbu;
        conBoton($('button[type=submit]', el), async () => {
          await api('/api/proveedores/' + cuit, { method: 'PUT', body });
          toast('Proveedor guardado. Se revalidaron sus facturas pendientes.'); cerrar(); alGuardar && alGuardar();
        });
      };
      $$('[data-desact]', el).forEach(b => b.onclick = () => conBoton(b, async () => {
        if (!await confirmar('¿Desactivar la configuración? La próxima factura de este proveedor se lee como si fuera nuevo.')) return;
        await api('/api/plantillas/' + b.dataset.desact, { method: 'PUT', body: { estado: 'desactivada' } }); toast('Configuración desactivada'); cerrar(); alGuardar && alGuardar();
      }));
      $$('[data-borrar-regla]', el).forEach(b => b.onclick = () => conBoton(b, async () => {
        if (!await confirmar('¿Borrar la regla?')) return;
        await api('/api/reglas/' + b.dataset.borrarRegla, { method: 'DELETE' }); b.closest('tr').remove(); toast('Regla borrada');
      }));
    },
  });
}

// Importador genérico de Excel con mapeo de columnas
const MAPEOS = {
  proveedores: {
    titulo: 'Importar proveedores', endpoint: '/api/proveedores/importar',
    ayuda: 'Exportá el maestro de proveedores de Shares a Excel. Los CBU existentes nunca se pisan desde el archivo.',
    campos: { cuit: /cuit/i, razon_social: /raz[oó]n|nombre|denominaci/i, codigo_shares: /^c[oó]d|codigo|id prov/i, condicion_iva: /condici[oó]n.*iva|cond\.? ?iva|^iva/i, cuenta_default: /cuenta|concepto|imputaci/i, dias_pago: /d[ií]as|plazo/i, cbu: /^cbu/i, alias_cbu: /alias/i },
    obligatorios: ['cuit', 'razon_social'],
  },
  cuentas: {
    titulo: 'Importar plan de cuentas', endpoint: '/api/cuentas/importar',
    ayuda: 'Columnas: código de concepto (codigo_concepto) y denominación. Las de retenciones/percepciones/IVA quedan fuera del selector de gasto.',
    campos: { codigo_concepto: /c[oó]d|concepto|cuenta/i, denominacion: /denominaci|descripci|nombre/i },
    obligatorios: ['codigo_concepto', 'denominacion'],
  },
};
function modalImportar(tipo, alTerminar) {
  const cfg = MAPEOS[tipo];
  modal(`<h2>${cfg.titulo}</h2><p class="muted">${cfg.ayuda}</p>
    <label class="drop"><input type="file" id="f-xls" accept=".xlsx,.xls,.csv" hidden>Elegí el archivo Excel o CSV</label><div id="map"></div>`, {
    ancho: true,
    alMontar: (el, cerrar) => {
      $('#f-xls', el).onchange = async (e) => {
        try {
          const filas = (await leerPlanilla(e.target.files[0])).filter(f => f.some(x => String(x).trim()));
          // fila de encabezados = la primera con ≥2 coincidencias
          let hi = filas.findIndex(f => Object.values(cfg.campos).filter(re => f.some(x => re.test(String(x)))).length >= 2);
          if (hi < 0) hi = 0;
          const enc = filas[hi].map(String);
          const usado = new Set();
          const auto = Object.fromEntries(Object.entries(cfg.campos).map(([k, re]) => { const i = enc.findIndex((h, j) => !usado.has(j) && re.test(h)); if (i >= 0) usado.add(i); return [k, i]; }));
          const datos = filas.slice(hi + 1);
          $('#map', el).innerHTML = `<p class="small">${datos.length} filas. Revisá qué columna va en cada campo:</p>
            <div class="fila">${Object.keys(cfg.campos).map(k => `<div class="campo"><label>${k}${cfg.obligatorios.includes(k) ? ' *' : ''}</label><select data-campo="${k}"><option value="-1">— no importar —</option>${enc.map((h, i) => `<option value="${i}" ${auto[k] === i ? 'selected' : ''}>${esc(h || 'Col ' + (i + 1))}</option>`).join('')}</select></div>`).join('')}</div>
            <div class="tabla-wrap" style="max-height:200px"><table><thead><tr>${enc.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${datos.slice(0, 5).map(f => `<tr>${f.map(x => `<td class="small">${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
            <div class="acciones" style="margin-top:12px"><button class="btn btn-negro" id="b-go">Importar ${datos.length} filas</button></div><div id="imp-res" class="small"></div>`;
          $('#b-go', el).onclick = () => conBoton($('#b-go', el), async () => {
            const m = Object.fromEntries($$('[data-campo]', el).map(s => [s.dataset.campo, Number(s.value)]));
            for (const k of cfg.obligatorios) if (m[k] < 0) throw new Error(`Falta mapear ${k}.`);
            const out = datos.map(f => Object.fromEntries(Object.entries(m).filter(([, i]) => i >= 0).map(([k, i]) => [k, String(f[i] ?? '').trim()])));
            let res = { creados: 0, actualizados: 0, cantidad: 0, errores: [], conflictos_cbu: [] };
            for (let i = 0; i < out.length; i += 400) {
              const r = await api(cfg.endpoint, { method: 'POST', body: { filas: out.slice(i, i + 400) } });
              res.creados += r.creados || 0; res.actualizados += r.actualizados || 0; res.cantidad += r.cantidad || 0;
              res.errores.push(...(r.errores || [])); res.conflictos_cbu.push(...(r.conflictos_cbu || []));
            }
            $('#imp-res', el).innerHTML = `<p><b>Listo.</b> ${tipo === 'cuentas' ? res.cantidad + ' cuentas' : `${res.creados} nuevos · ${res.actualizados} actualizados`}</p>
              ${res.errores.length ? `<details><summary>${res.errores.length} con error</summary>${res.errores.map(esc).join('<br>')}</details>` : ''}
              ${res.conflictos_cbu.length ? `<details open><summary>${res.conflictos_cbu.length} CBU distintos (no se tocaron)</summary>${res.conflictos_cbu.map(esc).join('<br>')}</details>` : ''}`;
            if (tipo === 'cuentas') S.cuentas = null;
            alTerminar && alTerminar();
          });
        } catch (err) { toast(err.message, true); }
      };
      void cerrar;
    },
  });
}

// ---------------------------------------------------------------------------
//  Admin
// ---------------------------------------------------------------------------
async function vistaAdmin(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Administración</h1><p>Conexiones, usuarios, plan de cuentas, configuración y auditoría.</p></div></div>
    <div class="panel"><div class="tabs" id="atabs">${['Salud', 'Usuarios', 'Cuentas', 'Configuración', 'Auditoría'].map((t, i) => `<button class="${i ? '' : 'activo'}" data-t="${i}">${t}</button>`).join('')}</div><div id="acont" class="panel-pad"></div></div>`;
  const tabs = [adminSalud, adminUsuarios, adminCuentas, adminConfig, adminAuditoria];
  const ir = async (i) => {
    $$('#atabs button').forEach(b => b.classList.toggle('activo', b.dataset.t === String(i)));
    $('#acont').innerHTML = '<span class="cargando"></span>';
    try { await tabs[i]($('#acont')); } catch (e) { $('#acont').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  };
  $$('#atabs button').forEach(b => b.onclick = () => ir(Number(b.dataset.t)));
  ir(0);
}

async function adminSalud(el) {
  const s = await api('/api/salud');
  const fila = (ok, t, det, prueba) => `<tr><td>${ok ? '<span class="badge b-ok">OK</span>' : '<span class="badge b-normal">Falta</span>'}</td><td><b>${t}</b><div class="small muted">${det}</div></td><td>${prueba ? `<button class="btn btn-chico" data-probar="${prueba}">Probar</button>` : ''}</td></tr>`;
  el.innerHTML = `<table><tbody>
    ${fila(s.apps_script, 'Apps Script (Gmail + Drive)', 'APPS_SCRIPT_URL y APPS_SCRIPT_SECRET', 'apps-script')}
    ${fila(s.lector && !!s.lector_ultimo, 'Lector (GitHub Actions)', `${s.lector ? 'LECTOR_SECRET cargado' : 'falta LECTOR_SECRET'} · último contacto ${s.lector_ultimo ? fmtFH(s.lector_ultimo) : 'nunca'} · disparo inmediato ${s.lector_disparo ? 'sí' : 'no (corre cada 15 min)'} · ${s.proveedores_configurados} proveedores configurados`)}
    ${fila(s.shares, 'Shares', esc(s.shares_base), 'shares')}
    ${s.shares_uso_hora ? (() => {
      const u = s.shares_uso_hora, d = s.shares_uso_dia || {};
      const NOM = { login: 'login', recent: 'historial/duplicados', provider: 'proveedor', receive: 'envíos', concepts: 'plan de cuentas' };
      const tipos = Object.entries(u.por_tipo || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(NOM[k] || k)} ${n}`).join(' · ') || 'sin llamadas';
      return fila(!u.frenadas, 'Uso de Shares (lo que consume esta app)', `Última hora: <b>${u.llamadas}</b> llamadas · <b>${u.frenadas}</b> frenadas por Shares (429) · pico ${u.pico_por_minuto}/min · ${tipos}<br>Últimas 24 h: ${d.llamadas ?? 0} llamadas · ${d.frenadas ?? 0} frenadas${s.shares_pausa_hasta ? `<br><b>En pausa hasta las ${esc(s.shares_pausa_hasta)}</b>: Shares nos frenó, la app no le consulta nada hasta esa hora y después sigue sola.` : ''}`);
    })() : ''}
    ${fila(s.arca_cert && s.arca_modo !== 'off', 'ARCA (constatación de CAE)', `modo ${esc(s.arca_modo)} · certificado ${s.arca_cert ? 'cargado' : 'falta'}`, s.arca_modo !== 'off' ? 'arca' : '')}
    ${s.arca_cert && s.arca_modo !== 'off' ? fila(true, 'Padrón ARCA (razón social por CUIT)', 'Requiere autorizar el servicio ws_sr_constancia_inscripcion para el certificado en ARCA', 'padron') : ''}
    ${fila(s.empresas > 0, 'Empresas del grupo', `${s.empresas} cargadas`)}
    ${fila(s.cuentas > 0, 'Plan de cuentas', `${s.cuentas} cuentas`)}
    ${fila(s.proveedores > 0, 'Maestro de proveedores', `${s.proveedores} proveedores`)}
  </tbody></table><p class="small muted">Versión ${esc(s.version)}</p>`;
  $$('[data-probar]', el).forEach(b => b.onclick = () => conBoton(b, async () => { const r = await api('/api/probar/' + b.dataset.probar, { method: 'POST' }); toast(r.mensaje); }));
}

async function adminUsuarios(el) {
  const r = await api('/api/usuarios');
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-nu">Nuevo usuario</button></div>
    <table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>2FA</th><th>Estado</th><th></th></tr></thead><tbody>
    ${r.usuarios.map(u => `<tr><td>${esc(u.nombre)}</td><td>${esc(u.email)}</td>
      <td><select data-rol="${u.id}">${['carga', 'aprobador', 'admin', 'director'].map(x => `<option ${u.rol === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td>${u.totp_activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">no</span>'}</td>
      <td>${u.activo ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      <td class="acciones"><button class="btn btn-chico" data-pass="${u.id}">Resetear clave</button>${u.totp_activo ? `<button class="btn btn-chico" data-totp="${u.id}">Resetear 2FA</button>` : ''}<button class="btn btn-chico" data-act="${u.id}" data-v="${u.activo ? 0 : 1}">${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}
    </tbody></table><p class="small muted">Roles: <b>carga</b> resuelve excepciones · <b>aprobador</b> además envía a Shares y edita proveedores · <b>admin</b> todo, incluido CBU y configuración · <b>director</b> solo aprueba pagos y consulta facturas (no puede aprobar propuestas que arme él).</p>`;
  const put = (id, body) => api('/api/usuarios/' + id, { method: 'PUT', body }).then(() => { toast('Guardado'); adminUsuarios(el); }).catch(e => toast(e.message, true));
  $$('[data-rol]', el).forEach(s => s.onchange = () => put(s.dataset.rol, { rol: s.value }));
  $$('[data-act]', el).forEach(b => b.onclick = () => put(b.dataset.act, { activo: b.dataset.v === '1' }));
  $$('[data-totp]', el).forEach(b => b.onclick = async () => await confirmar('¿Resetear el doble factor de este usuario?') && put(b.dataset.totp, { reset_totp: true }));
  $$('[data-pass]', el).forEach(b => b.onclick = async () => { const p = await pedirTexto({ titulo: 'Nueva contraseña', etiqueta: 'Contraseña (mínimo 10 caracteres)', boton: 'Guardar', minimo: 10 }); if (p) put(b.dataset.pass, { password: p }); });
  $('#b-nu', el).onclick = () => modal(`<h2>Nuevo usuario</h2><form id="f-nu">
      <div class="campo"><label>Nombre</label><input name="nombre" required></div>
      <div class="campo"><label>Email</label><input name="email" type="email" required></div>
      <div class="campo"><label>Rol</label><select name="rol"><option>carga</option><option>aprobador</option><option>admin</option><option>director</option></select></div>
      <div class="campo"><label>Contraseña inicial</label><input name="password" type="text" minlength="10" required><div class="ayuda">Pasásela por un canal seguro; la puede cambiar en “Mi cuenta”.</div></div>
      <button class="btn btn-negro" type="submit">Crear</button></form>`, {
    alMontar: (m, cerrar) => { $('#f-nu', m).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/usuarios', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); cerrar(); toast('Usuario creado'); adminUsuarios(el); }); }; },
  });
}

async function adminEmpresas(el) {
  const r = await api('/api/empresas');
  el.innerHTML = `<p class="muted">CUITs del grupo a los que tienen que venir emitidas las facturas (control “Destinatario”).</p>
    <table><tbody>${r.empresas.map(e => `<tr><td class="mono">${fmtCuit(e.cuit)}</td><td>${esc(e.razon_social)}</td><td><button class="btn btn-chico btn-rojo" data-del="${e.cuit}">Quitar</button></td></tr>`).join('') || '<tr><td class="muted">Sin empresas cargadas.</td></tr>'}</tbody></table>
    <form id="f-emp" class="fila" style="margin-top:16px;align-items:end"><div class="campo"><label>CUIT</label><input name="cuit" class="mono" required></div><div class="campo"><label>Razón social</label><input name="razon_social" required></div><div class="campo"><button class="btn btn-negro" type="submit">Agregar</button></div></form>`;
  $('#f-emp', el).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/empresas', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); adminEmpresas(el); }); };
  $$('[data-del]', el).forEach(b => b.onclick = async () => await confirmar('¿Quitar esta empresa?') && conBoton(b, async () => { await api('/api/empresas/' + b.dataset.del, { method: 'DELETE' }); adminEmpresas(el); }));
}

async function adminCuentas(el) {
  const r = await api('/api/cuentas?todas=1');
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-sync">Sincronizar desde Shares</button><button class="btn" id="b-imp">Importar Excel</button><input id="q" placeholder="Filtrar…" style="max-width:240px"></div>
    <p class="small muted">${r.cuentas.length} cuentas. Las tildadas aparecen en el selector de imputación y se le pasan a la IA para sugerir.</p>
    <div class="tabla-wrap" style="max-height:60vh"><table><thead><tr><th>Usar</th><th>Código</th><th>Denominación</th><th>Origen</th></tr></thead><tbody id="tbc">
    ${r.cuentas.map(c => `<tr data-txt="${esc((c.codigo_concepto + ' ' + c.denominacion).toLowerCase())}"><td><input type="checkbox" data-cta="${c.codigo_concepto}" ${c.usable_gasto ? 'checked' : ''}></td><td class="mono">${c.codigo_concepto}</td><td>${esc(c.denominacion)}</td><td class="small muted">${esc(c.origen)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#q', el).oninput = (e) => { const q = e.target.value.toLowerCase(); $$('#tbc tr', el).forEach(tr => tr.classList.toggle('hidden', !tr.dataset.txt.includes(q))); };
  $$('[data-cta]', el).forEach(c => c.onchange = () => api('/api/cuentas/' + c.dataset.cta, { method: 'PUT', body: { usable_gasto: c.checked } }).then(() => { S.cuentas = null; }).catch(e => toast(e.message, true)));
  $('#b-sync', el).onclick = () => conBoton($('#b-sync', el), async () => { const x = await api('/api/cuentas/sincronizar', { method: 'POST' }); toast(`${x.cantidad} cuentas sincronizadas`); S.cuentas = null; adminCuentas(el); });
  $('#b-imp', el).onclick = () => modalImportar('cuentas', () => adminCuentas(el));
}

// ---------------------------------------------------------------------------
//  Configuración (admin): en criollo, con interruptores y campos simples.
//  Lo técnico (mapeos de Shares en JSON) queda abajo, en "Avanzado".
// ---------------------------------------------------------------------------
const DIAS_SEMANA = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mié'], ['4', 'Jue'], ['5', 'Vie'], ['6', 'Sáb'], ['0', 'Dom']];
const CFG_UI = [
  { t: 'Envío a Shares', ico: 'send', items: [
    { k: 'shares_envio_habilitado', tipo: 'switch', t: 'Enviar facturas a Shares', d: 'Apagado es el modo prueba: la app lee y controla todo, pero no carga nada en Shares.',
      si: 'Activado: “Enviar a Shares” carga los comprobantes de verdad', no: 'Apagado: modo prueba',
      confirmarSi: '¿Habilitar el envío real a Shares?\n\nDesde ahora “Enviar a Shares” carga los comprobantes en Shares.', confirmarNo: '¿Apagar el envío a Shares? Nadie va a poder cargar comprobantes hasta que lo vuelvas a prender.' },
  ] },
  { t: 'Controles de cada factura', ico: 'shield', items: [
    { k: 'arca_bloqueante', tipo: 'switch', t: 'Exigir la constatación de ARCA', d: 'Si ARCA está conectado y no se pudo constatar el comprobante, la factura queda para revisar.' },
    { k: 'ia_imputacion_requiere_ok', tipo: 'switch', t: 'Revisar las cuentas que sugiere la IA', d: 'Cuando la cuenta contable la sugiere Gemini, una persona la confirma antes de enviarla.' },
    { k: 'tolerancia_total', tipo: 'numero', t: 'Diferencia aceptada en el total', d: 'Si neto + IVA + percepciones no da el total por más que esto, la factura va a revisión.', pre: '$', step: 0.01 },
    { k: 'dias_antiguedad_aviso', tipo: 'numero', t: 'Aviso por factura vieja', d: 'Las facturas emitidas hace más días que esto muestran un aviso.', suf: 'días', step: 1 },
    { k: 'fecha_contable', tipo: 'opciones', t: 'Fecha contable en Shares', d: 'Con qué fecha se registra el comprobante.', ops: [['emision', 'Emisión'], ['recepcion', 'Recepción']] },
  ] },
  { t: 'Pagos', ico: 'coin', items: [
    { k: 'dia_pago', tipo: 'dia', t: 'Día fijo de pago', d: 'Cada propuesta nueva sugiere el próximo. Pili también lo puede cambiar desde Propuestas de pago → Ajustes.' },
    { k: 'director_whatsapp', tipo: 'tel', t: 'WhatsApp del Director', d: 'Para el botón “Avisar por WhatsApp”. Con código de país y área, sin 0 ni 15 (ej. 54 9 223 512 3456).' },
  ] },
  { t: 'Inteligencia artificial', ico: 'sparkle', items: [
    { k: 'max_cuentas_prompt', tipo: 'numero', t: 'Cuentas que se le muestran a la IA', d: 'Para sugerir la cuenta de un proveedor nuevo. Más cuentas = más opciones, pero más lento.', suf: 'cuentas', step: 10 },
  ] },
];
async function adminConfig(el) {
  const r = await api('/api/config');
  const cfg = r.config, def = r.defaults;
  const igual = (k) => JSON.stringify(cfg[k]) === JSON.stringify(def[k]);
  const guardar = async (k, valor, { silencio = false } = {}) => {
    const x = await api('/api/config', { method: 'PUT', body: { clave: k, valor } });
    Object.assign(cfg, x.config);
    if (!silencio) toast(valor === null ? 'Volvió al valor original' : 'Guardado');
    return x;
  };
  const control = (it) => {
    const v = cfg[it.k];
    if (it.tipo === 'switch') return `<label class="switch"><input type="checkbox" data-sw="${it.k}" ${v ? 'checked' : ''} aria-label="${esc(it.t)}"><span></span></label><span class="sw-txt" data-swtxt="${it.k}">${esc(v ? (it.si || 'Activado') : (it.no || 'Apagado'))}</span>`;
    if (it.tipo === 'numero') return `${it.pre ? `<span class="muted">${it.pre}</span>` : ''}<input type="number" data-num="${it.k}" value="${esc(v)}" min="0" step="${it.step || 1}" inputmode="decimal">${it.suf ? `<span class="muted">${it.suf}</span>` : ''}`;
    if (it.tipo === 'opciones') return `<div class="seg" data-op="${it.k}">${it.ops.map(([val, txt]) => `<button type="button" data-v="${val}" class="${v === val ? 'on' : ''}">${txt}</button>`).join('')}</div>`;
    if (it.tipo === 'dia') return `<div class="seg" data-op="${it.k}" data-numerico="1">${DIAS_SEMANA.map(([val, txt]) => `<button type="button" data-v="${val}" class="${String(v) === val ? 'on' : ''}">${txt}</button>`).join('')}</div>`;
    if (it.tipo === 'tel') return `<span class="muted">${ICO.phone}</span><input data-tel="${it.k}" value="${esc(v || '')}" placeholder="5492235123456" inputmode="tel" style="width:190px"><button class="btn btn-chico" data-tel-ok="${it.k}">Guardar</button>`;
    return '';
  };
  const fila = (it) => `<div class="cfg-row" data-fila="${it.k}"><div><div class="t">${esc(it.t)} ${igual(it.k) || it.tipo === 'switch' ? '' : `<button class="btn-link small" data-reset="${it.k}">volver al original</button>`}</div><div class="d">${esc(it.d)}</div></div>
    <div class="cfg-ctrl">${control(it)}</div></div>`;
  el.innerHTML = `${CFG_UI.map(sec => `<section class="cfg-sec"><h3 class="cfg-h">${ICO[sec.ico]}${esc(sec.t)}</h3><div class="panel">${sec.items.map(fila).join('')}</div></section>`).join('')}
    <p class="small muted" style="margin-top:14px">Los cambios se guardan solos y quedan en Auditoría. Los mapeos técnicos de Shares (tipos de comprobante, condición IVA y percepciones) no se tocan desde acá: se cambian con una versión nueva de la app. Para aplicarlos a facturas que ya están en revisión, usá “Revalidar todas” en Para revisar.</p>`;
  const recargar = () => adminConfig(el);

  $$('[data-sw]', el).forEach(c => c.onchange = async () => {
    const it = CFG_UI.flatMap(x => x.items).find(x => x.k === c.dataset.sw);
    const msg = c.checked ? it.confirmarSi : it.confirmarNo;
    if (msg && !await confirmar(msg)) { c.checked = !c.checked; return; }
    try { await guardar(it.k, c.checked); $(`[data-swtxt="${it.k}"]`, el).textContent = c.checked ? (it.si || 'Activado') : (it.no || 'Apagado'); }
    catch (e) { c.checked = !c.checked; toast(e.message, true); }
  });
  $$('[data-num]', el).forEach(i => i.onchange = async () => {
    try { await guardar(i.dataset.num, Number(String(i.value).replace(',', '.'))); }
    catch (e) { i.value = cfg[i.dataset.num]; toast(e.message, true); }
  });
  $$('[data-op]', el).forEach(g => $$('button', g).forEach(b => b.onclick = async () => {
    const val = g.dataset.numerico ? Number(b.dataset.v) : b.dataset.v;
    try { await guardar(g.dataset.op, val); $$('button', g).forEach(x => x.classList.toggle('on', x === b)); }
    catch (e) { toast(e.message, true); }
  }));
  $$('[data-tel-ok]', el).forEach(b => b.onclick = () => conBoton(b, async () => { const i = $(`[data-tel="${b.dataset.telOk}"]`, el); const x = await guardar(b.dataset.telOk, i.value); i.value = x.config[b.dataset.telOk] || ''; }));
  $$('[data-reset]', el).forEach(b => b.onclick = async () => await confirmar('¿Volver al valor original?') && conBoton(b, async () => { await guardar(b.dataset.reset, null); recargar(); }));
}

// ---- Pagos → Ajustes (Pili): aviso al Director, día de pago y categoría de cada cuenta ----
async function vistaAjustesPagos(el) {
  if (!puede('aprobador')) throw new Error('Necesitás rol aprobador.');
  const c = await api('/api/pagos/config');
  el.innerHTML = `<div class="encabezado"><div><div class="acciones" style="margin-bottom:6px"><a class="btn btn-ghost btn-chico" href="#/propuestas">${ICO.back}Propuestas</a></div>
      <h1>Ajustes de pagos</h1><p>A quién se avisa, qué día se paga y cómo se agrupa cada cuenta en la aprobación del Director.</p></div></div>
    <section class="cfg-sec"><h3 class="cfg-h">${ICO.chat}Aviso al Director</h3><div class="panel">
      <div class="cfg-row"><div><div class="t">WhatsApp del Director</div><div class="d">El botón “Avisar por WhatsApp” abre el chat con él y el mensaje armado (sin importes, solo el link). Con código de país y área, sin 0 ni 15.</div></div>
        <div class="cfg-ctrl"><span class="muted">${ICO.phone}</span><input id="aj-wsp" value="${esc(c.director_whatsapp || '')}" placeholder="5492235123456" inputmode="tel" style="width:190px"><button class="btn btn-chico btn-negro" id="aj-wsp-ok">Guardar</button></div></div>
      <div class="cfg-row"><div><div class="t">Aviso por mail</div><div class="d">Cuando enviás una propuesta, al Director le llega un mail con el link (sin importes). Con este botón te mandás un mail de prueba a vos para confirmar que sale.</div><div class="d" id="aj-mail-res"></div></div>
        <div class="cfg-ctrl"><button class="btn btn-chico" id="aj-mail">${ICO.send}Mandarme un mail de prueba</button></div></div>
      <div class="cfg-row"><div><div class="t">Día fijo de pago</div><div class="d">Cada propuesta nueva sugiere el próximo; si es una excepción, cambiás la fecha en la propuesta.</div></div>
        <div class="cfg-ctrl"><div class="seg" id="aj-dia">${DIAS_SEMANA.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(c.dia_pago) === v ? 'on' : ''}">${t}</button>`).join('')}</div></div></div>
    </div></section>
    <section class="cfg-sec"><h3 class="cfg-h">${ICO.chart}Gastos, Inversión o Materia prima</h3><div class="panel panel-pad" id="aj-cat"><span class="cargando"></span></div></section>`;
  $('#aj-mail').onclick = () => conBoton($('#aj-mail'), async () => {
    const r = await api('/api/pagos/probar-mail', { method: 'POST', body: {} });
    const dirs = (r.directores || []).map(d => `${esc(d.nombre)} (${esc(d.email)})`).join(', ');
    $('#aj-mail-res').innerHTML = r.ok
      ? `<span class="txt-ok">${ICO.check} Salió el mail a ${esc(r.para)}. Revisá tu bandeja (y spam).</span> Los avisos van a: <b>${dirs || 'ningún Director activo'}</b>.`
      : `<span class="txt-neg">No salió el mail: ${esc(r.error || 'error desconocido')}</span>`;
  });
  $('#aj-wsp-ok').onclick = () => conBoton($('#aj-wsp-ok'), async () => { const x = await api('/api/pagos/config', { method: 'PUT', body: { director_whatsapp: $('#aj-wsp').value } }); $('#aj-wsp').value = x.director_whatsapp || ''; toast('Guardado'); });
  $$('#aj-dia button').forEach(b => b.onclick = async () => {
    try { await api('/api/pagos/config', { method: 'PUT', body: { dia_pago: Number(b.dataset.v) } }); $$('#aj-dia button').forEach(x => x.classList.toggle('on', x === b)); toast('Guardado'); }
    catch (e) { toast(e.message, true); }
  });
  await adminCategorias($('#aj-cat'));
}

async function adminAuditoria(el) {
  const r = await api('/api/auditoria');
  el.innerHTML = `<div class="tabla-wrap" style="max-height:65vh"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Entidad</th><th>Acción</th><th>Campo</th><th>Antes → Después</th></tr></thead><tbody>
    ${r.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${a.entidad === 'factura' ? `<a href="#/factura/${esc(a.entidad_id)}">factura #${esc(a.entidad_id)}</a>` : esc([a.entidad, a.entidad_id].filter(x => x != null && x !== '').join(' ') || '—')}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(a.campo || '')}</td><td class="small mono">${esc(String(a.valor_anterior ?? '').slice(0, 80))} → ${esc(String(a.valor_nuevo ?? '').slice(0, 80))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------------------
//  Mi cuenta: contraseña y doble factor
// ---------------------------------------------------------------------------
async function vistaMiCuenta(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Mi cuenta</h1><p>${esc(S.user.email)} · rol ${esc(S.user.rol)}</p></div></div>
    ${bloqueInstalar()}
    <div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:12px">Doble factor</h2>
      ${S.user.totp_activo ? '<p><span class="badge b-ok">Activo</span> Te vamos a pedir el código de tu app autenticadora al ingresar.</p>'
      : '<p class="muted">Usá Google Authenticator, Microsoft Authenticator o similar.</p><button class="btn btn-negro" id="b-2fa">Activar doble factor</button><div id="c-2fa"></div>'}
    </div>
    <form class="panel panel-pad" style="max-width:560px" id="f-pass"><h2 style="margin-bottom:12px">Cambiar contraseña</h2>
      <div class="campo"><label>Actual</label><input type="password" name="actual" required autocomplete="current-password"></div>
      <div class="campo"><label>Nueva (mínimo 10 caracteres)</label><input type="password" name="nueva" minlength="10" required autocomplete="new-password"></div>
      <button class="btn btn-negro" type="submit">Cambiar</button></form>`;
  $('#f-pass').onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/yo/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Contraseña cambiada'); }); };
  montarInstalar(el);
  const b = $('#b-2fa');
  if (b) b.onclick = () => conBoton(b, async () => {
    const r = await api('/api/yo/totp/iniciar', { method: 'POST' });
    $('#c-2fa').innerHTML = `<p>1. Escaneá este QR con la app:</p><div id="qr" style="background:#fff;padding:12px;display:inline-block;border-radius:8px"></div>
      <p class="small muted">o cargá la clave a mano: <span class="mono">${esc(r.secret)}</span></p>
      <p>2. Escribí el código de 6 dígitos que muestra la app:</p><div class="fila"><input id="code" inputmode="numeric" maxlength="6" class="mono"><button class="btn btn-negro" id="b-conf">Confirmar</button></div>`;
    if (window.QRCode) new QRCode($('#qr'), { text: r.otpauth, width: 180, height: 180 });
    else $('#qr').textContent = r.otpauth;
    b.remove();
    $('#b-conf').onclick = () => conBoton($('#b-conf'), async () => { await api('/api/yo/totp/confirmar', { method: 'POST', body: { code: $('#code').value } }); S.user.totp_activo = true; toast('Doble factor activado'); vistaMiCuenta(el); });
  });
}

// ---------------------------------------------------------------------------
//  Gráficos simples (una sola serie, color de acento, tooltip al pasar el mouse)
// ---------------------------------------------------------------------------
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtMes = (ym, largo = false) => { const [y, m] = String(ym).split('-').map(Number); return largo ? `${MESES[m - 1]} ${y}` : `${MESES[m - 1]} ${String(y).slice(2)}`; };
function ultimosMeses(n, hasta = new Date().toISOString().slice(0, 7)) {
  const [y, m] = hasta.split('-').map(Number), out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
}
// datos: [{ et, v, sub?, act? }]
function barras(datos, { alto = 150, fmt = $$corto } = {}) {
  const max = Math.max(1, ...datos.map(x => Math.abs(x.v)));
  return `<div class="barras" style="--alto:${alto}px" role="img" aria-label="Gráfico de barras">${datos.map(x => `<div class="barra ${x.act ? 'act' : ''}" tabindex="0">
    <span class="tip"><b>${esc(fmt(x.v))}</b>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</span>
    <i style="height:${x.v ? Math.max(2, Math.round(100 * Math.abs(x.v) / max)) : 0}%"></i><span class="et">${esc(x.et)}</span></div>`).join('')}</div>`;
}
// filas: [{ t, d?, v, href?, extra? }] → ranking con barrita
function ranking(filas, { fmt = $$m, total = null, limite = 12 } = {}) {
  if (!filas.length) return '<div class="vacio">Sin datos para el período.</div>';
  const max = Math.max(1, ...filas.map(x => Math.abs(x.v)));
  const ver = filas.slice(0, limite), resto = filas.slice(limite);
  const otros = resto.reduce((a, x) => a + x.v, 0);
  const fila = (x, i) => `<li ${x.href ? `data-href="${esc(x.href)}" tabindex="0"` : ''}><span class="pos">${i + 1}</span>
    <div style="min-width:0"><div class="t">${esc(x.t)}</div>${x.d ? `<div class="d">${esc(x.d)}</div>` : ''}<div class="barrita"><i style="width:${Math.round(100 * Math.abs(x.v) / max)}%;background:var(--accent)"></i></div></div>
    <div class="r"><b>${esc(fmt(x.v))}</b>${total ? `<small>${(100 * x.v / total).toFixed(1).replace('.', ',')}%</small>` : ''}${x.extra ? `<small>${esc(x.extra)}</small>` : ''}</div></li>`;
  return `<ul class="ranking">${ver.map(fila).join('')}${resto.length ? `<li class="otros"><span class="pos">+</span><div><div class="t">Otros ${resto.length}</div></div><div class="r"><b>${esc(fmt(otros))}</b>${total ? `<small>${(100 * otros / total).toFixed(1).replace('.', ',')}%</small>` : ''}</div></li>` : ''}</ul>`;
}
function conectarRanking(el) { $$('.ranking li[data-href]', el).forEach(li => li.onclick = li.onkeydown = (e) => { if (e.type === 'keydown' && e.key !== 'Enter') return; location.hash = li.dataset.href; }); }
async function copiar(txt) { try { await navigator.clipboard.writeText(txt); toast('Copiado: ' + txt); } catch { toast('No se pudo copiar', true); } }

// ---------------------------------------------------------------------------
//  Ficha del proveedor
// ---------------------------------------------------------------------------
const COND_IVA = { 73: 'Resp. inscripto', 77: 'Monotributo', 67: 'Consumidor final', 78: 'Resp. no inscripto', 69: 'Exento', 65: 'No responsable', 84: 'No categorizado' };
async function pintarSaldoShares(cuit, fresco = false) {
  const k = $('#kp-saldo'); if (!k) return;
  try {
    const x = await api(`/api/proveedores/${cuit}/saldo${fresco ? '?fresco=1' : ''}`);
    const s0 = (x.saldos || []).filter(s => s.saldo != null);
    const tot = s0.reduce((a, s) => a + s.saldo, 0);
    const err = (x.saldos || []).find(s => s.error);
    const noExiste = (x.saldos || []).length && (x.saldos || []).every(s => s.existe === false);
    if (!$('#kp-saldo')) return;
    k.innerHTML = `<div class="et">Saldo en Shares</div><div class="val ${tot > 0.01 ? 'txt-neg' : ''}">${noExiste ? '—' : $$corto(tot)}</div>
      <div class="sub">${noExiste ? 'no está dado de alta en Shares' : err ? esc(err.error) : tot > 0.01 ? 'le debemos · cuenta corriente' : 'sin deuda'}${s0.length > 1 ? '<br>' + s0.map(s => `${esc(s.empresa)}: ${$$m(s.saldo)}`).join(' · ') : ''}
      <br><button class="btn-link" id="b-saldo-r">actualizar</button></div>`;
    $('#b-saldo-r').onclick = () => { k.querySelector('.val').innerHTML = '<span class="cargando"></span>'; pintarSaldoShares(cuit, true); };
  } catch (e) { if ($('#kp-saldo')) k.innerHTML = `<div class="et">Saldo en Shares</div><div class="val">—</div><div class="sub">${esc(e.message)}</div>`; }
}

async function vistaFicha(el, cuit) {
  await cuentas().catch(() => null);
  const x = await api('/api/proveedores/' + cuit);
  const p = x.proveedor;
  const facts = x.facturas || [];
  if (!p && !facts.length) { el.innerHTML = `<div class="panel panel-pad"><h2>No encontré el proveedor ${fmtCuit(cuit)}</h2><p class="muted">No está en el maestro ni tiene facturas.</p><a class="btn" href="#/proveedores">${ICO.back}Volver</a></div>`; return; }
  const nombre = p?.razon_social || facts[0]?.razon_social_emisor || fmtCuit(cuit);
  const porMes = Object.fromEntries((x.mensual || []).map(r => [r.mes, r]));
  const meses = ultimosMeses(12);
  const tot12 = meses.reduce((a, m) => a + (porMes[m]?.total || 0), 0);
  const n12 = meses.reduce((a, m) => a + (porMes[m]?.n || 0), 0);
  const conCompras = meses.filter(m => porMes[m]?.total).length;
  const pl = (x.plantillas || []).find(q => q.estado === 'activa');
  const sh = x.shares || [];
  const cuentasSh = {};
  sh.forEach(h => (h.items || []).filter(i => i[0] === 2 || i[0] === 3).forEach(i => { cuentasSh[i[1]] = (cuentasSh[i[1]] || 0) + 1; }));
  const ultima = facts[0];
  guardarCola(facts.map(f => f.id));
  el.innerHTML = `
    <div class="encabezado">
      <div class="ficha-prov">${cuad(nombre).replace('class="cuad"', 'class="cuad grande"')}<div><h1>${esc(nombre)}</h1>
        <p><span class="mono">${fmtCuit(cuit)}</span> · ${esc(COND_IVA[p?.condicion_iva] || 'Cond. IVA sin cargar')}${p?.codigo_shares ? ` · Cód. Shares <span class="mono">${esc(p.codigo_shares)}</span>` : ''}${p && !p.activo ? ' · <span class="badge b-aviso">inactivo</span>' : ''}</p></div></div>
      <div class="acciones"><a class="btn btn-ghost" href="#/proveedores">${ICO.back}Proveedores</a>${p && puede('aprobador') ? `<button class="btn" id="b-editar">${ICO.gear}Editar</button>` : ''}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="et">Comprado en 12 meses</div><div class="val">${$$corto(tot12)}</div><div class="sub">${n12} comprobante(s) · con IVA</div></div>
      <div class="kpi"><div class="et">Promedio mensual</div><div class="val">${$$corto(conCompras ? tot12 / conCompras : 0)}</div><div class="sub">en los ${conCompras} meses con compras</div></div>
      <div class="kpi"><div class="et">Última factura</div><div class="val">${ultima ? fmtF(ultima.fecha_emision) : '—'}</div><div class="sub">${ultima ? $$m(ultima.total) + ' · ' + esc(ESTADOS[ultima.estado] || ultima.estado) : 'sin facturas en la app'}</div></div>
      <div class="kpi"><div class="et">Lectura</div><div class="val">${pl ? 'Sola' : 'Manual'}</div><div class="sub">${pl ? `configuración v${esc(pl.version)} · ${esc(pl.usos || 0)} usos` : 'se configura al confirmar su primera factura'}</div></div>
      ${puede('aprobador') ? '<div class="kpi" id="kp-saldo"><div class="et">Saldo en Shares</div><div class="val"><span class="cargando"></span></div><div class="sub">cuenta corriente</div></div>' : ''}
    </div>
    <div class="dos">
      <div class="panel"><div class="panel-titulo"><h2>Compras por mes</h2><span class="ayuda">facturas en la app · con IVA · NC restan</span></div>
        <div class="panel-pad">${tot12 ? barras(meses.map(m => ({ et: fmtMes(m), v: porMes[m]?.total || 0, sub: `${porMes[m]?.n || 0} comprobante(s) · ${fmtMes(m, true)}`, act: m === meses[11] }))) : '<div class="vacio">Sin compras en los últimos 12 meses.</div>'}</div></div>
      <div class="panel"><div class="panel-titulo"><h2>Cómo se carga</h2></div>
        <dl class="kv panel-pad">
          <dt>Cuenta habitual</dt><dd>${p?.cuenta_default ? `${esc(p.cuenta_default)} · ${esc(nombreCuenta(p.cuenta_default))}` : '—'}</dd>
          <dt>CBU</dt><dd>${p?.cbu ? `${esc(p.cbu)} <button class="btn-link" data-copiar="${esc(p.cbu)}">copiar</button>` : '—'}</dd>
          ${p?.alias_cbu ? `<dt>Alias</dt><dd>${esc(p.alias_cbu)}</dd>` : ''}
          ${p?.dias_pago ? `<dt>Plazo de pago</dt><dd>${esc(p.dias_pago)} días</dd>` : ''}
          <dt>Reglas</dt><dd>${(x.reglas || []).length ? x.reglas.map(r => `${esc(r.codigo_concepto)}${r.palabra_clave ? ` si dice “${esc(r.palabra_clave)}”` : ' siempre'}`).join('<br>') : 'ninguna'}</dd>
          ${Object.keys(cuentasSh).length ? `<dt>En Shares usa</dt><dd>${Object.entries(cuentasSh).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${esc(c)} · ${esc(nombreCuenta(c) || '')} <span class="muted">(${n} de ${sh.length})</span>`).join('<br>')}</dd>` : ''}
          ${p?.notas ? `<dt>Notas</dt><dd style="font-family:var(--sans)">${esc(p.notas)}</dd>` : ''}
        </dl></div>
    </div>
    <div class="panel" style="margin-top:16px"><div class="panel-titulo"><h2>Facturas en la app</h2><span class="ayuda">${facts.length} ${facts.length === 100 ? '(las últimas 100)' : ''}</span></div>
      <div class="tabla-wrap"><table><thead>${encabezadoFacturas()}</thead><tbody id="tb">${filasFacturas(facts)}</tbody></table></div></div>
    ${sh.length ? `<div class="panel"><div class="panel-titulo"><h2>Últimas cargadas en Shares</h2><span class="ayuda">de la última consulta a Shares (incluye cargas a mano)</span></div>
      <div class="tabla-wrap"><table><thead><tr><th>Fecha</th><th>Comprobante</th><th>Nro. registro</th><th>Cuentas</th><th class="num">Total</th></tr></thead><tbody>
      ${sh.map(h => `<tr><td class="mono">${esc(fmtF(h.fecha))}</td><td class="mono">${h.pv != null && h.nro != null ? `${esc(h.tipo || '')} ${String(h.pv).padStart(5, '0')}-${String(h.nro).padStart(8, '0')}` : '—'}</td><td class="mono">${esc(h.nro_reg ?? '—')}</td>
        <td class="small">${[...new Set((h.items || []).filter(i => i[0] === 2 || i[0] === 3).map(i => i[1]))].map(c => `<span class="mono">${esc(c)}</span> ${esc(nombreCuenta(c) || '')}`).join('<br>') || '—'}</td><td class="num">${$$m(h.total)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  $$('#tb tr[data-id]', el).forEach(tr => tr.onclick = () => { location.hash = '#/factura/' + tr.dataset.id; });
  $$('[data-copiar]', el).forEach(b => b.onclick = () => copiar(b.dataset.copiar));
  pintarSaldoShares(cuit);
  const be = $('#b-editar');
  if (be) be.onclick = () => modalProveedor(p, false, () => router(), x);
}

// ---------------------------------------------------------------------------
//  Agenda de pagos
// ---------------------------------------------------------------------------
const isoMas = (dias) => { const d = new Date(); d.setDate(d.getDate() + dias); return d.toLocaleDateString('sv-SE'); };
function lunesDe(iso) { const d = new Date(iso + 'T12:00:00'); const dia = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dia); return d.toLocaleDateString('sv-SE'); }
async function vistaPagos(el) {
  const RANGOS = { vencidas: ['Vencidas (30 días)', -30, -1], semana: ['Esta semana', 0, 6], quince: ['Próximos 15 días', 0, 15], mes: ['Próximos 30 días', 0, 30], todo: ['−30 a +60 días', -30, 60] };
  let rango = sessionStorage.getItem('pagos_rango') || 'quince';
  let incluirCargadas = sessionStorage.getItem('pagos_cargadas') !== '0';
  let verPagadas = sessionStorage.getItem('pagos_ver_pagadas') === '1';
  el.innerHTML = `<div class="encabezado"><div><h1>Agenda de pagos</h1><p>Lo que vence, agrupado por semana, con el CBU a mano. Lo que ya está pago (en Shares o desde “Propuestas de pago”) no aparece; lo que está en una propuesta lo indica.</p></div>
    <div class="acciones">${puede('aprobador') ? `<button class="btn" id="b-sync-pagos">${ICO.refresh}Actualizar pagos desde Shares</button>` : ''}<button class="btn" id="b-csv">${ICO.doc}Exportar CSV</button></div></div>
    <p class="small muted" id="sync-info" style="margin:-6px 0 12px"></p>
    <div class="seg" id="seg">${Object.entries(RANGOS).map(([k, r]) => `<button data-r="${k}" class="${k === rango ? 'on' : ''}">${r[0]}</button>`).join('')}</div>
    <div class="kpis" id="kp"></div>
    <div class="panel"><div class="cola-bar"><label class="campo-buscar">${ICO.search}<input id="q" placeholder="Filtrar por proveedor o CUIT" aria-label="Filtrar"></label>
      <label class="check" style="margin:0"><input type="checkbox" id="chk-carg" ${incluirCargadas ? 'checked' : ''}> Incluir todas (no solo las cargadas/listas)</label>
      <label class="check" style="margin:0"><input type="checkbox" id="chk-pag" ${verPagadas ? 'checked' : ''}> Mostrar las ya pagadas</label></div>
      <div id="lista"><div class="vacio"><span class="cargando"></span></div></div></div>`;
  let datos = null;
  const pintar = () => {
    const q = $('#q').value.trim().toLowerCase();
    const hoy = datos.hoy;
    const pagadaF = (f) => f.ps_estado === 'pagada' || f.pago_estado === 'pagada';
    // Resumen de lo que dijo Shares sobre las facturas cargadas del período
    const carg = datos.facturas.filter(f => f.estado === 'cargada');
    const cnt = (e) => carg.filter(f => f.ps_estado === e).length;
    const resSh = { pagada: cnt('pagada'), parcial: cnt('parcial'), pendiente: cnt('pendiente'), sin_confirmar: cnt('sin_confirmar'), error: cnt('error') + cnt('sin_datos'), sin_consultar: carg.filter(f => !f.ps_estado).length };
    const fs = datos.facturas.filter(f => verPagadas || !pagadaF(f)).filter(f => (incluirCargadas || ['lista', 'cargada', 'error_shares'].includes(f.estado)))
      .filter(f => !q || String(f.razon_social_emisor || '').toLowerCase().includes(q) || String(f.cuit_emisor || '').includes(q.replace(/-/g, '')))
      .map(f => ({ ...f, pesos: (f.ps_estado === 'parcial' && f.ps_pendiente != null ? Number(f.ps_pendiente) : (Number(f.total) || 0) * (f.moneda && f.moneda !== 'PES' && Number(f.cotizacion) > 1 ? Number(f.cotizacion) : 1)) * (TIPOS_NC_F.includes(Number(f.tipo_cbte_arca)) ? -1 : 1) }));
    const aPagar = fs.filter(f => !pagadaF(f));
    const total = aPagar.reduce((a, f) => a + f.pesos, 0);
    const venc = aPagar.filter(f => f.fecha_vto < hoy), vencT = venc.reduce((a, f) => a + f.pesos, 0);
    const provs = new Set(fs.map(f => f.cuit_emisor)).size;
    const sinCbu = fs.filter(f => !(f.cbu_maestro || f.cbu_factura)).length;
    $('#kp').innerHTML = `<div class="kpi"><div class="et">A pagar en el período</div><div class="val">${$$corto(total)}</div><div class="sub">${fs.length} comprobante(s) · ${provs} proveedor(es)</div></div>
      <div class="kpi ${venc.length ? 'alerta' : ''}"><div class="et">Ya vencido</div><div class="val">${$$corto(vencT)}</div><div class="sub">${venc.length} comprobante(s)</div></div>
      <div class="kpi"><div class="et">Sin CBU cargado</div><div class="val">${sinCbu}</div><div class="sub">completalo en la ficha del proveedor</div></div>
      <div class="kpi"><div class="et">Según Shares (cargadas)</div><div class="val">${resSh.pagada} pagas</div><div class="sub">${resSh.parcial} en parte · ${resSh.pendiente} impagas · ${resSh.sin_confirmar} sin aprobar en Agente IA${resSh.error ? ` · <span class="txt-neg">${resSh.error} con error</span>` : ''}${resSh.sin_consultar ? ` · ${resSh.sin_consultar} sin consultar todavía` : ''}${resSh.pagada && !verPagadas ? '<br><button class="btn-link" id="b-ver-pag">ver las pagadas</button>' : ''}</div></div>`;
    const bvp = $('#b-ver-pag'); if (bvp) bvp.onclick = () => { $('#chk-pag').checked = true; $('#chk-pag').onchange({ target: $('#chk-pag') }); };
    const sem = {};
    fs.forEach(f => { const k = lunesDe(f.fecha_vto); (sem[k] = sem[k] || []).push(f); });
    const claves = Object.keys(sem).sort();
    $('#lista').innerHTML = claves.length ? claves.map(k => {
      const fin = new Date(k + 'T12:00:00'); fin.setDate(fin.getDate() + 6);
      const st = sem[k].filter(f => !pagadaF(f)).reduce((a, f) => a + f.pesos, 0);
      const esta = k === lunesDe(hoy);
      return `<div class="semana ${esta ? 'esta' : ''}"><div class="semana-t"><b>${esta ? 'Esta semana' : k < lunesDe(hoy) ? 'Semana vencida' : 'Semana'} · ${fmtF(k).slice(0, 5)} al ${fmtF(fin.toLocaleDateString('sv-SE')).slice(0, 5)}</b><span>${sem[k].length} · <b>${$$m(st)}</b></span></div>
        <div class="tabla-wrap"><table class="tabla-agenda"><colgroup><col style="width:92px"><col><col style="width:230px"><col style="width:270px"><col style="width:160px"></colgroup><tbody>${sem[k].map(f => { const cbu = f.cbu_maestro || f.cbu_factura, alias = f.alias_maestro || f.alias_factura, difCbu = f.cbu_maestro && f.cbu_factura && f.cbu_maestro !== f.cbu_factura;
          return `<tr class="click ${pagadaF(f) ? 'fila-pagada' : ''}" data-id="${f.id}"><td style="width:92px"><span class="mono ${f.fecha_vto < hoy ? 'txt-neg' : ''}">${fmtF(f.fecha_vto).slice(0, 5)}</span><small class="sub-celda">${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][new Date(f.fecha_vto + 'T12:00:00').getDay()]}</small></td>
          <td><div class="prov">${cuad(f.razon_social_emisor || '?')}<div><b>${esc(f.razon_social_emisor || 'Sin identificar')}</b><small class="mono">${esc(TIPOS[f.tipo_cbte_arca] || '')} ${nroCbte(f)}</small></div></div></td>
          <td>${badgeEstado(f.estado)}${f.pago_estado && EST_PAGO_F[f.pago_estado] ? `<br><span class="badge ${EST_PAGO_F[f.pago_estado][1]}" style="margin-top:4px">${EST_PAGO_F[f.pago_estado][0]}</span>` : ''}${f.ps_estado && ['parcial', 'pagada'].includes(f.ps_estado) ? `<br><span class="badge ${EST_PAGO_SH[f.ps_estado][1]}" style="margin-top:4px">${EST_PAGO_SH[f.ps_estado][0]}</span>${f.ps_op ? `<small class="sub-celda">${esc(f.ps_op)} · ${fmtF(f.ps_fecha)}</small>` : ''}` : ''}</td>
          <td>${cbu ? `<span class="mono">${esc(cbu)}</span> <button class="btn-link" data-copiar="${esc(cbu)}">copiar</button>${difCbu ? `<small class="sub-celda txt-neg con-ico">${ICO.alert}distinto al de la factura</small>` : alias ? `<small class="sub-celda">${esc(alias)}</small>` : ''}` : '<span class="muted">sin CBU</span>'}</td>
          <td class="num"><b>${$$m(f.pesos)}</b>${f.ps_estado === 'parcial' ? `<small class="sub-celda">falta de ${$$m(f.total)}</small>` : f.moneda && f.moneda !== 'PES' ? `<small class="sub-celda">${esc(f.moneda)} ${fmtNum.format(f.total)}</small>` : ''}</td></tr>`; }).join('')}</tbody></table></div></div>`;
    }).join('') : '<div class="vacio"><span class="grande">Nada vence en este período</span>Probá con otro rango.</div>';
    $$('#lista tr[data-id]').forEach(tr => tr.onclick = (e) => { if (e.target.closest('[data-copiar]')) return; location.hash = '#/factura/' + tr.dataset.id; });
    $$('#lista [data-copiar]').forEach(b => b.onclick = (e) => { e.stopPropagation(); copiar(b.dataset.copiar); });
    pintar.filas = fs;
  };
  const cargar = async () => {
    const r = RANGOS[rango];
    $('#lista').innerHTML = '<div class="vacio"><span class="cargando"></span></div>';
    datos = await api(`/api/pagos?desde=${isoMas(r[1])}&hasta=${isoMas(r[2])}&pagadas=1`);
    const si = $('#sync-info'); if (si) si.innerHTML = datos.shares_sync ? `Pagos leídos de Shares: lo que ya está pago no aparece, y lo pagado en parte muestra lo que falta. Última consulta: ${fmtFH(datos.shares_sync).replace(/\.$/, '')}.` : 'Todavía no se consultaron los pagos en Shares.';
    pintar();
  };
  $$('#seg button').forEach(b => b.onclick = () => { rango = b.dataset.r; sessionStorage.setItem('pagos_rango', rango); $$('#seg button').forEach(x => x.classList.toggle('on', x === b)); cargar(); });
  $('#q').oninput = () => datos && pintar();
  const bs = $('#b-sync-pagos');
  if (bs) bs.onclick = () => conBoton(bs, async () => { const x = await api('/api/pagos/sincronizar', { method: 'POST' }); toast(x.mensaje); setTimeout(() => { if ($('#b-sync-pagos')) cargar(); }, 25000); });
  $('#chk-pag').onchange = (e) => { verPagadas = e.target.checked; sessionStorage.setItem('pagos_ver_pagadas', verPagadas ? '1' : '0'); pintar(); };
  $('#chk-carg').onchange = (e) => { incluirCargadas = e.target.checked; sessionStorage.setItem('pagos_cargadas', incluirCargadas ? '1' : '0'); pintar(); };
  $('#b-csv').onclick = () => descargarCsv(`agenda_pagos_${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Vencimiento', 'CUIT', 'Proveedor', 'Comprobante', 'Estado', 'Pago', 'CBU', 'Alias', 'Moneda', 'Total original', 'Total en pesos', 'ID'],
    ...(pintar.filas || []).map(f => [f.fecha_vto, f.cuit_emisor, f.razon_social_emisor, `${TIPOS[f.tipo_cbte_arca] || ''} ${nroCbte(f)}`, ESTADOS[f.estado] || f.estado, (EST_PAGO_F[f.pago_estado] || [''])[0], f.cbu_maestro || f.cbu_factura || '', f.alias_maestro || f.alias_factura || '', f.moneda || 'PES', String(f.total ?? '').replace('.', ','), String(Math.round(f.pesos * 100) / 100).replace('.', ','), f.id]),
  ]);
  await cargar();
}
const TIPOS_NC_F = [3, 8, 13, 53, 203, 208, 213];

// ---------------------------------------------------------------------------
//  Aprobación de pagos
//  Pili arma la propuesta (facturas cargadas en Shares + NC + pagos manuales)
//  por sociedad y fecha de pago → el Director aprueba u observa cada pago →
//  se exporta lo aprobado y se marca pagado.
// ---------------------------------------------------------------------------
const CAT_PAGO = { materia_prima: ['Materia prima', 'var(--accent)'], gasto: ['Gastos', 'var(--info)'], inversion: ['Inversión', 'var(--warn)'] };
const EST_LOTE = {
  borrador: ['Borrador', 'b-aviso'], enviado: ['Esperando aprobación', 'b-warn'], aprobado: ['Aprobada', 'b-ok'],
  parcial: ['Aprobada en parte', 'b-ok'], rechazado: ['Observada', 'b-critica'], cerrado: ['Pagada', 'b-cargada'],
};
const EST_PAGO_F = { propuesta: ['En propuesta', 'b-aviso'], en_aprobacion: ['En aprobación', 'b-warn'], aprobada: ['Pago aprobado', 'b-ok'], pagada: ['Pagada', 'b-cargada'] };
const MEDIOS_PAGO = ['Transferencia', 'E-cheq', 'Cheque', 'Efectivo', 'Débito automático', 'Otro'];
const esDirector = () => S.user?.rol === 'director';
const badgeLote = (e) => `<span class="badge ${(EST_LOTE[e] || [])[1] || ''}">${esc((EST_LOTE[e] || [e])[0])}</span>`;
const dotCat = (k) => `<i class="cat-dot" style="background:${(CAT_PAGO[k] || CAT_PAGO.gasto)[1]}"></i>`;
const nomCat = (k) => (CAT_PAGO[k] || [k])[0];
const fechaLarga = (iso) => { if (!iso) return '—'; const d = new Date(iso + 'T12:00:00'); return Number.isNaN(d.getTime()) ? fmtF(iso) : d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }); };
const appUrl = () => location.href.split('#')[0];

// Próximo día fijo de pago (hoy cuenta si hoy es ese día)
function proximoDiaPago(dia = 5) {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const falta = (Number(dia) - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + falta);
  return d.toLocaleDateString('sv-SE');
}

// Barra apilada por categoría
function barraCategorias(por, total) {
  const t = Object.keys(CAT_PAGO).reduce((a, k) => a + Math.max(0, Number(por?.[k]?.total ?? por?.[k] ?? 0)), 0) || Math.abs(total) || 1;
  return `<div class="medidor cat-barra">${Object.keys(CAT_PAGO).map(k => { const v = Math.max(0, Number(por?.[k]?.total ?? por?.[k] ?? 0)); return v ? `<i style="width:${(v / t * 100).toFixed(2)}%;background:${CAT_PAGO[k][1]}" title="${esc(nomCat(k))}: ${esc($$m(v))}"></i>` : ''; }).join('')}</div>`;
}
function kpisCategorias(por, total) {
  return Object.keys(CAT_PAGO).map(k => {
    const c = por?.[k] || { total: 0, n: 0 };
    const pct = total ? Math.round(c.total / total * 100) : 0;
    return `<div class="kpi"><div class="et">${dotCat(k)}${esc(nomCat(k))}</div><div class="val">${$$corto(c.total)}</div><div class="sub">${c.n} pago(s) · ${pct}% del total</div></div>`;
  }).join('');
}
const chipsAlertas = (al) => (al || []).map(a => `<span class="badge ${a.grave ? 'b-critica' : a.tipo === 'manual' ? 'b-acc' : 'b-warn'}">${esc(a.texto)}</span>`).join(' ');

// Abre el PDF de una factura en otra pestaña (sirve en el celular)
async function abrirPdfFactura(id) {
  const w = window.open('', '_blank');
  try {
    const res = await api(`/api/facturas/${id}/pdf`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location = url; else location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { if (w) w.close(); toast(e.message, true); }
}

function linkWhatsapp(d) {
  const nro = d.config?.director_whatsapp || '';
  const txt = `Hola! Te dejé para aprobar la propuesta de pagos de ${d.lote.empresa || fmtCuit(d.lote.cuit_empresa)} para el ${fmtF(d.lote.fecha_pago)} (${d.items.length} pagos). Entrá acá: ${appUrl()}#/pago/${d.lote.id}`;
  return `https://wa.me/${nro}?text=${encodeURIComponent(txt)}`;
}
function modalAvisoEnviado(d, aviso) {
  modal(`<h2>Propuesta enviada</h2>
    <p class="muted">${aviso ? esc(aviso) : 'Le llegó un mail al Director (sin importes). Si querés apurarlo, avisale por WhatsApp: el mensaje tampoco lleva importes, solo el link.'}</p>
    <div class="acciones"><a class="btn btn-acento" target="_blank" rel="noopener" href="${esc(linkWhatsapp(d))}">${ICO.chat}Avisar por WhatsApp</a><button class="btn" id="b-cerrar-av">Listo</button></div>
    ${d.config?.director_whatsapp ? '' : '<p class="small muted" style="margin-top:12px">Tip: cargá el celular del Director en Propuestas de pago → Ajustes y el mensaje le llega directo.</p>'}`,
  { alMontar: (m, cerrar) => { $('#b-cerrar-av', m).onclick = cerrar; } });
}

// ---- Lista de propuestas (para el Director: "Aprobar pagos") ----
async function vistaPropuestas(el) {
  const dir = esDirector();
  let filtro = sessionStorage.getItem('prop_filtro') || 'activas';
  el.innerHTML = `<div class="encabezado"><div><h1>${dir ? 'Aprobar pagos' : 'Propuestas de pago'}</h1>
      <p>${dir ? 'Las propuestas que te mandaron para aprobar. Tocá una para ver el detalle por Gastos, Inversión y Materia prima.' : 'Armá la propuesta por sociedad y fecha de pago con las facturas ya cargadas en Shares, mandala al Director y, cuando vuelva aprobada, marcá lo pagado.'}</p></div>
    ${dir ? '' : `<div class="acciones"><a class="btn" href="#/pagos-ajustes">${ICO.sliders}Ajustes</a><a class="btn btn-negro" href="#/propuesta/nueva">${ICO.coin}Nueva propuesta</a></div>`}</div>
    <div class="seg" id="seg"><button data-f="activas">Activas</button><button data-f="todas">Todas</button></div>
    <div id="lista"><div class="vacio"><span class="cargando"></span></div></div>`;
  const r = await api('/api/pagos/lotes');
  const pintar = () => {
    $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.f === filtro));
    const ls = r.lotes.filter(l => filtro === 'todas' || ['borrador', 'enviado', 'aprobado', 'parcial'].includes(l.estado));
    const esperando = r.lotes.filter(l => l.estado === 'enviado');
    const aviso = dir && esperando.length ? `<div class="tarea lista-vivo" style="margin-bottom:16px"><div class="panel-titulo"><h2>${esperando.length === 1 ? 'Tenés 1 propuesta esperando' : `Tenés ${esperando.length} propuestas esperando`} tu aprobación</h2><span class="badge b-warn">${$$m(esperando.reduce((a, l) => a + (l.total || 0), 0))}</span></div></div>` : '';
    $('#lista').innerHTML = aviso + (ls.length ? `<div class="lotes">${ls.map(l => {
      const por = { gasto: l.t_gasto || 0, inversion: l.t_inversion || 0, materia_prima: l.t_materia_prima || 0 };
      return `<a class="lote-card ${l.estado === 'enviado' ? 'pend' : ''}" href="#/pago/${l.id}">
        <div class="lc-top"><div><b>${esc(l.empresa || fmtCuit(l.cuit_empresa))}</b><small>Pago del ${esc(fechaLarga(l.fecha_pago))} · #${l.id}</small></div>${badgeLote(l.estado)}</div>
        <div class="lc-monto">${$$m(l.total)}<small>${l.n} pago(s)${l.aprobado != null && ['aprobado', 'parcial', 'cerrado'].includes(l.estado) ? ` · aprobado ${$$m(l.aprobado)}` : ''}${l.por_pagar ? ` · <b>${l.por_pagar} por pagar</b>` : ''}</small></div>
        ${barraCategorias(por, l.total)}
        <div class="lc-cats">${Object.keys(CAT_PAGO).map(k => `<span>${dotCat(k)}${esc(nomCat(k))} <b>${$$corto(por[k])}</b></span>`).join('')}</div></a>`;
    }).join('')}</div>` : `<div class="panel"><div class="vacio"><span class="grande">${dir ? 'No hay nada para aprobar' : 'Todavía no hay propuestas'}</span>${dir ? 'Cuando te manden una propuesta te llega un mail.' : 'Tocá “Nueva propuesta” para armar la primera.'}</div></div>`);
  };
  $$('#seg button').forEach(b => b.onclick = () => { filtro = b.dataset.f; sessionStorage.setItem('prop_filtro', filtro); pintar(); });
  let oculto = false; try { oculto = !!localStorage.getItem('instalar_oculto'); } catch { /* sin storage */ }
  if (dir && !esStandalone() && !oculto && matchMedia('(max-width: 860px)').matches) {
    $('#seg').insertAdjacentHTML('beforebegin', `<div class="panel panel-pad aviso-instalar"><button class="ibtn cerrar" aria-label="No mostrar más">${ICO.x}</button>
      <img src="icons/icon-192.png" alt="" width="44" height="44"><div><b>Tenela a mano como app</b><div data-instalar></div></div></div>`);
    montarInstalar(el);
    $('.aviso-instalar .cerrar', el).onclick = () => { try { localStorage.setItem('instalar_oculto', '1'); } catch { /* */ } $('.aviso-instalar', el).remove(); };
  }
  pintar();
}

// ---- Armar / editar propuesta ----
async function vistaPropuestaEditar(el, id) {
  if (!puede('aprobador')) throw new Error('Necesitás rol aprobador para armar propuestas de pago.');
  id = id ? Number(id) : null;
  const [emps, lotes, previo] = await Promise.all([api('/api/empresas'), api('/api/pagos/lotes?estado=enviado'), id ? api('/api/pagos/lotes/' + id) : null]);
  if (previo && !previo.puede.editar) throw new Error('Esta propuesta ya no se puede editar (está ' + (EST_LOTE[previo.lote.estado] || [previo.lote.estado])[0].toLowerCase() + ').');
  const empresas = (emps.empresas || []).filter(e => e.activa !== 0);
  if (!empresas.length) throw new Error('No hay ninguna sociedad cargada.');
  const cfg = lotes.config || { dia_pago: 5 };
  // Estado del editor
  const st = {
    empresa: previo?.lote.cuit_empresa || (empresas.some(e => e.cuit === sessionStorage.getItem('prop_empresa')) ? sessionStorage.getItem('prop_empresa') : empresas[0].cuit),
    fecha: previo?.lote.fecha_pago || proximoDiaPago(cfg.dia_pago),
    nota: previo?.lote.nota || '',
    sel: new Map((previo?.items || []).filter(i => i.factura_id).map(i => [i.factura_id, i.categoria])), // factura_id → categoría
    manuales: (previo?.items || []).filter(i => !i.factura_id).map(i => ({ proveedor: i.proveedor, cuit_proveedor: i.cuit_proveedor || '', concepto: String(i.concepto || '').replace(/^Pago manual: /, ''), importe: i.importe, categoria: i.categoria, cbu: i.cbu || '' })),
    cand: [], primera: !previo,
  };
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  el.innerHTML = `<div class="encabezado"><div><h1>${id ? `Editar propuesta #${id}` : 'Nueva propuesta de pagos'}</h1>
      <p>Solo aparecen facturas <b>cargadas en Shares</b> de la sociedad elegida que no estén en otra propuesta. Vienen tildadas las que vencen hasta la fecha de pago (y sus notas de crédito).</p></div></div>
    <div class="panel panel-pad"><div class="prop-cab">
      <div class="campo"><label>Sociedad</label>${empresas.length === 1 ? `<div class="campo-fijo">${esc(empresas[0].razon_social)} <span class="mono muted small">${fmtCuit(empresas[0].cuit)}</span></div>` : `<select id="p-emp">${empresas.map(e => `<option value="${esc(e.cuit)}" ${e.cuit === st.empresa ? 'selected' : ''}>${esc(e.razon_social)} (${fmtCuit(e.cuit)})</option>`).join('')}</select>`}</div>
      <div class="campo"><label>Fecha de pago</label><input type="date" id="p-fecha" value="${esc(st.fecha)}"><div class="ayuda">Día fijo: ${dias[cfg.dia_pago] || '—'}. Cambiala si es una excepción.</div></div>
      <div class="campo"><label>Nota para el Director (opcional)</label><input id="p-nota" maxlength="500" value="${esc(st.nota)}" placeholder="Ej.: adelantamos Lácteos por el aumento"></div></div></div>
    <div class="panel"><div class="cola-bar"><label class="campo-buscar">${ICO.search}<input id="q" placeholder="Filtrar por proveedor, CUIT o cuenta" aria-label="Filtrar"></label>
      <span class="acciones"><button class="btn btn-chico" id="b-sug">Tildar sugeridas</button><button class="btn btn-chico" id="b-todas">Todas</button><button class="btn btn-chico btn-ghost" id="b-ning">Ninguna</button></span></div>
      <div id="cand"><div class="vacio"><span class="cargando"></span></div></div></div>
    <div class="panel"><div class="panel-titulo"><h2>Pagos sin factura en la app</h2><span class="ayuda">anticipos, impuestos, sueldos, etc. También los aprueba el Director.</span></div>
      <div id="manuales" class="panel-pad"></div></div>
    <div class="barra-acciones" id="barra"></div>`;

  const catSel = (val, attr) => `<select ${attr} class="sel-cat">${Object.entries(CAT_PAGO).map(([k, v]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>`;
  const totales = () => {
    const por = { gasto: { total: 0, n: 0 }, inversion: { total: 0, n: 0 }, materia_prima: { total: 0, n: 0 } };
    const netos = {};
    for (const c of st.cand) if (st.sel.has(c.factura_id)) {
      const k = st.sel.get(c.factura_id) || c.categoria; por[k].total += c.importe; por[k].n++;
      netos[c.cuit_proveedor] = (netos[c.cuit_proveedor] || 0) + c.importe;
    }
    for (const m of st.manuales) { const k = m.categoria || 'gasto'; por[k].total += Number(m.importe) || 0; por[k].n++; }
    const total = Object.values(por).reduce((a, c) => a + c.total, 0);
    const neg = Object.entries(netos).filter(([, v]) => v < -0.009).map(([c]) => st.cand.find(x => x.cuit_proveedor === c)?.proveedor);
    return { por, total, n: Object.values(por).reduce((a, c) => a + c.n, 0), neg };
  };
  // Los botones se pintan una sola vez: si se re-pintaran al escribir un importe, el "change" del
  // campo (que dispara al tocar el botón) los reemplazaría en medio del clic y el clic se perdería.
  $('#barra').innerHTML = `<div class="principal" id="barra-tot"></div>
    <button class="btn" id="b-guardar">Guardar borrador</button><button class="btn btn-acento" id="b-enviar">${ICO.send}Guardar y enviar al Director</button>`;
  $('#b-guardar').onclick = () => conBoton($('#b-guardar'), () => guardar(false));
  $('#b-enviar').onclick = () => conBoton($('#b-enviar'), () => guardar(true));
  const pintarBarra = () => {
    const t = totales();
    $('#barra-tot').innerHTML = `<div class="small muted">${t.n} pago(s) · ${Object.keys(CAT_PAGO).map(k => `${dotCat(k)}${esc(nomCat(k))} ${$$corto(t.por[k].total)}`).join(' · ')}</div>
        <div style="font:800 22px var(--display)">${$$m(t.total)}</div>${t.neg.length ? `<div class="small txt-neg con-ico">${ICO.alert}Las NC de ${esc(t.neg.join(', '))} superan sus facturas</div>` : ''}`;
  };
  const pintarCand = () => {
    const q = ($('#q').value || '').trim().toLowerCase();
    const grupos = new Map();
    for (const c of st.cand) {
      if (q && !`${c.proveedor} ${c.cuit_proveedor} ${c.cuenta_den || ''} ${c.cuenta || ''}`.toLowerCase().includes(q.replace(/-/g, ''))) continue;
      if (!grupos.has(c.cuit_proveedor)) grupos.set(c.cuit_proveedor, []);
      grupos.get(c.cuit_proveedor).push(c);
    }
    if (!st.cand.length) { $('#cand').innerHTML = '<div class="vacio"><span class="grande">No hay facturas para proponer</span>No hay facturas cargadas en Shares de esta sociedad que estén libres. Podés agregar pagos manuales abajo.</div>'; return; }
    $('#cand').innerHTML = `<div class="tabla-wrap"><table class="tabla-cand"><thead><tr><th style="width:32px"></th><th>Comprobante</th><th>Vence</th><th>Cuenta</th><th>Categoría</th><th class="num">Importe</th></tr></thead><tbody>
      ${[...grupos.entries()].map(([cuit, fs]) => {
        const f0 = fs[0];
        const selN = fs.filter(f => st.sel.has(f.factura_id));
        const sub = selN.reduce((a, f) => a + f.importe, 0);
        const todas = selN.length === fs.length;
        return `<tr class="grupo-prov"><td><input type="checkbox" data-prov="${esc(cuit)}" ${todas ? 'checked' : ''} ${selN.length && !todas ? 'data-mixto="1"' : ''} aria-label="Tildar todo el proveedor"></td>
          <td colspan="3"><div class="prov">${cuad(f0.proveedor)}<div><b>${esc(f0.proveedor)}</b><small class="mono">${fmtCuit(cuit)} · ${f0.cbu ? esc(f0.cbu) : 'sin CBU'}${f0.alias ? ' · ' + esc(f0.alias) : ''}</small></div></div>${f0.alertas?.length ? `<div class="chips" style="margin-top:6px">${chipsAlertas(f0.alertas)}</div>` : ''}</td>
          <td class="small muted">${selN.length}/${fs.length}</td><td class="num"><b>${selN.length ? $$m(sub) : '—'}</b></td></tr>
          ${fs.map(f => `<tr class="${st.sel.has(f.factura_id) ? '' : 'apagada'}"><td><input type="checkbox" data-fid="${f.factura_id}" ${st.sel.has(f.factura_id) ? 'checked' : ''} aria-label="Incluir"></td>
            <td><a href="#/factura/${f.factura_id}" target="_blank" class="mono">${esc(f.comprobante)}</a>${f.es_nc ? ' <span class="badge b-acc">NC</span>' : ''}<small class="sub-celda">Emitida ${fmtF(f.fecha_emision)}${f.shares_ref ? ' · Shares ' + esc(f.shares_ref) : ''}</small></td>
            <td class="mono ${f.vencida ? 'txt-neg' : ''}">${fmtF(f.fecha_vto)}</td>
            <td class="small">${f.cuenta ? `<span class="mono">${esc(f.cuenta)}</span> ${esc(f.cuenta_den || '')}` : '<span class="muted">sin cuenta</span>'}</td>
            <td>${catSel(st.sel.get(f.factura_id) || f.categoria, `data-cat="${f.factura_id}"`)}</td>
            <td class="num"><b class="${f.importe < 0 ? 'txt-neg' : ''}">${$$m(f.importe)}</b>${f.moneda !== 'PES' ? `<small class="sub-celda">${esc(f.moneda)} ${fmtNum.format(f.importe_original)} × ${fmtNum.format(f.cotizacion)}</small>` : ''}</td></tr>`).join('')}`;
      }).join('') || '<tr><td colspan="6" class="muted">Nada coincide con el filtro.</td></tr>'}</tbody></table></div>`;
    $$('[data-mixto]', $('#cand')).forEach(c => { c.indeterminate = true; });
    $$('[data-fid]', $('#cand')).forEach(c => c.onchange = () => {
      const f = st.cand.find(x => x.factura_id === Number(c.dataset.fid));
      if (c.checked) st.sel.set(f.factura_id, $(`[data-cat="${f.factura_id}"]`).value); else st.sel.delete(f.factura_id);
      pintarCand(); pintarBarra();
    });
    $$('[data-prov]', $('#cand')).forEach(c => c.onchange = () => {
      for (const f of st.cand.filter(x => x.cuit_proveedor === c.dataset.prov)) { if (c.checked) st.sel.set(f.factura_id, st.sel.get(f.factura_id) || f.categoria); else st.sel.delete(f.factura_id); }
      pintarCand(); pintarBarra();
    });
    $$('[data-cat]', $('#cand')).forEach(s => s.onchange = () => {
      const fid = Number(s.dataset.cat); const f = st.cand.find(x => x.factura_id === fid); f.categoria = s.value;
      if (st.sel.has(fid)) st.sel.set(fid, s.value);
      pintarBarra();
    });
  };
  const pintarManuales = () => {
    $('#manuales').innerHTML = (st.manuales.length ? `<div class="tabla-wrap"><table><thead><tr><th>Proveedor / beneficiario</th><th>CUIT</th><th>Motivo</th><th>Categoría</th><th>CBU</th><th class="num">Importe $</th><th></th></tr></thead><tbody>
      ${st.manuales.map((m, i) => `<tr><td><input data-m="${i}" data-k="proveedor" value="${esc(m.proveedor)}" placeholder="Ej.: ARCA"></td>
        <td><input data-m="${i}" data-k="cuit_proveedor" class="mono" value="${esc(m.cuit_proveedor)}" placeholder="opcional" style="width:130px"></td>
        <td><input data-m="${i}" data-k="concepto" value="${esc(m.concepto)}" placeholder="Ej.: Plan de pagos cuota 3"></td>
        <td>${catSel(m.categoria || 'gasto', `data-m="${i}" data-k="categoria"`)}</td>
        <td><input data-m="${i}" data-k="cbu" class="mono" value="${esc(m.cbu)}" placeholder="opcional" style="width:200px"></td>
        <td><input data-m="${i}" data-k="importe" type="number" step="0.01" min="0" class="num" value="${esc(m.importe ?? '')}" style="width:130px"></td>
        <td><button class="btn btn-chico btn-rojo" data-mdel="${i}" aria-label="Quitar">${ICO.x}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small" style="margin:0 0 10px">No hay pagos manuales.</p>')
      + '<button class="btn btn-chico" id="b-addm">+ Agregar pago manual</button>';
    $$('[data-m]', $('#manuales')).forEach(inp => inp.oninput = inp.onchange = () => { const m = st.manuales[inp.dataset.m]; m[inp.dataset.k] = inp.dataset.k === 'importe' ? Number(inp.value) || 0 : inp.value; pintarBarra(); });
    $$('[data-mdel]', $('#manuales')).forEach(b => b.onclick = () => { st.manuales.splice(Number(b.dataset.mdel), 1); pintarManuales(); pintarBarra(); });
    $('#b-addm').onclick = () => { st.manuales.push({ proveedor: '', cuit_proveedor: '', concepto: '', importe: '', categoria: 'gasto', cbu: '' }); pintarManuales(); $(`[data-m="${st.manuales.length - 1}"][data-k="proveedor"]`)?.focus(); };
  };
  const cargarCand = async () => {
    $('#cand').innerHTML = '<div class="vacio"><span class="cargando"></span></div>';
    const r = await api(`/api/pagos/candidatas?empresa=${encodeURIComponent(st.empresa)}&fecha=${encodeURIComponent(st.fecha)}${id ? '&lote=' + id : ''}`);
    st.cand = r.candidatas;
    const ids = new Set(st.cand.map(c => c.factura_id));
    for (const fid of [...st.sel.keys()]) if (!ids.has(fid)) st.sel.delete(fid);   // cambió la sociedad o ya no está libre
    if (st.primera) { for (const c of st.cand) if (c.sugerida) st.sel.set(c.factura_id, c.categoria); st.primera = false; }
    pintarCand(); pintarBarra();
  };
  const guardar = async (enviar) => {
    const t = totales();
    if (!t.n) throw new Error('La propuesta está vacía.');
    if (t.neg.length) throw new Error(`Las notas de crédito de ${t.neg.join(', ')} superan sus facturas: tildá las facturas o sacá la NC.`);
    const body = { cuit_empresa: st.empresa, fecha_pago: st.fecha, nota: $('#p-nota').value.trim(),
      facturas: [...st.sel.entries()].map(([factura_id, categoria]) => ({ factura_id, categoria })),
      manuales: st.manuales.filter(m => m.proveedor || m.concepto || m.importe) };
    if (enviar && !await confirmar(`¿Enviar al Director ${t.n} pago(s) por ${$$m(t.total)}?\n\nDespués de enviarla no se puede editar (la podés retirar mientras no la resuelva).`)) return;
    const d = await api(id ? '/api/pagos/lotes/' + id : '/api/pagos/lotes', { method: id ? 'PUT' : 'POST', body });
    sessionStorage.setItem('prop_empresa', st.empresa);
    if (!enviar) { toast('Borrador guardado'); location.hash = '#/pago/' + d.lote.id; return; }
    const e = await api(`/api/pagos/lotes/${d.lote.id}/enviar`, { method: 'POST', body: { app_url: appUrl() } });
    location.hash = '#/pago/' + d.lote.id;
    setTimeout(() => modalAvisoEnviado(e, e.aviso), 300);
  };
  if ($('#p-emp')) $('#p-emp').onchange = (e) => { st.empresa = e.target.value; st.sel.clear(); st.primera = true; cargarCand().catch(err => toast(err.message, true)); };
  $('#p-fecha').onchange = (e) => { if (!e.target.value) return; st.fecha = e.target.value; cargarCand().catch(err => toast(err.message, true)); };
  $('#q').oninput = pintarCand;
  $('#b-sug').onclick = () => { st.sel.clear(); for (const c of st.cand) if (c.sugerida) st.sel.set(c.factura_id, c.categoria); pintarCand(); pintarBarra(); };
  $('#b-todas').onclick = () => { for (const c of st.cand) if (!st.sel.has(c.factura_id)) st.sel.set(c.factura_id, c.categoria); pintarCand(); pintarBarra(); };
  $('#b-ning').onclick = () => { st.sel.clear(); pintarCand(); pintarBarra(); };
  pintarManuales();
  await cargarCand();
}

// ---- Detalle de una propuesta (y aprobación del Director) ----
async function vistaLote(el, id) {
  const d = await api('/api/pagos/lotes/' + id);
  const L = d.lote, R = d.resumen;
  const aprobando = d.puede.resolver;
  const porCat = {};
  for (const it of d.items) (porCat[it.categoria] = porCat[it.categoria] || []).push(it);
  const quien = (e) => esc(String(e || '').split('@')[0]);
  const historialTxt = { crear_propuesta: 'armó la propuesta', editar_propuesta: 'la editó', enviar_a_aprobar: 'la envió al Director', retirar_propuesta: 'la retiró para editarla', resolver: 'la resolvió', marcar_pagado: 'marcó pagos', borrar_propuesta: 'la borró' };

  // Estado de la aprobación (solo Director)
  const ap = { sel: new Set(d.items.map(i => i.id)), coment: {}, general: '' };
  const nombreCats = Object.keys(CAT_PAGO).filter(k => porCat[k]).concat(Object.keys(porCat).filter(k => !CAT_PAGO[k]));

  const filaItem = (it) => {
    const sel = ap.sel.has(it.id);
    const decision = it.decision ? `<span class="badge ${it.decision === 'aprobado' ? 'b-ok' : 'b-critica'}">${it.decision === 'aprobado' ? 'Aprobado' : 'Observado'}</span>` : '';
    const pagado = it.pagado_at ? `<span class="badge b-cargada">Pagado ${fmtF(it.pagado_at)}</span><small class="sub-celda">${esc(it.pago_medio || '')}${it.pago_ref ? ' · ' + esc(it.pago_ref) : ''}</small>` : '';
    const puedePagar = d.puede.pagar && it.decision === 'aprobado' && !it.pagado_at;
    return `<div class="ip ${aprobando && !sel ? 'apagada' : ''} ${it.alertas?.some(a => a.grave) ? 'grave' : ''}" data-item="${it.id}">
      ${aprobando ? `<input type="checkbox" data-ap="${it.id}" ${sel ? 'checked' : ''} aria-label="Aprobar">` : puedePagar ? `<input type="checkbox" data-pg="${it.id}" aria-label="Marcar pagado">` : '<span></span>'}
      <div class="ip-info"><b>${esc(it.proveedor)}</b>
        <small>${esc(it.concepto || '')}${it.fecha_vto ? ` · vence ${fmtF(it.fecha_vto)}` : ''}${it.cbu ? ` · <span class="mono">${esc(it.cbu)}</span>` : ''}</small>
        ${it.alertas?.length ? `<div class="chips">${chipsAlertas(it.alertas)}</div>` : ''}
        ${it.comentario ? `<div class="small con-ico" style="margin-top:4px">${ICO.chat}${esc(it.comentario)}</div>` : ''}
        ${aprobando ? `<input class="ip-coment" data-com="${it.id}" placeholder="${sel ? 'Comentario (opcional)' : 'Por qué no lo aprobás (obligatorio)'}" value="${esc(ap.coment[it.id] || '')}" ${sel ? 'hidden' : ''}>` : ''}
        <div class="chips" style="margin-top:4px">${decision}${pagado}${it.factura_id ? `<button class="btn-link small" data-pdf="${it.factura_id}">Ver factura</button>` : ''}</div></div>
      <div class="ip-monto ${it.importe < 0 ? 'txt-neg' : ''}">${$$m(it.importe)}${it.moneda && it.moneda !== 'PES' ? `<small>${esc(it.moneda)} ${fmtNum.format(it.importe_original)}</small>` : ''}</div></div>`;
  };
  const seccion = (k) => {
    const its = porCat[k];
    const tot = its.reduce((a, i) => a + i.importe, 0);
    const selT = its.filter(i => ap.sel.has(i.id)).reduce((a, i) => a + i.importe, 0);
    return `<section class="panel cat-sec"><div class="panel-titulo"><h2>${aprobando ? `<input type="checkbox" data-apcat="${k}" ${its.every(i => ap.sel.has(i.id)) ? 'checked' : ''} aria-label="Aprobar toda la categoría"> ` : ''}${dotCat(k)}${esc(nomCat(k))} <span class="muted small">${its.length}</span></h2>
      <b>${aprobando && selT !== tot ? `<span class="muted small">${$$m(selT)} de </span>` : ''}${$$m(tot)}</b></div>
      <div class="ips">${its.map(filaItem).join('')}</div></section>`;
  };
  const totalSel = () => d.items.filter(i => ap.sel.has(i.id)).reduce((a, i) => a + i.importe, 0);

  const acciones = [];
  if (d.puede.editar) acciones.push(`<a class="btn" href="#/propuesta/${L.id}/editar">Editar</a>`);
  if (d.puede.enviar) acciones.push(`<button class="btn btn-acento" id="b-env">${ICO.send}Enviar al Director</button>`);
  if (d.puede.retirar) acciones.push(`<a class="btn" target="_blank" rel="noopener" href="${esc(linkWhatsapp(d))}">${ICO.chat}Avisar por WhatsApp</a><button class="btn" id="b-ret">Retirar para editar</button>`);
  if (d.puede.editar) acciones.push(`<button class="btn btn-rojo" id="b-del">Borrar</button>`);
  if (!esDirector() && R.aprobado) acciones.push(`<button class="btn" id="b-csv">${ICO.doc}Exportar aprobados</button>`);

  el.innerHTML = `<div class="encabezado"><div><div class="acciones" style="margin-bottom:6px"><a class="btn btn-ghost btn-chico" href="#/propuestas">${ICO.back}${esDirector() ? 'Aprobar pagos' : 'Propuestas'}</a></div>
      <h1>${esc(L.empresa || fmtCuit(L.cuit_empresa))} · ${esc(fechaLarga(L.fecha_pago))}</h1>
      <p>${badgeLote(L.estado)} &nbsp;Propuesta #${L.id} · armada por ${quien(L.creado_por)}${L.enviado_at ? ` · enviada ${fmtFH(L.enviado_at)}` : ''}${L.resuelto_at ? ` · resuelta por ${L.resuelto_nombre ? esc(L.resuelto_nombre) : quien(L.resuelto_por)} ${fmtFH(L.resuelto_at)}` : ''}</p></div>
      ${acciones.length ? `<div class="acciones">${acciones.join('')}</div>` : ''}</div>
    ${L.nota ? `<div class="panel panel-pad" style="margin-bottom:16px"><b>Nota:</b> ${esc(L.nota)}</div>` : ''}
    ${L.comentario_director ? `<div class="panel panel-pad" style="margin-bottom:16px"><b>Comentario del Director:</b> ${esc(L.comentario_director)}</div>` : ''}
    <div class="kpis"><div class="kpi"><div class="et">Total propuesto</div><div class="val">${$$corto(R.total)}</div><div class="sub">${R.items} pago(s)${R.alertas_graves ? ` · <b class="txt-neg">${R.alertas_graves} con alerta</b>` : ''}</div>${barraCategorias(R.por_categoria, R.total)}</div>
      ${kpisCategorias(R.por_categoria, R.total)}</div>
    ${['aprobado', 'parcial', 'cerrado', 'rechazado'].includes(L.estado) ? `<div class="kpis"><div class="kpi ok"><div class="et">Aprobado</div><div class="val">${$$corto(R.aprobado)}</div></div><div class="kpi ${R.observado ? 'alerta' : ''}"><div class="et">Observado</div><div class="val">${$$corto(R.observado)}</div></div><div class="kpi"><div class="et">Pagado</div><div class="val">${$$corto(R.pagado)}</div><div class="sub">${R.aprobado - R.pagado > 0.009 ? `falta ${$$m(R.aprobado - R.pagado)}` : 'completo'}</div></div></div>` : ''}
    ${aprobando ? '<p class="muted">Tildá lo que aprobás. Lo que destildes queda <b>observado</b> y vuelve a Pili con tu comentario (es obligatorio). </p>' : ''}
    <div id="secs">${nombreCats.map(seccion).join('')}</div>
    ${aprobando ? `<div class="barra-acciones" id="barra-ap"></div>` : ''}
    ${d.puede.pagar && d.items.some(i => i.decision === 'aprobado' && !i.pagado_at) ? `<div class="barra-acciones"><div class="principal small muted">Tildá los pagos que ya hiciste y marcálos como pagados.</div><button class="btn btn-chico" id="b-pg-todos">Tildar todos</button><button class="btn btn-negro" id="b-pagar">${ICO.check}Marcar pagados</button></div>` : ''}
    ${firmaDirector(L, d, R)}
    <div class="panel" style="margin-top:16px"><div class="panel-titulo"><h2>Historial</h2></div><div class="panel-pad"><ul class="hist">${d.historial.map(h => `<li><span class="small mono muted">${fmtFH(h.ts)}</span> <b>${quien(h.usuario)}</b> ${esc(historialTxt[h.accion] || h.accion)}${h.accion === 'resolver' && h.valor_nuevo ? (() => { const v = safeParse(h.valor_nuevo); return v ? ` · ${v.aprobados} de ${v.de} aprobados (${$$m(v.total_aprobado)})` : ''; })() : ''}</li>`).join('') || '<li class="muted">Sin movimientos.</li>'}</ul></div></div>`;

  // PDFs
  $$('[data-pdf]', el).forEach(b => b.onclick = () => abrirPdfFactura(b.dataset.pdf));

  // Aprobación
  const pintarBarraAp = () => {
    const n = ap.sel.size, tot = totalSel();
    if (!$('#b-resolver')) {
      $('#barra-ap').innerHTML = `<div class="principal"><div id="ap-tot"></div><input id="ap-gral" placeholder="Comentario general (opcional)" style="margin-top:6px"></div><button class="btn btn-grande" id="b-resolver"></button>`;
      $('#ap-gral').oninput = (e) => { ap.general = e.target.value; };
      $('#b-resolver').onclick = () => resolver();
    }
    $('#ap-tot').innerHTML = `<div class="small muted">Aprobás ${n} de ${d.items.length} pago(s)</div><div style="font:800 22px var(--display)">${$$m(tot)} <span class="small muted" style="font-weight:500">de ${$$m(R.total)}</span></div>`;
    const br = $('#b-resolver');
    br.className = `btn ${n ? 'btn-acento' : 'btn-rojo'} btn-grande`;
    br.innerHTML = n ? `${ICO.check}${n === d.items.length ? 'Aprobar todo' : 'Aprobar seleccionados'}` : 'Observar todo';
  };
  const resolver = () => conBoton($('#b-resolver'), async () => {
      const sinCom = d.items.filter(i => !ap.sel.has(i.id) && !String(ap.coment[i.id] || ap.general || '').trim());
      if (sinCom.length) { const c = $(`[data-com="${sinCom[0].id}"]`); c?.focus(); c?.scrollIntoView({ block: 'center' }); throw new Error(`Escribí por qué no aprobás el pago a ${sinCom[0].proveedor}.`); }
      const graves = d.items.filter(i => ap.sel.has(i.id) && i.alertas?.some(a => a.grave));
      const msg = `¿Confirmás?\n\nAprobás ${ap.sel.size} pago(s) por ${$$m(totalSel())}${ap.sel.size < d.items.length ? ` y observás ${d.items.length - ap.sel.size}` : ''}.` + (graves.length ? `\n\nAtención: ${graves.length} de los aprobados tienen alerta de CBU.` : '');
      if (!await confirmar(msg)) return;
      const r = await api(`/api/pagos/lotes/${L.id}/resolver`, { method: 'POST', body: { aprobados: [...ap.sel], comentarios: ap.coment, comentario: ap.general.trim(), app_url: appUrl() } });
      toast(r.aviso || 'Listo, quedó resuelta. Le avisamos por mail.', !!r.aviso);
      router();
    });
  const conectarAp = () => {
    $$('[data-ap]', el).forEach(c => c.onchange = () => {
      const iid = Number(c.dataset.ap);
      if (c.checked) ap.sel.add(iid); else ap.sel.delete(iid);
      repintarAp(iid);
    });
    $$('[data-apcat]', el).forEach(c => c.onchange = () => { for (const it of porCat[c.dataset.apcat]) c.checked ? ap.sel.add(it.id) : ap.sel.delete(it.id); repintarAp(); });
    $$('[data-com]', el).forEach(i => i.oninput = () => { ap.coment[i.dataset.com] = i.value; });
  };
  const repintarAp = (foco) => {
    $('#secs').innerHTML = nombreCats.map(seccion).join('');
    $$('[data-pdf]', el).forEach(b => b.onclick = () => abrirPdfFactura(b.dataset.pdf));
    conectarAp(); pintarBarraAp();
    if (foco && !ap.sel.has(foco)) $(`[data-com="${foco}"]`)?.focus();
  };
  if (aprobando) { conectarAp(); pintarBarraAp(); }

  // Acciones de Pili
  const b = (sel, fn) => { const x = $(sel, el); if (x) x.onclick = () => conBoton(x, fn); };
  b('#b-env', async () => {
    if (!await confirmar(`¿Enviar al Director ${R.items} pago(s) por ${$$m(R.total)}?`)) return;
    const e = await api(`/api/pagos/lotes/${L.id}/enviar`, { method: 'POST', body: { app_url: appUrl() } });
    await router(); modalAvisoEnviado(e, e.aviso);
  });
  b('#b-ret', async () => { if (!await confirmar('¿Retirar la propuesta? Vuelve a borrador y el Director deja de verla hasta que la reenvíes.')) return; await api(`/api/pagos/lotes/${L.id}/retirar`, { method: 'POST' }); toast('Propuesta retirada'); location.hash = `#/propuesta/${L.id}/editar`; });
  b('#b-del', async () => { if (!await confirmar('¿Borrar este borrador?')) return; await api(`/api/pagos/lotes/${L.id}`, { method: 'DELETE' }); toast('Borrador eliminado'); location.hash = '#/propuestas'; });
  const csv = $('#b-csv', el);
  if (csv) csv.onclick = () => descargarCsv(`pagos_aprobados_${L.id}_${L.fecha_pago}.csv`, [
    ['Propuesta', 'Sociedad', 'Fecha de pago', 'Categoría', 'CUIT', 'Proveedor', 'Concepto', 'Vencimiento', 'CBU', 'Alias', 'Importe $', 'Moneda', 'Importe original', 'Estado', 'Pagado', 'Medio', 'Referencia', 'Factura ID'],
    ...d.items.filter(i => i.decision === 'aprobado').map(i => [L.id, L.empresa || L.cuit_empresa, L.fecha_pago, nomCat(i.categoria), i.cuit_proveedor || '', i.proveedor, i.concepto || '', i.fecha_vto || '', i.cbu || '', i.alias || '',
      String(i.importe).replace('.', ','), i.moneda || 'PES', String(i.importe_original ?? '').replace('.', ','), i.pagado_at ? 'Pagado' : 'Por pagar', i.pagado_at || '', i.pago_medio || '', i.pago_ref || '', i.factura_id || '']),
  ]);
  const pt = $('#b-pg-todos', el);
  if (pt) pt.onclick = () => $$('[data-pg]', el).forEach(c => { c.checked = true; });
  const pg = $('#b-pagar', el);
  if (pg) pg.onclick = () => {
    const ids = $$('[data-pg]:checked', el).map(c => Number(c.dataset.pg));
    if (!ids.length) return toast('Tildá los pagos que ya hiciste.', true);
    const tot = d.items.filter(i => ids.includes(i.id)).reduce((a, i) => a + i.importe, 0);
    modal(`<h2>Marcar ${ids.length} pago(s) como pagados</h2><p class="muted">Total ${$$m(tot)}</p><form id="f-pg">
      <div class="fila"><div class="campo"><label>Fecha</label><input type="date" name="fecha" value="${new Date().toLocaleDateString('sv-SE')}" required></div>
      <div class="campo"><label>Medio</label><select name="medio">${MEDIOS_PAGO.map(m => `<option>${m}</option>`).join('')}</select></div></div>
      <div class="campo"><label>Referencia (opcional)</label><input name="referencia" placeholder="Nº de OP, transferencia o cheque"></div>
      <button class="btn btn-negro" type="submit">${ICO.check}Confirmar</button></form>`, {
      alMontar: (m, cerrar) => { $('#f-pg', m).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api(`/api/pagos/lotes/${L.id}/pagar`, { method: 'POST', body: { ...Object.fromEntries(new FormData(e.target)), items: ids } }); cerrar(); toast('Pagos registrados'); router(); }); }; },
    });
  };
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---- Guía para el Director ----
function guiaDirector(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Cómo aprobar pagos</h1><p>Tres pasos, desde el celular o la compu.</p></div></div>
    <div class="panel panel-pad guia-txt">
      <p><b>1. Te llega un aviso</b> (mail o WhatsApp) sin importes, solo con el link. Por seguridad, los pagos se aprueban únicamente dentro de la app.</p>
      <p><b>2. Abrí la propuesta.</b> Arriba ves el total y cuánto es <b>Gastos</b>, <b>Inversión</b> y <b>Materia prima</b>. Abajo, cada pago agrupado por categoría, con su vencimiento y su factura (tocá “Ver factura”).</p>
      <p><b>3. Tildá lo que aprobás</b> y tocá “Aprobar seleccionados”. Lo que destildes queda observado: escribí por qué y le vuelve a Pili. Lo observado se puede volver a proponer más adelante.</p>
      <p class="muted">Una vez aprobada, Pili hace los pagos y los marca como pagados; lo ves en la misma propuesta.</p>
      <p class="muted">Solo ves las propuestas que te enviaron y las facturas que están en ellas.</p></div>
    <div style="margin-top:16px">${bloqueInstalar()}</div>`;
  montarInstalar(el);
}

// ---- Admin: categoría de pago por cuenta ----
async function adminCategorias(el) {
  const r = await api('/api/pagos/cuentas');
  let q = '';
  el.innerHTML = `<p class="muted">Cada cuenta del plan define si el pago es <b>Gastos</b>, <b>Inversión</b> o <b>Materia prima</b> en la aprobación del Director. Si no la elegís, se sugiere por el nombre de la cuenta (ej. “Rodados” → Inversión, “Materias primas” → Materia prima). En cada propuesta se puede cambiar factura por factura.</p>
    <div class="acciones" style="margin-bottom:12px"><input id="qc" placeholder="Filtrar cuentas…" style="max-width:260px">
      <select id="bulk-cat" style="max-width:200px"><option value="">Automática</option>${Object.entries(CAT_PAGO).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>
      <button class="btn btn-negro" id="b-bulk">Aplicar a las filtradas</button></div>
    <div class="tabla-wrap" style="max-height:60vh"><table><thead><tr><th>Código</th><th>Denominación</th><th>Categoría de pago</th></tr></thead><tbody id="tbcat"></tbody></table></div>`;
  const pintar = () => {
    const fs = r.cuentas.filter(c => !q || `${c.codigo_concepto} ${c.denominacion}`.toLowerCase().includes(q));
    $('#tbcat', el).innerHTML = fs.map(c => `<tr><td class="mono">${c.codigo_concepto}</td><td>${esc(c.denominacion)}${c.usable_gasto ? '' : ' <span class="muted small">(no usable)</span>'}</td>
      <td><select data-ccat="${c.codigo_concepto}" style="max-width:240px"><option value="" ${c.categoria ? '' : 'selected'}>Automática (${esc(nomCat(c.sugerida))})</option>${Object.entries(CAT_PAGO).map(([k, v]) => `<option value="${k}" ${c.categoria === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin cuentas.</td></tr>';
    $$('[data-ccat]', el).forEach(s => s.onchange = () => api('/api/pagos/cuentas', { method: 'PUT', body: { codigos: [Number(s.dataset.ccat)], categoria: s.value || null } })
      .then(() => { const c = r.cuentas.find(x => String(x.codigo_concepto) === s.dataset.ccat); c.categoria = s.value || null; toast('Guardado'); }).catch(e => toast(e.message, true)));
    pintar.filtradas = fs;
  };
  $('#qc', el).oninput = (e) => { q = e.target.value.trim().toLowerCase(); pintar(); };
  $('#b-bulk', el).onclick = async () => {
    const fs = pintar.filtradas || [];
    const cat = $('#bulk-cat', el).value;
    if (!fs.length) return toast('No hay cuentas filtradas.', true);
    if (!await confirmar(`¿Poner ${fs.length} cuenta(s) en “${cat ? nomCat(cat) : 'Automática'}”?`)) return;
    conBoton($('#b-bulk', el), async () => { await api('/api/pagos/cuentas', { method: 'PUT', body: { codigos: fs.map(c => c.codigo_concepto), categoria: cat || null } }); fs.forEach(c => { c.categoria = cat || null; }); pintar(); toast('Listo'); });
  };
  pintar();
}

// ---------------------------------------------------------------------------
//  Análisis de compras
// ---------------------------------------------------------------------------
async function vistaAnalisis(el) {
  const mesHoy = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  let desde = sessionStorage.getItem('an_desde') || mesHoy, hasta = sessionStorage.getItem('an_hasta') || mesHoy;
  let vista = sessionStorage.getItem('an_vista') || 'cuenta', soloOk = sessionStorage.getItem('an_solo') === 'ok', medida = sessionStorage.getItem('an_medida') || 'neto';
  el.innerHTML = `<div class="encabezado"><div><h1>Análisis de compras</h1><p>Lo comprado según las facturas que entraron a la app, en pesos. Las notas de crédito restan.</p></div>
    <div class="acciones"><button class="btn" id="b-csv">${ICO.doc}Exportar CSV</button></div></div>
    <div class="panel"><div class="filtros">
      <div class="campo"><label for="an-d">Desde</label><input type="month" id="an-d" value="${desde}"></div>
      <div class="campo"><label for="an-h">Hasta</label><input type="month" id="an-h" value="${hasta}"></div>
      <div class="campo"><label for="an-m">Importe</label><select id="an-m"><option value="neto" ${medida === 'neto' ? 'selected' : ''}>Neto (sin IVA ni percepciones)</option><option value="total" ${medida === 'total' ? 'selected' : ''}>Total con IVA</option></select></div>
      <div class="campo"><label for="an-s">Facturas</label><select id="an-s"><option value="">Todas menos rechazadas</option><option value="ok" ${soloOk ? 'selected' : ''}>Solo listas o cargadas</option></select></div>
      <div class="campo"><label>&nbsp;</label><div class="acciones"><button class="btn btn-chico" data-p="mes">Este mes</button><button class="btn btn-chico" data-p="ant">Mes pasado</button><button class="btn btn-chico" data-p="3m">Últimos 3</button><button class="btn btn-chico" data-p="anio">Este año</button></div></div>
    </div></div>
    <div id="an-cuerpo" style="margin-top:16px"><div class="vacio"><span class="cargando"></span></div></div>`;
  let datos = null;
  const pintar = () => {
    const filas = datos.filas.filter(f => f.mes >= desde && f.mes <= hasta);
    const ant = datos.filas.filter(f => f.mes === datos.mes_anterior);
    const v = (f) => f[medida];
    const tot = filas.reduce((a, f) => a + v(f), 0), totAnt = ant.reduce((a, f) => a + v(f), 0);
    const nMeses = ultimosMeses(24, hasta).filter(m => m >= desde).length || 1;
    const sinCuenta = filas.filter(f => !f.cuenta), sinCuentaT = sinCuenta.reduce((a, f) => a + v(f), 0);
    const agrupar = (key, et, d, href) => {
      const g = new Map();
      filas.forEach(f => { const k = key(f); const x = g.get(k) || { t: et(f), d: d(f), v: 0, n: 0, href: href(f) }; x.v += v(f); x.n++; g.set(k, x); });
      return [...g.values()].map(x => ({ ...x, extra: `${x.n} comp.` })).sort((a, b) => b.v - a.v);
    };
    const grupos = {
      cuenta: agrupar(f => f.cuenta || '-', f => f.cuenta ? `${f.cuenta} · ${f.cuenta_den || nombreCuenta(f.cuenta) || 'Sin nombre'}` : 'Sin cuenta asignada', () => '', () => null),
      proveedor: agrupar(f => f.cuit || f.proveedor, f => f.proveedor, f => fmtCuit(f.cuit), f => f.cuit ? '#/proveedor/' + f.cuit : null),
      local: agrupar(f => f.local || '-', f => f.local || 'Sin local detectado', () => '', () => null),
    };
    const meses = ultimosMeses(Math.min(24, Math.max(6, nMeses)), hasta);
    const porMes = {}; datos.filas.forEach(f => { porMes[f.mes] = (porMes[f.mes] || 0) + v(f); });
    const varPct = totAnt && desde === hasta ? Math.round(100 * (tot - totAnt) / Math.abs(totAnt)) : null;
    $('#an-cuerpo').innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="et">Comprado ${desde === hasta ? 'en ' + fmtMes(desde, true) : 'en el período'}</div><div class="val">${$$corto(tot)}</div><div class="sub">${medida === 'neto' ? 'neto' : 'con IVA'}${varPct !== null ? ` · <b class="${varPct > 0 ? 'txt-neg' : 'txt-pos'}">${varPct > 0 ? '+' : ''}${varPct}%</b> vs ${fmtMes(datos.mes_anterior, true)}` : ''}</div></div>
        <div class="kpi"><div class="et">Comprobantes</div><div class="val">${filas.length}</div><div class="sub">${new Set(filas.map(f => f.cuit)).size} proveedores</div></div>
        <div class="kpi"><div class="et">Promedio mensual</div><div class="val">${$$corto(tot / nMeses)}</div><div class="sub">${nMeses} mes(es)</div></div>
        <div class="kpi ${sinCuenta.length ? 'alerta' : ''}"><div class="et">Sin cuenta asignada</div><div class="val">${$$corto(sinCuentaT)}</div><div class="sub">${sinCuenta.length} comprobante(s) por revisar</div></div>
      </div>
      <div class="panel"><div class="panel-titulo"><h2>Evolución mensual</h2><span class="ayuda">${medida === 'neto' ? 'neto' : 'con IVA'} · en pesos</span></div>
        <div class="panel-pad">${barras(meses.map(m => ({ et: fmtMes(m), v: porMes[m] || 0, sub: fmtMes(m, true), act: m >= desde && m <= hasta })))}</div></div>
      <div class="panel"><div class="panel-titulo"><div class="seg" style="margin:0" id="an-v">${[['cuenta', 'Por cuenta'], ['proveedor', 'Por proveedor'], ['local', 'Por local']].map(([k, t]) => `<button data-v="${k}" class="${vista === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        <span class="ayuda">${vista === 'local' ? 'el local sale del detalle de la factura' : vista === 'proveedor' ? 'tocá uno para ver su ficha' : ''}</span></div>
        <div id="an-rank">${ranking(grupos[vista], { total: tot, limite: 15 })}</div></div>`;
    $$('#an-v button').forEach(b => b.onclick = () => { vista = b.dataset.v; sessionStorage.setItem('an_vista', vista); pintar(); });
    conectarRanking($('#an-cuerpo'));
    pintar.filas = filas;
  };
  const cargar = async () => {
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    sessionStorage.setItem('an_desde', desde); sessionStorage.setItem('an_hasta', hasta);
    $('#an-d').value = desde; $('#an-h').value = hasta;
    $('#an-cuerpo').innerHTML = '<div class="vacio"><span class="cargando"></span></div>';
    // Trae hasta 12 meses antes para el gráfico de evolución
    const desdeGraf = ultimosMeses(Math.max(6, ultimosMeses(24, hasta).filter(m => m >= desde).length), hasta)[0];
    datos = await api(`/api/analisis?desde=${desdeGraf < desde ? desdeGraf : desde}&hasta=${hasta}${soloOk ? '&solo=ok' : ''}`);
    // el Worker compara contra el mes anterior al "desde" pedido: lo recalculamos sobre el "desde" elegido
    const [y, m] = desde.split('-').map(Number);
    datos.mes_anterior = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    pintar();
  };
  $('#an-d').onchange = (e) => { desde = e.target.value || mesHoy; cargar(); };
  $('#an-h').onchange = (e) => { hasta = e.target.value || mesHoy; cargar(); };
  $('#an-m').onchange = (e) => { medida = e.target.value; sessionStorage.setItem('an_medida', medida); pintar(); };
  $('#an-s').onchange = (e) => { soloOk = e.target.value === 'ok'; sessionStorage.setItem('an_solo', soloOk ? 'ok' : ''); cargar(); };
  $$('[data-p]', el).forEach(b => b.onclick = () => {
    const ms = ultimosMeses(13, mesHoy);
    if (b.dataset.p === 'mes') desde = hasta = mesHoy;
    if (b.dataset.p === 'ant') desde = hasta = ms[11];
    if (b.dataset.p === '3m') { desde = ms[10]; hasta = mesHoy; }
    if (b.dataset.p === 'anio') { desde = mesHoy.slice(0, 4) + '-01'; hasta = mesHoy; }
    cargar();
  });
  $('#b-csv').onclick = () => descargarCsv(`analisis_compras_${desde}_${hasta}.csv`, [
    ['ID', 'Mes', 'CUIT', 'Proveedor', 'Cuenta', 'Denominación', 'Local', 'Neto', 'Total', 'Estado', 'En USD'],
    ...(pintar.filas || []).map(f => [f.id, f.mes, f.cuit, f.proveedor, f.cuenta || '', f.cuenta_den || '', f.local || '', String(f.neto).replace('.', ','), String(f.total).replace('.', ','), ESTADOS[f.estado] || f.estado, f.usd ? 'sí' : '']),
  ]);
  await cargar();
}

// ---------------------------------------------------------------------------
//  Guía de uso + bienvenida la primera vez
// ---------------------------------------------------------------------------
const PASOS_GUIA = [
  ['mail', 'Llega por mail', 'El proveedor manda la factura a la casilla. Cada 15 minutos la app la guarda en Drive y la pone en cola. También podés subirla a mano con “Subir factura”.'],
  ['sparkle', 'Se lee sola', 'El lector usa el QR de ARCA y la configuración del proveedor. Si el proveedor es nuevo, usa reglas generales o Gemini, y una persona confirma esa primera vez.'],
  ['shield', 'Se valida', 'Se constata el CAE en ARCA, se controla que los importes cierren, que esté a nombre de una empresa del grupo y que no esté cargada en Shares.'],
  ['inbox', 'Vos revisás lo raro', 'Lo que no pasa un control va a “Para revisar”, con el motivo en criollo. Lo resolvés y pasa sola a la siguiente.'],
  ['send', 'Va a Shares', 'Las que pasan todo quedan en “Enviar a Shares”. Un aprobador las manda en lote. Nada se carga sin aprobación.'],
];
async function vistaGuia(el) {
  if (esDirector()) return guiaDirector(el);
  const grupos = Object.entries(GRUPOS).filter(([k]) => k !== 'lectura').sort((a, b) => a[1].orden - b[1].orden);
  el.innerHTML = `<div class="encabezado"><div><h1>Guía de uso</h1><p>Cómo funciona la app, qué significa cada motivo y los atajos para ir más rápido.</p></div>
    <div class="acciones"><button class="btn" id="b-bienv">${ICO.sparkle}Ver la bienvenida otra vez</button></div></div>
    <div class="panel"><div class="panel-titulo"><h2>El recorrido de una factura</h2></div>
      <ol class="pasos-guia">${PASOS_GUIA.map(([ic, t, d], i) => `<li><span class="num-paso">${ICO[ic]}<b>${i + 1}</b></span><div><div class="t">${esc(t)}</div><p>${esc(d)}</p></div></li>`).join('')}</ol></div>
    <div class="dos" style="margin-top:16px">
      <div class="panel"><div class="panel-titulo"><h2>Cómo revisar una factura</h2></div><div class="panel-pad guia-txt">
        <p><b>1. Mirá el recuadro verde.</b> Dice exactamente qué falta. Si es un proveedor nuevo, revisá el desglose contra el PDF y la cuenta sugerida (si viene de Shares, es la que usa siempre).</p>
        <p><b>2. Corregí lo que haga falta</b> en la pestaña Datos. Abajo te dice si los importes cierran al centavo.</p>
        <p><b>3. Tocá el botón verde.</b> Se guarda, se revalida y pasás a la siguiente de la cola.</p>
        <p><b>¿Algo no corresponde?</b> “Rechazar” la saca del circuito (queda registrada y se puede reabrir). “Aceptar igual” deja pasar un control con un comentario que queda en el historial.</p>
        <p><b>Proveedor nuevo:</b> al confirmarlo, la app aprende dónde está cada dato y sus próximas facturas se leen solas, sin IA.</p></div></div>
      <div class="panel"><div class="panel-titulo"><h2>Atajos</h2></div><div class="panel-pad">
        <dl class="kv atajos"><dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Buscar desde cualquier pantalla. Un número abre esa factura (ej. 14).</dd>
          <dt><kbd>J</kbd> / <kbd>K</kbd></dt><dd>Bajar / subir en “Para revisar”.</dd><dt><kbd>Enter</kbd></dt><dd>Abrir la factura marcada.</dd><dt><kbd>/</kbd></dt><dd>Ir al buscador de la cola.</dd></dl>
        <h3 style="margin:18px 0 8px">Otras pantallas</h3>
        <div class="guia-txt"><p><b>Propuestas de pago:</b> elegís sociedad y fecha de pago, tildás las facturas cargadas en Shares (vienen sugeridas las que vencen) y la mandás al Director. Él aprueba u observa cada pago, separado en Gastos, Inversión y Materia prima. Lo aprobado se exporta y se marca pagado.</p><p><b>Agenda de pagos:</b> qué vence por semana con el CBU para copiar. <b>Análisis de compras:</b> cuánto se compró por cuenta, proveedor y local. <b>Ficha del proveedor:</b> tocá cualquier proveedor para ver sus compras, cómo se carga y su historial en Shares.</p></div></div></div>
    </div>
    <div class="panel"><div class="panel-titulo"><h2>Qué significa cada motivo</h2><span class="ayuda">los mismos que ves en “Para revisar”</span></div>
      <div class="motivos-guia">${grupos.map(([k, g]) => { const [bg, fg] = g.tono === 'acc' ? ['accent-soft', 'accent-ink'] : [g.tono + '-bg', g.tono];
        return `<section><h3 style="color:var(--${fg})"><span class="ico" style="background:var(--${bg});color:var(--${fg})">${ICO[g.ico]}</span>${esc(g.t)}</h3><dl>${Object.entries(MOTIVOS).filter(([, m]) => m[0] === k).map(([c, m]) => `<dt>${esc(m[1])} <span class="mono muted small">${c}</span></dt><dd>${esc(m[2])}</dd>`).join('')}</dl></section>`; }).join('')}</div></div>`;
  $('#b-bienv').onclick = () => bienvenida(true);
}
function bienvenida(forzar = false) {
  try { if (!forzar && localStorage.getItem('facturas_bienvenida')) return; localStorage.setItem('facturas_bienvenida', '1'); } catch { if (!forzar) return; }
  let i = 0;
  const pintar = (el, cerrar) => {
    const [ic, t, d] = PASOS_GUIA[i];
    el.innerHTML = `<div class="bienv"><span class="bienv-ico">${ICO[ic]}</span><span class="et">Paso ${i + 1} de ${PASOS_GUIA.length}</span><h2>${esc(t)}</h2><p class="muted">${esc(d)}</p>
      <div class="puntos">${PASOS_GUIA.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="acciones" style="justify-content:space-between;width:100%"><button class="btn btn-ghost" id="bv-salt">${i === PASOS_GUIA.length - 1 ? '' : 'Saltar'}</button>
        <span class="acciones">${i ? `<button class="btn" id="bv-ant">${ICO.back}Atrás</button>` : ''}<button class="btn btn-acento" id="bv-sig">${i === PASOS_GUIA.length - 1 ? 'Empezar' : 'Siguiente'} ${ICO.arrow}</button></span></div></div>`;
    $('#bv-sig', el).onclick = () => { if (i === PASOS_GUIA.length - 1) return cerrar(); i++; pintar(el, cerrar); };
    const a = $('#bv-ant', el); if (a) a.onclick = () => { i--; pintar(el, cerrar); };
    $('#bv-salt', el).onclick = cerrar;
  };
  modal('<div></div>', { alMontar: (el, cerrar) => pintar(el, cerrar) });
}

// ---------------------------------------------------------------------------
//  Ordenar cualquier tabla tocando el título de la columna (en toda la app).
//  Un toque: de mayor a menor (fechas e importes) o A→Z (texto). Otro toque: al revés.
//  Detecta solo si la columna es fecha, importe/número o texto. Se recuerda por pantalla.
// ---------------------------------------------------------------------------
const ORDEN = {
  // Una sola columna ordenada por tabla (la última que se tocó), recordada por pantalla
  clave: (th) => `orden:${location.hash.split('?')[0]}:${[...th.closest('table').querySelectorAll('thead th')].map(h => h.textContent.trim()).join('|')}`,
  valor(td) {
    if (!td) return { t: 'x', v: '' };
    if (td.dataset.orden != null) { const n = Number(td.dataset.orden); return isNaN(n) ? { t: 's', v: td.dataset.orden } : { t: 'n', v: n }; }
    // En celdas con avatar + nombre (proveedor) se usa el nombre, no las iniciales
    const base = td.querySelector('.prov b, b') || td;
    const txt = (base.innerText || base.textContent || '').trim().split('\n')[0].trim();
    let m = txt.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) { const a = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : '0000'; return { t: 'n', v: Number(a + m[2].padStart(2, '0') + m[1].padStart(2, '0')) }; }
    m = txt.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { t: 'n', v: Number(m[1] + m[2] + m[3]) };
    m = txt.replace(/\s/g, '').match(/^(-)?(?:US\$|U\$S|USD|DOL|EUR|\$)?(-)?([\d.]+(?:,\d+)?)(\s*[MK])?/i);
    if (m && /\d/.test(m[3]) && !/^\d{11}$/.test(m[3]) && !/^\d{2}-\d{8}-\d$/.test(txt)) {
      let v = Number(m[3].replace(/\./g, '').replace(',', '.'));
      if (/M/i.test(m[4] || '')) v *= 1e6; else if (/K/i.test(m[4] || '')) v *= 1e3;
      if (m[1] || m[2]) v = -v;
      if (isFinite(v)) return { t: 'n', v };
    }
    return { t: 's', v: txt.toLowerCase() };
  },
  aplicar(th, dir) {
    const tabla = th.closest('table'); const tb = tabla && tabla.tBodies[0]; if (!tb) return;
    const i = [...th.parentElement.children].indexOf(th);
    const filas = [...tb.rows].filter(r => r.cells.length > 1);
    if (filas.length < 2) return;
    const vals = filas.map(r => ({ r, k: ORDEN.valor(r.cells[i]) }));
    const num = vals.filter(x => x.k.t === 'n').length >= vals.filter(x => x.k.t === 's' && x.k.v).length;
    vals.sort((a, b) => {
      let c;
      if (num) c = (a.k.t === 'n' ? a.k.v : -Infinity) - (b.k.t === 'n' ? b.k.v : -Infinity);
      else c = String(a.k.v).localeCompare(String(b.k.v), 'es', { numeric: true });
      return dir === 'asc' ? c : -c;
    });
    vals.forEach(x => tb.appendChild(x.r));
    tabla.querySelectorAll('thead th').forEach(h => h.removeAttribute('data-dir'));
    th.dataset.dir = dir;
  },
  // Primer toque: fechas/importes de mayor a menor; texto de la A a la Z
  primero(th) {
    const tb = th.closest('table')?.tBodies[0]; if (!tb) return 'desc';
    const i = [...th.parentElement.children].indexOf(th);
    const ks = [...tb.rows].slice(0, 15).map(r => ORDEN.valor(r.cells[i]));
    return ks.filter(k => k.t === 'n').length >= ks.filter(k => k.t === 's' && k.v).length ? 'desc' : 'asc';
  },
  // No se ordenan las tablas agrupadas (filas de grupo con colspan): se desarmarían los grupos
  ordenable: (th) => th && th.closest('thead') && !th.querySelector('input,button,select') && th.textContent.trim() && th.closest('table')?.tBodies[0] && !th.closest('table').querySelector('tbody tr.grupo-prov, tbody td[colspan]:not(.vacio)') && !th.closest('table').classList.contains('sin-orden'),
};
document.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!ORDEN.ordenable(th) || e.target.closest('input,button,select,a')) return;
  const dir = th.dataset.dir ? (th.dataset.dir === 'asc' ? 'desc' : 'asc') : ORDEN.primero(th);
  ORDEN.aplicar(th, dir);
  try { sessionStorage.setItem(ORDEN.clave(th), JSON.stringify({ i: [...th.parentElement.children].indexOf(th), dir })); } catch { }
});
// Las tablas que se dibujan de nuevo vuelven a quedar con el orden elegido
new MutationObserver(() => {
  clearTimeout(ORDEN._t);
  ORDEN._t = setTimeout(() => {
    document.querySelectorAll('table thead th').forEach(th => { if (ORDEN.ordenable(th)) th.classList.add('ordenable'); });
    document.querySelectorAll('table thead tr').forEach(tr => {
      const th0 = tr.querySelector('th.ordenable'); if (!th0) return;
      let g = null; try { g = JSON.parse(sessionStorage.getItem(ORDEN.clave(th0)) || 'null'); } catch { }
      const th = g && tr.children[g.i];
      if (th && ORDEN.ordenable(th) && th.dataset.dir !== g.dir) ORDEN.aplicar(th, g.dir);
    });
  }, 60);
}).observe(document.documentElement, { childList: true, subtree: true });

// Firma del Director: se muestra en la propuesta una vez que la resolvió (aprobó, aprobó en parte u observó todo)
function firmaDirector(L, d, R) {
  if (!L.resuelto_at || !['aprobado', 'parcial', 'cerrado', 'rechazado'].includes(L.estado)) return '';
  const nombre = L.resuelto_nombre || String(L.resuelto_por || '').split('@')[0];
  const t = String(L.resuelto_at);
  const f = new Date(t.replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/.test(t) ? '' : 'Z'));
  const ok = !Number.isNaN(f.getTime());
  const fecha = ok ? f.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : fmtF(t);
  const hora = ok ? f.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const aprob = d.items.filter(i => i.decision === 'aprobado').length;
  const titulo = L.estado === 'rechazado' ? 'Observada por' : aprob < d.items.length ? 'Autorizada en parte por' : 'Autorizada por';
  const detalle = L.estado === 'rechazado' ? `Observó los ${d.items.length} pago(s)` : `Aprobó ${aprob} de ${d.items.length} pago(s) por ${$$m(R.aprobado)}`;
  const rol = 'Director'; // solo el Director puede resolver (lo controla el worker)
  return `<div class="firma-wrap"><div class="firma ${L.estado === 'rechazado' ? 'firma-obs' : ''}">
    <div class="firma-et">${titulo}</div>
    <div class="firma-trazo" aria-hidden="true">${esc(nombre)}</div>
    <div class="firma-linea"></div>
    <div class="firma-nom">${esc(nombre)}${rol ? ` <span>· ${rol}</span>` : ''}</div>
    <div class="firma-fecha">${ICO.check}${esc(fecha)}${hora ? ` · ${hora} hs` : ''}</div>
    <div class="firma-det">${detalle}</div>
  </div></div>`;
}

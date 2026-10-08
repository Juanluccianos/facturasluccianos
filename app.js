/* =============================================================================
 *  Facturas de Proveedores — Lucciano's (frontend)
 *  Vanilla JS, sin build. Habla con el Worker (window.FACTURAS_API).
 *  Rutas por hash: #/tablero, #/bandeja, #/facturas, #/factura/ID, #/shares,
 *                  #/proveedores, #/admin, #/cuenta
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
const $$m = (n) => (n === null || n === undefined || n === '') ? '—' : '$ ' + fmtNum.format(Number(n));
const fmtF = (iso) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const fmtFH = (s) => { if (!s) return '—'; const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') || String(s).includes('+') ? '' : 'Z')); return d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); };
const nroCbte = (f) => (f.pto_vta != null && f.numero != null) ? `${String(f.pto_vta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}` : '—';
const fmtCuit = (c) => { c = String(c || ''); return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : (c || '—'); };
const TIPOS = { 1: 'FA', 2: 'ND A', 3: 'NC A', 6: 'FB', 7: 'ND B', 8: 'NC B', 11: 'FC', 12: 'ND C', 13: 'NC C', 51: 'FM', 52: 'ND M', 53: 'NC M', 201: 'FCE A', 202: 'ND FCE A', 203: 'NC FCE A', 206: 'FCE B', 207: 'ND FCE B', 208: 'NC FCE B', 211: 'FCE C', 212: 'ND FCE C', 213: 'NC FCE C' };
const ESTADOS = { recibida: 'En cola de lectura', leyendo: 'Leyendo', excepcion: 'En excepción', lista: 'Lista para Shares', cargada: 'Cargada en Shares', error_shares: 'Error Shares', rechazada: 'Rechazada' };
const METODOS = { plantilla: 'Configuración del proveedor', plantilla_pendiente: 'Configuración pendiente', reglas: 'Reglas generales (sin IA)', ia: 'Gemini (IA)' };
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
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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

async function vistaLogin() {
  let setup = false;
  try { setup = (await api('/api/estado')).setup_requerido; } catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="panel"><h1>Sin conexión</h1><p>No pude conectar con el servidor (${esc(API)}).<br>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reintentar</button></div></div>`;
    return;
  }
  $('#app').innerHTML = `<div class="login"><form class="panel" id="f-login">
    <h1>${setup ? 'Primer ingreso' : 'Facturas de proveedores'}</h1>
    <p>${setup ? 'Creá el usuario administrador.' : "Lucciano's · Administración"}</p>
    ${setup ? '<div class="campo"><label>Nombre</label><input name="nombre" required autocomplete="name"></div>' : ''}
    <div class="campo"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
    <div class="campo"><label>Contraseña</label><input name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}"></div>
    <div class="campo hidden" id="c-totp"><label>Código de doble factor</label><input name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></div>
    <button class="btn btn-negro" style="width:100%" type="submit">${setup ? 'Crear y entrar' : 'Ingresar'}</button>
  </form></div>`;
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await conBoton($('button[type=submit]', e.target), async () => {
      const r = await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: fd });
      if (r.requiere_totp) { $('#c-totp').classList.remove('hidden'); $('#c-totp input').focus(); toast('Ingresá el código de tu app autenticadora.'); return; }
      guardarToken(r.token); S.user = r.usuario;
      if (!location.hash) location.hash = '#/tablero';
      iniciar();
    });
  };
}

// ---------------------------------------------------------------------------
//  Shell + router
// ---------------------------------------------------------------------------
const RUTAS = [
  { re: /^#\/tablero$/, v: vistaTablero, nav: 'tablero' },
  { re: /^#\/bandeja$/, v: vistaBandeja, nav: 'bandeja' },
  { re: /^#\/facturas$/, v: vistaFacturas, nav: 'facturas' },
  { re: /^#\/factura\/(\d+)$/, v: vistaFactura, nav: 'bandeja' },
  { re: /^#\/shares$/, v: vistaShares, nav: 'shares' },
  { re: /^#\/proveedores$/, v: vistaProveedores, nav: 'proveedores' },
  { re: /^#\/admin$/, v: vistaAdmin, nav: 'admin' },
  { re: /^#\/cuenta$/, v: vistaMiCuenta, nav: '' },
];

function shell(navActivo) {
  const items = [
    ['tablero', 'Tablero'], ['bandeja', 'Bandeja'], ['facturas', 'Facturas'],
    ...(puede('aprobador') ? [['shares', 'Enviar a Shares']] : []),
    ['proveedores', 'Proveedores'],
    ...(puede('admin') ? [['admin', 'Admin']] : []),
  ];
  return `<header class="top">
    <a class="marca" href="#/tablero"><b>LUCCIANO'S</b><span>Facturas proveedores</span></a>
    <nav class="nav">${items.map(([k, t]) => `<a href="#/${k}" class="${k === navActivo ? 'activo' : ''}">${t}</a>`).join('')}</nav>
    <div class="usuario"><a href="#/cuenta" class="nombre">${esc(S.user.nombre)}</a><span class="badge b-aviso">${esc(S.user.rol)}</span><button class="btn btn-chico" id="b-salir">Salir</button></div>
  </header><main id="vista"><div class="vacio"><span class="cargando"></span></div></main>`;
}

async function router() {
  if (!S.token) return vistaLogin();
  if (S.pdfUrl) { URL.revokeObjectURL(S.pdfUrl); S.pdfUrl = null; }
  const h = location.hash || '#/tablero';
  const r = RUTAS.find(x => x.re.test(h)) || RUTAS[0];
  const m = h.match(r.re) || [];
  $('#app').innerHTML = shell(r.nav);
  $('#b-salir').onclick = () => salir();
  S.vista = h;
  try { await r.v($('#vista'), ...m.slice(1)); }
  catch (e) { if (S.token) $('#vista').innerHTML = `<div class="panel panel-pad"><h2>No se pudo cargar</h2><p class="muted">${esc(e.message)}</p></div>`; }
}

async function iniciar() {
  if (!S.token) return vistaLogin();
  try {
    const r = await api('/api/yo');
    S.user = r.usuario; S.arca = r.arca_modo;
  } catch { return vistaLogin(); }
  cuentas().catch(() => null);
  router();
}
window.addEventListener('hashchange', router);
document.addEventListener('DOMContentLoaded', iniciar);

// ---------------------------------------------------------------------------
//  Tablero
// ---------------------------------------------------------------------------
async function vistaTablero(el) {
  const t = await api('/api/tablero');
  const pe = (k) => t.por_estado[k] || { n: 0, monto: 0 };
  const pct = t.automatico_mes.pct;
  el.innerHTML = `
    <div class="encabezado">
      <div><h1>Tablero</h1><p>Hoy ${fmtF(t.hoy)} · ARCA: ${esc(S.arca === 'off' ? 'sin constatación' : S.arca)}</p></div>
      <div class="acciones"><button class="btn btn-negro" id="b-subir">Subir factura</button><button class="btn" id="b-procesar">Leer pendientes ahora</button></div>
    </div>
    <div class="kpis">
      <a class="kpi" href="#/facturas"><div class="et">Recibidas hoy</div><div class="val">${t.recibidas_hoy}</div><div class="sub">${t.recibidas_mes} en el mes</div></a>
      <a class="kpi" href="#/facturas"><div class="et">En cola de lectura</div><div class="val">${pe('recibida').n + pe('leyendo').n}</div><div class="sub">el lector pasa cada 15 min</div></a>
      <a class="kpi ${pe('excepcion').n ? 'alerta' : ''}" href="#/bandeja"><div class="et">En excepción</div><div class="val">${pe('excepcion').n}</div><div class="sub">${$$m(pe('excepcion').monto)}</div></a>
      <a class="kpi ok" href="${puede('aprobador') ? '#/shares' : '#/facturas'}"><div class="et">Listas para Shares</div><div class="val">${pe('lista').n}</div><div class="sub">${$$m(pe('lista').monto)}</div></a>
      <a class="kpi ${pe('error_shares').n ? 'alerta' : ''}" href="#/shares"><div class="et">Error Shares</div><div class="val">${pe('error_shares').n}</div><div class="sub">rechazadas por Shares</div></a>
      <div class="kpi"><div class="et">Cargadas en el mes</div><div class="val">${t.cargadas_mes}</div><div class="sub">${pe('cargada').n} en total</div></div>
      <div class="kpi"><div class="et">Sin intervención</div><div class="val">${pct === null ? '—' : pct + '%'}</div><div class="sub">${t.automatico_mes.ok} de ${t.automatico_mes.total} en el mes · meta 80–90%</div></div>
      <a class="kpi" href="#/proveedores"><div class="et">Proveedores configurados</div><div class="val">${t.proveedores_configurados}</div><div class="sub">se leen solos, sin IA</div></a>
      <div class="kpi"><div class="et">Lectura del mes</div><div class="val">${(t.lectura_mes.plantilla || 0)}</div><div class="sub">por configuración · ${t.lectura_mes.reglas || 0} reglas · ${t.lectura_mes.ia || 0} Gemini</div></div>
      <div class="kpi"><div class="et">Vencen en 7 días</div><div class="val">${t.vencen_7_dias.n}</div><div class="sub">${$$m(t.vencen_7_dias.monto)}</div></div>
    </div>
    <div class="panel">
      <div class="panel-titulo"><h2>Motivos de excepción abiertos</h2><a class="btn btn-chico" href="#/bandeja">Ir a la bandeja</a></div>
      ${t.top_excepciones.length ? `<table><tbody>${t.top_excepciones.map(x => `<tr class="click" data-cod="${esc(x.codigo)}"><td class="mono">${esc(x.codigo)}</td><td class="muted">${esc(DESC_EXC[x.codigo] || '')}</td><td class="num">${x.n}</td></tr>`).join('')}</tbody></table>`
      : '<div class="vacio">No hay excepciones abiertas. 🎉</div>'}
    </div>`;
  $('#b-subir').onclick = modalSubir;
  const bp = $('#b-procesar');
  if (bp) bp.onclick = () => conBoton(bp, async () => { const r = await api('/api/lector/disparar', { method: 'POST' }); toast(r.mensaje, !r.ok); });
  $$('tr[data-cod]', el).forEach(tr => tr.onclick = () => { sessionStorage.setItem('bandeja_cod', tr.dataset.cod); location.hash = '#/bandeja'; });
}

const DESC_EXC = {
  PROVEEDOR_NUEVO: 'Primera factura del proveedor: confirmar', FORMATO_CAMBIO: 'El proveedor cambió el formato de su factura',
  LECTURA: 'No se pudo leer automáticamente', NO_ES_FACTURA: 'El PDF no es un comprobante', QR_INCONSISTENTE: 'El QR no coincide con lo leído',
  ARCA_RECHAZADO: 'ARCA no valida el CAE', ARCA_ERROR: 'No se pudo consultar ARCA', ARCA_PENDIENTE: 'Falta constatar en ARCA',
  DESTINATARIO: 'Emitida a otro CUIT', DUPLICADO: 'Posible duplicado', PROVEEDOR_DESCONOCIDO: 'Proveedor fuera del maestro',
  PROVEEDOR_COND_IVA: 'Falta condición IVA', ARITMETICA: 'Los importes no cierran', MONEDA: 'Moneda extranjera', CBU: 'CBU distinto al del maestro',
  IMPUTACION: 'Cuenta contable a definir/confirmar', CUENTA_INEXISTENTE: 'Cuenta fuera del plan', FISCAL_MAPEO: 'Percepción sin mapeo fiscal',
  FECHA: 'Fecha fuera de rango', FACTURA_B: 'Factura B recibida', TIPO_NO_SOPORTADO: 'Tipo de comprobante no contemplado',
};

function modalSubir() {
  modal(`<h2>Subir factura</h2><p class="muted">Para facturas que no llegaron por mail. Entran al mismo circuito (IA + validaciones).</p>
    <label class="drop" id="drop"><input type="file" accept="application/pdf" multiple hidden id="f-pdf">Arrastrá PDFs acá o hacé clic para elegir</label>
    <div id="sub-res" class="small" style="margin-top:12px"></div>`, {
    alMontar: (el) => {
      const drop = $('#drop', el), inp = $('#f-pdf', el), res = $('#sub-res', el);
      const subir = async (files) => {
        for (const file of files) {
          if (file.type !== 'application/pdf') { res.insertAdjacentHTML('beforeend', `<div>✗ ${esc(file.name)}: no es PDF</div>`); continue; }
          if (file.size > 15e6) { res.insertAdjacentHTML('beforeend', `<div>✗ ${esc(file.name)}: supera 15 MB</div>`); continue; }
          const linea = document.createElement('div');
          linea.innerHTML = `<span class="cargando"></span> ${esc(file.name)} — subiendo…`;
          res.appendChild(linea);
          try {
            const b64 = await new Promise((ok, err) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = err; fr.readAsDataURL(file); });
            const r = await api('/api/facturas/subir', { method: 'POST', body: { archivo_nombre: file.name, pdf_base64: b64 } });
            linea.innerHTML = `✓ ${esc(file.name)} → <a href="#/factura/${r.id}">#${r.id}</a> ${badgeEstado(r.estado)} <span class="muted">${esc(r.lector?.ok ? 'el lector ya arrancó' : 'se lee en el próximo ciclo del lector')}</span>`;
          } catch (e) { linea.innerHTML = `✗ ${esc(file.name)}: ${esc(e.message)}`; }
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
//  Bandeja de excepciones y listado de facturas
// ---------------------------------------------------------------------------
function chipsExc(s) {
  if (!s) return '';
  return `<div class="chips">${s.split(',').map(x => { const [c, sev] = x.split(':'); return `<span class="badge b-${esc(sev)}" title="${esc(DESC_EXC[c] || '')}">${esc(c)}</span>`; }).join('')}</div>`;
}
function filasFacturas(lista, { conExc = true } = {}) {
  if (!lista.length) return `<tr><td colspan="9" class="vacio">No hay facturas para mostrar.</td></tr>`;
  return lista.map(f => `<tr class="click" data-id="${f.id}">
    <td class="mono muted">#${f.id}</td>
    <td>${badgeEstado(f.estado)}</td>
    <td><div>${esc(f.razon_social_emisor || f.mail_from || f.archivo_nombre || '—')}</div><div class="small muted mono">${fmtCuit(f.cuit_emisor)}</div></td>
    <td class="mono">${esc(TIPOS[f.tipo_cbte_arca] || '')} ${nroCbte(f)}</td>
    <td class="mono">${fmtF(f.fecha_emision)}</td>
    <td class="mono">${fmtF(f.fecha_vto)}</td>
    <td class="num">${f.moneda && f.moneda !== 'PES' ? esc(f.moneda) + ' ' : ''}${$$m(f.total)}</td>
    ${conExc ? `<td>${chipsExc(f.excepciones)}${f.error_proceso && f.estado !== 'lista' ? `<div class="small muted">${esc(f.error_proceso).slice(0, 120)}</div>` : ''}</td>` : ''}
    <td class="small muted">${fmtFH(f.recibido_at)}</td>
  </tr>`).join('');
}
function encabezadoFacturas(conExc = true) {
  return `<tr><th>#</th><th>Estado</th><th>Proveedor</th><th>Comprobante</th><th>Emisión</th><th>Vto.</th><th class="num">Total</th>${conExc ? '<th>Motivos</th>' : ''}<th>Recibida</th></tr>`;
}

async function vistaBandeja(el) {
  const cod = sessionStorage.getItem('bandeja_cod') || '';
  el.innerHTML = `<div class="encabezado"><div><h1>Bandeja de excepciones</h1><p>Facturas que necesitan una persona. Abrí cada una, corregí y guardá: se revalida sola.</p></div>
    <div class="acciones"><button class="btn" id="b-subir">Subir factura</button>${puede('aprobador') ? '<button class="btn" id="b-reval">Revalidar todas</button>' : ''}</div></div>
    <div class="panel"><div class="filtros">
      <div class="campo ancho"><label>Buscar</label><input id="q" placeholder="Proveedor, CUIT, número, #id"></div>
      <div class="campo"><label>Motivo</label><select id="cod"><option value="">Todos</option>${Object.keys(DESC_EXC).map(k => `<option ${k === cod ? 'selected' : ''} value="${k}">${k}</option>`).join('')}</select></div>
      <div class="campo"><label>Incluir</label><select id="inc"><option value="excepcion">Solo excepciones</option><option value="excepcion,recibida,leyendo">+ en cola de lectura</option></select></div>
    </div><div class="tabla-wrap"><table><thead>${encabezadoFacturas()}</thead><tbody id="tb"></tbody></table></div><div class="paginacion" id="pg"></div></div>`;
  const cargar = async () => {
    const p = new URLSearchParams({ estado: $('#inc').value, limite: 200, orden: 'id' });
    if ($('#q').value.trim()) p.set('q', $('#q').value.trim());
    if ($('#cod').value) p.set('codigo', $('#cod').value);
    sessionStorage.setItem('bandeja_cod', $('#cod').value);
    const r = await api('/api/facturas?' + p);
    $('#tb').innerHTML = filasFacturas(r.facturas);
    $('#pg').innerHTML = `<span>${r.total} factura(s) · ${$$m(r.monto)}</span>`;
    $$('#tb tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = '#/factura/' + tr.dataset.id; });
  };
  let deb;
  $('#q').oninput = () => { clearTimeout(deb); deb = setTimeout(cargar, 300); };
  $('#cod').onchange = cargar; $('#inc').onchange = cargar;
  $('#b-subir').onclick = modalSubir;
  const br = $('#b-reval');
  if (br) br.onclick = () => conBoton(br, async () => { const r = await api('/api/facturas/revalidar', { method: 'POST' }); toast(`Revalidadas: ${r.revalidadas}`); cargar(); });
  await cargar();
}

async function vistaFacturas(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Facturas</h1><p>Todas las facturas recibidas, con su PDF original a un clic.</p></div>
    <div class="acciones"><button class="btn" id="b-csv">Exportar CSV</button></div></div>
    <div class="panel"><div class="filtros">
      <div class="campo ancho"><label>Buscar</label><input id="q" placeholder="Proveedor, CUIT, número, #id, remitente"></div>
      <div class="campo"><label>Estado</label><select id="est"><option value="">Todos</option>${Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="campo"><label>Emisión desde</label><input type="date" id="desde"></div>
      <div class="campo"><label>Hasta</label><input type="date" id="hasta"></div>
      <div class="campo"><label>Orden</label><select id="ord"><option value="id">Más recientes</option><option value="vto">Por vencimiento</option></select></div>
    </div><div class="tabla-wrap"><table><thead>${encabezadoFacturas()}</thead><tbody id="tb"></tbody></table></div>
    <div class="paginacion"><span id="pg-info"></span><span class="acciones"><button class="btn btn-chico" id="ant">← Anterior</button><button class="btn btn-chico" id="sig">Siguiente →</button></span></div></div>`;
  let pagina = 1, ultimo = null;
  const params = (lim = 50) => {
    const p = new URLSearchParams({ limite: lim, pagina, orden: $('#ord').value });
    for (const [k, id] of [['q', 'q'], ['estado', 'est'], ['desde', 'desde'], ['hasta', 'hasta']]) if ($('#' + id).value.trim()) p.set(k, $('#' + id).value.trim());
    return p;
  };
  const cargar = async () => {
    const r = await api('/api/facturas?' + params());
    ultimo = r;
    $('#tb').innerHTML = filasFacturas(r.facturas);
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
  $('#b-csv').onclick = () => conBoton($('#b-csv'), async () => {
    const pAnt = pagina; pagina = 1;
    const r = await api('/api/facturas?' + params(500)); pagina = pAnt;
    descargarCsv(`facturas_${new Date().toISOString().slice(0, 10)}.csv`, [
      ['ID', 'Estado', 'CUIT', 'Proveedor', 'Tipo', 'Comprobante', 'Emisión', 'Vencimiento', 'Moneda', 'Total', 'Motivos', 'Recibida', 'Ref. Shares'],
      ...r.facturas.map(f => [f.id, ESTADOS[f.estado] || f.estado, f.cuit_emisor, f.razon_social_emisor, TIPOS[f.tipo_cbte_arca] || f.tipo_cbte_arca, nroCbte(f), f.fecha_emision, f.fecha_vto, f.moneda, String(f.total ?? '').replace('.', ','), f.excepciones, f.recibido_at, f.shares_ref]),
    ]);
    if (r.total > 500) toast('Se exportaron las primeras 500. Filtrá por fechas para el resto.');
  });
  void ultimo;
  await cargar();
}

// ---------------------------------------------------------------------------
//  Detalle de una factura (PDF a la izquierda, datos editables a la derecha)
// ---------------------------------------------------------------------------
async function vistaFactura(el, id) {
  await cuentas().catch(() => null);
  const r = await api('/api/facturas/' + id);
  pintarFactura(el, r);
  cargarPdf(id);
}

async function cargarPdf(id) {
  const visor = $('#visor');
  if (!visor) return;
  try {
    const res = await api(`/api/facturas/${id}/pdf`, { raw: true });
    const blob = await res.blob();
    if (S.pdfUrl) URL.revokeObjectURL(S.pdfUrl);
    S.pdfUrl = URL.createObjectURL(blob);
    if ($('#visor')) $('#visor').innerHTML = `<iframe src="${S.pdfUrl}#view=FitH" title="PDF de la factura"></iframe>`;
  } catch (e) {
    if ($('#visor')) $('#visor').innerHTML = `<div class="vacio">No se pudo cargar el PDF: ${esc(e.message)}</div>`;
  }
}

function pintarFactura(el, r) {
  const f = r.factura, d = r.datos || vacioDatos(), c = d.comprobante || {}, im = d.importes || {};
  const editable = ['recibida', 'excepcion', 'lista', 'error_shares'].includes(f.estado);
  const abiertas = r.excepciones.filter(e => !e.resuelta && e.severidad !== 'aviso');
  const dis = editable ? '' : 'disabled';
  const inp = (name, val, extra = '') => `<input name="${name}" value="${esc(val ?? '')}" ${dis} ${extra}>`;
  el.innerHTML = `
  <div class="encabezado">
    <div><h1>${esc(d.emisor?.razon_social || f.archivo_nombre || 'Factura')} <span class="muted mono" style="font-weight:400">#${f.id}</span></h1>
      <p>${badgeEstado(f.estado)} ${badgeMetodo(f.lector_metodo)} · ${esc(f.origen === 'mail' ? 'Mail de ' + (f.mail_from || '?') : f.mail_from || 'Carga manual')} · recibida ${fmtFH(f.recibido_at)}${f.shares_ref ? ` · Ref. Shares <span class="mono">${esc(f.shares_ref)}</span>` : ''}</p></div>
    <div class="acciones"><a class="btn" href="#/bandeja">← Bandeja</a></div>
  </div>
  <div class="detalle">
    <div class="visor panel" id="visor"><div class="vacio"><span class="cargando"></span> Cargando PDF…</div></div>
    <div class="panel" id="lado">
      ${['recibida', 'leyendo'].includes(f.estado) && !r.datos ? `<div class="seccion"><div class="excepcion"><div class="txt"><div class="cod">EN COLA DE LECTURA</div>El lector (QR + configuración del proveedor) la procesa en su próximo ciclo.${f.error_proceso ? ' Último error: ' + esc(f.error_proceso) : ''}</div></div></div>` : ''}
      ${f.estado === 'rechazada' ? `<div class="seccion"><div class="excepcion critica"><div class="txt"><div class="cod">RECHAZADA</div>${esc(f.rechazo_motivo)}</div></div></div>` : ''}
      ${f.estado === 'error_shares' && r.shares_respuesta ? `<div class="seccion"><div class="excepcion critica"><div class="txt"><div class="cod">SHARES HTTP ${esc(r.shares_respuesta.http_status)}</div>${esc(r.shares_respuesta.body?.message || JSON.stringify(r.shares_respuesta.body).slice(0, 300))}</div></div></div>` : ''}
      <div class="seccion">
        <h3>Controles ${abiertas.length ? `<span class="badge b-normal">${abiertas.length} abiertos</span>` : '<span class="badge b-ok">OK</span>'}</h3>
        ${r.excepciones.length ? r.excepciones.map(e => `<div class="excepcion ${e.resuelta ? 'aceptada' : e.severidad}">
          <div class="txt"><div class="cod">${esc(e.codigo)} <span class="badge b-${e.resuelta ? 'ok' : esc(e.severidad)}">${e.resuelta ? 'aceptada' : esc(e.severidad)}</span></div>
            <div>${esc(e.mensaje)}</div>${e.resuelta ? `<div class="small muted">Aceptada por ${esc(e.resuelta_por)}: “${esc(e.resolucion)}”</div>` : ''}</div>
          ${!e.resuelta && e.severidad !== 'aviso' && editable && !['IMPUTACION', 'PROVEEDOR_NUEVO'].includes(e.codigo) && (e.severidad !== 'critica' || puede('admin')) ? `<button class="btn btn-chico" data-aceptar="${esc(e.codigo)}">Aceptar</button>` : ''}
          ${e.codigo === 'PROVEEDOR_DESCONOCIDO' && !e.resuelta && puede('aprobador') ? `<button class="btn btn-chico" id="b-alta-prov">Dar de alta</button>` : ''}
        </div>`).join('') : '<p class="muted">Todavía no se validó.</p>'}
        ${f.error_proceso && !r.datos ? `<p class="small muted">Último error: ${esc(f.error_proceso)}</p>` : ''}
      </div>
      <div class="tabs" id="tabs"><button class="activo" data-tab="datos">Datos</button><button data-tab="shares">Shares</button><button data-tab="arca">Lectura / ARCA</button><button data-tab="hist">Historial</button></div>
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
          ${r.proveedor ? `<p class="small muted">Maestro: ${esc(r.proveedor.razon_social)} · cond. IVA ${esc(r.proveedor.condicion_iva ?? '—')} · CBU ${esc(r.proveedor.cbu || '—')} · cuenta ${esc(r.proveedor.cuenta_default || '—')}</p>` : ''}
        </div>
        <div class="seccion"><h3>Importes</h3>
          <div class="grid-items small muted"><span>Alícuota</span><span>Neto gravado</span><span>IVA</span><span></span></div>
          <div id="gravado">${(im.gravado || []).map(filaGravado).join('')}</div>
          ${editable ? '<button type="button" class="btn btn-chico" id="add-grav">+ Alícuota</button>' : ''}
          <div class="fila" style="margin-top:12px">
            <div class="campo"><label>Sin IVA discriminado (B/C)</label>${inp('importes.sin_discriminar', im.sin_discriminar || '', 'class="num"')}</div>
            <div class="campo"><label>No gravado</label>${inp('importes.no_gravado', im.no_gravado || '', 'class="num"')}</div>
            <div class="campo"><label>Exento</label>${inp('importes.exento', im.exento || '', 'class="num"')}</div>
            <div class="campo"><label>Otros tributos</label>${inp('importes.otros_tributos', im.otros_tributos || '', 'class="num"')}</div>
          </div>
          <h3 style="margin:8px 0">Percepciones</h3>
          <div class="grid-perc small muted"><span>Tipo</span><span>Jurisdicción</span><span>Importe</span><span></span></div>
          <div id="percepciones">${(d.percepciones || []).map(filaPercepcion).join('')}</div>
          ${editable ? '<button type="button" class="btn btn-chico" id="add-perc">+ Percepción</button>' : ''}
          <div class="fila" style="margin-top:12px"><div class="campo"><label>TOTAL del comprobante</label>${inp('importes.total', im.total || '', 'class="num" style="font-weight:600"')}</div></div>
          <div id="cuadre"></div>
        </div>
        <div class="seccion"><h3>Imputación</h3>
          ${datalistCuentas()}
          <div class="fila">
            <div class="campo"><label>Cuenta (codigo_concepto)</label><input name="imputacion.codigo_concepto" list="dl-cuentas" class="mono" value="${esc(d.imputacion?.codigo_concepto || '')}" ${dis}></div>
            <div class="campo" style="grid-column: span 2"><label>Denominación</label><input id="den-cuenta" disabled value="${esc(r.cuenta?.denominacion || nombreCuenta(d.imputacion?.codigo_concepto))}"></div>
          </div>
          <p class="small muted">Origen: <b>${esc({ regla: 'regla de imputación', proveedor: 'cuenta por defecto del proveedor', ia: 'sugerida por Gemini — confirmala', manual: 'elegida por una persona' }[d.imputacion?.origen] || 'sin definir')}</b>${d.imputacion?.detalle ? ' · ' + esc(d.imputacion.detalle) : ''}${d.ia?.motivo_cuenta && d.imputacion?.origen === 'ia' ? ' · ' + esc(d.ia.motivo_cuenta) : ''}</p>
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
      <div class="barra-acciones">
        ${editable ? `<button class="btn btn-negro" id="b-guardar">Guardar y revalidar</button>` : ''}
        ${editable && abiertas.some(e => e.codigo === 'PROVEEDOR_NUEVO') ? `<button class="btn btn-negro" id="b-conf-prov">Confirmar proveedor y activar lectura</button>` : ''}
        ${editable && abiertas.some(e => e.codigo === 'FORMATO_CAMBIO') && !abiertas.some(e => e.codigo === 'PROVEEDOR_NUEVO') ? `<button class="btn btn-negro" id="b-conf-prov">Confirmar y actualizar configuración</button>` : ''}
        ${editable && d.imputacion?.origen === 'ia' && !abiertas.some(e => e.codigo === 'PROVEEDOR_NUEVO') ? `<button class="btn" id="b-confirmar">Confirmar cuenta sugerida</button>` : ''}
        ${f.estado === 'lista' && puede('aprobador') ? `<button class="btn btn-negro" id="b-enviar">Enviar a Shares</button>` : ''}
        ${f.estado === 'error_shares' && puede('aprobador') ? `<button class="btn btn-negro" id="b-enviar">Reintentar envío</button>` : ''}
        ${editable ? `<button class="btn" id="b-ia">Volver a leer</button>` : ''}
        ${editable && f.mail_thread_id ? `<button class="btn" id="b-aclar">Pedir aclaración</button>` : ''}
        ${editable ? `<button class="btn btn-rojo" id="b-rechazar">Rechazar</button>` : ''}
        ${f.estado === 'rechazada' && puede('aprobador') ? `<button class="btn" id="b-reabrir">Reabrir</button>` : ''}
      </div>
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
  const recargar = (nuevo) => { pintarFactura(el, nuevo); if (S.pdfUrl) $('#visor').innerHTML = `<iframe src="${S.pdfUrl}#view=FitH" title="PDF de la factura"></iframe>`; else cargarPdf(id); };
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
  if (ap) ap.onclick = () => $('#percepciones').insertAdjacentHTML('beforeend', filaPercepcion({ tipo: 'IIBB' }));
  const chk = $('#chk-regla');
  if (chk) chk.onchange = () => $('#c-palabra').classList.toggle('hidden', !chk.checked);
  actualizarCuadre();

  const guardar = (extra = {}) => api('/api/facturas/' + id, {
    method: 'PUT',
    body: { datos: leerFormulario(r.datos), guardar_regla: chk?.checked ? { palabra_clave: $('#palabra').value.trim() || null } : null, ...extra },
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
    if (!confirm('Confirmás que el desglose y la cuenta están bien? Con esta factura se guarda cómo leer las próximas de este proveedor.')) return;
    const n = await guardar({ confirmar_proveedor: true });
    const av = n.confirmacion?.avisos || [];
    toast(`✓ Proveedor configurado (v${n.confirmacion?.version}). ${av.length ? av[0] : 'Sus próximas facturas se leen solas.'}`);
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
    if (!confirm('¿Enviar este comprobante a Shares?')) return;
    const res = (await api('/api/shares/enviar', { method: 'POST', body: { ids: [id] } })).resultados[0];
    toast(res.ok ? `✓ Cargada en Shares${res.shares_ref ? ' (ref. ' + res.shares_ref + ')' : ''}` : `Shares: ${res.message}`, !res.ok);
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
  const r = await api('/api/facturas?estado=lista,error_shares&limite=500&orden=vto');
  el.innerHTML = `<div class="encabezado"><div><h1>Enviar a Shares</h1><p>Facturas que pasaron todos los controles. Nada se carga sin tu aprobación.</p></div>
    <div class="acciones"><span class="muted" id="sel-info"></span><button class="btn btn-negro" id="b-env" disabled>Aprobar y enviar</button></div></div>
    <div class="panel"><div class="tabla-wrap"><table><thead><tr><th><input type="checkbox" id="todas"></th>${encabezadoFacturas(false).replace('<tr>', '').replace('</tr>', '')}</tr></thead>
    <tbody>${r.facturas.length ? r.facturas.map(f => `<tr data-id="${f.id}"><td><input type="checkbox" data-sel="${f.id}" data-total="${f.total || 0}"></td>${filasFacturas([f], { conExc: false }).replace(/^<tr[^>]*>/, '').replace(/<\/tr>$/, '')}</tr>`).join('') : '<tr><td colspan="9" class="vacio">No hay nada listo para enviar.</td></tr>'}</tbody></table></div></div>
    <div id="resultado"></div>`;
  const info = () => {
    const sel = $$('[data-sel]:checked');
    const tot = sel.reduce((a, x) => a + Number(x.dataset.total), 0);
    $('#sel-info').textContent = sel.length ? `${sel.length} seleccionadas · ${$$m(tot)}` : '';
    $('#b-env').disabled = !sel.length;
  };
  $('#todas').onchange = (e) => { $$('[data-sel]').forEach(c => { c.checked = e.target.checked; }); info(); };
  $$('[data-sel]').forEach(c => c.onchange = info);
  $$('tr[data-id] td:not(:first-child)').forEach(td => { td.style.cursor = 'pointer'; td.onclick = () => { location.hash = '#/factura/' + td.parentElement.dataset.id; }; });
  $('#b-env').onclick = () => conBoton($('#b-env'), async () => {
    const ids = $$('[data-sel]:checked').map(c => Number(c.dataset.sel));
    if (!confirm(`¿Enviar ${ids.length} comprobante(s) a Shares?`)) return;
    const res = [];
    for (let i = 0; i < ids.length; i += 20) {
      $('#resultado').innerHTML = `<div class="panel panel-pad"><span class="cargando"></span> Enviando ${i + 1}–${Math.min(i + 20, ids.length)} de ${ids.length}…</div>`;
      res.push(...(await api('/api/shares/enviar', { method: 'POST', body: { ids: ids.slice(i, i + 20) } })).resultados);
    }
    const ok = res.filter(x => x.ok).length;
    await vistaShares(el);
    $('#resultado').innerHTML = `<div class="panel" style="margin-top:16px"><div class="panel-titulo"><h2>Resultado: ${ok} OK · ${res.length - ok} con error</h2></div>
      <table><tbody>${res.map(x => `<tr><td class="mono"><a href="#/factura/${x.id}">#${x.id}</a></td><td>${x.ok ? '<span class="badge b-ok">OK</span>' : '<span class="badge b-critica">Error</span>'}</td><td class="small">${esc(x.message || '')}</td><td class="mono small">${esc(x.shares_ref || '')}</td></tr>`).join('')}</tbody></table></div>`;
  });
}

// ---------------------------------------------------------------------------
//  Proveedores
// ---------------------------------------------------------------------------
async function vistaProveedores(el) {
  await cuentas().catch(() => null);
  el.innerHTML = `<div class="encabezado"><div><h1>Proveedores</h1><p>Maestro: CUIT, condición IVA, CBU, cuenta por defecto y reglas de imputación.</p></div>
    <div class="acciones">${puede('aprobador') ? '<button class="btn" id="b-nuevo">Nuevo proveedor</button>' : ''}${puede('admin') ? '<button class="btn btn-negro" id="b-imp">Importar Excel</button>' : ''}</div></div>
    <div class="panel"><div class="filtros"><div class="campo ancho"><label>Buscar</label><input id="q" placeholder="Razón social, CUIT o código Shares"></div></div>
    <div class="tabla-wrap"><table><thead><tr><th>Proveedor</th><th>CUIT</th><th>Cód. Shares</th><th>Cond. IVA</th><th>Cuenta por defecto</th><th>CBU</th><th>Lectura</th><th class="num">Facturas</th><th>Estado</th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  const cargar = async () => {
    const r = await api('/api/proveedores?q=' + encodeURIComponent($('#q').value.trim()));
    $('#tb').innerHTML = r.proveedores.length ? r.proveedores.map(p => `<tr class="click" data-cuit="${p.cuit}">
      <td>${esc(p.razon_social)}</td><td class="mono">${fmtCuit(p.cuit)}</td><td class="mono">${esc(p.codigo_shares || '—')}</td><td class="mono">${esc(p.condicion_iva ?? '—')}</td>
      <td><span class="mono">${esc(p.cuenta_default || '—')}</span> <span class="small muted">${esc(p.cuenta_denominacion || '')}</span></td>
      <td class="mono small">${p.cbu ? '···' + esc(p.cbu.slice(-6)) : '—'}</td><td>${p.config_version ? `<span class="badge b-ok">config v${p.config_version}</span>` : '<span class="badge b-aviso">sin configurar</span>'}</td><td class="num">${p.facturas}</td>
      <td>${p.activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">inactivo</span>'}</td></tr>`).join('')
      : '<tr><td colspan="9" class="vacio">No hay proveedores. Importá el maestro desde un Excel exportado de Shares.</td></tr>';
    $$('#tb tr[data-cuit]').forEach(tr => tr.onclick = async () => { const x = await api('/api/proveedores/' + tr.dataset.cuit); modalProveedor(x.proveedor, false, cargar, x); });
  };
  let deb;
  $('#q').oninput = () => { clearTimeout(deb); deb = setTimeout(cargar, 300); };
  const bn = $('#b-nuevo'); if (bn) bn.onclick = () => modalProveedor({}, true, cargar);
  const bi = $('#b-imp'); if (bi) bi.onclick = () => modalImportar('proveedores', cargar);
  await cargar();
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
        if (!confirm('¿Desactivar la configuración? La próxima factura de este proveedor se lee como si fuera nuevo.')) return;
        await api('/api/plantillas/' + b.dataset.desact, { method: 'PUT', body: { estado: 'desactivada' } }); toast('Configuración desactivada'); cerrar(); alGuardar && alGuardar();
      }));
      $$('[data-borrar-regla]', el).forEach(b => b.onclick = () => conBoton(b, async () => {
        if (!confirm('¿Borrar la regla?')) return;
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
  el.innerHTML = `<div class="encabezado"><div><h1>Administración</h1><p>Conexiones, usuarios, empresas, plan de cuentas, configuración fiscal y auditoría.</p></div></div>
    <div class="panel"><div class="tabs" id="atabs">${['Salud', 'Usuarios', 'Empresas', 'Cuentas', 'Configuración', 'Auditoría'].map((t, i) => `<button class="${i ? '' : 'activo'}" data-t="${i}">${t}</button>`).join('')}</div><div id="acont" class="panel-pad"></div></div>`;
  const tabs = [adminSalud, adminUsuarios, adminEmpresas, adminCuentas, adminConfig, adminAuditoria];
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
    ${fila(s.arca_cert && s.arca_modo !== 'off', 'ARCA (constatación de CAE)', `modo ${esc(s.arca_modo)} · certificado ${s.arca_cert ? 'cargado' : 'falta'}`, s.arca_modo !== 'off' ? 'arca' : '')}
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
      <td><select data-rol="${u.id}">${['carga', 'aprobador', 'admin'].map(x => `<option ${u.rol === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td>${u.totp_activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">no</span>'}</td>
      <td>${u.activo ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      <td class="acciones"><button class="btn btn-chico" data-pass="${u.id}">Resetear clave</button>${u.totp_activo ? `<button class="btn btn-chico" data-totp="${u.id}">Resetear 2FA</button>` : ''}<button class="btn btn-chico" data-act="${u.id}" data-v="${u.activo ? 0 : 1}">${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}
    </tbody></table><p class="small muted">Roles: <b>carga</b> resuelve excepciones · <b>aprobador</b> además envía a Shares y edita proveedores · <b>admin</b> todo, incluido CBU y configuración.</p>`;
  const put = (id, body) => api('/api/usuarios/' + id, { method: 'PUT', body }).then(() => { toast('Guardado'); adminUsuarios(el); }).catch(e => toast(e.message, true));
  $$('[data-rol]', el).forEach(s => s.onchange = () => put(s.dataset.rol, { rol: s.value }));
  $$('[data-act]', el).forEach(b => b.onclick = () => put(b.dataset.act, { activo: b.dataset.v === '1' }));
  $$('[data-totp]', el).forEach(b => b.onclick = () => confirm('¿Resetear el doble factor de este usuario?') && put(b.dataset.totp, { reset_totp: true }));
  $$('[data-pass]', el).forEach(b => b.onclick = async () => { const p = await pedirTexto({ titulo: 'Nueva contraseña', etiqueta: 'Contraseña (mínimo 10 caracteres)', boton: 'Guardar', minimo: 10 }); if (p) put(b.dataset.pass, { password: p }); });
  $('#b-nu', el).onclick = () => modal(`<h2>Nuevo usuario</h2><form id="f-nu">
      <div class="campo"><label>Nombre</label><input name="nombre" required></div>
      <div class="campo"><label>Email</label><input name="email" type="email" required></div>
      <div class="campo"><label>Rol</label><select name="rol"><option>carga</option><option>aprobador</option><option>admin</option></select></div>
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
  $$('[data-del]', el).forEach(b => b.onclick = () => confirm('¿Quitar esta empresa?') && conBoton(b, async () => { await api('/api/empresas/' + b.dataset.del, { method: 'DELETE' }); adminEmpresas(el); }));
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

const AYUDA_CFG = {
  tipos_shares: 'Tipo de comprobante ARCA → tipo_comprobante de Shares. "F" está probado; NC/ND a confirmar con Shares.',
  condicion_iva_por_letra: 'Condición IVA (código Shares) a usar según la letra si el proveedor no la tiene en el maestro. null = obligar a cargarla.',
  fiscal: 'Percepciones → ítem Shares (id_concepto_fc, codigo_concepto, total_key). Confirmá las cuentas de percepción IIBB con el plan de cuentas.',
  tolerancia_total: 'Diferencia máxima en $ entre la suma de componentes y el total.',
  dias_antiguedad_aviso: 'Facturas más viejas que esto generan un aviso.',
  ia_imputacion_requiere_ok: 'true = cuando la cuenta la sugiere Gemini, una persona la confirma.',
  arca_bloqueante: 'true = si ARCA está activo y no se pudo constatar, la factura no pasa.',
  fecha_contable: '"emision" o "recepcion".',
  max_cuentas_prompt: 'Cuántas cuentas se le pasan a Gemini para sugerir imputación (solo proveedores nuevos).',
};
async function adminConfig(el) {
  const r = await api('/api/config');
  el.innerHTML = Object.keys(r.defaults).map(k => `<div class="campo" style="margin-bottom:20px"><label class="mono">${k}</label><div class="ayuda" style="margin:0 0 6px">${esc(AYUDA_CFG[k] || '')}</div>
    <textarea data-cfg="${k}" class="mono" style="min-height:${typeof r.config[k] === 'object' ? 160 : 40}px;font-size:12px">${esc(JSON.stringify(r.config[k], null, 2))}</textarea>
    <div class="acciones" style="margin-top:6px"><button class="btn btn-chico btn-negro" data-guardar="${k}">Guardar</button><button class="btn btn-chico" data-def="${k}">Volver al default</button></div></div>`).join('');
  $$('[data-guardar]', el).forEach(b => b.onclick = () => conBoton(b, async () => {
    let v; try { v = JSON.parse($(`[data-cfg="${b.dataset.guardar}"]`, el).value); } catch { throw new Error('JSON inválido.'); }
    await api('/api/config', { method: 'PUT', body: { clave: b.dataset.guardar, valor: v } }); toast('Configuración guardada. Usá “Revalidar todas” en la bandeja para aplicarla.');
  }));
  $$('[data-def]', el).forEach(b => b.onclick = () => confirm('¿Volver al valor por defecto?') && conBoton(b, async () => { await api('/api/config', { method: 'PUT', body: { clave: b.dataset.def, valor: null } }); adminConfig(el); }));
}

async function adminAuditoria(el) {
  const r = await api('/api/auditoria');
  el.innerHTML = `<div class="tabla-wrap" style="max-height:65vh"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Entidad</th><th>Acción</th><th>Campo</th><th>Antes → Después</th></tr></thead><tbody>
    ${r.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${a.entidad === 'factura' ? `<a href="#/factura/${esc(a.entidad_id)}">factura #${esc(a.entidad_id)}</a>` : esc(a.entidad + ' ' + a.entidad_id)}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(a.campo || '')}</td><td class="small mono">${esc(String(a.valor_anterior ?? '').slice(0, 80))} → ${esc(String(a.valor_nuevo ?? '').slice(0, 80))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------------------
//  Mi cuenta: contraseña y doble factor
// ---------------------------------------------------------------------------
async function vistaMiCuenta(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Mi cuenta</h1><p>${esc(S.user.email)} · rol ${esc(S.user.rol)}</p></div></div>
    <div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:12px">Doble factor</h2>
      ${S.user.totp_activo ? '<p><span class="badge b-ok">Activo</span> Te vamos a pedir el código de tu app autenticadora al ingresar.</p>'
      : '<p class="muted">Usá Google Authenticator, Microsoft Authenticator o similar.</p><button class="btn btn-negro" id="b-2fa">Activar doble factor</button><div id="c-2fa"></div>'}
    </div>
    <form class="panel panel-pad" style="max-width:560px" id="f-pass"><h2 style="margin-bottom:12px">Cambiar contraseña</h2>
      <div class="campo"><label>Actual</label><input type="password" name="actual" required autocomplete="current-password"></div>
      <div class="campo"><label>Nueva (mínimo 10 caracteres)</label><input type="password" name="nueva" minlength="10" required autocomplete="new-password"></div>
      <button class="btn btn-negro" type="submit">Cambiar</button></form>`;
  $('#f-pass').onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/yo/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Contraseña cambiada'); }); };
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

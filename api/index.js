const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// Marcador de version (para verificar que Railway tiene el codigo nuevo)
app.get('/api/version', (req, res) => res.json({ version: 'v36-permisos-asistente', costo_congelado: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Middleware: exige usuario logueado (token de Supabase) ────────
// NUEVO v13: ademas del login, carga el ROL del usuario desde mml_roles.
// Si el email no esta en la tabla, queda como 'operador' (lo mas restrictivo).
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'No autorizado' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Sesion invalida' });
    req.authUser = data.user;
    try {
      const email = String(data.user.email || '').toLowerCase().trim();
      const { data: rolRow } = await supabase.from('mml_roles')
        .select('rol,pestanas,apps,acciones').eq('email', email).single();
      req.rol      = (rolRow && rolRow.rol) || 'operador';
      req.pestanas = (rolRow && rolRow.pestanas) || null;
      req.apps     = (rolRow && rolRow.apps) || null;
      req.acciones = (rolRow && rolRow.acciones) || null;
    } catch (e) {
      req.rol = 'operador';
      req.pestanas = null;
      req.apps = null;
      req.acciones = null;
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'No autorizado' });
  }
}

// ── Middleware: exige uno de estos roles (usar DESPUES de requireAuth) ──
// Ejemplo: app.get('/ruta', requireAuth, soloRoles('admin','encargado'), handler)
function soloRoles(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.rol)) return next();
    return res.status(403).json({ error: 'Sin permiso para esta seccion', rol: req.rol });
  };
}

// ── Middleware: exige tener HABILITADA una app de Pontec OS ────────
// Promociones y Asistente ya NO dependen de Rentabilidad ni del rol: se
// habilitan por usuario desde el panel de Usuarios del hub (campo "apps").
// Esta lista debe ser IGUAL a appsPorRol() del hub, para que lo que se ve
// en el menu y lo que deja hacer el backend nunca se contradigan.
function appsPorRol(rol) {
  if (rol === 'admin' || rol === 'encargado') return ['rentabilidad', 'logistica', 'promos', 'respondia', 'asistente'];
  return ['rentabilidad', 'logistica'];
}
function puedeApp(app) {
  return (req, res, next) => {
    if (req.rol === 'admin') return next();   // el admin siempre puede todo
    const habilitadas = (req.apps && req.apps.length) ? req.apps : appsPorRol(req.rol);
    if (habilitadas.includes(app)) return next();
    return res.status(403).json({
      error: 'Sin permiso para esta seccion',
      rol: req.rol,
      detalle: 'Tu usuario no tiene habilitado el modulo "' + app + '". Pediselo al admin en Pontec OS > Usuarios.'
    });
  };
}

// ══ PERMISOS FINOS DEL ASISTENTE ══════════════════════════════════
// Todos pueden usar el Asistente, pero cada usuario hace SOLO lo que
// tiene tildado en Pontec OS > Usuarios. Se guarda en mml_roles.acciones.
const ASIS_PERMISOS = {
  consultar:  'Consultar publicaciones y promos',
  ventas:     'Ver ventas y ganancias',
  desc_poner: 'Poner descuentos',
  desc_sacar: 'Sacar descuentos',
  desc_todos: 'Sacar TODOS los descuentos del catalogo',
  smart:      'Sumar productos a campanas SMART',
  fotos:      'Copiar fotos entre publicaciones',
  medidas:    'Cargar medidas de embalaje en ML'
};
// que permiso exige cada accion que entiende el asistente
const ASIS_ACCION_PERM = {
  buscar: 'consultar', ver_promos: 'consultar',
  ventas: 'ventas',
  aplicar_descuento: 'desc_poner',
  quitar_descuento: 'desc_sacar',
  quitar_todo: 'desc_todos',
  smart: 'smart', smart_aplicar: 'smart',
  clonar_fotos: 'fotos',
  medidas: 'medidas'
  // 'multi' se valida por dentro (cada sub-accion) y 'charla' no exige nada
};
// Default cuando el usuario no tiene nada tildado (respeta lo que ya podia hacer).
function accionesPorRol(rol) {
  if (rol === 'admin') return Object.keys(ASIS_PERMISOS);
  if (rol === 'encargado') return ['consultar', 'ventas'];
  return ['consultar'];
}
function permisosDe(req) {
  if (req.rol === 'admin') return Object.keys(ASIS_PERMISOS);  // el admin siempre todo
  return (req.acciones && req.acciones.length) ? req.acciones : accionesPorRol(req.rol);
}
// ¿puede ejecutar esta accion del asistente? Devuelve null si puede, o el texto del "no".
function noPuedeAccion(req, accion) {
  const perm = ASIS_ACCION_PERM[accion];
  if (!perm) return null;                       // charla / multi: no exigen permiso propio
  if (permisosDe(req).includes(perm)) return null;
  return 'No tenes permiso para: ' + ASIS_PERMISOS[perm] + '. Pediselo al admin en Pontec OS > Usuarios.';
}

// ── Quien soy: el frontend pregunta el rol para armar el menu ──────
app.get('/api/mi-rol', requireAuth, (req, res) => {
  res.json({ email: req.authUser.email, rol: req.rol, pestanas: req.pestanas, apps: req.apps,
    acciones: req.acciones, acciones_efectivas: permisosDe(req), catalogo_acciones: ASIS_PERMISOS });
});

// ══ USUARIOS v14 (solo admin): gestion del equipo desde el panel ══
// Crea el login en Supabase Auth Y la fila de rol en mml_roles de un saque.

// Listar equipo
app.get('/api/usuarios', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('mml_roles')
      .select('email,rol,pestanas,apps,acciones,user_id,creado').order('creado', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ usuarios: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear usuario (login + rol)
app.post('/api/usuarios', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const email    = String((req.body && req.body.email) || '').toLowerCase().trim();
    const password = String((req.body && req.body.password) || '');
    const rol      = String((req.body && req.body.rol) || 'operador');
    if (!email || email.indexOf('@') === -1) return res.status(400).json({ error: 'Email invalido' });
    if (password.length < 6) return res.status(400).json({ error: 'La contrasena debe tener 6 caracteres o mas' });
    if (['admin','encargado','operador'].indexOf(rol) === -1) return res.status(400).json({ error: 'Rol invalido' });

    const { data: created, error: eAuth } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true
    });
    let uid = created && created.user && created.user.id;
    if (eAuth) {
      const yaExiste = /already|registered|exists/i.test(eAuth.message || '');
      if (!yaExiste) return res.status(400).json({ error: 'No se pudo crear el login: ' + eAuth.message });
      // El login ya existia (quedo de antes): lo adoptamos -> buscamos su id,
      // le pisamos la contrasena con la nueva y le asignamos el rol.
      try {
        const { data: lu } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
        const u = lu && lu.users && lu.users.find(x => String(x.email || '').toLowerCase() === email);
        uid = u && u.id;
      } catch (e2) {}
      if (!uid) return res.status(400).json({ error: 'Ese email ya tiene login pero no pude ubicarlo para asignarle el rol' });
      const { error: ePw } = await supabase.auth.admin.updateUserById(uid, { password });
      if (ePw) return res.status(400).json({ error: 'El login ya existia y no pude actualizarle la contrasena: ' + ePw.message });
    }

    const { error: eRol } = await supabase.from('mml_roles')
      .upsert({ email, rol, user_id: uid || null }, { onConflict: 'email' });
    if (eRol) return res.status(500).json({ error: 'Login listo pero fallo el rol: ' + eRol.message });

    res.json({ ok: true, email, rol, adoptado: !!eAuth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cambiar rol
app.put('/api/usuarios', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();
    const rol   = String((req.body && req.body.rol) || '');
    if (!email || ['admin','encargado','operador'].indexOf(rol) === -1) return res.status(400).json({ error: 'Datos invalidos' });
    if (email === String(req.authUser.email || '').toLowerCase() && rol !== 'admin') {
      return res.status(400).json({ error: 'No podes sacarte el rol admin a vos mismo' });
    }
    const upd = { email, rol };
    if (req.body && ('pestanas' in req.body)) {
      const p = req.body.pestanas;
      const permitidas = ['resumen','ventas','graficos','top','alertas','reclamo','promos','config','usuarios'];
      if (p === null) upd.pestanas = null;
      else if (Array.isArray(p)) upd.pestanas = p.filter(x => permitidas.indexOf(String(x)) > -1);
      else return res.status(400).json({ error: 'pestanas debe ser lista o null' });
    }
    if (req.body && ('apps' in req.body)) {
      const a = req.body.apps;
      const appsOk = ['rentabilidad','logistica','promos','respondia','asistente'];
      if (a === null) upd.apps = null;
      else if (Array.isArray(a)) upd.apps = a.filter(x => appsOk.indexOf(String(x)) > -1);
      else return res.status(400).json({ error: 'apps debe ser lista o null' });
    }
    if (req.body && ('acciones' in req.body)) {
      const ac = req.body.acciones;
      const okAc = Object.keys(ASIS_PERMISOS);
      if (ac === null) upd.acciones = null;
      else if (Array.isArray(ac)) upd.acciones = ac.filter(x => okAc.indexOf(String(x)) > -1);
      else return res.status(400).json({ error: 'acciones debe ser lista o null' });
    }
    const { error } = await supabase.from('mml_roles').upsert(upd, { onConflict: 'email' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, email, rol });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar usuario (rol + login)
app.delete('/api/usuarios', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const email = String(req.query.email || (req.body && req.body.email) || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Falta email' });
    if (email === String(req.authUser.email || '').toLowerCase()) {
      return res.status(400).json({ error: 'No podes borrarte a vos mismo' });
    }
    const { data: row } = await supabase.from('mml_roles').select('user_id').eq('email', email).single();
    let uid = row && row.user_id;
    if (!uid) {
      try {
        const { data: lu } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
        const u = lu && lu.users && lu.users.find(x => String(x.email || '').toLowerCase() === email);
        uid = u && u.id;
      } catch (e2) {}
    }
    if (uid) { try { await supabase.auth.admin.deleteUser(uid); } catch (e3) {} }
    await supabase.from('mml_roles').delete().eq('email', email);
    res.json({ ok: true, email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ PROMOCIONES v15: central de descuentos de ML ═══════════════════
// Lectura: admin y encargado. Aplicar/quitar: SOLO admin.

// Campañas y promos disponibles del vendedor
app.get('/api/promos', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const r = await fetch(`https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Items de una promo (candidatos + activos)
app.get('/api/promos/items', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const { promotion_id, promotion_type } = req.query;
    if (!promotion_id || !promotion_type) return res.status(400).json({ error: 'Faltan promotion_id y promotion_type' });
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    let url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(promotion_id)}/items`
      + `?promotion_type=${encodeURIComponent(promotion_type)}&app_version=v2&limit=${Math.min(parseInt(req.query.limit) || 50, 50)}`;
    if (req.query.offset)       url += `&offset=${encodeURIComponent(req.query.offset)}`;
    if (req.query.search_after) url += `&search_after=${encodeURIComponent(req.query.search_after)}`;
    if (req.query.status_item)  url += `&status_item=${encodeURIComponent(req.query.status_item)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Titulos + SKU + precio de items (para mostrar lindo y cruzar con costos)
app.get('/api/promos/titulos', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({});
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const out = {};
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const url = 'https://api.mercadolibre.com/items?ids=' + chunk.join(',')
        + '&attributes=id,title,price,seller_sku,seller_custom_field,available_quantity';
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const arr = await r.json();
        (Array.isArray(arr) ? arr : []).forEach(row => {
          const b = row && row.body;
          if (b && b.id) out[b.id] = {
            title: b.title || '',
            sku: String(b.seller_sku || b.seller_custom_field || '').trim().toUpperCase(),
            price: b.price || 0,
            stock: b.available_quantity != null ? b.available_quantity : null
          };
        });
      } catch (e2) {}
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Promos activas de UN item
app.get('/api/promos/item/:item_id', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const r = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(req.params.item_id)}?app_version=v2`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aplicar oferta a un item (campaña o descuento individual PRICE_DISCOUNT)
app.post('/api/promos/aplicar', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = (req.body && req.body.user_id) || '67619515';
    const itemId = req.body && req.body.item_id;
    if (!itemId) return res.status(400).json({ error: 'Falta item_id' });
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });

    const body = {};
    if (req.body.deal_price != null)     body.deal_price = Number(req.body.deal_price);
    if (req.body.top_deal_price != null) body.top_deal_price = Number(req.body.top_deal_price);
    if (req.body.promotion_id)           body.promotion_id = String(req.body.promotion_id);
    if (req.body.promotion_type)         body.promotion_type = String(req.body.promotion_type);

    const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`;
    const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // POST crea la oferta; si ya existia, ML devuelve error -> probamos PUT (editar)
    let r = await fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
    let d; try { d = await r.json(); } catch (e2) { d = {}; }
    if (!r.ok) {
      const r2 = await fetch(url, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
      let d2; try { d2 = await r2.json(); } catch (e3) { d2 = {}; }
      if (r2.ok) return res.status(r2.status).json(d2);
      return res.status(r.status).json({ error: (d && (d.message || d.error)) || 'ML rechazo la oferta', detalle: d, detalle_put: d2 });
    }
    res.status(r.status).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Quitar oferta(s) de un item. Con promotion_type+promotion_id saca ESA;
// sin parametros saca TODAS las que se puedan (delete masivo de ML).
app.delete('/api/promos/quitar', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const itemId = req.query.item_id;
    if (!itemId) return res.status(400).json({ error: 'Falta item_id' });
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    let url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`;
    if (req.query.promotion_type) url += `&promotion_type=${encodeURIComponent(req.query.promotion_type)}`;
    if (req.query.promotion_id)   url += `&promotion_id=${encodeURIComponent(req.query.promotion_id)}`;
    const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    let d; try { d = await r.json(); } catch (e2) { d = { ok: r.ok }; }
    res.status(r.status).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ANALIZADOR v17: cruza campañas de ML contra costos Contabilium ══
// Cache de costos en memoria (6 hs): la primera corrida tarda ~1 min
// porque recorre todo Contabilium; las siguientes son instantaneas.
var _contaMapaCache = { ts: 0, mapa: null };
async function contabiliumMapaCostos() {
  const ahora = Date.now();
  if (_contaMapaCache.mapa && (ahora - _contaMapaCache.ts) < 6 * 60 * 60 * 1000) return _contaMapaCache.mapa;
  const token = await getContabiliumToken();
  const pageSize = 50;
  const base = 'https://rest.contabilium.com/api/conceptos/search';
  const PAUSA = 500;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getPage = async (param, n) => {
    const r = await fetch(`${base}?pageSize=${pageSize}&${param}=${n}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.json();
  };
  const primerCod = d => { const it = (d && (d.Items || d.items)) || []; return it.length ? String(it[0].Codigo || it[0].codigo || '').toUpperCase().trim() : ''; };
  const mapa = {};
  const add = d => {
    const it = (d && (d.Items || d.items)) || [];
    let n = 0;
    for (const x of it) {
      const c = String(x.Codigo || x.codigo || '').toUpperCase().trim();
      if (c && !(c in mapa)) { mapa[c] = Number(x.CostoInterno || x.costoInterno || 0); n++; }
    }
    return { n, len: it.length };
  };
  const d1 = await getPage('pageNumber', 1);
  const cod1 = primerCod(d1);
  add(d1);
  let pageParam = null;
  for (const cand of ['pageNumber', 'page', 'nroPagina', 'pagina', 'nroPag', 'pageIndex']) {
    await sleep(PAUSA);
    const d2 = await getPage(cand, 2);
    const cod2 = primerCod(d2);
    if (cod2 && cod2 !== cod1) { pageParam = cand; add(d2); break; }
  }
  if (pageParam) {
    let page = 3;
    while (true) {
      await sleep(PAUSA);
      const d = await getPage(pageParam, page);
      const { n, len } = add(d);
      if (len === 0 || n === 0 || len < pageSize) break;
      page++;
      if (page > 500) break;
    }
  }
  _contaMapaCache = { ts: Date.now(), mapa };
  console.log('[ANALISIS] costos Contabilium en cache:', Object.keys(mapa).length);
  return mapa;
}

// Titulo + SKU de items en lotes de 20
async function itemsMini(ids, token) {
  const out = {};
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const r = await fetch('https://api.mercadolibre.com/items?ids=' + chunk.join(',') + '&attributes=id,title,price,seller_sku,seller_custom_field,attributes', {
        headers: { Authorization: 'Bearer ' + token }
      });
      const arr = await r.json();
      (Array.isArray(arr) ? arr : []).forEach(row => {
        const b = row && row.body;
        if (b && b.id) {
          let sku = String(b.seller_sku || b.seller_custom_field || '').trim().toUpperCase();
          if (!sku && Array.isArray(b.attributes)) {
            const at = b.attributes.find(a => a && a.id === 'SELLER_SKU');
            if (at) sku = String(at.value_name || at.value_id || '').trim().toUpperCase();
          }
          out[b.id] = { title: b.title || '', price: b.price || 0, sku };
        }
      });
    } catch (e) {}
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

// GET /api/promos/analisis -> recorre TODAS las campañas y devuelve
// cada item con precio actual, sugerido de ML y costo de Contabilium.
app.get('/api/promos/analisis', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const maxPag = Math.min(parseInt(req.query.max_paginas) || 4, 10);
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });

    const rc = await fetch(`https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const dc = await rc.json();
    const campanas = (dc.results || []).filter(p => p && p.id && p.type);

    const filas = [];
    let campOk = 0;
    for (const p of campanas) {
      try {
        for (let pag = 0; pag < maxPag; pag++) {
          const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(p.id)}/items`
            + `?promotion_type=${encodeURIComponent(p.type)}&app_version=v2&limit=50&offset=${pag * 50}`;
          const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
          const d = await r.json();
          const items = d.results || d.items || [];
          for (const it of items) {
            filas.push({
              item_id: it.id, campana: p.name || p.id, tipo: p.type, promo_id: p.id,
              estado: it.status || '',
              precio_actual: it.original_price || it.price || 0,
              sugerido: it.suggested_discounted_price || null,
              minimo: it.min_discounted_price || null,
              maximo: it.max_discounted_price || null
            });
            if (filas.length >= 1500) break;
          }
          if (items.length < 50 || filas.length >= 1500) break;
          await new Promise(r => setTimeout(r, 150));
        }
        campOk++;
      } catch (e) { console.error('[ANALISIS] campana', p.id, e.message); }
      if (filas.length >= 1500) break;
    }

    const ids = [...new Set(filas.map(f => f.item_id).filter(Boolean))];
    const mini = await itemsMini(ids, token);
    const mapa = await contabiliumMapaCostos();
    let sinCosto = 0;
    for (const f of filas) {
      const m = mini[f.item_id] || {};
      f.titulo = m.title || '';
      f.sku = m.sku || '';
      f.costo = (f.sku && (f.sku in mapa) && mapa[f.sku] > 0) ? mapa[f.sku] : null;
      if (f.costo == null) sinCosto++;
    }

    console.log(`[ANALISIS] ${campOk} campanas, ${filas.length} items, ${sinCosto} sin costo`);
    res.json({ filas, campanas: campOk, items: filas.length, sin_costo: sinCosto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ASISTENTE v18: ordenes en lenguaje natural ═════════════════════
// Interpreta con Claude (ANTHROPIC_API_KEY en Railway), muestra que va
// a tocar, y SOLO ejecuta cuando el usuario confirma con el boton.
const ASISTENTE_SYS = `Sos el Asistente de Pontec OS, el sistema interno de PONTEC SA (vendedor grande de MercadoLibre Argentina).
Tu unico trabajo es interpretar el pedido del usuario y responder SOLO un JSON valido, sin markdown ni texto extra, con esta forma:
{"accion":"...","parametros":{...},"respuesta":"texto corto para el usuario"}

Acciones disponibles:
- "quitar_descuento": parametros {"sku":"..."} o {"item_id":"MLA..."} -> saca los descuentos de las publicaciones de ese SKU
- "aplicar_descuento": parametros {"sku" o "item_id"} mas UNO de estos dos: {"precio": numero} (precio final deseado) o {"porcentaje": numero} (ej "10% de descuento" -> {"porcentaje":10}) -> aplica descuento individual; opcional {"dias": numero} si el usuario dice por cuantos dias
- "ver_promos": parametros {"sku" o "item_id"} -> lista las promociones activas
- "buscar": parametros {"sku":"..."} -> lista las publicaciones de un SKU con precio
- "ventas": parametros {"sku": opcional, "dias": numero opcional (default 30)} -> resumen de MIS ventas: cantidad, unidades, facturacion y ganancia aprox. "cuanto vendi del X este mes" -> {"sku":"X","dias":30}
- "medidas": parametros {"sku":"..."} -> declara en ML las medidas de embalaje (largo/ancho/alto/peso) que figuran en la planilla de medidas de Pontec
- "clonar_fotos": parametros {"origen":"MLA... (publicacion de la que copiar)"} y destino {"sku":"..."} (o {"item_id":"MLA..."}) -> copia las fotos de una publicacion a las demas del SKU
- "smart": parametros {"max_mi_parte": numero} -> busca en las campanas co-participadas (SMART y similares) las propuestas donde TU parte del descuento es hasta ese % y MercadoLibre aporta el resto. "mandame los que me piden hasta 13% de mi parte" -> {"max_mi_parte":13}
- "quitar_todo": sin parametros -> SOLO cuando el usuario pide explicitamente sacar TODOS los descuentos de TODOS los productos del catalogo
- "multi": parametros {"acciones":[{"accion":"quitar_descuento","parametros":{...}},{"accion":"aplicar_descuento","parametros":{...}}]} -> cuando el usuario pide VARIAS cosas en un mismo mensaje (solo combina quitar_descuento y aplicar_descuento)
- "charla": sin parametros -> saludos, dudas, o cuando falta un dato; lo que quieras decir va en "respuesta"

Reglas:
- Los SKU de Pontec son codigos tipo OFI210-BL o AIR010-NE: letras+numeros y a veces sufijo de color (NE=negro, BL=blanco, AZ=azul, RO=rojo, GR=gris, VE=verde, MA=marron, CO=cobre). Si el usuario dice "la silla ofi 210 blanca", el SKU es OFI210-BL.
- Si el usuario dice un porcentaje de descuento, mandalo como "porcentaje"; NO le pidas el precio final.\n- Para clonar_fotos hace falta saber DE QUE publicacion copiar (un codigo MLA...). Si el usuario no lo dijo, pedilo con "charla".
- El descuento individual dura maximo 14 dias (limite de ML); si piden mas, avisalo en "respuesta" y usa dias=14.
- Si para aplicar_descuento no hay ni precio ni porcentaje, usa "charla" y pedi uno de los dos.
- Nunca inventes precios ni SKUs que el usuario no dijo.
- "respuesta" siempre en espanol rioplatense informal y corta.`;

async function asistenteLLM(mensajes) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'Falta la variable ANTHROPIC_API_KEY en Railway' };
  const model = process.env.ASISTENTE_MODEL || 'claude-sonnet-4-6';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 3000, system: ASISTENTE_SYS,
      messages: mensajes.map(m => ({ role: m.rol === 'user' ? 'user' : 'assistant', content: String(m.texto || '').slice(0, 8000) }))
    })
  });
  const d = await r.json();
  if (d.error) return { error: 'Anthropic: ' + (d.error.message || JSON.stringify(d.error)) };
  const txt = (d.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
  try { return { json: JSON.parse(txt) }; }
  catch (e) { return { json: { accion: 'charla', respuesta: txt || 'No te entendi, proba de nuevo.' } }; }
}

async function asistenteResolverItems(p, userId, token) {
  if (p.item_id) return [String(p.item_id).toUpperCase().trim()];
  const sku = String(p.sku || '').toUpperCase().trim();
  if (!sku) return [];
  for (const param of ['seller_sku', 'sku']) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/users/${userId}/items/search?${param}=${encodeURIComponent(sku)}&status=active`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      const d = await r.json();
      if (Array.isArray(d.results) && d.results.length) return d.results.slice(0, 20);
    } catch (e) {}
  }
  return [];
}

// Consulta de ventas propias (solo lectura, desde la base de MargenML)
async function asistenteVentas(p, userId) {
  try {
    const dias = Math.min(Math.max(parseInt(p.dias) || 30, 1), 365);
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    const sku = p.sku ? String(p.sku).toUpperCase().trim() : null;
    let rows = [], off = 0;
    while (off < 6000) {
      let q = supabase.from('ventas')
        .select('sku,unidades,precio,comision,costo_envio,precio_comprador_envio,costo_congelado,costo_financiero,estado')
        .eq('user_id', String(userId)).gte('fecha', desde).range(off, off + 999);
      if (sku) q = q.ilike('sku', sku);
      const { data: d, error } = await q;
      if (error) return 'Error consultando ventas: ' + error.message;
      rows = rows.concat(d || []);
      if (!d || d.length < 1000) break;
      off += 1000;
    }
    const validas = rows.filter(x => x.estado !== 'cancelled');
    if (!validas.length) return 'No encontre ventas' + (sku ? ' de ' + sku : '') + ' en los ultimos ' + dias + ' dias.';
    let un = 0, fact = 0, gan = 0, conCosto = 0;
    for (const x of validas) {
      un += Number(x.unidades) || 0;
      fact += Number(x.precio) || 0;
      if (x.costo_congelado != null) {
        gan += (Number(x.precio) || 0) - (Number(x.comision) || 0)
          - ((Number(x.costo_envio) || 0) - (Number(x.precio_comprador_envio) || 0))
          - (Number(x.costo_congelado) || 0) - (Number(x.costo_financiero) || 0);
        conCosto++;
      }
    }
    const canc = rows.length - validas.length;
    let txt = 'Ultimos ' + dias + ' dias' + (sku ? ' de ' + sku : '') + ':\n- ' + validas.length + ' venta(s), ' + un + ' unidad(es)\n- Facturacion: $' + Math.round(fact).toLocaleString();
    if (conCosto) txt += '\n- Ganancia aprox (' + conCosto + ' ventas con costo): $' + Math.round(gan).toLocaleString() + (fact > 0 ? ' (' + (gan / fact * 100).toFixed(1) + '% s/facturacion)' : '');
    txt += '\n(aprox: no descuenta IIBB ni publicidad' + (canc ? '; ' + canc + ' cancelada(s) excluidas' : '') + ')';
    return txt;
  } catch (e) { return 'Error: ' + e.message; }
}

// Medidas de un SKU desde la planilla publicada (misma fuente que /api/medidas)
async function medidasDeSku(sku) {
  try {
    const ahora = Date.now();
    if (!_medidasCache || (ahora - _medidasTs) > 5 * 60 * 1000) {
      const r = await fetch(MEDIDAS_CSV_URL);
      const text = await r.text();
      const map = buildMedidas(text);
      if (Object.keys(map).length > 0) { _medidasCache = map; _medidasTs = ahora; }
    }
    return (_medidasCache && _medidasCache[String(sku).toUpperCase().trim()]) || null;
  } catch (e) { return null; }
}

// Fecha en formato local de ML (sin zona horaria; solo cuenta el dia)
function fechaLocalAR(masDias) {
  const t = new Date(Date.now() - 3 * 3600 * 1000 + (masDias || 0) * 864e5);
  const p = n => String(n).padStart(2, '0');
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + 'T00:00:00';
}

// Errores de ML: el motivo real viene en el array "cause", no en el mensaje
function mlErrDetalle(d) {
  if (!d) return 'ML lo rechazo sin detalle';
  let t = d.message || d.error || 'ML lo rechazo sin detalle';
  if (Array.isArray(d.cause) && d.cause.length) {
    const cs = d.cause.map(c => (c && (c.message || c.code)) || '').filter(Boolean).slice(0, 3);
    if (cs.length) t += ': ' + cs.join(' | ');
  }
  return String(t).slice(0, 240);
}

async function asistenteEjecutar(acc, userId, token) {
  const p = acc.parametros || {};
  const ids = Array.isArray(acc.items) && acc.items.length ? acc.items : await asistenteResolverItems(p, userId, token);
  if (!ids.length) return { texto: 'No encontre publicaciones para ese SKU/item.' };
  const mini = await itemsMini(ids, token);
  const lineas = [];
  for (const id of ids) {
    const t = (mini[id] && mini[id].title) ? mini[id].title.slice(0, 42) : id;
    try {
      if (acc.accion === 'quitar_descuento') {
        // Mira que promos activas tiene y las baja UNA POR UNA por tipo+campana
        const rp = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`, {
          headers: { Authorization: 'Bearer ' + token }
        });
        let dp; try { dp = await rp.json(); } catch (e2) { dp = []; }
        const todasP = Array.isArray(dp) ? dp : (dp.results || []);
        const activas = todasP.filter(x => ['started', 'active', 'pending', 'programmed', 'scheduled'].indexOf(x.status) > -1);
        if (!activas.length) {
          lineas.push('OK - ' + t + ' (no tenia ofertas activas)');
        } else {
          const partes = [];
          for (const pr of activas) {
            let urlDel = `https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2&promotion_type=${encodeURIComponent(pr.type)}`;
            if (pr.id) urlDel += `&promotion_id=${encodeURIComponent(pr.id)}`;
            try {
              const rd = await fetch(urlDel, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
              let dd; try { dd = await rd.json(); } catch (e3) { dd = {}; }
              if (rd.ok) partes.push('quite ' + pr.type);
              else partes.push(pr.type + ' NO: ' + ((dd && (dd.message || dd.error)) || ('HTTP ' + rd.status)));
            } catch (e4) { partes.push(pr.type + ' NO: ' + e4.message); }
            await new Promise(rs => setTimeout(rs, 150));
          }
          const fallo = partes.some(x => x.indexOf(' NO: ') > -1);
          lineas.push((fallo ? 'PARCIAL - ' : 'OK - ') + t + ' (' + partes.join('; ') + ')');
        }
      } else if (acc.accion === 'aplicar_descuento') {
        const precioFinal = (acc.precios && acc.precios[id] != null) ? Number(acc.precios[id]) : Number(p.precio);
        const diasE = Math.min(Math.max(parseInt(p.dias) || 14, 1), 14);
        const body = { deal_price: precioFinal, promotion_type: 'PRICE_DISCOUNT',
          start_date: fechaLocalAR(0), finish_date: fechaLocalAR(diasE - 1) };
        const url = `https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`;
        const hdr = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
        let r = await fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
        let d1; try { d1 = await r.json(); } catch (e5) { d1 = {}; }
        if (!r.ok) {
          r = await fetch(url, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
          try { d1 = await r.json(); } catch (e6) { d1 = {}; }
        }
        lineas.push((r.ok ? 'OK - ' : 'ERROR - ') + t + (r.ok
          ? ' -> $' + Math.round(precioFinal).toLocaleString()
          : ' (' + mlErrDetalle(d1) + ')'));
      } else if (acc.accion === 'medidas') {
        const md = acc.medidas || {};
        const bodyM = { attributes: [
          { id: 'SELLER_PACKAGE_LENGTH', value_name: md.L + ' cm' },
          { id: 'SELLER_PACKAGE_WIDTH',  value_name: md.A + ' cm' },
          { id: 'SELLER_PACKAGE_HEIGHT', value_name: md.H + ' cm' },
          { id: 'SELLER_PACKAGE_WEIGHT', value_name: md.G + ' g' }
        ] };
        const rM = await fetch('https://api.mercadolibre.com/items/' + id, {
          method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyM)
        });
        let dM; try { dM = await rM.json(); } catch (e7) { dM = {}; }
        let extraM = '';
        if (!rM.ok && /too small/i.test(mlErrDetalle(dM))) {
          // ML dice que el paquete es mas chico que el PRODUCTO: mostrar que declara la ficha
          try {
            const rA = await fetch('https://api.mercadolibre.com/items/' + id + '?attributes=attributes', {
              headers: { Authorization: 'Bearer ' + token }
            });
            const dA = await rA.json();
            const attrsA = dA.attributes || [];
            const paq = attrsA.filter(a => a && /^SELLER_PACKAGE_/i.test(a.id || ''))
              .map(a => String(a.id).replace('SELLER_PACKAGE_', '') + '=' + (a.value_name || '?'));
            const prod = attrsA.filter(a => a && /LENGTH|WIDTH|HEIGHT|WEIGHT|DEPTH|DIAMETER/i.test(a.id || '') && !/^SELLER_PACKAGE/i.test(a.id || ''))
              .slice(0, 5).map(a => a.id + '=' + (a.value_name || '?'));
            const partes = [];
            if (paq.length) partes.push('ML ya registra el paquete: ' + paq.join(', ') + ' (si en la web figura "verificado", ML lo midio y esta BLOQUEADO: no se puede cambiar)');
            if (prod.length) partes.push('Ficha del producto: ' + prod.join(', '));
            if (partes.length) extraM = '\n   ' + partes.join('\n   ');
          } catch (eX) {}
        }
        lineas.push((rM.ok ? 'OK - ' : 'ERROR - ') + t + (rM.ok ? ' (medidas declaradas)' : ' (' + mlErrDetalle(dM) + ')') + extraM);
      } else if (acc.accion === 'clonar_fotos') {
        const rF = await fetch('https://api.mercadolibre.com/items/' + id, {
          method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ pictures: acc.fotos || [] })
        });
        let dF; try { dF = await rF.json(); } catch (e8) { dF = {}; }
        lineas.push((rF.ok ? 'OK - ' : 'ERROR - ') + t + (rF.ok ? ' (' + (acc.fotos || []).length + ' fotos)' : ' (' + mlErrDetalle(dF) + ')'));
      } else {
        lineas.push('Accion desconocida: ' + acc.accion);
      }
    } catch (e) { lineas.push('ERROR - ' + t + ': ' + e.message); }
    await new Promise(rs => setTimeout(rs, 200));
  }
  return { texto: lineas.join('\n') };
}

async function asistenteVerPromos(p, userId, token) {
  const ids = await asistenteResolverItems(p, userId, token);
  if (!ids.length) return 'No encontre publicaciones para ese SKU/item.';
  const mini = await itemsMini(ids, token);
  const lineas = [];
  for (const id of ids.slice(0, 10)) {
    const t = (mini[id] && mini[id].title) ? mini[id].title.slice(0, 42) : id;
    try {
      const r = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      const d = await r.json();
      const arr = Array.isArray(d) ? d : (d.results || []);
      const activas = arr.filter(x => x.status === 'started' || x.status === 'active');
      const cand = arr.length - activas.length;
      if (!arr.length) lineas.push(t + ': sin promociones');
      else lineas.push(t + ': ' + (activas.length ? 'ACTIVA: ' + activas.map(x => x.type).join(', ') : 'sin promos activas') + (cand ? ' (+' + cand + ' campana/s disponibles sin aplicar)' : ''));
    } catch (e) { lineas.push(t + ': error al consultar'); }
  }
  return lineas.join('\n');
}

app.post('/api/asistente', requireAuth, puedeApp('asistente'), async (req, res) => {
  try {
    const userId = (req.body && req.body.user_id) || '67619515';
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const esAdmin = req.rol === 'admin';
    const puedeSmart = permisosDe(req).includes('smart');

    // Boton Confirmar: ejecuta la accion pendiente tal cual se mostro
    const conf = req.body && req.body.confirmar;
    if (conf && conf.accion) {
      const noC = noPuedeAccion(req, conf.accion === 'multi' ? 'charla' : conf.accion);
      if (noC) return res.json({ respuesta: noC });
      // en un "multi" revisamos cada sub-accion por separado
      if (conf.accion === 'multi' && Array.isArray(conf.acciones)) {
        for (const sub of conf.acciones) {
          const noS = noPuedeAccion(req, sub.accion);
          if (noS) return res.json({ respuesta: noS });
        }
      }
      if (conf.accion === 'smart_aplicar' && Array.isArray(conf.objetivos)) {
        let okS = 0, errS = 0;
        const erroresS = [];
        for (const o of conf.objetivos) {
          try {
            const bodyS = { promotion_id: String(o.promo_id), promotion_type: String(o.type) };
            if (o.sug > 0) bodyS.deal_price = Number(o.sug);
            const rA = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(o.item)}?app_version=v2`, {
              method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyS)
            });
            if (rA.ok) okS++;
            else {
              errS++;
              if (erroresS.length < 5) {
                let dA; try { dA = await rA.json(); } catch (e9) { dA = {}; }
                erroresS.push(o.item + ': ' + ((dA && (dA.message || dA.error)) || ('HTTP ' + rA.status)));
              }
            }
          } catch (eA) { errS++; if (erroresS.length < 5) erroresS.push(o.item + ': ' + eA.message); }
          await new Promise(rs => setTimeout(rs, 200));
        }
        return res.json({ respuesta: 'Listo: ' + okS + ' producto(s) sumado(s) a sus campanas' + (errS ? ', ' + errS + ' con error' : '') + '.'
          + (erroresS.length ? '\nPrimeros errores:\n- ' + erroresS.join('\n- ') : '') });
      }
      if (conf.accion === 'quitar_todo' && Array.isArray(conf.objetivos)) {
        let ok = 0, err = 0;
        const errores = [];
        for (const o of conf.objetivos) {
          try {
            let urlD = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(o.item)}?app_version=v2&promotion_type=${encodeURIComponent(o.type)}`;
            if (o.promo_id) urlD += `&promotion_id=${encodeURIComponent(o.promo_id)}`;
            const rD = await fetch(urlD, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
            if (rD.ok) ok++;
            else {
              err++;
              if (errores.length < 5) {
                let dD; try { dD = await rD.json(); } catch (e5) { dD = {}; }
                errores.push(o.item + ' (' + o.type + '): ' + ((dD && (dD.message || dD.error)) || ('HTTP ' + rD.status)));
              }
            }
          } catch (e6) { err++; if (errores.length < 5) errores.push(o.item + ': ' + e6.message); }
          await new Promise(rs => setTimeout(rs, 150));
        }
        return res.json({ respuesta: 'Listo: ' + ok + ' promocion(es) quitada(s)' + (err ? ', ' + err + ' con error' : '') + '.'
          + (errores.length ? '\nPrimeros errores:\n- ' + errores.join('\n- ') : '')
          + '\nSi habia mas tandas, repeti la orden para seguir.' });
      }
      if (conf.accion === 'multi' && Array.isArray(conf.acciones)) {
        const partes = [];
        for (const sub of conf.acciones) {
          const out = await asistenteEjecutar(sub, userId, token);
          partes.push(out.texto);
        }
        return res.json({ respuesta: partes.join('\n') });
      }
      const out = await asistenteEjecutar(conf, userId, token);
      return res.json({ respuesta: out.texto });
    }

    const mensajes = (req.body && req.body.mensajes) || [];
    if (!mensajes.length) return res.status(400).json({ error: 'Faltan mensajes' });

    const llm = await asistenteLLM(mensajes.slice(-12));
    if (llm.error) return res.status(500).json({ error: llm.error });
    const j = llm.json || {};
    const p = j.parametros || {};

    // Permisos finos: cada accion exige su tilde en Pontec OS > Usuarios
    const noP = noPuedeAccion(req, j.accion);
    if (noP) return res.json({ respuesta: noP });
    if (j.accion === 'multi' && Array.isArray((j.parametros || {}).acciones)) {
      for (const sub of j.parametros.acciones) {
        const noS = noPuedeAccion(req, sub.accion);
        if (noS) return res.json({ respuesta: noS });
      }
    }

    if (j.accion === 'ventas') {
      return res.json({ respuesta: await asistenteVentas(p, userId) });
    }

    if (j.accion === 'medidas') {
      const skuM = String(p.sku || '').toUpperCase().trim();
      if (!skuM) return res.json({ respuesta: 'De que SKU cargo las medidas?' });
      const m = await medidasDeSku(skuM);
      if (!m) return res.json({ respuesta: 'No encontre a ' + skuM + ' en la planilla de medidas.' });
      const L = Math.ceil(m.largo), A = Math.ceil(m.ancho), H = Math.ceil(m.alto);
      const pesoCrudo = (m.peso || m.kgEnvio) || 0;
      // La planilla mezcla unidades: <=100 se toma como KG, >100 como gramos ya expresados
      const G = Math.ceil(pesoCrudo > 100 ? pesoCrudo : pesoCrudo * 1000);
      if (!(L > 0 && A > 0 && H > 0 && G > 0)) return res.json({ respuesta: 'Las medidas de ' + skuM + ' estan incompletas en la planilla (largo/ancho/alto/peso).' });
      const idsM = await asistenteResolverItems({ sku: skuM }, userId, token);
      if (!idsM.length) return res.json({ respuesta: 'No encontre publicaciones activas de ' + skuM + '.' });
      const miniM = await itemsMini(idsM, token);
      const listaM = idsM.map(id => '- ' + ((miniM[id] && miniM[id].title) ? miniM[id].title.slice(0, 48) : id)).join('\n');
      return res.json({
        respuesta: 'Voy a declarar en ' + idsM.length + ' publicacion(es) de ' + skuM + ': ' + L + 'x' + A + 'x' + H + ' cm, ' + G + ' g:\n' + listaM,
        pendiente: { accion: 'medidas', parametros: { sku: skuM }, items: idsM, medidas: { L, A, H, G } }
      });
    }

    if (j.accion === 'clonar_fotos') {
      const origen = String(p.origen || '').toUpperCase().trim();
      if (!/^MLA\d+$/.test(origen)) return res.json({ respuesta: j.respuesta || 'Decime de que publicacion copio las fotos (el codigo MLA...).' });
      const rO = await fetch('https://api.mercadolibre.com/items/' + origen + '?attributes=id,title,pictures', { headers: { Authorization: 'Bearer ' + token } });
      const dO = await rO.json();
      const fotos = (dO.pictures || []).map(x => ({ id: x.id })).filter(x => x.id);
      if (!fotos.length) return res.json({ respuesta: 'La publicacion ' + origen + ' no tiene fotos para copiar.' });
      let destinos = p.item_id ? [String(p.item_id).toUpperCase().trim()] : await asistenteResolverItems({ sku: p.sku }, userId, token);
      destinos = destinos.filter(x => x !== origen);
      if (!destinos.length) return res.json({ respuesta: 'No encontre otras publicaciones destino (el origen no cuenta).' });
      const conVar = {}, sinVar = [];
      for (let i = 0; i < destinos.length; i += 20) {
        const chunk = destinos.slice(i, i + 20);
        try {
          const rV = await fetch('https://api.mercadolibre.com/items?ids=' + chunk.join(',') + '&attributes=id,variations', { headers: { Authorization: 'Bearer ' + token } });
          const aV = await rV.json();
          (Array.isArray(aV) ? aV : []).forEach(row => {
            const b = row && row.body;
            if (b && b.id) { if (Array.isArray(b.variations) && b.variations.length) conVar[b.id] = 1; else sinVar.push(b.id); }
          });
        } catch (eV) {}
      }
      if (!sinVar.length) return res.json({ respuesta: 'Las publicaciones destino tienen variantes; el clonado a publicaciones con variantes viene en la proxima version.' });
      const miniF = await itemsMini(sinVar, token);
      const listaF = sinVar.map(id => '- ' + ((miniF[id] && miniF[id].title) ? miniF[id].title.slice(0, 48) : id)).join('\n');
      const nVar = Object.keys(conVar).length;
      return res.json({
        respuesta: 'Voy a copiar ' + fotos.length + ' foto(s) de "' + String(dO.title || origen).slice(0, 40) + '" a ' + sinVar.length + ' publicacion(es):\n' + listaF + (nVar ? '\n(' + nVar + ' con variantes: las salteo por ahora)' : ''),
        pendiente: { accion: 'clonar_fotos', parametros: p, items: sinVar, fotos }
      });
    }

    if (j.accion === 'smart') {
      const maxMi = Number(p.max_mi_parte);
      if (!(maxMi > 0 && maxMi <= 100)) return res.json({ respuesta: 'Hasta que porcentaje pones vos? Ej: "hasta 13% de mi parte".' });
      const rcS = await fetch(`https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      const dcS = await rcS.json();
      const promosS = (dcS.results || []).filter(x => x && x.id && x.type);
      const props = [];
      let masHayS = false;
      for (const pr of promosS) {
        for (let pag = 0; pag < 8; pag++) {
          if (props.length >= 60) { masHayS = true; break; }
          let itemsS = [];
          try {
            const rS = await fetch(`https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(pr.id)}/items`
              + `?promotion_type=${encodeURIComponent(pr.type)}&app_version=v2&limit=50&offset=${pag * 50}`, {
              headers: { Authorization: 'Bearer ' + token }
            });
            const dS = await rS.json();
            itemsS = dS.results || dS.items || [];
          } catch (eS) { break; }
          for (const it of itemsS) {
            if (it.status !== 'candidate') continue;
            const ben = it.benefits || {};
            const mi = (ben.seller_percent != null) ? Number(ben.seller_percent)
              : (it.seller_percentage != null ? Number(it.seller_percentage) : null);
            const ml = (ben.meli_percent != null) ? Number(ben.meli_percent)
              : (it.meli_percentage != null ? Number(it.meli_percentage) : null);
            if (mi == null || !(ml > 0)) continue;
            if (mi > maxMi) continue;
            props.push({ item: it.id, promo_id: pr.id, type: pr.type, campana: String(pr.name || pr.id).slice(0, 25),
              price: it.original_price || it.price || 0, sug: it.suggested_discounted_price || null, mi, ml });
            if (props.length >= 60) { masHayS = true; break; }
          }
          if (itemsS.length < 50) break;
          await new Promise(rs => setTimeout(rs, 150));
        }
        if (props.length >= 60) break;
      }
      if (!props.length) return res.json({ respuesta: 'No encontre propuestas co-participadas donde tu parte sea hasta ' + maxMi + '% con aporte de ML.' });
      const miniS = await itemsMini(props.map(x => x.item), token);
      const lineasS = props.map(x => {
        const t = (miniS[x.item] && (miniS[x.item].sku ? miniS[x.item].sku + ' - ' : '') + (miniS[x.item].title || '').slice(0, 34)) || x.item;
        return '- ' + t + ': vos ' + x.mi + '% + ML ' + x.ml + '%' + (x.sug ? ' -> $' + Math.round(x.sug).toLocaleString() : '') + (x.price ? ' (de $' + Math.round(x.price).toLocaleString() + ')' : '') + ' [' + x.campana + ']';
      }).join('\n');
      const resp = 'Encontre ' + props.length + ' propuesta(s) donde pones hasta ' + maxMi + '% y ML aporta el resto:\n' + lineasS
        + (masHayS ? '\n(Hay mas: proceso estas primero.)' : '')
        + (puedeSmart ? '\nConfirmas para sumarlas TODAS a sus campanas?' : '\n(Solo lectura: no tenes permiso para sumarlas.)');
      const out = { respuesta: resp };
      if (puedeSmart) out.pendiente = { accion: 'smart_aplicar', objetivos: props.map(x => ({ item: x.item, promo_id: x.promo_id, type: x.type, sug: x.sug })) };
      return res.json(out);
    }

    if (j.accion === 'quitar_todo') {
      const rc2 = await fetch(`https://api.mercadolibre.com/seller-promotions/users/${userId}?app_version=v2`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      const dc2 = await rc2.json();
      const promos = (dc2.results || []).filter(x => x && x.id && x.type);
      const objetivos = [];
      const porCampana = {};
      const vistos = {};
      let masHay = false;
      for (const pr of promos) {
        for (let pag = 0; pag < 10; pag++) {
          if (objetivos.length >= 400) { masHay = true; break; }
          let url2 = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(pr.id)}/items`
            + `?promotion_type=${encodeURIComponent(pr.type)}&app_version=v2&limit=50&offset=${pag * 50}&status_item=started`;
          let items2 = [];
          try {
            const r2 = await fetch(url2, { headers: { Authorization: 'Bearer ' + token } });
            const d2 = await r2.json();
            items2 = d2.results || d2.items || [];
          } catch (e2) { break; }
          for (const it2 of items2) {
            if (!(it2.status === 'started' || it2.status === 'active')) continue;
            const k = it2.id + '|' + pr.type + '|' + pr.id;
            if (vistos[k]) continue;
            vistos[k] = 1;
            objetivos.push({ item: it2.id, type: pr.type, promo_id: pr.id });
            const nom = String(pr.name || pr.id);
            porCampana[nom] = (porCampana[nom] || 0) + 1;
            if (objetivos.length >= 400) { masHay = true; break; }
          }
          if (items2.length < 50) break;
          await new Promise(rs => setTimeout(rs, 150));
        }
        if (objetivos.length >= 400) break;
      }
      if (!objetivos.length) return res.json({ respuesta: 'No encontre promociones activas en el catalogo. Nada para sacar.' });
      const desglose = Object.keys(porCampana).map(n => '- ' + n.slice(0, 35) + ': ' + porCampana[n] + ' publicacion(es)').join('\n');
      return res.json({
        respuesta: 'ATENCION: esto va a QUITAR las promociones activas de ' + objetivos.length + ' participacion(es) en todo el catalogo:\n'
          + desglose
          + (masHay ? '\n(Hay mas: proceso estas primero; cuando termine, repeti la orden para la siguiente tanda.)' : '')
          + '\nEs una operacion grande y con impacto en las ventas. Segura/o?',
        pendiente: { accion: 'quitar_todo', objetivos }
      });
    }
    if (j.accion === 'multi') {
      let subs = ((p.acciones || j.acciones || [])).filter(s => s && (s.accion === 'quitar_descuento' || s.accion === 'aplicar_descuento'));
      let recorte = '';
      if (subs.length > 60) { recorte = '\n(Ojo: eran ' + subs.length + ' ordenes, proceso las primeras 60; mandame el resto en otro mensaje.)'; subs = subs.slice(0, 60); }
      if (!subs.length) return res.json({ respuesta: j.respuesta || 'No entendi la lista de ordenes, proba de a una.' });
      const lineas = []; const listos = [];
      for (const s of subs) {
        const sp = s.parametros || {};
        const spct = Number(sp.porcentaje);
        const sTienePct = spct > 0 && spct < 95;
        const sDias = Math.min(Math.max(parseInt(sp.dias) || 14, 1), 14);
        if (s.accion === 'aplicar_descuento' && !(Number(sp.precio) > 0) && !sTienePct) {
          return res.json({ respuesta: 'Me falta el precio o el porcentaje para "' + (sp.sku || sp.item_id || '?') + '". Pasamelo y armo el plan completo.' });
        }
        const ids = await asistenteResolverItems(sp, userId, token);
        if (!ids.length) { lineas.push('- ' + (sp.sku || sp.item_id || '?') + ': no encontre publicaciones (la salteo)'); continue; }
        const mini = await itemsMini(ids, token);
        let sPrecios = null;
        let idsUsar = ids;
        if (s.accion === 'aplicar_descuento' && sTienePct) {
          sPrecios = {}; idsUsar = [];
          for (const id of ids) {
            const base = (mini[id] && mini[id].price) || 0;
            if (base > 0) { sPrecios[id] = Math.round(base * (1 - spct / 100)); idsUsar.push(id); }
          }
          if (!idsUsar.length) { lineas.push('- ' + (sp.sku || '?') + ': sin precios visibles (la salteo)'); continue; }
        }
        const tt = idsUsar.map(id => (mini[id] && mini[id].title) ? mini[id].title.slice(0, 38) : id).join(' | ');
        lineas.push('- ' + (s.accion === 'quitar_descuento' ? 'QUITAR descuentos'
          : (sTienePct ? 'Descuento ' + spct + '% (' + sDias + 'd)' : 'Descuento a $' + Math.round(Number(sp.precio)).toLocaleString() + ' (' + sDias + 'd)'))
          + ' en ' + idsUsar.length + ' pub: ' + tt);
        listos.push({ accion: s.accion, parametros: sp, items: idsUsar, precios: sPrecios });
      }
      if (!listos.length) return res.json({ respuesta: 'No encontre publicaciones para ninguna de las ordenes:\n' + lineas.join('\n') });
      return res.json({
        respuesta: 'Plan (' + listos.length + ' orden/es):\n' + lineas.join('\n') + recorte,
        pendiente: { accion: 'multi', acciones: listos }
      });
    }
    if (j.accion === 'quitar_descuento' || j.accion === 'aplicar_descuento') {
      const pct = Number(p.porcentaje);
      const tienePct = pct > 0 && pct < 95;
      const diasP = Math.min(Math.max(parseInt(p.dias) || 14, 1), 14);
      if (j.accion === 'aplicar_descuento' && !(Number(p.precio) > 0) && !tienePct) {
        return res.json({ respuesta: j.respuesta || 'Decime el precio final o el porcentaje de descuento.' });
      }
      const ids = await asistenteResolverItems(p, userId, token);
      if (!ids.length) return res.json({ respuesta: 'No encontre publicaciones activas para "' + (p.sku || p.item_id || '?') + '". Revisa el SKU.' });
      const mini = await itemsMini(ids, token);

      if (j.accion === 'aplicar_descuento' && tienePct) {
        const precios = {};
        const okIds = [];
        const lineasP = [];
        for (const id of ids) {
          const base = (mini[id] && mini[id].price) || 0;
          const tt = (mini[id] && mini[id].title) ? mini[id].title.slice(0, 42) : id;
          if (!(base > 0)) { lineasP.push('- ' + tt + ': sin precio visible, la salteo'); continue; }
          const fin = Math.round(base * (1 - pct / 100));
          precios[id] = fin;
          okIds.push(id);
          lineasP.push('- ' + tt + ': $' + Math.round(base).toLocaleString() + ' -> $' + fin.toLocaleString());
        }
        if (!okIds.length) return res.json({ respuesta: 'No pude leer los precios actuales para calcular el ' + pct + '%.' });
        return res.json({
          respuesta: 'Voy a aplicar ' + pct + '% de descuento (vigente ' + diasP + ' dias) en ' + okIds.length + ' publicacion(es):\n' + lineasP.join('\n'),
          pendiente: { accion: j.accion, parametros: p, items: okIds, precios }
        });
      }

      const lista = ids.map(id => '- ' + ((mini[id] && mini[id].title) ? mini[id].title.slice(0, 48) : id)).join('\n');
      const desc = j.accion === 'quitar_descuento'
        ? 'Voy a QUITAR los descuentos de ' + ids.length + ' publicacion(es):'
        : 'Voy a aplicar descuento (vigente ' + diasP + ' dias) dejando el precio en $' + Math.round(Number(p.precio)).toLocaleString() + ' en ' + ids.length + ' publicacion(es):';
      return res.json({
        respuesta: desc + '\n' + lista,
        pendiente: { accion: j.accion, parametros: p, items: ids }
      });
    }
    if (j.accion === 'ver_promos') {
      return res.json({ respuesta: await asistenteVerPromos(p, userId, token) });
    }
    if (j.accion === 'buscar') {
      const ids = await asistenteResolverItems(p, userId, token);
      if (!ids.length) return res.json({ respuesta: 'No encontre publicaciones para ese SKU.' });
      const mini = await itemsMini(ids, token);
      return res.json({ respuesta: ids.map(id => '- ' + id + ': ' + (((mini[id] && mini[id].title) || '').slice(0, 50)) + ((mini[id] && mini[id].price) ? ' ($' + Math.round(mini[id].price).toLocaleString() + ')' : '')).join('\n') });
    }
    return res.json({ respuesta: j.respuesta || 'Decime que necesitas hacer.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Numeros reales por SKU: comision % y envio neto promedio de ventas recientes
// (para calcular el "limpio" en la app Promociones con datos propios)
app.get('/api/promos/reales', requireAuth, puedeApp('promos'), async (req, res) => {
  try {
    const userId = req.query.user_id || '67619515';
    const skus = String(req.query.skus || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 120);
    if (!skus.length) return res.json({});
    const desde = new Date(Date.now() - 60 * 864e5).toISOString();
    let rows = [], off = 0;
    while (off < 6000) {
      const { data: d, error } = await supabase.from('ventas')
        .select('sku,precio,comision,costo_envio,precio_comprador_envio,estado')
        .eq('user_id', String(userId)).gte('fecha', desde).in('sku', skus).range(off, off + 999);
      if (error) return res.status(500).json({ error: error.message });
      rows = rows.concat(d || []);
      if (!d || d.length < 1000) break;
      off += 1000;
    }
    const agg = {};
    for (const v2 of rows) {
      if (v2.estado === 'cancelled') continue;
      const s = String(v2.sku || '').toUpperCase();
      const a = agg[s] || (agg[s] = { fact: 0, com: 0, env: 0, n: 0 });
      a.fact += Number(v2.precio) || 0;
      a.com += Number(v2.comision) || 0;
      a.env += (Number(v2.costo_envio) || 0) - (Number(v2.precio_comprador_envio) || 0);
      a.n++;
    }
    const out = {};
    for (const s in agg) {
      const a = agg[s];
      if (a.n < 1 || a.fact <= 0) continue;
      out[s] = { com_pct: a.com / a.fact, envio: a.env / a.n, ventas: a.n };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI  = process.env.ML_REDIRECT_URI || 'https://margenml-frontend.vercel.app/';

// ── OAUTH ─────────────────────────────────────────────────────────
app.post('/api/auth/token', async (req, res) => {
  try {
    const { code } = req.body;
    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri:  ML_REDIRECT_URI
      })
    });
    const data = await resp.json();
    if (data.error) return res.status(400).json(data);

    const { error } = await supabase.from('ml_tokens').upsert({
      user_id:       String(data.user_id),
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString()
    }, { onConflict: 'user_id' });

    if (error) console.error('Supabase upsert error:', error);

    res.json({ access_token: data.access_token, user_id: data.user_id, expires_in: data.expires_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REFRESH TOKEN ─────────────────────────────────────────────────
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { user_id } = req.body;
    const { data: tokenRow } = await supabase
      .from('ml_tokens').select('*').eq('user_id', user_id).single();
    if (!tokenRow) return res.status(404).json({ error: 'Token no encontrado' });

    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        refresh_token: tokenRow.refresh_token
      })
    });
    const data = await resp.json();
    if (data.error) return res.status(400).json(data);

    await supabase.from('ml_tokens').upsert({
      user_id:       String(data.user_id),
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString()
    }, { onConflict: 'user_id' });

    res.json({ access_token: data.access_token, expires_in: data.expires_in });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: token válido ──────────────────────────────────────────
async function getValidToken(userId) {
  const { data: tokenRow } = await supabase
    .from('ml_tokens').select('*').eq('user_id', String(userId)).single();
  if (!tokenRow) return null;

  if (new Date(tokenRow.expires_at).getTime() - 60000 > Date.now()) {
    return tokenRow.access_token;
  }

  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token
    })
  });
  const data = await resp.json();
  if (data.error) {
    console.error('Refresh falló:', data);
    return tokenRow.access_token;
  }

  await supabase.from('ml_tokens').upsert({
    user_id:       String(userId),
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at:    new Date().toISOString()
  }, { onConflict: 'user_id' });

  return data.access_token;
}

// ── Helper: datos de envío completos ─────────────────────────────
async function getShipData(shipmentId, token) {
  if (!shipmentId) return {};
  try {
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const ship = await r.json();
    if (ship.error) return {};

    // Costo "bruto" del envío = tarifa total de ML (con IVA)
    let costoEnvio   = (ship.shipping_option && ship.shipping_option.list_cost) || ship.base_cost || 0;
    // Aporte del comprador (fallback: campo del shipment; suele venir 0 en envíos subsidiados)
    let pagoComprador = (ship.shipping_option && ship.shipping_option.cost) || 0;

    // Desglose real de costos: acá está lo que paga el comprador y lo que banca el vendedor.
    try {
      const rc = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/costs`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const costs = await rc.json();
      if (costs && !costs.error) {
        const gross    = Number(costs.gross_amount) || 0;
        const recvCost = (costs.receiver && Number(costs.receiver.cost)) || 0;
        const sender   = (Array.isArray(costs.senders) && costs.senders[0]) || {};
        const sendCost = Number(sender.cost) || 0;

        const esFlexShip = ship.logistic_type === 'self_service';
        const haySenders = Array.isArray(costs.senders) && costs.senders.length > 0;
        if (!esFlexShip && haySenders) {
          // FIX envio: el costo REAL del vendedor es senders.cost (ya neto del aporte del
          // comprador y del descuento de ML). Es 0 cuando el envio lo paga el comprador
          // (productos baratos). Evita cargar el bruto cuando no hay list_cost.
          costoEnvio    = sendCost;
          pagoComprador = 0;
        } else {
          // Flex u otros sin desglose de senders: logica anterior
          if (recvCost > 0) pagoComprador = recvCost;
          if (!costoEnvio && gross > 0) costoEnvio = gross;
          if (!costoEnvio && sendCost > 0) costoEnvio = sendCost + pagoComprador;
        }

        // Log de verificación: bruto - aporteComprador debería dar el neto del vendedor (senders.cost)
        console.log(`[ENVIO] ship=${shipmentId} bruto=${costoEnvio} pagoComprador=${pagoComprador} netoCalc=${costoEnvio - pagoComprador} netoVendedor(senders.cost)=${sendCost} | keys=${Object.keys(costs).join(',')}`);
      }
    } catch(e) { /* si /costs falla, quedan los valores del shipment */ }

    // ML devuelve la dirección del comprador bajo receiver_address (no receiver)
    const rcv = ship.receiver_address || ship.receiver || {};
    console.log(`[PROV] ship=${shipmentId} provincia=${(rcv.state && rcv.state.name) || '(vacío)'} ciudad=${(rcv.city && rcv.city.name) || '(vacío)'} | shipKeys=${Object.keys(ship).join(',')}`);
    return {
      costo_envio:            costoEnvio,
      precio_comprador_envio: pagoComprador,
      logistic_type:          ship.logistic_type || '',
      provincia:             (rcv.state && rcv.state.name) || '',
      ciudad:                (rcv.city  && rcv.city.name)  || '',
    };
  } catch(e) {
    return {};
  }
}

// ── Helper: datos de ítem (tipo de publicación) ───────────────────
async function getItemData(itemId, token) {
  if (!itemId) return {};
  try {
    const r = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=listing_type_id,seller_sku`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const item = await r.json();
    if (item.error) return {};
    return {
      tipo_publicacion: item.listing_type_id || '',
    };
  } catch(e) {
    return {};
  }
}

// ── Helper: construir objeto venta completo ───────────────────────
async function buildVentaRow(order, userId, token, incluirEnvio = true) {
  const item     = (order.order_items && order.order_items[0]) || {};
  const payment  = (order.payments && order.payments[0]) || {};
  const sku      = (item.item && (item.item.seller_sku || item.item.seller_custom_field)) || '';
  // sale_fee de ML es POR UNIDAD → multiplicar por la cantidad de cada item
  const comision = order.order_items
    ? order.order_items.reduce((a, i) => a + (i.sale_fee || 0) * (i.quantity || 1), 0) : 0;

  // Cuotas y costo financiero
  const cuotas = payment.installments || 1;
  // ML cobra un costo financiero por cuotas: total_paid_amount - transaction_amount
  const costoFinanciero = (payment.total_paid_amount && payment.transaction_amount)
    ? Math.max(0, payment.total_paid_amount - payment.transaction_amount)
    : 0;

  // Tipo de publicación
  const itemData = incluirEnvio && item.item && item.item.id
    ? await getItemData(item.item.id, token)
    : {};

  // Envío
  const shipData = incluirEnvio && order.shipping && order.shipping.id
    ? await getShipData(order.shipping.id, token)
    : {};

  return {
    nro_venta:             String(order.id),
    user_id:               String(userId),
    fecha:                 order.date_created,
    fecha_cierre:          order.date_closed || null,
    sku:                   sku ? String(sku).trim() : '',
    titulo:                item.item ? item.item.title : '',
    unidades:              item.quantity || 1,
    precio:                order.total_amount,
    comision,
    costo_envio:           shipData.costo_envio           || 0,
    precio_comprador_envio:shipData.precio_comprador_envio || 0,
    logistic_type:         shipData.logistic_type          || '',
    provincia:             shipData.provincia              || '',
    ciudad:                shipData.ciudad                 || '',
    estado:                order.status,
    con_cuotas:            cuotas > 1,
    cuotas:                cuotas,
    costo_financiero:      costoFinanciero,
    tipo_publicacion:      itemData.tipo_publicacion       || '',
    pack_id:               order.pack_id ? String(order.pack_id) : null,
    item_id:               (item.item && item.item.id) ? String(item.item.id) : null,
    raw:                   order
  };
}

// ── Helper: encontrar la orden asociada a un envío (Flex/shipments) ─
async function getOrderIdFromShipment(shipmentId, token) {
  if (!shipmentId) return null;
  try {
    // 1) El detalle del envío a veces ya trae order_id
    const r = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const ship = await r.json();
    if (ship && ship.order_id) return String(ship.order_id);

    // 2) Si no, /shipments/{id}/items devuelve el order_id de cada ítem
    const ri = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}/items`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const items = await ri.json();
    if (Array.isArray(items) && items[0] && items[0].order_id) {
      return String(items[0].order_id);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── WEBHOOK ───────────────────────────────────────────────────────
// ── Helper: costo interno de Contabilium para un SKU ──────────────
async function getCostoInterno(sku) {
  try {
    if (!sku) return null;
    const token = await getContabiliumToken();
    if (!token) return null;
    const r = await fetch(`https://rest.contabilium.com/api/conceptos/getByCodigo?codigo=${encodeURIComponent(sku)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (data && data.CostoInterno != null) return data.CostoInterno;
    return null;
  } catch (e) {
    return null;
  }
}

// ── Reenvío de webhooks al backend del Depósito ───────────────────
// Una sola app de ML notifica acá (MargenML). Le pasamos una copia de
// cada notificación al Depósito para que mantenga su panel al día.
// Es "fire-and-forget": no esperamos la respuesta y cualquier error se
// traga en silencio, así NUNCA afecta el procesamiento de MargenML.
const DEPOSITO_WEBHOOK_URL = process.env.DEPOSITO_WEBHOOK_URL
  || 'https://depositoml-backend-production.up.railway.app/api/despacho/webhook';

function reenviarADeposito(payload) {
  try {
    if (!payload || typeof payload !== 'object') return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000); // corta a los 4s, no cuelga
    fetch(DEPOSITO_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    }).then(() => clearTimeout(t))
      .catch(e => { clearTimeout(t); console.error('[REENVIO-DEPOSITO]', e.message); });
  } catch (e) {
    console.error('[REENVIO-DEPOSITO] sync', e.message);
  }
}

app.post('/api/webhook/ml', async (req, res) => {
  // Reenvío al backend del Depósito (fire-and-forget): le mandamos una
  // copia de TODA notificación. Si falla, no afecta a MargenML.
  reenviarADeposito(req.body);
  try {
    const { topic, resource, user_id } = req.body || {};
    if (typeof resource !== 'string') return res.sendStatus(200);

    const token = await getValidToken(user_id);
    if (!token) return res.sendStatus(200);

    let orderId = null;

    if (resource.startsWith('/orders/')) {
      // Ventas normales (Full / Colecta / M1) y cambios de estado (cancela/devuelve)
      orderId = resource.split('/').pop();
    } else if (resource.startsWith('/shipments/')) {
      // Envíos (incluye Flex): hay que sacar la orden asociada al envío
      const shipmentId = resource.split('/').pop();
      orderId = await getOrderIdFromShipment(shipmentId, token);
    } else {
      // Cualquier otro tópico que no nos interesa
      return res.sendStatus(200);
    }

    if (!orderId) return res.sendStatus(200);

    const orderResp = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const order = await orderResp.json();
    if (order.error || !order.id) return res.sendStatus(200);

    // upsert: si la orden ya existía, se actualiza su estado (cancelada / devuelta / etc.)
    const row = await buildVentaRow(order, user_id, token, true);
    await supabase.from('ventas').upsert(row, { onConflict: 'nro_venta' });

    // Congelar el costo de Contabilium al momento de la venta (solo si aun no lo tiene)
    if (row.sku) {
      const cInterno = await getCostoInterno(row.sku);
      if (cInterno != null) {
        const totalCosto = cInterno * (Number(row.unidades) || 1);
        await supabase.from('ventas')
          .update({ costo_congelado: totalCosto })
          .eq('nro_venta', row.nro_venta)
          .is('costo_congelado', null);
      }
    }

    console.log('Venta guardada (webhook):', order.id, order.status, '/', topic || resource.split('/')[1]);
    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    return res.sendStatus(200);
  }
});

// ── VENTAS: obtener ventas guardadas (paginado para superar límite de 1000) ─
app.get('/api/ventas', requireAuth, async (req, res) => {
  try {
    const { user_id, desde, hasta } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

    let todas = [];
    let offset = 0;
    const lote = 1000;

    while (true) {
      let query = supabase.from('ventas').select('nro_venta,user_id,fecha,fecha_cierre,sku,titulo,unidades,precio,comision,costo_envio,precio_comprador_envio,logistic_type,provincia,ciudad,estado,con_cuotas,cuotas,costo_financiero,tipo_publicacion,pack_id,item_id,costo_congelado,cancel_code:raw->cancel_detail->>code,ml_tags:raw->tags,dev_return,dev_benef,dev_cargo').eq('user_id', user_id);
      if (desde) query = query.gte('fecha', desde);
      if (hasta) query = query.lte('fecha', hasta);
      query = query.order('fecha', { ascending: false }).range(offset, offset + lote - 1);

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      todas = todas.concat(data);
      if (data.length < lote) break;   // último lote
      offset += lote;
      if (offset > 500000) break;       // tope de seguridad
    }

    // monto_bonificado (reembolsos parciales): se calcula del raw YA guardado, sin re-sync
    try {
      const refundIds = todas.filter(v => String(v.estado||'').includes('partially_refunded')).map(v => v.nro_venta);
      if (refundIds.length) {
        const bonifMap = {};
        for (let i = 0; i < refundIds.length; i += 200) {
          const chunk = refundIds.slice(i, i + 200);
          const { data: rawRows } = await supabase.from('ventas').select('nro_venta,raw').in('nro_venta', chunk);
          (rawRows || []).forEach(r => {
            const o = r.raw || {};
            let mb = (o.total_amount != null && o.paid_amount != null) ? (Number(o.total_amount) - Number(o.paid_amount)) : 0;
            if (!(mb > 0) && Array.isArray(o.payments)) mb = o.payments.reduce((a, p) => a + (Number(p.transaction_amount_refunded) || 0), 0);
            bonifMap[r.nro_venta] = mb > 0 ? mb : 0;
          });
        }
        todas.forEach(v => { v.monto_bonificado = bonifMap[v.nro_venta] || 0; });
      }
    } catch (eb) { console.error('monto_bonificado enrich error:', eb.message); }

    // NUEVO v13: el rol operador NO recibe el costo del producto (dato sensible).
    // El frontend le esconde la pestaña, y aca el backend lo bloquea de verdad.
    if (req.rol === 'operador') {
      todas.forEach(v => { delete v.costo_congelado; });
    }

    res.json({ ventas: todas, total: todas.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNOSTICO devoluciones (TEMPORAL): estados reales + reembolsos ──
// GET /api/ventas/estados?user_id=67619515
app.get('/api/ventas/estados', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const counts = {};
    let offset = 0; const lote = 1000;
    while (true) {
      const { data, error } = await supabase.from('ventas').select('estado').eq('user_id', String(user_id)).range(offset, offset + lote - 1);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || !data.length) break;
      data.forEach(r => { const e = String(r.estado == null ? '(null)' : r.estado); counts[e] = (counts[e] || 0) + 1; });
      if (data.length < lote) break;
      offset += lote; if (offset > 500000) break;
    }
    const estados = Object.entries(counts).map(([estado, n]) => ({ estado, n })).sort((a, b) => b.n - a.n);
    // histograma de cancel_detail.code entre canceladas (para decidir cuales son devoluciones)
    let codes = {};
    try {
      let off2 = 0; const lote2 = 1000;
      while (true) {
        const { data, error } = await supabase.from('ventas')
          .select('ccode:raw->cancel_detail->>code, cgrp:raw->cancel_detail->>group')
          .eq('user_id', String(user_id)).eq('estado', 'cancelled')
          .range(off2, off2 + lote2 - 1);
        if (error) { codes = { _error: error.message }; break; }
        if (!data || !data.length) break;
        data.forEach(r => { const c = r.ccode || r.cgrp || '(sin code)'; codes[c] = (codes[c] || 0) + 1; });
        if (data.length < lote2) break;
        off2 += lote2; if (off2 > 500000) break;
      }
    } catch (e) { codes = { _error: e.message }; }
    const cancelCodes = Object.entries(codes).map(([code, n]) => ({ code, n })).sort((a, b) => (b.n || 0) - (a.n || 0));
    res.json({ estados, cancelCodes, nota: 'diagnostico temporal' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DIAGNOSTICO devoluciones (TEMPORAL): estructura de una orden con mediacion ──
// GET /api/ventas/raw-devol?user_id=67619515  -> campos NO sensibles para saber si volvio el producto
app.get('/api/ventas/raw-devol', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const out = [];
    let offset = 0; const lote = 500;
    while (out.length < 4 && offset < 6000) {
      const { data, error } = await supabase.from('ventas')
        .select('raw').eq('user_id', String(user_id)).eq('estado', 'cancelled')
        .range(offset, offset + lote - 1);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || !data.length) break;
      for (const r of data) {
        const o = r.raw || {};
        const code = o.cancel_detail ? (o.cancel_detail.code || '') : '';
        if (code !== 'mediations') continue;
        const sh = o.shipping || {};
        out.push({
          topKeys: Object.keys(o),
          status: o.status || null,
          status_detail: o.status_detail || null,
          cancel_detail: o.cancel_detail || null,
          tags: o.tags || null,
          mediationsRaw: o.mediations || null,
          shipping_keys: Object.keys(sh),
          shipping_status: sh.status || null,
          shipping_substatus: sh.substatus || null,
          shipping_tags: sh.tags || null,
          logistic: sh.logistic || sh.logistic_type || null,
          payments: Array.isArray(o.payments) ? o.payments.map(p => ({ status: p.status, refundedPct: o.total_amount ? Math.round((Number(p.transaction_amount_refunded) || 0) / Number(o.total_amount) * 100) : null })) : null
        });
        if (out.length >= 4) break;
      }
      if (data.length < lote) break;
      offset += lote;
    }
    res.json({ muestra: out, nota: 'para detectar si el producto volvio al stock' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE devoluciones (TEMPORAL): detectar "se lo queda" vs "lo devuelve" ──
// GET /api/devol/probe?user_id=67619515
app.get('/api/devol/probe', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const token = await getValidToken(user_id);
    const { data } = await supabase.from('ventas')
      .select('raw').eq('user_id', String(user_id)).eq('estado', 'cancelled')
      .order('fecha', { ascending: false }).limit(400);
    const casos = [];
    for (const r of (data || [])) {
      const o = r.raw || {};
      if (!(o.cancel_detail && o.cancel_detail.code === 'mediations')) continue;
      const shipId = o.shipping && o.shipping.id;
      const medId = Array.isArray(o.mediations) && o.mediations[0] && o.mediations[0].id;
      const caso = { fecha: o.date_created ? String(o.date_created).slice(0,10) : null, tieneShip: !!shipId, tieneMed: !!medId, related_orders: o.related_orders || null, probes: {} };
      if (shipId) {
        try {
          const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, { headers: { Authorization: 'Bearer ' + token, 'x-format-new': 'true' } });
          const js = await rs.json();
          caso.probes.shipment = { http: rs.status, status: js.status, substatus: js.substatus, mode: js.mode, logistic_type: js.logistic_type, return_keys: js.return_details ? Object.keys(js.return_details) : null, hasReturn: !!(js.return_details || js.returns), keys: Object.keys(js || {}) };
        } catch (e) { caso.probes.shipment = { error: e.message }; }
      }
      if (medId) {
        const urls = [
          'post-purchase/v1/claims/' + medId,
          'post-purchase/v1/claims/' + medId + '/returns',
          'post-purchase/v1/claims/' + medId + '/returns/shipments'
        ];
        for (const path of urls) {
          try {
            const rc = await fetch('https://api.mercadolibre.com/' + path, { headers: { Authorization: 'Bearer ' + token } });
            let jc = {}; try { jc = await rc.json(); } catch(e2) {}
            caso.probes[path.replace('post-purchase/v1/claims/'+medId,'claim')] = { http: rc.status, keys: Array.isArray(jc) ? ('array:' + jc.length) : Object.keys(jc || {}), status: jc && jc.status, type: jc && jc.type, stage: jc && jc.stage };
          } catch (e) { caso.probes[path] = { error: e.message }; }
        }
      }
      casos.push(caso);
      if (casos.length >= 3) break;
    }
    res.json({ casos, nota: 'probe se-lo-queda vs lo-devuelve' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE2 devoluciones (TEMPORAL): comparar caso conocido "se lo queda" vs "lo devuelve" ──
// GET /api/devol/probe2?user_id=67619515   (usa freidora vs silla por defecto; ?nros=a,b para otros)
app.get('/api/devol/probe2', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const nros = String(req.query.nros || '2000017077382238,2000017080396472').split(',').map(x => x.trim()).filter(Boolean);
    const token = await getValidToken(user_id);
    const out = [];
    for (const nro of nros) {
      const { data } = await supabase.from('ventas').select('nro_venta,sku,raw').eq('user_id', String(user_id)).eq('nro_venta', nro).limit(1);
      const row = data && data[0];
      if (!row) { out.push({ nro, error: 'no encontrado en la base' }); continue; }
      const o = row.raw || {};
      const medId = Array.isArray(o.mediations) && o.mediations[0] && o.mediations[0].id;
      const caso = { nro, sku: row.sku, cancelCode: o.cancel_detail && o.cancel_detail.code, medId: medId || null };
      if (medId) {
        try {
          const rc = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + medId, { headers: { Authorization: 'Bearer ' + token } });
          const jc = await rc.json();
          caso.type = jc.type; caso.stage = jc.stage; caso.status = jc.status; caso.reason_id = jc.reason_id;
          caso.resolution = jc.resolution || null;
          caso.related_entities = jc.related_entities || null;
          caso.players = Array.isArray(jc.players) ? jc.players.map(p => ({ type: p.type, role: p.role })) : null;
        } catch (e) { caso.claimError = e.message; }
      }
      out.push(caso);
    }
    res.json({ casos: out, nota: 'probe2: se-lo-queda (freidora) vs lo-devuelve (silla)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEVOLUCIONES: enriquecer con el reclamo de ML (se lo queda vs lo devuelve) ──
// GET /api/devol/enrich?user_id=67619515&limit=150  (llamar en loop hasta faltan=0)
app.get('/api/devol/enrich', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const limit = Math.min(parseInt(req.query.limit) || 150, 300);
    const token = await getValidToken(user_id);
    const { data, error } = await supabase.from('ventas')
      .select('nro_venta, med:raw->mediations')
      .eq('user_id', String(user_id)).eq('estado', 'cancelled')
      .filter('raw->cancel_detail->>code', 'eq', 'mediations')
      .is('dev_checked', null)
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message, hint: 'faltan las columnas dev_return/dev_benef/dev_checked?' });
    let procesados = 0, seQueda = 0, devuelve = 0, aFavor = 0, errores = 0;
    for (const r of (data || [])) {
      const med = r.med;
      const medId = Array.isArray(med) && med[0] && med[0].id;
      let dev_return = null, dev_benef = null;
      if (medId) {
        try {
          const rc = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + medId, { headers: { Authorization: 'Bearer ' + token } });
          const jc = await rc.json();
          const rel = Array.isArray(jc.related_entities) ? jc.related_entities : [];
          dev_return = rel.indexOf('return') > -1;
          dev_benef = (jc.resolution && Array.isArray(jc.resolution.benefited) && jc.resolution.benefited[0]) || null;
          if (dev_benef === 'respondent') aFavor++; else if (dev_return) devuelve++; else seQueda++;
        } catch (e) { errores++; }
      } else { errores++; }
      await supabase.from('ventas').update({ dev_return, dev_benef, dev_checked: new Date().toISOString() }).eq('user_id', String(user_id)).eq('nro_venta', r.nro_venta);
      procesados++;
      await new Promise(rs => setTimeout(rs, 110));
    }
    const { count: faltan } = await supabase.from('ventas').select('nro_venta', { count: 'exact', head: true })
      .eq('user_id', String(user_id)).eq('estado', 'cancelled')
      .filter('raw->cancel_detail->>code', 'eq', 'mediations')
      .is('dev_checked', null);
    res.json({ procesados, seQueda, devuelve, aFavor, errores, faltan: faltan == null ? 0 : faltan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LOOKUP devolucion (TEMPORAL): ver como quedo analizada una venta ──
// GET /api/devol/ver?user_id=67619515&nro=2000017080396472
app.get('/api/devol/ver', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    const nros = String(req.query.nro || '2000017080396472,2000017080396318').split(',').map(x => x.trim()).filter(Boolean);
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const out = [];
    for (const nro of nros) {
      const { data, error } = await supabase.from('ventas')
        .select('nro_venta, sku, estado, dev_return, dev_benef, dev_checked, cc:raw->cancel_detail->>code, med:raw->mediations')
        .eq('user_id', String(user_id)).eq('nro_venta', nro).limit(1);
      if (error) return res.status(500).json({ error: error.message });
      const r = data && data[0];
      if (!r) { out.push({ nro, error: 'no encontrado' }); continue; }
      out.push({ nro: r.nro_venta, sku: r.sku, estado: r.estado, cancelCode: r.cc, tieneMed: Array.isArray(r.med) && !!r.med.length, dev_return: r.dev_return, dev_benef: r.dev_benef, dev_checked: r.dev_checked });
    }
    res.json({ casos: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INSPECTOR de venta (TEMPORAL): todo lo que ML devuelve de una venta ──
// GET /api/venta/inspect?user_id=67619515&nro=2000013785412851
app.get('/api/venta/inspect', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    const nro = String(req.query.nro || '').trim();
    if (!user_id || !nro) return res.status(400).json({ error: 'user_id y nro requeridos' });
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };
    const out = { nro };

    // 1) fila en nuestra base (por nro_venta o pack_id)
    let { data: rows } = await supabase.from('ventas')
      .select('nro_venta,pack_id,sku,titulo,unidades,precio,comision,costo_envio,precio_comprador_envio,logistic_type,estado,fecha,dev_return,dev_benef,raw')
      .eq('user_id', String(user_id)).or('nro_venta.eq.' + nro + ',pack_id.eq.' + nro);
    out.enBase = (rows || []).map(r => ({ nro_venta: r.nro_venta, pack_id: r.pack_id, sku: r.sku, unidades: r.unidades, precio: r.precio, comision: r.comision, costo_envio: r.costo_envio, ingreso_envio_comprador: r.precio_comprador_envio, logistic: r.logistic_type, estado: r.estado, fecha: r.fecha, dev_return: r.dev_return, dev_benef: r.dev_benef }));

    let orderIds = (rows || []).map(r => r.nro_venta);
    if (!orderIds.length) orderIds = [nro];

    // 2) orden fresca de ML (montos y pagos)
    out.ordenes = [];
    for (const oid of orderIds.slice(0, 4)) {
      try {
        const r1 = await fetch('https://api.mercadolibre.com/orders/' + oid, { headers: H });
        const o = await r1.json();
        if (o && o.id) {
          out.ordenes.push({
            id: o.id, status: o.status,
            cancel_code: o.cancel_detail ? o.cancel_detail.code : null,
            total_amount: o.total_amount, paid_amount: o.paid_amount,
            pagos: Array.isArray(o.payments) ? o.payments.map(p => ({ status: p.status, transaction_amount: p.transaction_amount, refunded: p.transaction_amount_refunded, shipping_cost: p.shipping_cost, marketplace_fee: p.marketplace_fee })) : [],
            mediations: Array.isArray(o.mediations) ? o.mediations.map(m => m.id) : [],
            shipping_id: o.shipping && o.shipping.id, tags: o.tags
          });
        } else out.ordenes.push({ id: oid, error: o && (o.message || o.error) });
      } catch (e) { out.ordenes.push({ id: oid, error: e.message }); }
    }

    // 3) costos reales del envio
    out.envios = [];
    const shipIds = [...new Set(out.ordenes.map(o => o.shipping_id).filter(Boolean))];
    for (const sid of shipIds.slice(0, 3)) {
      try {
        const r2 = await fetch('https://api.mercadolibre.com/shipments/' + sid + '/costs', { headers: { ...H, 'x-format-new': 'true' } });
        const c = await r2.json();
        out.envios.push({ shipment: sid, gross_amount: c.gross_amount, receiver_cost: c.receiver ? c.receiver.cost : null, senders: Array.isArray(c.senders) ? c.senders.map(x => ({ cost: x.cost, save: x.save, compensation: x.compensation, charges: x.charges })) : c.senders });
      } catch (e) { out.envios.push({ shipment: sid, error: e.message }); }
    }

    // 4) reclamo / mediacion
    out.reclamos = [];
    const medIds = [...new Set([].concat(...out.ordenes.map(o => o.mediations || [])))];
    for (const mid of medIds.slice(0, 3)) {
      try {
        const r3 = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + mid, { headers: H });
        const j = await r3.json();
        out.reclamos.push({ claim: mid, type: j.type, stage: j.stage, status: j.status, reason_id: j.reason_id, resolution: j.resolution || null, related_entities: j.related_entities || null });
      } catch (e) { out.reclamos.push({ claim: mid, error: e.message }); }
    }

    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE3 (TEMPORAL): donde vive el cargo real por devolucion ──
// GET /api/devol/probe3?user_id=67619515&claims=5539834073,5533529331,5535841572
app.get('/api/devol/probe3', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const claims = String(req.query.claims || '5539834073,5533529331,5535841572').split(',').map(x => x.trim()).filter(Boolean);
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };
    const out = [];
    for (const cid of claims.slice(0, 5)) {
      const caso = { claim: cid, probes: {} };
      const paths = [
        ['charges', 'post-purchase/v1/claims/' + cid + '/charges'],
        ['charges_rsc', 'post-purchase/v1/claims/' + cid + '/charges/return-shipping-costs'],
        ['returns_v2', 'post-purchase/v2/claims/' + cid + '/returns'],
        ['returns_v1', 'post-purchase/v1/claims/' + cid + '/returns'],
        ['detail_returns', 'post-purchase/v1/claims/' + cid + '?with=returns']
      ];
      for (const [k, path] of paths) {
        try {
          const r = await fetch('https://api.mercadolibre.com/' + path, { headers: H });
          let j = null; try { j = await r.json(); } catch (e2) {}
          let resumen = null;
          if (j) {
            const txt = JSON.stringify(j);
            resumen = txt.length > 1200 ? (Array.isArray(j) ? { array: j.length, primer: j[0] } : { keys: Object.keys(j) }) : j;
          }
          caso.probes[k] = { http: r.status, body: resumen };
        } catch (e) { caso.probes[k] = { error: e.message }; }
        await new Promise(rs => setTimeout(rs, 120));
      }
      out.push(caso);
    }
    res.json({ casos: out, ref: { malacate: '5539834073 (3 envios cobrados)', freidora: '5533529331 (1 envio)', silla: '5535841572 ($0)' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE4 (TEMPORAL): retorno completo + costos de envios de devolucion ──
// GET /api/devol/probe4?user_id=67619515&claims=5539834073,5535841572
app.get('/api/devol/probe4', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const claims = String(req.query.claims || '5539834073,5535841572').split(',').map(x => x.trim()).filter(Boolean);
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };
    const out = [];
    for (const cid of claims.slice(0, 4)) {
      const caso = { claim: cid };
      try {
        const r = await fetch('https://api.mercadolibre.com/post-purchase/v2/claims/' + cid + '/returns', { headers: H });
        const j = await r.json();
        caso.return_http = r.status;
        caso.subtype = j.subtype; caso.status = j.status; caso.status_money = j.status_money; caso.refund_at = j.refund_at;
        caso.intermediate_check = j.intermediate_check;
        caso.shipments_raw = j.shipments;
        const shipIds = [];
        (Array.isArray(j.shipments) ? j.shipments : []).forEach(sh => { const id = sh && (sh.id || sh.shipment_id); if (id) shipIds.push(id); });
        caso.envios_devolucion = [];
        for (const sid of shipIds.slice(0, 3)) {
          const e = { shipment: sid };
          try {
            const r2 = await fetch('https://api.mercadolibre.com/shipments/' + sid, { headers: { ...H, 'x-format-new': 'true' } });
            const js = await r2.json();
            e.status = js.status; e.substatus = js.substatus; e.logistic = js.logistic && js.logistic.type;
          } catch (e2) { e.shipErr = e2.message; }
          try {
            const r3 = await fetch('https://api.mercadolibre.com/shipments/' + sid + '/costs', { headers: { ...H, 'x-format-new': 'true' } });
            const jc = await r3.json();
            e.costs = { gross_amount: jc.gross_amount, receiver: jc.receiver ? { cost: jc.receiver.cost, save: jc.receiver.save } : null, senders: Array.isArray(jc.senders) ? jc.senders.map(x => ({ cost: x.cost, save: x.save, compensation: x.compensation, charges: x.charges })) : jc.senders };
          } catch (e3) { e.costErr = e3.message; }
          caso.envios_devolucion.push(e);
          await new Promise(rs => setTimeout(rs, 120));
        }
      } catch (e) { caso.error = e.message; }
      out.push(caso);
    }
    res.json({ casos: out, ref: { malacate: '5539834073 (cargo devolucion $19.720 + ida $9.860)', silla: '5535841572 ($0)' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE5 (TEMPORAL): API de facturacion ML (cargos reales por devolucion) ──
// GET /api/devol/probe5?user_id=67619515&order=2000017191703550
app.get('/api/devol/probe5', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const orderId = String(req.query.order || '2000017191703550').trim();
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };
    const out = { orderBuscada: orderId };

    // 1) periodos de facturacion
    try {
      const r1 = await fetch('https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&document_type=BILL&offset=0&limit=3', { headers: H });
      const j1 = await r1.json();
      out.periodos = { http: r1.status, body: (JSON.stringify(j1).length > 1500 ? { keys: Object.keys(j1), primer: (j1.results && j1.results[0]) || null } : j1) };
      // 2) detalles del periodo mas reciente, probando variantes de filtro por orden
      const key = j1 && j1.results && j1.results[0] && (j1.results[0].key || (j1.results[0].period && j1.results[0].period.key));
      out.periodKey = key || null;
      if (key) {
        const variantes = [
          ['det_orderfilter', 'https://api.mercadolibre.com/billing/integration/periods/key/' + key + '/group/ML/details?document_type=BILL&limit=5&offset=0&order_id=' + orderId],
          ['det_sample', 'https://api.mercadolibre.com/billing/integration/periods/key/' + key + '/group/ML/details?document_type=BILL&limit=3&offset=0']
        ];
        out.detalles = {};
        for (const [k, url] of variantes) {
          try {
            const r2 = await fetch(url, { headers: H });
            let j2 = null; try { j2 = await r2.json(); } catch (e2) {}
            let resumen = null;
            if (j2) {
              const txt = JSON.stringify(j2);
              if (txt.length <= 3000) resumen = j2;
              else resumen = { keys: Object.keys(j2), total: j2.total || (j2.paging && j2.paging.total), primer: (j2.results && j2.results[0]) || null };
            }
            out.detalles[k] = { http: r2.status, body: resumen };
          } catch (e) { out.detalles[k] = { error: e.message }; }
          await new Promise(rs => setTimeout(rs, 150));
        }
      }
    } catch (e) { out.periodos = { error: e.message }; }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE6 (TEMPORAL): lineas de facturacion de ordenes especificas ──
// GET /api/devol/probe6?user_id=67619515&orders=2000017191703550,2000017077382238,2000017080396472&periods=2026-07-01,2026-06-01
app.get('/api/devol/probe6', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const orders = new Set(String(req.query.orders || '2000017191703550,2000017077382238,2000017080396472').split(',').map(x => x.trim()).filter(Boolean));
    const periods = String(req.query.periods || '2026-07-01,2026-06-01').split(',').map(x => x.trim()).filter(Boolean);
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };
    const encontrados = [];
    const meta = { paginas: 0, detallesRecorridos: 0, porPeriodo: {} };
    const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
    for (const key of periods.slice(0, 3)) {
      let offset = 0; let total = null; let vueltas = 0;
      while (vueltas < 80) {
        vueltas++;
        const url = 'https://api.mercadolibre.com/billing/integration/periods/key/' + key + '/group/ML/details?document_type=BILL&limit=' + limit + '&offset=' + offset;
        let r = null;
        for (let intento = 0; intento < 6; intento++) {
          r = await fetch(url, { headers: H });
          if (r.status !== 429) break;
          await new Promise(rp => setTimeout(rp, 15000));
        }
        if (r.status !== 200) { meta.porPeriodo[key] = { http: r.status, offsetAlFallar: offset }; break; }
        const j = await r.json();
        const rs = Array.isArray(j.results) ? j.results : [];
        total = j.total;
        meta.paginas++;
        meta.detallesRecorridos += rs.length;
        for (const d of rs) {
          const sales = Array.isArray(d.sales_info) ? d.sales_info : [];
          const hit = sales.find(si => si && orders.has(String(si.order_id)));
          if (hit) {
            const ci = d.charge_info || {};
            encontrados.push({
              period: key,
              order_id: String(hit.order_id),
              concepto: ci.transaction_detail,
              monto: ci.detail_amount,
              tipo: ci.detail_type,
              sub_tipo: ci.detail_sub_type,
              debitado_de_venta: ci.debited_from_operation,
              bonificado_id: ci.charge_bonified_id,
              fecha: ci.creation_date_time,
              descuento: d.discount_info ? { sin_desc: d.discount_info.charge_amount_without_discount, desc: d.discount_info.discount_amount } : null
            });
          }
        }
        if (!rs.length || offset + rs.length >= (total || 0)) break;
        offset += limit;
        await new Promise(rp => setTimeout(rp, 700));
      }
      meta.porPeriodo[key] = meta.porPeriodo[key] || { total, paginas: vueltas };
    }
    res.json({ encontrados, meta, ref: { malacate: '2000017191703550 (espero ~9860+19720)', freidora: '2000017077382238 (espero ~13920)', silla: '2000017080396472 (espero $0 o bonificado)' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEVOLUCIONES: cargos reales desde la facturacion de ML (incremental con cursor) ──
// 1) GET /api/devol/cargos-prep?user_id=..&periods=p1,p2  -> prepara cursores (full scan solo la 1ra vez)
// 2) GET /api/devol/cargos-sync?user_id=..&period=..      -> procesa UNA pagina desde el cursor guardado
app.get('/api/devol/cargos-prep', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    const periods = String(req.query.periods || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!user_id || !periods.length) return res.status(400).json({ error: 'user_id y periods requeridos' });
    const { data: cur, error } = await supabase.from('margen_billing_cursor').select('period,next_offset').eq('user_id', String(user_id)).in('period', periods);
    if (error) return res.status(500).json({ error: error.message, hint: 'falta la tabla margen_billing_cursor?' });
    const existentes = new Set((cur || []).map(r => r.period));
    const faltantes = periods.filter(p => !existentes.has(p));
    let fullScan = false;
    if (faltantes.length) {
      fullScan = true;
      // primera vez: limpiar cargos y arrancar todos los cursores de cero
      await supabase.from('ventas').update({ dev_cargo: null })
        .eq('user_id', String(user_id)).eq('estado', 'cancelled')
        .filter('raw->cancel_detail->>code', 'eq', 'mediations');
      await supabase.from('margen_billing_cursor').delete().eq('user_id', String(user_id)).in('period', periods);
      for (const p of periods) {
        await supabase.from('margen_billing_cursor').insert({ user_id: String(user_id), period: p, next_offset: 0, updated_at: new Date().toISOString() });
      }
    }
    const { data: cur2 } = await supabase.from('margen_billing_cursor').select('period,next_offset').eq('user_id', String(user_id)).in('period', periods);
    res.json({ fullScan, cursores: (cur2 || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const _devolCache = {};
app.get('/api/devol/cargos-sync', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    const period = String(req.query.period || '').trim();
    if (!user_id || !period) return res.status(400).json({ error: 'user_id y period requeridos' });
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };

    // cursor guardado
    const { data: curRows, error: curErr } = await supabase.from('margen_billing_cursor').select('next_offset').eq('user_id', String(user_id)).eq('period', period).limit(1);
    if (curErr) return res.status(500).json({ error: curErr.message, hint: 'falta la tabla margen_billing_cursor?' });
    let offset = (curRows && curRows[0] && curRows[0].next_offset) || 0;

    // set de ordenes que son devoluciones (mediations) - cacheado 10 min
    const cacheKey = String(user_id);
    let devolSet, devolPacks;
    if (_devolCache[cacheKey] && (Date.now() - _devolCache[cacheKey].ts) < 600000) {
      devolSet = _devolCache[cacheKey].set; devolPacks = _devolCache[cacheKey].packs;
    } else {
    devolSet = new Set();
    devolPacks = {};
    let off2 = 0;
    while (true) {
      const { data, error } = await supabase.from('ventas').select('nro_venta,pack_id')
        .eq('user_id', String(user_id)).eq('estado', 'cancelled')
        .filter('raw->cancel_detail->>code', 'eq', 'mediations')
        .range(off2, off2 + 999);
      if (error || !data || !data.length) break;
      data.forEach(r => { devolSet.add(String(r.nro_venta)); if (r.pack_id) devolPacks[String(r.pack_id)] = String(r.nro_venta); });
      if (data.length < 1000) break;
      off2 += 1000;
    }
    _devolCache[cacheKey] = { set: devolSet, packs: devolPacks, ts: Date.now() };
    }

    let rs = [];
    let total = null;
    let paginasOk = 0;
    for (let pg = 0; pg < 6; pg++) {
      const url = 'https://api.mercadolibre.com/billing/integration/periods/key/' + period + '/group/ML/details?document_type=BILL&limit=150&offset=' + (offset + rs.length);
      let r = null;
      for (let i = 0; i < 4; i++) {
        r = await fetch(url, { headers: H });
        if (r.status !== 429) break;
        await new Promise(rp => setTimeout(rp, 5000));
      }
      if (!r || r.status !== 200) {
        if (!paginasOk) return res.json({ period, offset, http: r ? r.status : null, reintentar: true, done: false });
        break;
      }
      const j = await r.json();
      const pagina = Array.isArray(j.results) ? j.results : [];
      if (j.total != null) total = j.total;
      rs = rs.concat(pagina);
      paginasOk++;
      if (!pagina.length || (total != null && offset + rs.length >= total)) break;
      await new Promise(rp => setTimeout(rp, 250));
    }

    const sumas = {};
    let hits = 0;
    for (const d of rs) {
      const ci = d.charge_info || {};
      const esCargo = ci.detail_type === 'CHARGE';
      const esCredito = ci.detail_type === 'CREDIT';
      if (!esCargo && !esCredito) continue;
      const concepto = String(ci.transaction_detail || '');
      // creditos: bonificaciones/devoluciones de cargos (si reclamaste y ML te lo devolvio)
      if (!/env|devoluci|bonific/i.test(concepto) && !(esCredito && ci.charge_bonified_id)) continue;
      const sales = Array.isArray(d.sales_info) ? d.sales_info : [];
      let destino = null;
      for (const si of sales) {
        const oid = si && String(si.order_id);
        if (oid && devolSet.has(oid)) { destino = oid; break; }
        const pid = si && si.pack_id && String(si.pack_id);
        if (pid && devolPacks[pid]) { destino = devolPacks[pid]; break; }
      }
      if (!destino && d.shipping_info && d.shipping_info.pack_id && devolPacks[String(d.shipping_info.pack_id)]) {
        destino = devolPacks[String(d.shipping_info.pack_id)];
      }
      if (destino) {
        const monto = Math.abs(Number(ci.detail_amount) || 0);
        sumas[destino] = (sumas[destino] || 0) + (esCredito ? -monto : monto);
        hits++;
      }
    }
    const cambios = [];
    for (const oid of Object.keys(sumas)) {
      const { data: cur } = await supabase.from('ventas').select('dev_cargo,sku').eq('user_id', String(user_id)).eq('nro_venta', oid).limit(1);
      const prev = (cur && cur[0] && cur[0].dev_cargo != null) ? Number(cur[0].dev_cargo) : null;
      const nuevo = (prev || 0) + sumas[oid];
      await supabase.from('ventas').update({ dev_cargo: nuevo }).eq('user_id', String(user_id)).eq('nro_venta', oid);
      cambios.push({ nro: oid, sku: (cur && cur[0] && cur[0].sku) || '', antes: prev, ahora: nuevo });
    }
    const nextOffset = offset + rs.length;
    const done = !rs.length || (total != null && nextOffset >= total);
    await supabase.from('margen_billing_cursor').update({ next_offset: nextOffset, updated_at: new Date().toISOString() }).eq('user_id', String(user_id)).eq('period', period);
    res.json({ period, escaneados: rs.length, total, nextOffset, done, hits, ordenesActualizadas: Object.keys(sumas).length, cambios });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROBE7 (TEMPORAL): variantes de filtro por orden en facturacion ──
// GET /api/devol/probe7?user_id=67619515&order=2000017191703550
app.get('/api/devol/probe7', async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
    const orderId = String(req.query.order || '2000017191703550').trim();
    const token = await getValidToken(user_id);
    const H = { Authorization: 'Bearer ' + token };
    const out = { order: orderId, variantes: {} };
    const urls = [
      ['v1_order_details', 'https://api.mercadolibre.com/billing/integration/group/ML/order/' + orderId + '/details?document_type=BILL'],
      ['v1_order_details_noDoc', 'https://api.mercadolibre.com/billing/integration/group/ML/order/' + orderId + '/details'],
      ['v2_order', 'https://api.mercadolibre.com/billing/integration/order/' + orderId + '/details?group=ML'],
      ['periods_orderparam', 'https://api.mercadolibre.com/billing/integration/periods/key/2026-07-01/group/ML/details?document_type=BILL&limit=10&offset=0&sales_info.order_id=' + orderId]
    ];
    for (const [k, url] of urls) {
      try {
        let r = null;
        for (let i = 0; i < 3; i++) {
          r = await fetch(url, { headers: H });
          if (r.status !== 429) break;
          await new Promise(rp => setTimeout(rp, 8000));
        }
        let j = null; try { j = await r.json(); } catch (e2) {}
        let resumen = null;
        if (j) {
          const txt = JSON.stringify(j);
          if (txt.length <= 2500) resumen = j;
          else {
            const rs = j.results || [];
            resumen = { keys: Object.keys(j), total: j.total, resultados: rs.length, lineas: rs.slice(0, 8).map(d => ({ concepto: d.charge_info && d.charge_info.transaction_detail, monto: d.charge_info && d.charge_info.detail_amount, tipo: d.charge_info && d.charge_info.detail_type, orden: d.sales_info && d.sales_info[0] && d.sales_info[0].order_id })) };
          }
        }
        out.variantes[k] = { http: r.status, body: resumen };
      } catch (e) { out.variantes[k] = { error: e.message }; }
      await new Promise(rp => setTimeout(rp, 400));
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SYNC DIARIO: cron job, trae ventas de ayer completas ──────────
app.get('/api/sync/diario', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  res.json({ message: 'Sync diario iniciado' });

  try {
    const { data: tokens } = await supabase.from('ml_tokens').select('*');
    if (!tokens || tokens.length === 0) return;

    for (const tokenRow of tokens) {
      const userId = tokenRow.user_id;
      const token  = await getValidToken(userId);
      if (!token) continue;

      // Ayer completo en hora Argentina (UTC-3)
      const ayer = new Date();
      ayer.setDate(ayer.getDate() - 1);
      const desdeISO = ayer.toISOString().substring(0,10) + 'T00:00:00.000-03:00';
      const hastaISO = ayer.toISOString().substring(0,10) + 'T23:59:59.000-03:00';

      let offset = 0, total = 999, guardadas = 0;

      while (offset < Math.min(total, 9950)) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${userId}`
          + `&order.date_created.from=${encodeURIComponent(desdeISO)}`
          + `&order.date_created.to=${encodeURIComponent(hastaISO)}`
          + `&sort=date_asc&offset=${offset}&limit=50&access_token=${token}`;

        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) { console.error('Sync diario error ML:', data.error); break; }

        total = data.paging.total;

        for (const order of data.results || []) {
          const row = await buildVentaRow(order, userId, token, true);
          await supabase.from('ventas').upsert(row, { onConflict: 'nro_venta' });
          guardadas++;
          await new Promise(r => setTimeout(r, 150)); // pausa entre ventas
        }

        offset += 50;
        await new Promise(r => setTimeout(r, 400));
      }

      console.log(`Sync diario user ${userId}: ${guardadas} ventas procesadas`);
    }
  } catch (e) {
    console.error('Sync diario error:', e.message);
  }
});

// ── SYNC (manual) ─────────────────────────────────────────────────
// Recorre las ventas desde hoy hacia atrás `dias` días y las guarda.
// incluirEnvio = true trae tipo de envío (Flex/Full/Colecta/M1) — más lento.
async function runSync(userId, dias, incluirEnvio, desdeStr, hastaStr) {
  let guardadas = 0;
  let errores = 0;
  try {
    let desde;
    if (desdeStr) { desde = new Date(desdeStr + 'T00:00:00.000-03:00'); }
    else { desde = new Date(); desde.setDate(desde.getDate() - (dias || 90)); }

    let chunkDesde = new Date(desde);
    const hoy = hastaStr ? new Date(hastaStr + 'T23:59:59.000-03:00') : new Date();

    console.log(`========================================`);
    console.log(`[SYNC] ARRANCA user=${userId} dias=${dias} envio=${incluirEnvio}`);
    console.log(`[SYNC] rango: ${desde.toISOString().substring(0,10)} -> ${hoy.toISOString().substring(0,10)}`);
    console.log(`========================================`);

    while (chunkDesde < hoy) {
      // Token renovado por chunk (los syncs largos pueden superar la vida del token)
      const token = await getValidToken(userId);
      if (!token) { console.error('[SYNC] CORTE: sin token para', userId); break; }

      const chunkHasta = new Date(chunkDesde);
      chunkHasta.setDate(chunkDesde.getDate() + 7);
      if (chunkHasta > hoy) chunkHasta.setTime(hoy.getTime());

      const desdeISO = chunkDesde.toISOString().substring(0,10)+'T00:00:00.000-03:00';
      const hastaISO = chunkHasta.toISOString().substring(0,10)+'T23:59:59.000-03:00';

      console.log(`[SYNC] CHUNK ${desdeISO.substring(0,10)} -> ${hastaISO.substring(0,10)} | guardadas hasta ahora=${guardadas}`);

      let offset = 0, total = 999;
      while (offset < Math.min(total, 9950)) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${userId}`
          + `&order.date_created.from=${encodeURIComponent(desdeISO)}`
          + `&order.date_created.to=${encodeURIComponent(hastaISO)}`
          + `&sort=date_asc&offset=${offset}&limit=50&access_token=${token}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) { console.error('[SYNC] ERROR ML orders/search:', JSON.stringify(data)); break; }
        total = (data.paging && data.paging.total) || 0;
        const cantidad = (data.results || []).length;
        console.log(`[SYNC]   pagina offset=${offset} total_ML=${total} trajo=${cantidad}`);

        for (const order of data.results || []) {
          try {
            // /orders/search NO trae el seller_sku completo -> traemos la orden
            // completa igual que el webhook, asi el SKU matchea con Contabilium
            let orderFull = order;
            try {
              const oResp = await fetch(`https://api.mercadolibre.com/orders/${order.id}?access_token=${token}`);
              const oData = await oResp.json();
              if (oData && oData.id) orderFull = oData;
            } catch (_) {}
            const row = await buildVentaRow(orderFull, userId, token, incluirEnvio);
            const { error: upErr } = await supabase.from('ventas').upsert(row, { onConflict: 'nro_venta' });
            if (upErr) { errores++; console.error('[SYNC] ERROR upsert venta', order.id, ':', upErr.message); }
            else guardadas++;
          } catch (orderErr) {
            errores++;
            console.error('[SYNC] ERROR procesando venta', order && order.id, ':', orderErr.message);
          }
          if (incluirEnvio) await new Promise(r => setTimeout(r, 120));
        }

        offset += 50;
        await new Promise(r => setTimeout(r, incluirEnvio ? 300 : 200));
      }

      chunkDesde.setDate(chunkDesde.getDate() + 8);
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`========================================`);
    console.log(`[SYNC] COMPLETO user ${userId}: ${guardadas} guardadas, ${errores} errores (dias=${dias}, envio=${incluirEnvio})`);
    console.log(`========================================`);
  } catch (e) {
    console.error('[SYNC] ERROR FATAL:', e.message, '|', e.stack);
  }
  return guardadas;
}

// POST /api/sync  { user_id, dias, envio }
app.post('/api/sync', (req, res) => {
  const { user_id, dias, envio } = req.body || {};
  const incluirEnvio = envio !== false && envio !== 'no';
  res.json({ message: 'Sincronización iniciada', user_id, dias, envio: incluirEnvio });
  runSync(String(user_id), Number(dias) || 90, incluirEnvio);
});

// GET /api/sync?user_id=...&dias=...&envio=si|no  (para disparar desde el navegador)
app.get('/api/sync', (req, res) => {
  const user_id = req.query.user_id;
  const dias    = Number(req.query.dias) || 7;
  const incluirEnvio = req.query.envio !== 'no';
  const desde = req.query.desde || null;
  const hasta = req.query.hasta || null;
  if (!user_id) return res.status(400).json({ error: 'Falta user_id. Ej: /api/sync?user_id=67619515&dias=7' });
  res.json({
    message: 'Sincronización iniciada. Corre en segundo plano; mirá los logs de Railway para ver el avance.',
    user_id, dias, desde, hasta, envio: incluirEnvio
  });
  runSync(String(user_id), dias, incluirEnvio, desde, hasta);
});

// ── CONTABILIUM: obtener token ────────────────────────────────────
async function getContabiliumToken() {
  const resp = await fetch('https://rest.contabilium.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Connection': 'close',
      'Accept-Encoding': 'identity'
    },
    compress: false,
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.CONTABILIUM_CLIENT_ID,
      client_secret: process.env.CONTABILIUM_CLIENT_SECRET
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Contabilium auth falló: ' + JSON.stringify(data));
  return data.access_token;
}

// ── ML: thumbnails por item_id (proxy, evita CORS en el navegador) ──
// GET /api/thumbs?ids=MLA1,MLA2&user_id=...  -> { id: url }
app.get('/api/thumbs', async (req, res) => {
  try {
    const ids = String(req.query.ids||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!ids.length) return res.json({});
    const userId = req.query.user_id || '67619515';
    let token = null; try { token = await getValidToken(userId); } catch(e) {}
    const out = {};
    for (let i=0;i<ids.length;i+=20){
      const chunk = ids.slice(i,i+20);
      const url = 'https://api.mercadolibre.com/items?ids='+chunk.join(',')+'&attributes=id,secure_thumbnail,thumbnail';
      try {
        const r = await fetch(url, { headers: token ? { Authorization: 'Bearer '+token } : {} });
        const arr = await r.json();
        (Array.isArray(arr)?arr:[]).forEach(row=>{
          const b = row && row.body;
          if (b && b.id) { let u = b.secure_thumbnail || b.thumbnail || ''; if (u) out[b.id] = u.replace(/^http:/,'https:'); }
        });
      } catch(e) {}
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTABILIUM: PROBE de compras (diagnostico TEMPORAL, solo lectura) ──
// GET /api/compras/probe -> prueba rutas candidatas y devuelve cual responde + muestra.
// Si seteas PROBE_SECRET en Railway, hay que pasar ?secret=...; si no, queda abierto.
// Borrar este endpoint cuando armemos la feature real de compras.
app.get('/api/compras/probe', async (req, res) => {
  try {
    if (process.env.PROBE_SECRET && req.query.secret !== process.env.PROBE_SECRET) {
      return res.status(401).json({ error: 'secret requerido' });
    }
    const token = await getContabiliumToken();
    const base  = 'https://rest.contabilium.com';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const candidatos = [
      '/api/comprobantescompra/search?pageSize=3&pageNumber=1',
      '/api/comprobantesdecompra/search?pageSize=3&pageNumber=1',
      '/api/compras/search?pageSize=3&pageNumber=1',
      '/api/comprobantes/search?pageSize=3&pageNumber=1',
      '/api/ordenescompra/search?pageSize=3&pageNumber=1',
      '/api/comprobantescompra/get?pageSize=3'
    ];
    const resultados = [];
    for (const path of candidatos) {
      try {
        const r   = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        const txt = await r.text();
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        let cuenta = null, keys = null, muestra = null;
        if (j) {
          const items = j.Items || j.items || (Array.isArray(j) ? j : null);
          if (Array.isArray(items)) { cuenta = items.length; muestra = items[0] || null; keys = items[0] ? Object.keys(items[0]) : []; }
          else { keys = Object.keys(j); }
        }
        resultados.push({ path, status: r.status, ok: r.ok, cuenta, keys, muestra, body: (j ? undefined : txt.slice(0, 200)) });
      } catch (e) {
        resultados.push({ path, error: e.message });
      }
      await sleep(500); // rate limit 25/10s
    }
    res.json({ probe: 'compras', resultados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CONTABILIUM: traer todos los productos con costo ──────────────
// GET /api/costos/contabilium
// Devuelve array de { codigo, nombre, costoInterno, iva, precio }
// v13: SOLO admin y encargado. El operador recibe 403 aunque pruebe la URL a mano.
app.get('/api/costos/contabilium', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
  try {
    const token = await getContabiliumToken();
    const pageSize = 50;
    const base = 'https://rest.contabilium.com/api/conceptos/search';
    const PAUSA = 500; // Contabilium limita a 25 pedidos/10s -> ~2/seg es seguro
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const getPage = async (pageParam, n) => {
      const url = `${base}?pageSize=${pageSize}&${pageParam}=${n}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.json();
    };
    const primerCod = (d) => {
      const it = (d && (d.Items || d.items)) || [];
      return it.length ? String(it[0].Codigo || it[0].codigo || '').toUpperCase().trim() : '';
    };
    const _seen = new Map();
    const addItems = (d) => {
      const it = (d && (d.Items || d.items)) || [];
      let n = 0;
      for (const x of it) {
        const c = String(x.Codigo || x.codigo || '').toUpperCase().trim();
        if (c && !_seen.has(c)) { _seen.set(c, x); n++; }
      }
      return { nuevos: n, len: it.length };
    };

    // Página 1 (cualquier nombre da la primera página si el parámetro se ignora)
    const d1 = await getPage('pageNumber', 1);
    const cod1 = primerCod(d1);
    const totalItems = (d1 && d1.TotalItems != null) ? d1.TotalItems : null;
    console.log(`[CONTA] pagina 1: primerCod=${cod1} TotalItems=${totalItems}`);
    addItems(d1);

    // Detectar cuál parámetro pagina DE VERDAD (que la página 2 traiga otros códigos)
    const candidatos = ['pageNumber', 'page', 'nroPagina', 'pagina', 'nroPag', 'pageIndex'];
    let pageParam = null;
    for (const cand of candidatos) {
      await sleep(PAUSA);
      const d2 = await getPage(cand, 2);
      const cod2 = primerCod(d2);
      console.log(`[CONTA] probando "${cand}=2" -> primerCod=${cod2}`);
      if (cod2 && cod2 !== cod1) { pageParam = cand; addItems(d2); break; }
    }

    if (pageParam) {
      console.log(`[CONTA] paginación OK con parámetro "${pageParam}"`);
      let page = 3; // ya tenemos página 1 y 2
      while (true) {
        await sleep(PAUSA);
        const d = await getPage(pageParam, page);
        const { nuevos, len } = addItems(d);
        console.log(`[CONTA] pagina ${page} (${pageParam}) nuevos=${nuevos} | unicos=${_seen.size}`);
        if (len === 0 || nuevos === 0 || len < pageSize) break;
        page++;
        if (page > 500) break;
      }
    } else {
      console.error('[CONTA] NINGUN parametro de paginacion cambio la pagina -> solo ' + _seen.size + ' productos. Revisar el nombre del parametro en la doc de Contabilium.');
    }

    const costos = [..._seen.values()].map(p => ({
      codigo:       String(p.Codigo || p.codigo || '').toUpperCase().trim(),
      nombre:       p.Nombre || p.nombre || '',
      costoInterno: p.CostoInterno || p.costoInterno || 0,
      iva:          p.Iva || p.iva || 0,
      precio:       p.Precio || p.precio || 0,
      estado:       p.Estado || p.estado || '',
      stock:        (p.Stock!=null?Number(p.Stock):(p.StockActual!=null?Number(p.StockActual):(p.StockDisponible!=null?Number(p.StockDisponible):(p.Inventario!=null?Number(p.Inventario):(p.Cantidad!=null?Number(p.Cantidad):null)))))
    })).filter(p => p.codigo);
    try { const _s0=[..._seen.values()][0]; if(_s0) console.log('[CONTA] claves del concepto:', Object.keys(_s0).join(', ')); } catch(e){}

    console.log(`[CONTA] TOTAL: ${costos.length} productos unicos (parametro=${pageParam || 'NINGUNO'}, esperado ~${totalItems})`);
    res.json({ costos, total: costos.length, pageParam: pageParam || null });
  } catch (e) {
    console.error('Contabilium error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CONTABILIUM: buscar producto por SKU ──────────────────────────
// v13: SOLO admin y encargado (devuelve costo interno = dato sensible)
app.get('/api/costos/contabilium/:sku', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
  try {
    const token = await getContabiliumToken();
    const sku = encodeURIComponent(req.params.sku);
    const r = await fetch(`https://rest.contabilium.com/api/conceptos/getByCodigo?codigo=${sku}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (data.error || !data.Codigo) return res.status(404).json({ error: 'SKU no encontrado' });
    res.json({
      codigo:       data.Codigo,
      nombre:       data.Nombre,
      costoInterno: data.CostoInterno || 0,
      iva:          data.Iva || 0,
      precio:       data.Precio || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BACKFILL HISTÓRICO (TEMPORAL): carga costo_congelado desde el CMV ──
// Matchea cada venta con el CMV por SKU exacto + precio (c/IVA) + día (±2),
// y si no, por el precio más cercano del mismo SKU en el mes. Sobreescribe.
// v13: SOLO admin (modifica costos de toda la base)
app.post('/api/costos/backfill', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const userId = req.body.user_id;
    const filas  = req.body.rows || [];
    if (!userId || !filas.length) return res.status(400).json({ error: 'Faltan datos' });

    const DAY = 864e5;
    const cmv = [];
    let minD = null, maxD = null;
    for (const f of filas) {
      const sku   = String(f.sku || '').trim();
      const cant  = (parseFloat(f.cantidad) || 1) || 1;
      const pu    = parseFloat(f.precioUnit);
      const iva   = parseFloat(f.iva) || 0;
      const costo = parseFloat(f.costo);
      const dia   = f.fecha ? new Date(f.fecha) : null;
      if (!sku || isNaN(pu) || isNaN(costo) || !dia || isNaN(dia.getTime())) continue;
      const t = dia.getTime();
      // El "Costo" del CMV YA viene por unidad → NO dividir por cantidad.
      // costo_congelado se calcula despues como costo_u * unidades (total).
      cmv.push({ sku, bruto_u: pu * (1 + iva / 100), costo_u: costo, t });
      if (minD === null || t < minD) minD = t;
      if (maxD === null || t > maxD) maxD = t;
    }
    if (!cmv.length) return res.status(400).json({ error: 'CMV vacio o invalido' });

    const bySku = {};
    for (const r of cmv) { (bySku[r.sku] = bySku[r.sku] || []).push(r); }

    // Traer ventas del rango (±2 dias) paginando (tope 1000 del plan free)
    const desde = new Date(minD - 2 * DAY).toISOString();
    const hasta = new Date(maxD + 2 * DAY).toISOString();
    let ventas = [], from = 0;
    while (true) {
      const { data, error } = await supabase.from('ventas')
        .select('nro_venta,sku,precio,unidades,fecha_cierre,fecha')
        .eq('user_id', userId)
        .gte('fecha_cierre', desde).lte('fecha_cierre', hasta)
        .range(from, from + 999);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || !data.length) break;
      ventas = ventas.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    const updates = [];
    let exacto = 0, aprox = 0, sin = 0;
    for (const v of ventas) {
      const sku = String(v.sku || '').trim();
      const cands = bySku[sku];
      const unidades = parseFloat(v.unidades) || 1;
      const precio = parseFloat(v.precio) || 0;
      const dt = new Date(v.fecha_cierre || v.fecha);
      if (!cands || !precio || isNaN(dt.getTime())) { sin++; continue; }
      const bruto_u = unidades > 0 ? precio / unidades : precio;
      const t = dt.getTime();
      let best = null;
      for (const c of cands) {
        if (Math.abs(c.t - t) / DAY <= 2.5) {
          const pdif = Math.abs(c.bruto_u - bruto_u);
          if (best === null || pdif < best.pdif) best = { pdif, costo_u: c.costo_u };
        }
      }
      let costo_u = null, esExacto = false;
      if (best) {
        costo_u = best.costo_u;
        esExacto = bruto_u > 0 && (best.pdif / bruto_u) <= 0.005;
      } else {
        let b2 = null;
        for (const c of cands) {
          const pdif = Math.abs(c.bruto_u - bruto_u);
          if (b2 === null || pdif < b2.pdif) b2 = { pdif, costo_u: c.costo_u };
        }
        if (b2) costo_u = b2.costo_u;
      }
      if (costo_u === null) { sin++; continue; }
      if (esExacto) exacto++; else aprox++;
      updates.push({ nro_venta: v.nro_venta, costo_congelado: Math.round(costo_u * unidades * 100) / 100 });
    }

    let actualizadas = 0;
    for (let i = 0; i < updates.length; i += 50) {
      const lote = updates.slice(i, i + 50);
      const resultados = await Promise.all(lote.map(u =>
        supabase.from('ventas')
          .update({ costo_congelado: u.costo_congelado })
          .eq('user_id', userId)
          .eq('nro_venta', u.nro_venta)
      ));
      for (const r of resultados) { if (!r.error) actualizadas++; }
    }

    res.json({ ventas: ventas.length, exacto, aprox, sin, actualizadas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO BONIFICACIONES (TEMPORAL, abierto): respuesta cruda de facturación ──
// Uso: /api/bonif/diag?user_id=67619515&nro_venta=2000016718538322
app.get('/api/bonif/diag', async (req, res) => {
  try {
    const { user_id, nro_venta } = req.query;
    if (!user_id || !nro_venta) return res.status(400).json({ error: 'Falta user_id o nro_venta' });
    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML para ese user_id' });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const probe = async (url) => {
      try {
        const r = await fetch(url, auth);
        let b; try { b = await r.json(); } catch { b = await r.text(); }
        return { url, status: r.status, body: b };
      } catch (e) { return { url, error: e.message }; }
    };

    const out = { nro_venta, order_payments: [], mediations: null, probes: [] };

    // 1) Orden → payment_ids, estado de pagos, reembolsos y mediaciones
    const order = await (await fetch(`https://api.mercadolibre.com/orders/${nro_venta}`, auth)).json();
    const pays = Array.isArray(order.payments) ? order.payments : [];
    out.order_payments = pays.map(p => ({
      id: p.id, status: p.status, status_detail: p.status_detail,
      transaction_amount: p.transaction_amount, total_paid_amount: p.total_paid_amount,
      transaction_amount_refunded: p.transaction_amount_refunded
    }));
    out.mediations = order.mediations || null;
    out.pack_id = order.pack_id || null;

    // 2) Probar endpoints de facturación (devuelvo crudo el que ande)
    for (const p of pays) {
      out.probes.push(await probe(`https://api.mercadolibre.com/billing/integration/payment/${p.id}/charges`));
    }
    out.probes.push(await probe(`https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&limit=6`));
    out.probes.push(await probe(`https://api.mercadolibre.com/billing/monthly/periods?group=ML&limit=6`));

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO FLEX (TEMPORAL): vuelca el desglose del envío para ubicar la bonificación ──
// Uso: /api/bonif/diagflex?user_id=67619515&nro_venta=2000016891494744
app.get('/api/bonif/diagflex', async (req, res) => {
  try {
    const { user_id, nro_venta } = req.query;
    if (!user_id || !nro_venta) return res.status(400).json({ error: 'Falta user_id o nro_venta' });
    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML para ese user_id' });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const order = await (await fetch(`https://api.mercadolibre.com/orders/${nro_venta}`, auth)).json();
    const out = {
      nro_venta,
      shipping_id: (order.shipping && order.shipping.id) || null,
      order_coupon: order.coupon || null,
      order_taxes: order.taxes || null,
      order_payments: (Array.isArray(order.payments) ? order.payments : []).map(p => ({
        id: p.id, transaction_amount: p.transaction_amount, total_paid_amount: p.total_paid_amount,
        shipping_cost: p.shipping_cost, coupon_amount: p.coupon_amount, taxes_amount: p.taxes_amount
      }))
    };
    const shipId = out.shipping_id;
    if (shipId) {
      const ship = await (await fetch(`https://api.mercadolibre.com/shipments/${shipId}`, auth)).json();
      out.shipment = { logistic_type: ship.logistic_type, base_cost: ship.base_cost, shipping_option: ship.shipping_option, status: ship.status };
      out.shipment_costs = await (await fetch(`https://api.mercadolibre.com/shipments/${shipId}/costs`, auth)).json();
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATUS ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '4.4.0', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
// ── MEDIDAS: planilla de pesos/medidas publicada en Google Sheets ────
const MEDIDAS_CSV_URL = process.env.MEDIDAS_CSV_URL
  || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTpXeWJBa0W6P4uZuEl8VrR2HN75pHr5oDXlD3BraTnSsVpjDh950v6O6k3y_q-lIA2S-feSRlh6tdu/pub?gid=1181343863&single=true&output=csv';
let _medidasCache = null, _medidasTs = 0;

function _parseCSV(text){
  const rows=[]; let row=[]; let field=''; let inQ=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQ){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else inQ=false; }
      else field+=c;
    } else {
      if(c==='"') inQ=true;
      else if(c===','){ row.push(field); field=''; }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else if(c==='\r'){ /* ignorar */ }
      else field+=c;
    }
  }
  if(field!==''||row.length){ row.push(field); rows.push(row); }
  return rows;
}
function _numAR(s){
  if(s==null) return 0;
  s=String(s).replace(/[$\s\u00a0]/g,'');
  if(!s) return 0;
  if(s.indexOf('.')>-1 && s.indexOf(',')>-1) s=s.replace(/\./g,'').replace(',','.');
  else if(s.indexOf(',')>-1) s=s.replace(',','.');
  const n=parseFloat(s);
  return isNaN(n)?0:n;
}
// Normaliza encabezados: saca acentos, colapsa espacios, minúsculas.
// (Antes NO sacaba acentos, así que "KG de envío" y "Costo envío Mercado Libre"
//  no matcheaban y envioML quedaba en 0 para todos.)
function _normH(c){
  return (c||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // saca tildes/acentos
    .replace(/\s+/g,' ').trim().toLowerCase();
}
function buildMedidas(text){
  const rows=_parseCSV(text);
  let hi=-1;
  for(let i=0;i<rows.length;i++){ if(rows[i].some(c=>_normH(c)==='sku producto')){ hi=i; break; } }
  if(hi<0) return {};
  const hdr=rows[hi].map(_normH);
  // Busca por coincidencia exacta y, si no, por "contiene" (tolera prefijos como "Costo ...").
  const findCol=(...needles)=>{
    for(const n of needles){ const i=hdr.indexOf(n); if(i>-1) return i; }
    for(const n of needles){ const i=hdr.findIndex(h=>h.indexOf(n)>-1); if(i>-1) return i; }
    return -1;
  };
  const cSku=findCol('sku producto');
  const cLargo=findCol('largo'), cAncho=findCol('ancho'), cAlto=findCol('alto');
  const cPeso=findCol('peso'), cKg=findCol('kg de envio');
  // En la planilla la columna se llama "Costo envío Mercado Libre": la tomamos por "contiene".
  const cEnvioML=findCol('envio mercado libre','costo envio mercado libre');
  console.log(`[MEDIDAS] cols -> sku=${cSku} largo=${cLargo} ancho=${cAncho} alto=${cAlto} peso=${cPeso} kg=${cKg} envioML=${cEnvioML}`);
  const map={};
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i]; const sku=(cSku>-1?(r[cSku]||''):'').trim();
    if(!sku) continue;
    map[sku.toUpperCase()]={
      sku, largo:_numAR(r[cLargo]), ancho:_numAR(r[cAncho]), alto:_numAR(r[cAlto]),
      peso:_numAR(r[cPeso]), kgEnvio:_numAR(r[cKg]), envioML:_numAR(r[cEnvioML])
    };
  }
  return map;
}

// GET /api/medidas -> mapa SKU -> medidas (cacheado 5 min). Lee la planilla publicada.
app.get('/api/medidas', requireAuth, async (req, res) => {
  try {
    const ahora = Date.now();
    if (_medidasCache && (ahora - _medidasTs) < 5*60*1000) {
      return res.json({ medidas: _medidasCache, skus: Object.keys(_medidasCache).length, cache: true });
    }
    const r = await fetch(MEDIDAS_CSV_URL);
    const text = await r.text();
    const map = buildMedidas(text);
    if (Object.keys(map).length > 0) { _medidasCache = map; _medidasTs = ahora; }
    console.log('[MEDIDAS] cargadas', Object.keys(map).length, 'SKUs desde Google Sheets');
    res.json({ medidas: map, skus: Object.keys(map).length, cache: false });
  } catch (e) {
    console.error('[MEDIDAS] error:', e.message);
    res.status(500).json({ error: e.message, medidas: {} });
  }
});

// ── DIAGNÓSTICO BONIFICACIONES 2 (TEMPORAL): periodos + detalles de facturacion ──
// Uso: /api/bonif/diag2?user_id=67619515&nro_venta=2000016718538322
app.get('/api/bonif/diag2', async (req, res) => {
  try {
    const { user_id, nro_venta } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const get = async (url) => {
      try { const r = await fetch(url, auth); let b; try { b = await r.json(); } catch { b = await r.text(); }
            return { status: r.status, body: b }; } catch (e) { return { error: e.message }; }
    };
    const out = { nro_venta: nro_venta || null, periods: {}, sample: {}, matches: {} };

    for (const dt of ['BILL', 'CREDIT_NOTE']) {
      const per = await get(`https://api.mercadolibre.com/billing/integration/monthly/periods?group=ML&document_type=${dt}&limit=6`);
      out.periods[dt] = per;
      let arr = per.body && (per.body.results || per.body.periods || per.body.data || per.body.last_periods);
      let key = (Array.isArray(arr) && arr.length) ? (arr[0].key || arr[0].period_key || arr[0].period || arr[0].id) : null;
      if (!key) continue;
      out.periods[dt + '_used_key'] = key;
      out.sample[dt] = await get(`https://api.mercadolibre.com/billing/integration/periods/key/${key}/group/ML/details?document_type=${dt}&limit=2`);
      if (nro_venta) {
        const found = [];
        for (let off = 0; off < 20 * 150; off += 150) {
          const pg = await get(`https://api.mercadolibre.com/billing/integration/periods/key/${key}/group/ML/details?document_type=${dt}&limit=150&offset=${off}`);
          const rs = pg.body && pg.body.results;
          if (!Array.isArray(rs) || rs.length === 0) break;
          for (const row of rs) { if (JSON.stringify(row).includes(String(nro_venta))) found.push(row); }
          if (found.length) break;
        }
        out.matches[dt] = found;
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO BONIFICACIONES 3 (TEMPORAL): detalle del pago (Mercado Pago) ──
// Uso: /api/bonif/diag3?user_id=67619515&nro_venta=2000016718538322
app.get('/api/bonif/diag3', async (req, res) => {
  try {
    const { user_id, nro_venta, payment_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const get = async (url) => {
      try { const r = await fetch(url, auth); let b; try { b = await r.json(); } catch { b = await r.text(); }
            return { url, status: r.status, body: b }; } catch (e) { return { url, error: e.message }; }
    };
    const out = { payment_id: payment_id || null, probes: [] };
    let pid = payment_id;
    if (!pid && nro_venta) {
      const order = await get(`https://api.mercadolibre.com/orders/${nro_venta}`);
      const pays = (order.body && order.body.payments) || [];
      pid = pays[0] && pays[0].id;
      out.payment_id = pid;
    }
    if (pid) {
      out.probes.push(await get(`https://api.mercadolibre.com/v1/payments/${pid}`));
      out.probes.push(await get(`https://api.mercadolibre.com/payments/${pid}`));
      out.probes.push(await get(`https://api.mercadolibre.com/v1/payments/${pid}/refunds`));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO PUBLICIDAD v3 (TEMPORAL): anuncios ACTIVOS (gasto>0) por publicación ──
// Uso: /api/ads/diag?user_id=67619515
app.get('/api/ads/diag', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Falta user_id. Ej: /api/ads/diag?user_id=67619515' });
    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML para ese user_id' });

    const V2 = { 'Api-Version': '2' };
    const probe = async (url) => {
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Api-Version': '2' } });
        let b; try { b = await r.json(); } catch (_) { b = await r.text(); }
        return { status: r.status, body: b };
      } catch (e) { return { error: e.message }; }
    };

    const a = 10904;
    const hoy = new Date(); const desde = new Date(hoy); desde.setDate(hoy.getDate() - 30);
    const f = d => d.toISOString().substring(0, 10);
    const M = 'clicks,prints,cost,cpc,acos,units_quantity,direct_amount,indirect_amount,total_amount,organic_units_quantity';
    const base = `https://api.mercadolibre.com/advertising/advertisers/${a}/product_ads/items?date_from=${f(desde)}&date_to=${f(hoy)}&metrics=${M}`;

    const out = { rango: `${f(desde)} a ${f(hoy)}`, sort_probes: [], total_items: null, paginas_escaneadas: 0, activos_encontrados: 0, top_anuncios: [] };

    // 1) probar si soporta ordenar por gasto (así una sola página trae los que más gastan)
    for (const s of ['sort=cost_desc', 'sort_field=cost&sort_order=desc', 'order=cost_desc']) {
      const r = await probe(`${base}&${s}&limit=5`);
      const first = (r.body && r.body.results) ? r.body.results.slice(0, 3).map(x => ({ item: x.item_id, cost: x.metrics && x.metrics.cost })) : null;
      out.sort_probes.push({ probe: s, status: r.status, primeros: first });
    }

    // 2) escanear páginas y juntar los anuncios con gasto > 0
    const activos = [];
    for (let off = 0; off < 500; off += 50) {
      const r = await probe(`${base}&limit=50&offset=${off}`);
      out.paginas_escaneadas++;
      const arr = (r.body && r.body.results) || [];
      if (out.total_items === null && r.body && r.body.paging) out.total_items = r.body.paging.total;
      for (const it of arr) {
        const m = it.metrics || {};
        if ((m.cost || 0) > 0) activos.push({
          item_id: it.item_id, campaign_id: it.campaign_id, title: it.title,
          status: it.status, cost: m.cost, acos: m.acos, units_quantity: m.units_quantity,
          total_amount: m.total_amount, organic_units: m.organic_units_quantity
        });
      }
      if (!arr.length) break;
    }
    activos.sort((x, y) => (y.cost || 0) - (x.cost || 0));
    out.activos_encontrados = activos.length;
    out.top_anuncios = activos.slice(0, 25);

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUBLICIDAD: gasto real por anuncio (item) en un rango, con caché ──
// Uso: /api/ads/items?user_id=67619515&desde=2026-06-01&hasta=2026-06-19
const _adsCache = {}; // key: user|desde|hasta -> { ts, data }
const ADS_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

app.get('/api/ads/items', async (req, res) => {
  try {
    const { user_id, desde, hasta } = req.query;
    if (!user_id || !desde || !hasta) return res.status(400).json({ error: 'Faltan user_id, desde, hasta (YYYY-MM-DD)' });

    const key = `${user_id}|${desde}|${hasta}`;
    const hit = _adsCache[key];
    if (hit && Date.now() - hit.ts < ADS_TTL_MS) return res.json(Object.assign({ cached: true }, hit.data));

    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML para ese user_id' });

    const a = 10904; // advertiser PONTEC SA
    const M = 'cost,acos,units_quantity,total_amount,organic_units_quantity';
    const base = `https://api.mercadolibre.com/advertising/advertisers/${a}/product_ads/items?date_from=${desde}&date_to=${hasta}&metrics=${M}`;
    const headers = { Authorization: `Bearer ${token}`, 'Api-Version': '2' };

    const map = {};
    let gastoTotal = 0;
    const acc = (arr) => {
      for (const it of arr || []) {
        const c = (it.metrics && it.metrics.cost) || 0;
        if (c > 0) {
          map[it.item_id] = { cost: c, acos: it.metrics.acos || 0, units: it.metrics.units_quantity || 0 };
          gastoTotal += c;
        }
      }
    };

    // primera página: saber el total
    const first = await fetch(`${base}&limit=50&offset=0`, { headers });
    const fj = await first.json();
    if (first.status !== 200) return res.status(first.status).json({ error: 'Error API ads', detalle: fj });
    const total = (fj.paging && fj.paging.total) || 0;
    acc(fj.results);

    // resto en lotes concurrentes (rápido)
    const offsets = [];
    for (let o = 50; o < total; o += 50) offsets.push(o);
    const LOTE = 6;
    for (let i = 0; i < offsets.length; i += LOTE) {
      const batch = offsets.slice(i, i + LOTE).map(o =>
        fetch(`${base}&limit=50&offset=${o}`, { headers }).then(r => r.json()).catch(() => ({}))
      );
      const results = await Promise.all(batch);
      results.forEach(j => acc(j.results));
    }

    const data = {
      advertiser_id: a,
      rango: `${desde} a ${hasta}`,
      total_items: total,
      anuncios_con_gasto: Object.keys(map).length,
      gasto_total: Math.round(gastoTotal),
      gastos: map
    };
    _adsCache[key] = { ts: Date.now(), data };
    res.json(Object.assign({ cached: false }, data));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO ENVÍO (TEMPORAL) ──
// 1 venta:  /api/envio/diag?user_id=67619515&order=2000017022730948
// muestra varias: /api/envio/diag?user_id=67619515&sample=1
app.get('/api/envio/diag', async (req, res) => {
  try {
    const { user_id, order, shipment, sample } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Falta user_id' });
    const token = await getValidToken(user_id);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });
    const H = { headers: { Authorization: `Bearer ${token}` } };

    // helper: trae el desglose real de un shipment
    const desglose = async (shipId) => {
      const rs = await fetch(`https://api.mercadolibre.com/shipments/${shipId}`, H);
      const ship = await rs.json();
      const rc = await fetch(`https://api.mercadolibre.com/shipments/${shipId}/costs`, H);
      const costs = await rc.json();
      const sender = (Array.isArray(costs.senders) && costs.senders[0]) || {};
      return {
        logistic_type: ship.logistic_type,
        list_cost: ship.shipping_option && ship.shipping_option.list_cost,
        base_cost: ship.base_cost,
        gross_amount: costs.gross_amount,
        comprador_cost: costs.receiver && costs.receiver.cost,
        vendedor_cost: sender.cost
      };
    };

    // MODO SAMPLE: ventas más caras con envío guardado > 0
    if (sample) {
      const { data, error } = await supabase.from('ventas')
        .select('nro_venta,sku,titulo,precio,costo_envio')
        .eq('user_id', String(user_id))
        .gt('costo_envio', 0)
        .order('precio', { ascending: false })
        .limit(10);
      if (error) return res.status(500).json({ error: error.message });
      const out = [];
      for (const v of (data || [])) {
        try {
          const ro = await fetch(`https://api.mercadolibre.com/orders/${v.nro_venta}`, H);
          const o = await ro.json();
          const shipId = o.shipping && o.shipping.id;
          let dg = {};
          if (shipId) dg = await desglose(shipId);
          out.push({
            nro: v.nro_venta, sku: v.sku, precio: v.precio,
            logistic: dg.logistic_type,
            GUARDADO_costo_envio: v.costo_envio,          // lo que usa MargenML hoy (bruto)
            REAL_vendedor_cost: dg.vendedor_cost,         // lo que pagás de verdad (senders.cost)
            comprador_cost: dg.comprador_cost,
            gross: dg.gross_amount
          });
        } catch (e) { out.push({ nro: v.nro_venta, error: e.message }); }
      }
      return res.json({ modo: 'sample', n: out.length, ventas: out });
    }

    // MODO 1 VENTA
    if (!order && !shipment) return res.status(400).json({ error: 'Pasá order=... o sample=1' });
    let shipId = shipment, ord = null;
    if (order) {
      const ro = await fetch(`https://api.mercadolibre.com/orders/${order}`, H);
      ord = await ro.json();
      shipId = ord.shipping && ord.shipping.id;
    }
    if (!shipId) return res.json({ error: 'No encontré shipment', order });
    const dg = await desglose(shipId);
    res.json(Object.assign({ order: order || null, shipment_id: shipId, precio_item: ord && ord.order_items && ord.order_items[0] && ord.order_items[0].unit_price }, dg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`MargenML backend v34 (verificados) corriendo en puerto ${PORT}`));

module.exports = app;

// ── CARGOS DE DEVOLUCIONES: sincronizacion automatica cada 5 dias (ultimos 60 dias / 3 periodos) ──
async function _cargosAutoSync() {
  try {
    const user_id = '67619515';
    const base = 'https://margenml-backend-production.up.railway.app';
    const h = new Date();
    const per = [];
    for (let k = 2; k >= 0; k--) { const d = new Date(h.getFullYear(), h.getMonth() - k, 1); per.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'); }
    console.log('[CARGOS-AUTO] arrancando, periodos:', per.join(','));
    await fetch(base + '/api/devol/cargos-prep?user_id=' + user_id + '&periods=' + per.join(','));
    for (const p of per) {
      for (let i = 0; i < 500; i++) {
        const r = await fetch(base + '/api/devol/cargos-sync?user_id=' + user_id + '&period=' + p);
        const d = await r.json();
        if (d.reintentar) { await new Promise(rs => setTimeout(rs, 20000)); continue; }
        if (d.error || d.done) break;
        await new Promise(rs => setTimeout(rs, 500));
      }
    }
    console.log('[CARGOS-AUTO] completado');
  } catch (e) { console.log('[CARGOS-AUTO] error:', e.message); }
}
setTimeout(_cargosAutoSync, 5 * 60 * 1000);          // 5 min despues de arrancar
setInterval(_cargosAutoSync, 5 * 24 * 60 * 60 * 1000); // y cada 5 dias

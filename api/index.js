const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// Marcador de version (para verificar que Railway tiene el codigo nuevo)
app.get('/api/version', (req, res) => res.json({ version: 'v21-porcentajes', costo_congelado: true }));

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
        .select('rol,pestanas,apps').eq('email', email).single();
      req.rol      = (rolRow && rolRow.rol) || 'operador';
      req.pestanas = (rolRow && rolRow.pestanas) || null;
      req.apps     = (rolRow && rolRow.apps) || null;
    } catch (e) {
      req.rol = 'operador';
      req.pestanas = null;
      req.apps = null;
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

// ── Quien soy: el frontend pregunta el rol para armar el menu ──────
app.get('/api/mi-rol', requireAuth, (req, res) => {
  res.json({ email: req.authUser.email, rol: req.rol, pestanas: req.pestanas, apps: req.apps });
});

// ══ USUARIOS v14 (solo admin): gestion del equipo desde el panel ══
// Crea el login en Supabase Auth Y la fila de rol en mml_roles de un saque.

// Listar equipo
app.get('/api/usuarios', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('mml_roles')
      .select('email,rol,pestanas,apps,user_id,creado').order('creado', { ascending: true });
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
    if (eAuth) return res.status(400).json({ error: 'No se pudo crear el login: ' + eAuth.message });
    const uid = created && created.user && created.user.id;

    const { error: eRol } = await supabase.from('mml_roles')
      .upsert({ email, rol, user_id: uid || null }, { onConflict: 'email' });
    if (eRol) return res.status(500).json({ error: 'Login creado pero fallo el rol: ' + eRol.message });

    res.json({ ok: true, email, rol });
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
      const appsOk = ['rentabilidad','logistica','promos','asistente'];
      if (a === null) upd.apps = null;
      else if (Array.isArray(a)) upd.apps = a.filter(x => appsOk.indexOf(String(x)) > -1);
      else return res.status(400).json({ error: 'apps debe ser lista o null' });
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
app.get('/api/promos', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
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
app.get('/api/promos/items', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
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
app.get('/api/promos/titulos', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
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
app.get('/api/promos/item/:item_id', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
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
app.post('/api/promos/aplicar', requireAuth, soloRoles('admin'), async (req, res) => {
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
app.delete('/api/promos/quitar', requireAuth, soloRoles('admin'), async (req, res) => {
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
      const r = await fetch('https://api.mercadolibre.com/items?ids=' + chunk.join(',') + '&attributes=id,title,price,seller_sku,seller_custom_field', {
        headers: { Authorization: 'Bearer ' + token }
      });
      const arr = await r.json();
      (Array.isArray(arr) ? arr : []).forEach(row => {
        const b = row && row.body;
        if (b && b.id) out[b.id] = { title: b.title || '', price: b.price || 0, sku: String(b.seller_sku || b.seller_custom_field || '').trim().toUpperCase() };
      });
    } catch (e) {}
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

// GET /api/promos/analisis -> recorre TODAS las campañas y devuelve
// cada item con precio actual, sugerido de ML y costo de Contabilium.
app.get('/api/promos/analisis', requireAuth, soloRoles('admin', 'encargado'), async (req, res) => {
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
- "aplicar_descuento": parametros {"sku" o "item_id"} mas UNO de estos dos: {"precio": numero} (precio final deseado) o {"porcentaje": numero} (ej "10% de descuento" -> {"porcentaje":10}) -> aplica descuento individual
- "ver_promos": parametros {"sku" o "item_id"} -> lista las promociones activas
- "buscar": parametros {"sku":"..."} -> lista las publicaciones de un SKU con precio
- "multi": parametros {"acciones":[{"accion":"quitar_descuento","parametros":{...}},{"accion":"aplicar_descuento","parametros":{...}}]} -> cuando el usuario pide VARIAS cosas en un mismo mensaje (solo combina quitar_descuento y aplicar_descuento)
- "charla": sin parametros -> saludos, dudas, o cuando falta un dato; lo que quieras decir va en "respuesta"

Reglas:
- Los SKU de Pontec son codigos tipo OFI210-BL o AIR010-NE: letras+numeros y a veces sufijo de color (NE=negro, BL=blanco, AZ=azul, RO=rojo, GR=gris, VE=verde, MA=marron, CO=cobre). Si el usuario dice "la silla ofi 210 blanca", el SKU es OFI210-BL.
- Si el usuario dice un porcentaje de descuento, mandalo como "porcentaje"; NO le pidas el precio final.
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
      model, max_tokens: 700, system: ASISTENTE_SYS,
      messages: mensajes.map(m => ({ role: m.rol === 'user' ? 'user' : 'assistant', content: String(m.texto || '').slice(0, 2000) }))
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
        const body = { deal_price: precioFinal, promotion_type: 'PRICE_DISCOUNT' };
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
          : ' (' + ((d1 && (d1.message || d1.error)) || 'ML lo rechazo sin detalle') + ')'));
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

app.post('/api/asistente', requireAuth, soloRoles('admin'), async (req, res) => {
  try {
    const userId = (req.body && req.body.user_id) || '67619515';
    const token = await getValidToken(userId);
    if (!token) return res.status(400).json({ error: 'Sin token ML' });

    // Boton Confirmar: ejecuta la accion pendiente tal cual se mostro
    const conf = req.body && req.body.confirmar;
    if (conf && conf.accion) {
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

    if (j.accion === 'multi') {
      const subs = ((p.acciones || j.acciones || [])).filter(s => s && (s.accion === 'quitar_descuento' || s.accion === 'aplicar_descuento'));
      if (!subs.length) return res.json({ respuesta: j.respuesta || 'No entendi la lista de ordenes, proba de a una.' });
      const lineas = []; const listos = [];
      for (const s of subs) {
        const sp = s.parametros || {};
        const spct = Number(sp.porcentaje);
        const sTienePct = spct > 0 && spct < 95;
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
          : (sTienePct ? 'Descuento ' + spct + '%' : 'Descuento a $' + Math.round(Number(sp.precio)).toLocaleString()))
          + ' en ' + idsUsar.length + ' pub: ' + tt);
        listos.push({ accion: s.accion, parametros: sp, items: idsUsar, precios: sPrecios });
      }
      if (!listos.length) return res.json({ respuesta: 'No encontre publicaciones para ninguna de las ordenes:\n' + lineas.join('\n') });
      return res.json({
        respuesta: 'Plan (' + listos.length + ' orden/es):\n' + lineas.join('\n'),
        pendiente: { accion: 'multi', acciones: listos }
      });
    }
    if (j.accion === 'quitar_descuento' || j.accion === 'aplicar_descuento') {
      const pct = Number(p.porcentaje);
      const tienePct = pct > 0 && pct < 95;
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
          respuesta: 'Voy a aplicar ' + pct + '% de descuento en ' + okIds.length + ' publicacion(es):\n' + lineasP.join('\n'),
          pendiente: { accion: j.accion, parametros: p, items: okIds, precios }
        });
      }

      const lista = ids.map(id => '- ' + ((mini[id] && mini[id].title) ? mini[id].title.slice(0, 48) : id)).join('\n');
      const desc = j.accion === 'quitar_descuento'
        ? 'Voy a QUITAR los descuentos de ' + ids.length + ' publicacion(es):'
        : 'Voy a aplicar descuento dejando el precio en $' + Math.round(Number(p.precio)).toLocaleString() + ' en ' + ids.length + ' publicacion(es):';
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
      let query = supabase.from('ventas').select('nro_venta,user_id,fecha,fecha_cierre,sku,titulo,unidades,precio,comision,costo_envio,precio_comprador_envio,logistic_type,provincia,ciudad,estado,con_cuotas,cuotas,costo_financiero,tipo_publicacion,pack_id,item_id,costo_congelado,cancel_code:raw->cancel_detail->>code,ml_tags:raw->tags,dev_return,dev_benef').eq('user_id', user_id);
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

app.listen(PORT, () => console.log(`MargenML backend v21 (porcentajes) corriendo en puerto ${PORT}`));

module.exports = app;

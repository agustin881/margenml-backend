const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
    return {
      costo_envio:           (ship.shipping_option && ship.shipping_option.list_cost) || ship.base_cost || 0,
      precio_comprador_envio:(ship.shipping_option && ship.shipping_option.cost) || 0,
      logistic_type:          ship.logistic_type || '',
      provincia:             (ship.receiver && ship.receiver.state  && ship.receiver.state.name)  || '',
      ciudad:                (ship.receiver && ship.receiver.city   && ship.receiver.city.name)   || '',
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
  const comision = order.order_items
    ? order.order_items.reduce((a, i) => a + (i.sale_fee || 0), 0) : 0;

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
app.post('/api/webhook/ml', async (req, res) => {
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

    console.log('Venta guardada (webhook):', order.id, order.status, '/', topic || resource.split('/')[1]);
    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.message);
    return res.sendStatus(200);
  }
});

// ── VENTAS: obtener ventas guardadas (paginado para superar límite de 1000) ─
app.get('/api/ventas', async (req, res) => {
  try {
    const { user_id, desde, hasta } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

    let todas = [];
    let offset = 0;
    const lote = 1000;

    while (true) {
      let query = supabase.from('ventas').select('*').eq('user_id', user_id);
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

    res.json({ ventas: todas, total: todas.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
async function runSync(userId, dias, incluirEnvio) {
  let guardadas = 0;
  let errores = 0;
  try {
    const desde = new Date();
    desde.setDate(desde.getDate() - (dias || 90));

    let chunkDesde = new Date(desde);
    const hoy = new Date();

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
  if (!user_id) return res.status(400).json({ error: 'Falta user_id. Ej: /api/sync?user_id=67619515&dias=7' });
  res.json({
    message: 'Sincronización iniciada. Corre en segundo plano; mirá los logs de Railway para ver el avance.',
    user_id, dias, envio: incluirEnvio
  });
  runSync(String(user_id), dias, incluirEnvio);
});

// ── CONTABILIUM: obtener token ────────────────────────────────────
async function getContabiliumToken() {
  const resp = await fetch('https://rest.contabilium.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

// ── CONTABILIUM: traer todos los productos con costo ──────────────
// GET /api/costos/contabilium
// Devuelve array de { codigo, nombre, costoInterno, iva, precio }
app.get('/api/costos/contabilium', async (req, res) => {
  try {
    const token = await getContabiliumToken();

    let productos = [];
    let page = 1;
    const pageSize = 50;       // Contabilium pagina de a 50
    let totalItems = null;
    let totalPages = null;

    while (true) {
      const url = `https://rest.contabilium.com/api/conceptos/search?pageSize=${pageSize}&pageIndex=${page}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();

      // Respuesta de Contabilium: { Items:[...], TotalPage:N, TotalItems:N }
      const items = (data && (data.Items || data.items)) || [];

      if (page === 1) {
        totalItems = data.TotalItems != null ? data.TotalItems : null;
        totalPages = data.TotalPage  != null ? data.TotalPage  : null;
        console.log(`Contabilium: TotalItems=${totalItems}, TotalPage=${totalPages}, primera página=${items.length}`);
      }

      if (!Array.isArray(items) || items.length === 0) break;

      productos = productos.concat(items);

      // Cortar según lo que informa Contabilium
      if (totalItems != null && productos.length >= totalItems) break;
      if (totalPages != null && page >= totalPages) break;
      if (totalItems == null && totalPages == null && items.length < pageSize) break;

      page++;
      if (page > 2000) break;   // tope de seguridad
      await new Promise(r => setTimeout(r, 150));
    }

    const costos = productos
      .filter(p => p && (p.Codigo || p.codigo))
      .map(p => ({
        codigo:       String(p.Codigo || p.codigo || '').toUpperCase().trim(),
        nombre:       p.Nombre || p.nombre || '',
        costoInterno: p.CostoInterno || p.costoInterno || 0,
        iva:          p.Iva || p.iva || 0,
        precio:       p.Precio || p.precio || 0,
        estado:       p.Estado || p.estado || ''
      }))
      .filter(p => p.codigo);

    console.log(`Contabilium: ${costos.length} productos traídos (esperado: ${totalItems})`);
    res.json({ costos, total: costos.length });
  } catch (e) {
    console.error('Contabilium error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CONTABILIUM: buscar producto por SKU ──────────────────────────
app.get('/api/costos/contabilium/:sku', async (req, res) => {
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

// ── STATUS ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '4.4.0', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MargenML backend v3 corriendo en puerto ${PORT}`));

module.exports = app;

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ML OAuth
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '7675542594083413';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'UMkN5YDMPQDGLK0GiipUgvTdpoIyYQAq';
const ML_REDIRECT_URI  = process.env.ML_REDIRECT_URI  || 'https://zingy-creponne-a36346.netlify.app/';

// ── OAUTH: intercambiar code por token ────────────────────────────
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

    // Guardar/actualizar token en Supabase
    const { error } = await supabase.from('ml_tokens').upsert({
      user_id:       String(data.user_id),
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString()
    }, { onConflict: 'user_id' });

    if (error) console.error('Supabase upsert error:', error);

    res.json({ 
      access_token: data.access_token, 
      user_id: data.user_id,
      expires_in: data.expires_in
    });
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

// ── WEBHOOK: recibir notificaciones de ML en tiempo real ──────────
app.post('/api/webhook/ml', async (req, res) => {
  res.sendStatus(200); // ML requiere respuesta inmediata
  try {
    const { resource, user_id, topic } = req.body;
    if (topic !== 'orders_v2') return;

    // Obtener el token del vendedor
    const { data: tokenRow } = await supabase
      .from('ml_tokens').select('*').eq('user_id', String(user_id)).single();
    if (!tokenRow) return;

    // Verificar si el token está vencido
    let token = tokenRow.access_token;
    if (new Date(tokenRow.expires_at) < new Date()) {
      const refreshResp = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET, refresh_token: tokenRow.refresh_token
        })
      });
      const refreshData = await refreshResp.json();
      if (!refreshData.error) {
        token = refreshData.access_token;
        await supabase.from('ml_tokens').upsert({
          user_id: String(user_id), access_token: token,
          refresh_token: refreshData.refresh_token,
          expires_at: new Date(Date.now() + refreshData.expires_in*1000).toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
      }
    }

    // Obtener detalle de la orden
    const orderId = resource.split('/').pop();
    const orderResp = await fetch(`https://api.mercadolibre.com/orders/${orderId}?access_token=${token}`);
    const order = await orderResp.json();
    if (order.error) return;

    // Obtener envío
    let shipData = {};
    if (order.shipping && order.shipping.id) {
      const shipResp = await fetch(`https://api.mercadolibre.com/shipments/${order.shipping.id}?access_token=${token}`);
      const ship = await shipResp.json();
      if (!ship.error) {
        shipData = {
          costo_envio:   (ship.shipping_option && ship.shipping_option.list_cost) || ship.base_cost || 0,
          logistic_type: ship.logistic_type || '',
          provincia:     ship.receiver && ship.receiver.state ? ship.receiver.state.name : ''
        };
      }
    }

    const item = order.order_items && order.order_items[0] ? order.order_items[0] : {};
    const comision = order.order_items ? order.order_items.reduce((a, i) => a + (i.sale_fee||0), 0) : 0;

    // Guardar/actualizar venta en Supabase
    await supabase.from('ventas').upsert({
      nro_venta:     String(order.id),
      user_id:       String(user_id),
      fecha:         order.date_created,
      sku:           item.item && item.item.seller_sku ? item.item.seller_sku.trim() : '',
      titulo:        item.item ? item.item.title : '',
      unidades:      item.quantity || 1,
      precio:        order.total_amount,
      comision:      comision,
      costo_envio:   shipData.costo_envio || 0,
      logistic_type: shipData.logistic_type || '',
      provincia:     shipData.provincia || '',
      estado:        order.status,
      con_cuotas:    order.payments && order.payments[0] && (order.payments[0].installments||1) > 1,
      pack_id:       order.pack_id ? String(order.pack_id) : null,
      raw:           JSON.stringify(order)
    }, { onConflict: 'nro_venta' });

    console.log('Venta guardada:', order.id);
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

// ── VENTAS: obtener ventas guardadas ──────────────────────────────
app.get('/api/ventas', async (req, res) => {
  try {
    const { user_id, desde, hasta } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

    let query = supabase.from('ventas').select('*').eq('user_id', user_id);
    if (desde) query = query.gte('fecha', desde);
    if (hasta) query = query.lte('fecha', hasta);
    query = query.order('fecha', { ascending: false }).limit(50000);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ventas: data, total: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SINCRONIZAR: traer órdenes históricas ─────────────────────────
app.post('/api/sync', async (req, res) => {
  const { user_id, dias } = req.body;
  res.json({ message: 'Sincronización iniciada', user_id, dias });

  try {
    const { data: tokenRow } = await supabase
      .from('ml_tokens').select('*').eq('user_id', String(user_id)).single();
    if (!tokenRow) return;

    const token = tokenRow.access_token;
    const desde = new Date();
    desde.setDate(desde.getDate() - (dias || 90));

    let todasOrdenes = [];
    let chunkDesde = new Date(desde);
    const hoy = new Date();

    while (chunkDesde < hoy) {
      const chunkHasta = new Date(chunkDesde);
      chunkHasta.setDate(chunkDesde.getDate() + 7);
      if (chunkHasta > hoy) chunkHasta.setTime(hoy.getTime());

      const desdeISO = chunkDesde.toISOString().substring(0,10)+'T00:00:00.000-03:00';
      const hastaISO = chunkHasta.toISOString().substring(0,10)+'T23:59:59.000-03:00';

      let offset = 0, total = 999;
      while (offset < Math.min(total, 9950)) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${user_id}&order.date_created.from=${encodeURIComponent(desdeISO)}&order.date_created.to=${encodeURIComponent(hastaISO)}&sort=date_asc&offset=${offset}&limit=50&access_token=${token}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) break;
        total = data.paging.total;
        todasOrdenes = todasOrdenes.concat(data.results || []);
        offset += 50;
        await new Promise(r => setTimeout(r, 200));
      }

      chunkDesde.setDate(chunkDesde.getDate() + 8);
      await new Promise(r => setTimeout(r, 500));
    }

    // Guardar todas en Supabase
    for (const order of todasOrdenes) {
      const item = order.order_items && order.order_items[0] ? order.order_items[0] : {};
      const comision = order.order_items ? order.order_items.reduce((a, i) => a + (i.sale_fee||0), 0) : 0;
      await supabase.from('ventas').upsert({
        nro_venta: String(order.id), user_id: String(user_id),
        fecha: order.date_created,
        sku: item.item && item.item.seller_sku ? item.item.seller_sku.trim() : '',
        titulo: item.item ? item.item.title : '',
        unidades: item.quantity || 1, precio: order.total_amount,
        comision, costo_envio: 0, logistic_type: '', provincia: '',
        estado: order.status,
        con_cuotas: order.payments && order.payments[0] && (order.payments[0].installments||1) > 1,
        pack_id: order.pack_id ? String(order.pack_id) : null
      }, { onConflict: 'nro_venta' });
    }
    console.log('Sync completo:', todasOrdenes.length, 'órdenes para user', user_id);
  } catch (e) {
    console.error('Sync error:', e.message);
  }
});

// ── STATUS ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MargenML backend corriendo en puerto ${PORT}`));

module.exports = app;

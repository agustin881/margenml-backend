// =====================================================================
// RespondIA - Backend v2 (Node + Express) -> Railway
// Multi-cuenta + Config avanzada:
//  - Interruptor de respuestas automaticas (OFF = modo sombra)
//  - Saludo inicial/final configurables
//  - Zona horaria + franjas horarias con demora de respuesta
//  - Limite anti-pelea (max respuestas seguidas al mismo comprador)
//  - Hilo por comprador (contexto de consultas previas del mismo cliente)
//  - Worker de envio programado (solo actua con auto ON y confianza alta)
// Archivo en GitHub: index.js
// =====================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// CORS: permite que el panel (Vercel) llame a este backend (Railway)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-clave, x-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 45mb porque los manuales viajan en base64 dentro del JSON: un archivo de
// 25MB (el maximo que acepta la mensajeria de ML) ocupa ~34mb codificado.
app.use(express.json({ limit: '45mb' }));

// ---------------------------------------------------------------------
// CONFIG (variables de entorno en Railway)
// ---------------------------------------------------------------------
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const ML_CLIENT_ID      = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET  = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI   = process.env.ML_REDIRECT_URI;
const ML_USER_ID        = process.env.ML_USER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const MODELO_IA         = process.env.MODELO_IA || 'claude-sonnet-4-6';   // Claude (por defecto)
const MODELO_GPT        = process.env.MODELO_GPT || 'gpt-5.4';            // rival GPT del Duelo
const MODELO_GEMINI     = process.env.MODELO_GEMINI || 'gemini-3.5-flash';// rival Gemini del Duelo
const CLAVE_PANEL       = process.env.CLAVE_PANEL || 'pontec';

// ---------------------------------------------------------------------
// PRECIOS DE LAS IA (USD por 1.000.000 de tokens)
//  in         = entrada normal (sin cache)
//  cacheWrite = escribir en cache (Claude cobra 1,25x la entrada)
//  cacheRead  = leer de cache (mucho mas barato)
//  out        = salida
// Editables aca si cambian las tarifas. Sirven para el Duelo y el costo real.
// ---------------------------------------------------------------------
const PRECIOS = {
  'claude-sonnet-4-6': { in: 3,   cacheWrite: 3.75, cacheRead: 0.30, out: 15 },
  'claude-sonnet-5':   { in: 3,   cacheWrite: 3.75, cacheRead: 0.30, out: 15 },
  'gpt-5.4':           { in: 2.5, cacheWrite: 2.5,  cacheRead: 0.25, out: 15 },
  'gpt-5.5':           { in: 5,   cacheWrite: 5,    cacheRead: 0.50, out: 30 },
  'gemini-3.5-flash':  { in: 1.5, cacheWrite: 1.5,  cacheRead: 0.15, out: 9 },
  'gemini-3.1-flash-lite': { in: 0.25, cacheWrite: 0.25, cacheRead: 0.025, out: 1.5 }
};
// u = { in, cacheWrite, cacheRead, out } (tokens). Devuelve USD reales de esa llamada.
function costoUSD(modelo, u) {
  const p = PRECIOS[modelo] || {};
  return (
    (u.in || 0)         * (p.in || 0) +
    (u.cacheWrite || 0) * (p.cacheWrite || p.in || 0) +
    (u.cacheRead || 0)  * (p.cacheRead || 0) +
    (u.out || 0)        * (p.out || 0)
  ) / 1e6;
}
// clave de cuenta ('claude' | 'gpt' | 'gemini') -> string real del modelo
function modeloDe(clave) {
  if (clave === 'gpt') return MODELO_GPT;
  if (clave === 'gemini') return MODELO_GEMINI;
  return MODELO_IA;
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let backfill = { corriendo: false, procesadas: 0, total: 0, desde: null, error: null, cuenta: null };

// =====================================================================
// CONFIG POR CUENTA (valores por defecto + merge con lo guardado)
// =====================================================================
const CONFIG_DEFAULT = {
  auto_responder: false,               // OFF = modo sombra (no envia nada)
  saludo_inicial: 'Hola!',
  saludo_final: '',
  timezone: 'America/Argentina/Buenos_Aires',
  demora_default_min: 5,               // demora si no hay franja que aplique
  fuera_de_franja: 'esperar',          // 'esperar' (manda al abrir la proxima franja) | 'revision' (queda para humano)
  franjas: [],                         // [{desde:'09:00', hasta:'20:00', demora_min:5}]
  max_respuestas_seguidas: 2,          // limite anti-pelea por comprador+producto
  ventana_hilo_dias: 7,                // dias hacia atras para armar el hilo del comprador
  msg_sin_dato: '',                    // plantilla de respuesta cuando falta un dato del producto
  auto_sin_dato: false,                // true = enviar esa plantilla automaticamente (con franjas); false = queda a revision
  confianza_minima: 'alta',            // precision minima para auto-enviar: 'alta' (recomendado) | 'media'
  ia_responde: 'claude'                // que IA responde esta cuenta: 'claude' | 'gpt' (lo elige el master / el cliente)
};

function configDe(cuenta) {
  return Object.assign({}, CONFIG_DEFAULT, (cuenta && cuenta.config) || {});
}

// =====================================================================
// FRANJAS HORARIAS (todas las cuentas en su propia zona horaria)
// =====================================================================
// Hora local "HH:MM" en la zona horaria dada
function horaLocal(tz, fecha = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(fecha);
  } catch (e) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(fecha);
  }
}

function aMinutos(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Devuelve la franja activa para una hora local, o null.
// Soporta franjas que cruzan medianoche (ej: 22:00 -> 06:00).
function franjaActiva(franjas, hhmm) {
  const t = aMinutos(hhmm);
  for (const f of (franjas || [])) {
    const d = aMinutos(f.desde), h = aMinutos(f.hasta);
    if (d === h) continue;
    const dentro = d < h ? (t >= d && t < h) : (t >= d || t < h);
    if (dentro) return f;
  }
  return null;
}

// Minutos que faltan (en la zona tz) hasta que abra la proxima franja.
// Si no hay franjas, devuelve null.
function minutosHastaProximaFranja(franjas, tz, fecha = new Date()) {
  if (!franjas || !franjas.length) return null;
  const ahora = aMinutos(horaLocal(tz, fecha));
  let mejor = null;
  for (const f of franjas) {
    const d = aMinutos(f.desde);
    let delta = d - ahora;
    if (delta <= 0) delta += 24 * 60; // manana
    if (mejor === null || delta < mejor) mejor = delta;
  }
  return mejor;
}

// Decide cuando enviar una respuesta segun la config de la cuenta.
// Devuelve { enviar_at: Date | null, motivo: string }
//  - enviar_at = null significa "queda para revision humana".
function calcularEnvio(cfg, ahora = new Date()) {
  const hh = horaLocal(cfg.timezone, ahora);
  const franja = franjaActiva(cfg.franjas, hh);
  if (franja) {
    const demora = Number(franja.demora_min ?? cfg.demora_default_min) || 0;
    return { enviar_at: new Date(ahora.getTime() + demora * 60000), motivo: `franja ${franja.desde}-${franja.hasta}, demora ${demora}m` };
  }
  // fuera de toda franja
  if (!cfg.franjas || !cfg.franjas.length) {
    const demora = Number(cfg.demora_default_min) || 0;
    return { enviar_at: new Date(ahora.getTime() + demora * 60000), motivo: `sin franjas, demora default ${demora}m` };
  }
  if (cfg.fuera_de_franja === 'revision') {
    return { enviar_at: null, motivo: 'fuera de franja -> revision humana' };
  }
  const faltan = minutosHastaProximaFranja(cfg.franjas, cfg.timezone, ahora) || 0;
  return { enviar_at: new Date(ahora.getTime() + faltan * 60000), motivo: `fuera de franja -> espera ${faltan}m hasta proxima franja` };
}

// =====================================================================
// USUARIOS Y SESIONES (Etapa 1)
// - Passwords hasheadas con scrypt (crypto de Node, sin dependencias).
// - Sesiones por token (30 dias) en pq_sesiones.
// - RED DE SEGURIDAD: la CLAVE_PANEL sigue funcionando como acceso MASTER,
//   asi nunca quedas afuera aunque el login fallara.
// Roles: master (todas las cuentas) | dueno | gerente | operador
// =====================================================================
const crypto = require('crypto');

function hashPassword(pass, sal = null) {
  sal = sal || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), sal, 64).toString('hex');
  return { hash, sal };
}
function verificarPassword(pass, hash, sal) {
  try {
    const h = crypto.scryptSync(String(pass), sal, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}
function nuevoToken() { return crypto.randomBytes(32).toString('hex'); }

async function usuarioPorToken(token) {
  if (!token) return null;
  try {
    const trabajo = (async () => {
      const { data: ses } = await db.from('pq_sesiones').select('usuario_id, expira_at').eq('token', token).single();
      if (!ses || new Date(ses.expira_at) < new Date()) return null;
      const { data: u } = await db.from('pq_usuarios').select('id, cuenta_id, email, nombre, rol, permisos, activo').eq('id', ses.usuario_id).single();
      if (!u || !u.activo) return null;
      return u;
    })();
    const timeout = new Promise(r => setTimeout(() => r(null), 5000));
    return await Promise.race([trabajo, timeout]);
  } catch (e) { return null; }
}

// Middleware de acceso: acepta CLAVE_PANEL (master legado) o token de sesion
async function soloPanel(req, res, next) {
  const clave = req.query.clave || req.headers['x-clave'];
  if (clave && clave === CLAVE_PANEL) {
    req.usuario = { id: 0, email: 'master', rol: 'master', cuenta_id: null, permisos: {} };
    return next();
  }
  const token = req.query.token || req.headers['x-token'];
  if (token) {
    const u = await usuarioPorToken(token);
    if (u) { req.usuario = u; return next(); }
  }
  return res.status(401).json({ error: 'clave invalida' });
}

// Solo ciertos roles pueden pasar
function requiereRol(...roles) {
  return (req, res, next) => {
    if (!req.usuario || !roles.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'no tenes permiso para esto (' + roles.join('/') + ')' });
    }
    next();
  };
}
// El operador necesita el permiso puntual; master/dueno/gerente pasan siempre
function requierePermiso(perm) {
  return (req, res, next) => {
    const u = req.usuario;
    if (!u) return res.status(401).json({ error: 'sin sesion' });
    if (['master', 'dueno', 'gerente'].includes(u.rol)) return next();
    if (u.permisos && u.permisos[perm]) return next();
    return res.status(403).json({ error: 'tu usuario no tiene el permiso: ' + perm });
  };
}

// Rate limit de login: 5 intentos fallidos por 15 min por IP+email (anti fuerza bruta)
const _intentosLogin = new Map();
function loginPermitido(key) {
  const ahora = Date.now();
  const e = _intentosLogin.get(key);
  if (!e || ahora - e.desde > 15 * 60 * 1000) { _intentosLogin.set(key, { n: 1, desde: ahora }); return true; }
  e.n++;
  if (_intentosLogin.size > 10000) _intentosLogin.clear();
  return e.n <= 5;
}

// ---- ENDPOINTS DE AUTENTICACION ----
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'falta email o contrasenia' });
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').toString().split(',')[0].trim();
    const key = ip + '|' + String(email).toLowerCase().trim();
    if (!loginPermitido(key)) return res.status(429).json({ error: 'demasiados intentos, proba de nuevo en 15 minutos' });
    const { data: u } = await db.from('pq_usuarios').select('*').eq('email', String(email).toLowerCase().trim()).single();
    if (!u || !u.activo || !verificarPassword(password, u.hash, u.sal)) {
      return res.status(401).json({ error: 'email o contrasenia incorrectos' });
    }
    _intentosLogin.delete(key); // login ok: limpiar contador
    const token = nuevoToken();
    await db.from('pq_sesiones').insert({
      token, usuario_id: u.id,
      expira_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    });
    res.json({ ok: true, token, usuario: { email: u.email, nombre: u.nombre, rol: u.rol, permisos: u.permisos, cuenta_id: u.cuenta_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SSO PONTEC OS: el hub le pasa su sesion de Supabase a la app embebida y este
// endpoint la verifica. Si el email del hub existe como usuario ACTIVO de
// RespondIA, se abre una sesion normal (mismo formato que /auth/login).
app.post('/auth/sso', async (req, res) => {
  try {
    const { access_token } = req.body || {};
    if (!access_token) return res.status(400).json({ error: 'falta access_token' });
    // verificar el token contra Supabase Auth (el mismo proyecto del hub)
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + access_token }
    });
    const su = await r.json();
    const email = (su && su.email ? String(su.email) : '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'sesion del hub invalida' });
    const { data: u } = await db.from('pq_usuarios').select('*').eq('email', email).single();
    if (!u || !u.activo) return res.status(403).json({ error: 'tu usuario del hub (' + email + ') no existe en RespondIA. Pedile al master que te cree con ese mismo email.' });
    const token = nuevoToken();
    await db.from('pq_sesiones').insert({
      token, usuario_id: u.id,
      expira_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    });
    res.json({ ok: true, token, usuario: { email: u.email, nombre: u.nombre, rol: u.rol, permisos: u.permisos, cuenta_id: u.cuenta_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/logout', soloPanel, async (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (token) await db.from('pq_sesiones').delete().eq('token', token);
  res.json({ ok: true });
});

app.get('/auth/me', soloPanel, async (req, res) => {
  res.json({ usuario: { email: req.usuario.email, nombre: req.usuario.nombre || null, rol: req.usuario.rol, permisos: req.usuario.permisos || {}, cuenta_id: req.usuario.cuenta_id } });
});

// REGISTRO SELF-SERVICE: un cliente nuevo crea su usuario dueno con un
// codigo de invitacion (variable CODIGO_REGISTRO en Railway). Despues conecta
// su Mercado Libre y queda operativo solo, sin intervencion del master.
app.post('/auth/registro', async (req, res) => {
  try {
    const CODIGO = process.env.CODIGO_REGISTRO;
    if (!CODIGO) return res.status(403).json({ error: 'el registro esta deshabilitado (falta CODIGO_REGISTRO en el servidor)' });
    const { codigo, email, password, nombre } = req.body || {};
    if (String(codigo || '').trim() !== CODIGO) return res.status(401).json({ error: 'codigo de invitacion incorrecto' });
    if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'email y contrasenia (min 8 caracteres) requeridos' });
    const { hash, sal } = hashPassword(password);
    const { data: creado, error } = await db.from('pq_usuarios').insert({
      email: String(email).toLowerCase().trim(), nombre: nombre || null, hash, sal,
      rol: 'dueno', cuenta_id: null   // sin cuenta todavia: la vincula con el paso de ML
    }).select('id').single();
    if (error) return res.status(500).json({ error: error.message.includes('duplicate') ? 'ese email ya esta registrado' : error.message });
    const token = nuevoToken();
    await db.from('pq_sesiones').insert({ token, usuario_id: creado.id, expira_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() });
    res.json({ ok: true, token, usuario: { email: String(email).toLowerCase().trim(), nombre: nombre || null, rol: 'dueno', permisos: {}, cuenta_id: null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear el PRIMER usuario master (solo con la clave maestra, solo si no existe ninguno)
app.post('/auth/setup-master', async (req, res) => {
  try {
    const clave = req.query.clave || req.headers['x-clave'];
    if (clave !== CLAVE_PANEL) return res.status(401).json({ error: 'clave invalida' });
    const { count } = await db.from('pq_usuarios').select('id', { count: 'exact', head: true }).eq('rol', 'master');
    if (count > 0) return res.status(400).json({ error: 'ya existe un usuario master' });
    const { email, password, nombre } = req.body || {};
    if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'email y contrasenia (min 8 caracteres) requeridos' });
    const { hash, sal } = hashPassword(password);
    const { error } = await db.from('pq_usuarios').insert({
      email: String(email).toLowerCase().trim(), nombre: nombre || null, hash, sal, rol: 'master', cuenta_id: null
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, msg: 'usuario master creado. Ya podes entrar con email y contrasenia.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GESTION DE USUARIOS (solo master y dueno) ----
app.get('/api/usuarios', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  let q = db.from('pq_usuarios').select('id, cuenta_id, email, nombre, rol, permisos, activo, creado_at').order('creado_at');
  if (req.usuario.rol === 'dueno') {
    // el dueno solo ve usuarios de SU cuenta
    q = q.eq('cuenta_id', req.usuario.cuenta_id);
  } else {
    // el master ve los usuarios de la CUENTA SELECCIONADA (+ el propio master, que es global)
    const cuenta = await resolverCuenta(req);
    if (cuenta) q = q.or(`cuenta_id.eq.${cuenta.id},rol.eq.master`);
  }
  const { data } = await q;
  res.json(data || []);
});

app.post('/api/usuarios', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const { email, nombre, password, rol, permisos } = req.body || {};
    if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'email y contrasenia (min 8) requeridos' });
    const rolesPermitidos = req.usuario.rol === 'master' ? ['dueno', 'gerente', 'operador'] : ['gerente', 'operador'];
    if (!rolesPermitidos.includes(rol)) return res.status(400).json({ error: 'rol invalido: ' + rolesPermitidos.join(' / ') });
    // el nuevo usuario queda en la cuenta del creador (o la elegida por el master)
    let cuentaId = req.usuario.cuenta_id;
    if (req.usuario.rol === 'master') {
      cuentaId = req.body.cuenta_id || (await resolverCuenta(req))?.id || null;
    }
    if (!cuentaId) return res.status(400).json({ error: 'no pude determinar la cuenta del usuario' });
    const { hash, sal } = hashPassword(password);
    const { error } = await db.from('pq_usuarios').insert({
      email: String(email).toLowerCase().trim(), nombre: nombre || null, hash, sal,
      rol, permisos: permisos || {}, cuenta_id: cuentaId, creado_por: req.usuario.id
    });
    if (error) return res.status(500).json({ error: error.message.includes('duplicate') ? 'ese email ya existe' : error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/usuarios/editar', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const { id, activo, rol, permisos, password, nombre } = req.body || {};
    const { data: objetivo } = await db.from('pq_usuarios').select('id, cuenta_id, rol').eq('id', id).single();
    if (!objetivo) return res.status(404).json({ error: 'usuario no encontrado' });
    if (req.usuario.rol === 'dueno' && objetivo.cuenta_id !== req.usuario.cuenta_id) return res.status(403).json({ error: 'no es un usuario de tu cuenta' });
    if (objetivo.rol === 'master' && req.usuario.rol !== 'master') return res.status(403).json({ error: 'no podes editar al master' });
    const upd = {};
    if (activo !== undefined) upd.activo = !!activo;
    if (nombre !== undefined) upd.nombre = nombre;
    const rolesEditables = req.usuario.rol === 'master' ? ['master', 'dueno', 'gerente', 'operador'] : ['dueno', 'gerente', 'operador'];
    if (rol && rolesEditables.includes(rol)) {
      upd.rol = rol;
      if (rol === 'master') upd.cuenta_id = null; // master es global: ve todas las cuentas
    }
    if (permisos !== undefined) upd.permisos = permisos;
    if (password) { const { hash, sal } = hashPassword(password); upd.hash = hash; upd.sal = sal; }
    const { error } = await db.from('pq_usuarios').update(upd).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    if (activo === false) await db.from('pq_sesiones').delete().eq('usuario_id', id); // desactivar = cerrar sesiones
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================================
// CUENTAS (tenants)
// =====================================================================
async function getCuentaPorMlUser(mlUserId) {
  const { data } = await db.from('pq_cuentas').select('*').eq('ml_user_id', mlUserId).single();
  return data || null;
}
async function getCuentaPorId(id) {
  const { data } = await db.from('pq_cuentas').select('*').eq('id', id).single();
  return data || null;
}
async function resolverCuenta(req) {
  // AISLAMIENTO: un usuario logueado (no master) SIEMPRE opera sobre su propia
  // cuenta, sin importar que pida por query. Solo el master elige cuenta.
  if (req.usuario && req.usuario.rol !== 'master' && req.usuario.cuenta_id) {
    return await getCuentaPorId(req.usuario.cuenta_id);
  }
  if (req.query.cuenta_id) return await getCuentaPorId(req.query.cuenta_id);
  if (ML_USER_ID) return await getCuentaPorMlUser(ML_USER_ID);
  return null;
}

// =====================================================================
// TOKENS DE MERCADO LIBRE (por cuenta)
// =====================================================================
async function getAccessToken(cuenta) {
  if (!cuenta || !cuenta.ml_refresh_token) throw new Error('Cuenta sin autorizar en ML. Entra a /oauth con esa cuenta.');
  if (cuenta.ml_expires_at && new Date(cuenta.ml_expires_at) > new Date()) return cuenta.ml_access_token;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: cuenta.ml_refresh_token
    })
  });
  const nuevo = await r.json();
  if (!nuevo.access_token) throw new Error('No pude refrescar token ML: ' + JSON.stringify(nuevo));
  const expires_at = new Date(Date.now() + (nuevo.expires_in - 300) * 1000).toISOString();
  await db.from('pq_cuentas').update({
    ml_access_token: nuevo.access_token, ml_refresh_token: nuevo.refresh_token, ml_expires_at: expires_at
  }).eq('id', cuenta.id);
  cuenta.ml_access_token = nuevo.access_token; cuenta.ml_refresh_token = nuevo.refresh_token; cuenta.ml_expires_at = expires_at;
  return nuevo.access_token;
}

async function mlGet(path, cuenta) {
  const token = await getAccessToken(cuenta);
  const url = path.startsWith('http') ? path : 'https://api.mercadolibre.com' + path;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { const txt = await r.text(); throw new Error('ML GET ' + path + ' -> ' + r.status + ' ' + txt); }
  return r.json();
}

async function mlPut(path, body, cuenta) {
  const token = await getAccessToken(cuenta);
  const r = await fetch('https://api.mercadolibre.com' + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('ML PUT ' + path + ' -> ' + r.status + ' ' + JSON.stringify(data));
  return data;
}
async function mlDelete(path, cuenta) {
  const token = await getAccessToken(cuenta);
  const r = await fetch('https://api.mercadolibre.com' + path, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('ML DELETE ' + path + ' -> ' + r.status + ' ' + JSON.stringify(data));
  return data;
}
async function mlPost(path, body, cuenta) {
  const token = await getAccessToken(cuenta);
  const r = await fetch('https://api.mercadolibre.com' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('ML POST ' + path + ' -> ' + r.status + ' ' + JSON.stringify(data));
  return data;
}

// =====================================================================
// ITEMS / SKU / STOCK (scope por cuenta)
// =====================================================================
function sacarSku(obj) {
  if (!obj) return null;
  // PRIORIDAD: 1) atributo SELLER_SKU (es el que ML actualiza cuando editas el SKU hoy)
  //            2) seller_sku  3) seller_custom_field (campo viejo, puede quedar congelado
  //               con SKUs anteriores cuando se renombra un producto)
  const a = (obj.attributes || []).find(x => x.id === 'SELLER_SKU');
  const deAtributo = a ? (a.value_name || a.values?.[0]?.name || null) : null;
  return deAtributo || obj.seller_sku || obj.seller_custom_field || null;
}

// SKU madre: agrupa variaciones del mismo producto.
// Convencion PONTEC: variacion = guion (GRI200-NE -> madre GRI200).
// SKUs sin guion quedan tal cual; sus variaciones se agrupan por publicacion (item_id).
function skuMadre(sku) {
  if (!sku) return null;
  const s = String(sku).trim();
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}
function descVariante(comb) {
  // TODOS los atributos que definen la variante (Color, Tapa, Diseno, etc.),
  // no solo "color": si la publicacion varia por otro atributo, tambien lo vemos.
  const partes = (comb || []).map(x => {
    const n = x.name || x.id || '';
    const v = x.value_name || '';
    return v ? (n ? n + ': ' + v : v) : null;
  }).filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

async function traerItem(cuenta, itemId, force = false) {
  const { data: cache } = await db.from('pq_items').select('*').eq('item_id', itemId).eq('cuenta_id', cuenta.id).single();
  if (!force && cache && cache.actualizado_at && (Date.now() - new Date(cache.actualizado_at).getTime()) < 6 * 3600 * 1000) return cache;

  let item, desc = '';
  try { item = await mlGet('/items/' + itemId, cuenta); } catch (e) { return cache || null; }
  try { const d = await mlGet('/items/' + itemId + '/description', cuenta); desc = d.plain_text || d.text || ''; } catch (e) {}

  let variaciones = (item.variations || []).map(v => ({
    color: descVariante(v.attribute_combinations), sku: sacarSku(v),
    stock: v.available_quantity, precio: v.price ?? null
  }));
  if (variaciones.length === 0) variaciones = [{ color: null, sku: sacarSku(item), stock: item.available_quantity, precio: item.price ?? null }];

  const skuItem = sacarSku(item) || variaciones[0]?.sku || null;
  const fila = {
    item_id: itemId,
    cuenta_id: cuenta.id,
    sku: skuItem,
    sku_madre: skuMadre(skuItem),
    titulo: item.title || null,
    imagenes: (item.pictures || []).slice(0, 4).map(p => p.secure_url || p.url).filter(Boolean),
    descripcion: desc,
    atributos: (item.attributes || []).reduce((o, a) => { o[a.name || a.id] = a.value_name; return o; }, {}),
    variaciones,
    nota_reposicion: cache?.nota_reposicion || null,
    skus: [...new Set([skuItem, ...variaciones.map(v => v.sku)].filter(Boolean))].join(' ') || null,
    estado: item.status || null,
    actualizado_at: new Date().toISOString()
  };
  await db.from('pq_items').upsert(fila);
  return fila;
}

// =====================================================================
// SIMILITUD: rankea el historial por parecido a la pregunta actual
// =====================================================================
const STOPWORDS = new Set(['hola','buenas','buenos','dias','tardes','noches','que','como','cual','cuales','por','para','con','sin','una','uno','unos','unas','the','del','las','los','este','esta','estos','estas','ese','esa','tiene','tienen','hay','son','mas','pero','les','pueden','puede','quiero','queria','saber','gracias','favor','consulta','pregunta','tenes','viene','vienen','ser','esta','estan'])
function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // sin acentos
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}
function similitud(tokensPregunta, textoHist) {
  if (!tokensPregunta.size) return 0;
  const th = new Set(tokens(textoHist));
  let comunes = 0;
  for (const t of tokensPregunta) if (th.has(t)) comunes++;
  return comunes / Math.sqrt(1 + th.size); // favorece coincidencias, penaliza textos larguisimos
}

// Decide si una regla aplica a una pregunta segun su "ambito".
// ambito: global | sku (exacto) | madre | item (publicacion) | prefijo | lista
function reglaAplica(r, ctx) {
  const sku = ctx.sku || '';
  const madre = ctx.madre || '';
  switch (r.ambito) {
    case 'global': return true;
    case 'sku':    return !!sku && sku === r.sku;
    case 'madre':  return !!madre && madre === (r.sku || skuMadre(r.sku));
    case 'item':   return !!ctx.item_id && ctx.item_id === r.item_id;
    case 'prefijo':return !!sku && !!r.sku && String(r.sku).split(',').map(s => s.trim().toUpperCase()).filter(Boolean).some(p => sku.toUpperCase().startsWith(p));
    case 'lista':  return !!sku && String(r.sku || '').split(',').map(s => s.trim().toUpperCase()).includes(sku.toUpperCase());
    default:       return !!sku && sku === r.sku; // compatibilidad con reglas viejas
  }
}

// =====================================================================
// MOTOR DE RESPUESTAS (CLAUDE)
// =====================================================================
// Todas devuelven { texto, inTok, outTok } para poder medir el costo real.
// system: string o array de bloques {type:'text', text, cache_control?}
// userContent: string o array de bloques (texto + imagenes)

async function llamarClaude(modelo, system, userContent, maxTokens = 700) {
  const body = {
    model: modelo,
    max_tokens: maxTokens,
    system: system,
    messages: [{ role: 'user', content: userContent }]
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.content) throw new Error('Claude error: ' + JSON.stringify(data));
  const texto = data.content.map(c => c.text || '').join('\n').trim();
  const u = data.usage || {};
  return { texto, usage: {
    in:         u.input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,   // primera vez: escribe el cache (1,25x)
    cacheRead:  u.cache_read_input_tokens || 0,        // repeticiones: lee del cache (barato)
    out:        u.output_tokens || 0
  } };
}

// Llama a GPT (OpenAI) adaptando el MISMO contexto que usa Claude, para que la
// comparacion del Duelo sea justa (misma ficha, mismas reglas, mismo historial).
async function llamarGPT(modelo, system, userContent, maxTokens = 700) {
  if (!OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY en Railway');
  // system Anthropic (array de bloques) -> un solo texto de sistema
  const sysText = typeof system === 'string'
    ? system
    : (system || []).map(b => b.text || '').join('\n\n');
  // userContent: string queda igual; array (texto+imagenes) se traduce al formato OpenAI
  let userMsg;
  if (typeof userContent === 'string') {
    userMsg = userContent;
  } else {
    userMsg = (userContent || []).map(b => {
      if (b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data) {
        return { type: 'image_url', image_url: { url: 'data:' + (b.source.media_type || 'image/jpeg') + ';base64,' + b.source.data } };
      }
      if (b.type === 'image' && b.source && b.source.url) {
        return { type: 'image_url', image_url: { url: b.source.url } };
      }
      return { type: 'text', text: b.text || '' };
    });
  }
  const body = {
    model: modelo,
    max_completion_tokens: maxTokens,
    response_format: { type: 'json_object' },   // nuestro prompt exige JSON valido
    messages: [
      { role: 'system', content: sysText },
      { role: 'user', content: userMsg }
    ]
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  const texto = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  if (!texto) throw new Error('GPT error: ' + JSON.stringify(data).slice(0, 300));
  const u = data.usage || {};
  // OpenAI cachea el prefijo automaticamente y lo reporta en prompt_tokens_details.cached_tokens
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return { texto: texto.trim(), usage: {
    in:         (u.prompt_tokens || 0) - cached,   // entrada NO cacheada
    cacheWrite: 0,                                 // OpenAI no cobra escritura de cache
    cacheRead:  cached,                            // parte servida desde cache (barata)
    out:        u.completion_tokens || 0
  } };
}

// Llama a Gemini (Google) adaptando el MISMO contexto que Claude/GPT.
// Convierte imagenes-por-URL a inline_data (base64) porque Gemini no toma URLs sueltas.
async function _urlAInline(url) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = r.headers.get('content-type') || 'image/jpeg';
  return { inline_data: { mime_type: mime, data: buf.toString('base64') } };
}
async function llamarGemini(modelo, system, userContent, maxTokens = 700) {
  if (!GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY en Railway');
  const sysText = typeof system === 'string'
    ? system
    : (system || []).map(b => b.text || '').join('\n\n');
  // partes del mensaje del usuario (texto + imagenes)
  let parts;
  if (typeof userContent === 'string') {
    parts = [{ text: userContent }];
  } else {
    parts = [];
    for (const b of (userContent || [])) {
      if (b.type === 'image' && b.source && b.source.url) parts.push(await _urlAInline(b.source.url));
      else parts.push({ text: b.text || '' });
    }
  }
  const genCfg = { maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + GEMINI_API_KEY;

  // pide a Gemini; primer intento sin "pensamiento" (mas barato y no corta la respuesta),
  // y si ese parametro no lo acepta este modelo, reintenta sin el.
  async function pedir(conThinkingOff) {
    const gc = conThinkingOff ? Object.assign({}, genCfg, { thinkingConfig: { thinkingBudget: 0 } }) : genCfg;
    const body = { systemInstruction: { parts: [{ text: sysText }] }, contents: [{ role: 'user', parts }], generationConfig: gc };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  }
  let data = await pedir(true);
  if (data.error) data = await pedir(false); // reintento sin thinkingConfig
  const cand = data.candidates && data.candidates[0];
  const texto = (cand && cand.content && cand.content.parts ? cand.content.parts.map(p => p.text || '').join('') : '').trim();
  if (!texto) throw new Error('Gemini error: ' + JSON.stringify(data).slice(0, 300));
  const u = data.usageMetadata || {};
  const cached = u.cachedContentTokenCount || 0;
  return { texto, usage: {
    in:         (u.promptTokenCount || 0) - cached,
    cacheWrite: 0,
    cacheRead:  cached,
    out:        u.candidatesTokenCount || 0
  } };
}

// Despachador: elige Claude, GPT o Gemini segun el string del modelo.
async function llamarIA(modelo, system, userContent, maxTokens = 1024) {
  if (String(modelo).startsWith('gpt'))    return await llamarGPT(modelo, system, userContent, maxTokens);
  if (String(modelo).startsWith('gemini')) return await llamarGemini(modelo, system, userContent, maxTokens);
  return await llamarClaude(modelo, system, userContent, maxTokens);
}
function parsearJson(txt) {
  const limpio = txt.replace(/```json|```/g, '').trim();
  try { return JSON.parse(limpio); } catch (e) {}
  // si vino con texto alrededor, extraigo el primer objeto {...} balanceado
  const i = limpio.indexOf('{');
  if (i >= 0) {
    let prof = 0;
    for (let j = i; j < limpio.length; j++) {
      if (limpio[j] === '{') prof++;
      else if (limpio[j] === '}') { prof--; if (prof === 0) {
        try { return JSON.parse(limpio.slice(i, j + 1)); } catch (e) {} break;
      } }
    }
  }
  return { respuesta: extraerRespuestaCortada(limpio) || txt, confianza: 'media', fuente: 'desconocida' };
}
// Si el JSON vino cortado (sin cerrar), rescata el valor de "respuesta" para no
// mostrar el JSON crudo al usuario. Devuelve null si no encuentra nada usable.
function extraerRespuestaCortada(txt) {
  const m = txt.match(/"respuesta"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\\\/g, '\\').trim();
}

// Hilo del comprador: consultas previas del MISMO comprador sobre el MISMO producto
// dentro de la ventana configurada. Se usa como contexto y para el limite anti-pelea.
async function hiloComprador(cuenta, compradorId, itemId, preguntaId, ventanaDias) {
  if (!compradorId || !itemId) return [];
  const desde = new Date(Date.now() - (ventanaDias || 7) * 24 * 3600 * 1000).toISOString();
  const { data } = await db.from('pq_preguntas')
    .select('id, texto, ia_respuesta, respuesta_real, correccion, fecha_pregunta, estado')
    .eq('cuenta_id', cuenta.id)
    .eq('comprador_id', compradorId)
    .eq('item_id', itemId)
    .neq('id', preguntaId)
    .gte('fecha_pregunta', desde)
    .order('fecha_pregunta', { ascending: true })
    .limit(10);
  return data || [];
}

// BUSCAR EN EL CATALOGO: publicaciones activas del vendedor que matcheen los
// terminos, con stock verificado EN VIVO contra ML (nunca cache viejo).
// Busca publicaciones por SKU exacto o por SKU madre en el CACHE local (pq_items).
// Esto es lo que resuelve las variantes: trae TODAS las publicaciones de la familia
// (ej: AGZ52110-NEOS, AGZ52110-BLCL...), cosa que la busqueda de texto de ML no hace.
// Devuelve [] si no encuentra, para poder caer a la busqueda por texto.
async function buscarPorSku(cuenta, texto) {
  const t = String(texto || '').trim().toUpperCase();
  // ¿parece un SKU? (letras+numeros, un guion opcional). Si es una frase, no aplica.
  const m = t.match(/^[A-Z0-9]+(?:-[A-Z0-9]+)?$/);
  if (!m) return [];
  const madre = skuMadre(t);
  try {
    const { data } = await db.from('pq_items')
      .select('item_id, sku, skus, titulo, estado')
      .eq('cuenta_id', cuenta.id)
      .or(`sku.ilike.${t}%,skus.ilike.%${t}%,sku_madre.eq.${madre}`)
      .limit(12);
    return data || [];
  } catch (e) { return []; }
}

async function buscarEnCatalogo(cuenta, terminos) {
  const q = String(terminos || '').trim().slice(0, 80);
  if (!q) return [];
  const _cuotasTmp = new Map();
  // 1) si parece SKU, buscamos por SKU en el cache (trae toda la familia, exacto)
  let ids = (await buscarPorSku(cuenta, q)).map(x => x.item_id);
  let resultados = [];
  // 2) completamos (o reemplazamos si no hubo match de SKU) con la busqueda de texto de ML
  if (ids.length < 3) {
    try {
      const d = await mlGet(`/sites/MLA/search?seller_id=${cuenta.ml_user_id}&q=${encodeURIComponent(q)}&limit=6`, cuenta);
      for (const r of (d.results || [])) {
        if (ids.indexOf(r.id) === -1) ids.push(r.id);
        if (r.installments && r.installments.quantity) _cuotasTmp.set(r.id, `${r.installments.quantity} cuotas de $${Math.round(r.installments.amount || 0)}`);
      }
    } catch (e) {}
  }
  const candidatos = [];
  for (const id of ids.slice(0, 6)) {
    try {
      const it = await mlGet(`/items/${id}?attributes=id,title,price,available_quantity,permalink,status`, cuenta);
      if (it.status !== 'active') continue;
      candidatos.push({
        id: it.id, titulo: it.title, precio: await precioRealDe(cuenta, it.id, it.price),
        cuotas: _cuotasTmp.get(it.id) || null,
        stock: it.available_quantity || 0,
        link: it.permalink || ('https://articulo.mercadolibre.com.ar/' + String(it.id).replace(/^MLA/, 'MLA-'))
      });
    } catch (e) { /* item puntual fallo, seguimos */ }
  }
  return candidatos;
}

// Averigua si un comprador YA COMPRO este producto y devuelve { compro, ordenId }.
// Sirve para posventa y para linkear la venta en el panel. Cache 10 min por
// comprador+item para no pedir a ML dos veces (util en el Duelo, que genera con 3 IA).
const _compras = new Map();
// TODAS las compras que este comprador te hizo en los ultimos 60 dias (max 5).
// Antes buscabamos solo compras de ESTA publicacion y se escapaban casos como
// "compre la negra y pregunto en la blanca". Cache 10 min.
async function compradorCompras(cuenta, compradorId) {
  if (!compradorId) return [];
  const key = 'lista:' + cuenta.id + ':' + compradorId;
  const hit = _compras.get(key);
  if (hit && (Date.now() - hit.t) < 600000) return hit.v;
  let v = [];
  try {
    const d = await mlGet(`/orders/search?seller=${cuenta.ml_user_id}&buyer=${compradorId}&sort=date_desc&limit=15`, cuenta);
    const corte = Date.now() - 60 * 24 * 3600 * 1000;
    v = (d.results || [])
      .filter(o => o.date_created && new Date(o.date_created).getTime() >= corte)
      .slice(0, 5)
      .map(o => {
        const oi = (o.order_items || [])[0] || {};
        return { id: String(o.id), fecha: o.date_created,
          sku: oi.item && (oi.item.seller_sku || oi.item.seller_custom_field) || null,
          titulo: oi.item && oi.item.title ? String(oi.item.title).slice(0, 60) : null,
          item_id: oi.item && oi.item.id || null };
      });
  } catch (e) {}
  if (_compras.size > 5000) _compras.clear();
  _compras.set(key, { v, t: Date.now() });
  return v;
}
async function compradorCompro(cuenta, compradorId, itemId) {
  const compras = await compradorCompras(cuenta, compradorId);
  const deEste = compras.find(c => c.item_id === itemId);
  return { compro: compras.length > 0, ordenId: (deEste || compras[0] || {}).id || null };
}

// Precio REAL de una publicacion: el de lista NO incluye las promociones.
// Consultamos /prices y usamos la promo vigente si existe (lo que ve el comprador).
const _precioCache = new Map();
async function precioRealCached(cuenta, itemId, fallback) {
  const hit = _precioCache.get(itemId);
  if (hit && (Date.now() - hit.t) < 600000) return hit.v;
  const v = await precioRealDe(cuenta, itemId, fallback);
  if (_precioCache.size > 4000) _precioCache.clear();
  _precioCache.set(itemId, { v, t: Date.now() });
  return v;
}
async function precioRealDe(cuenta, itemId, fallback) {
  try {
    const pr = await mlGet(`/items/${itemId}/prices`, cuenta);
    const ahora = Date.now();
    const vigente = p => {
      const c = p.conditions || {};
      const st = c.start_time ? new Date(c.start_time).getTime() : -Infinity;
      const en = c.end_time ? new Date(c.end_time).getTime() : Infinity;
      return ahora >= st && ahora <= en;
    };
    const lista = (pr && pr.prices) || [];
    const promos = lista.filter(p => p.type === 'promotion' && vigente(p)).map(p => Number(p.amount)).filter(Boolean);
    if (promos.length) return Math.min(...promos);
    const std = lista.find(p => p.type === 'standard' && vigente(p));
    if (std && Number(std.amount)) return Number(std.amount);
  } catch (e) {}
  return fallback;
}

// Verifica EN VIVO los links de publicaciones que aparecen dentro de una regla.
// Una regla es texto fijo, pero el stock cambia: sin esto, la IA seguiria pasando
// el link de algo pausado o agotado. Cache 10 min para no castigar a ML.
const _linksCache = new Map();
async function estadoDeItem(cuenta, itemId) {
  const key = cuenta.id + ':' + itemId;
  const hit = _linksCache.get(key);
  if (hit && (Date.now() - hit.t) < 600000) return hit.v;
  let v = { ok: false, motivo: 'no se pudo verificar' };
  try {
    const d = await mlGet(`/items/${itemId}?attributes=id,status,available_quantity,title,price`, cuenta);
    const stock = Number(d.available_quantity) || 0;
    if (d.status !== 'active') v = { ok: false, motivo: d.status === 'paused' ? 'PAUSADA' : 'no activa (' + d.status + ')' };
    else if (stock <= 0) v = { ok: false, motivo: 'SIN STOCK' };
    else v = { ok: true, motivo: stock + ' en stock', titulo: d.title || '', precio: await precioRealDe(cuenta, itemId, d.price || null), stock };
  } catch (e) { v = { ok: false, motivo: 'no se pudo verificar' }; }
  if (_linksCache.size > 3000) _linksCache.clear();
  _linksCache.set(key, { v, t: Date.now() });
  return v;
}
// Devuelve el texto de las reglas con una nota al lado de cada link segun su estado real.
async function reglasConLinksVerificados(cuenta, reglas) {
  const linea = (r) => `- [${r.ambito === 'global' ? 'TODOS' : 'este producto'}] ${r.disparador ? '(' + r.disparador + ') ' : ''}${r.respuesta}`;
  const salida = [];
  for (const r of (reglas || [])) {
    let txt = linea(r);
    const ids = [...new Set((String(r.respuesta || '').match(/MLA-?\d{6,}/g) || []).map(x => x.replace('-', '')))];
    for (const id of ids) {
      const e = await estadoDeItem(cuenta, id);
      txt += e.ok
        ? `\n  (verificado: el link de ${id} esta DISPONIBLE, ${e.motivo} — podes pasarlo)`
        : `\n  ATENCION: el link de ${id} esta ${e.motivo}. NO pases ese link ni ofrezcas ese producto. Usa el resto de la regla y, si hace falta, deci que por ahora no esta disponible.`;
    }
    salida.push(txt);
  }
  return salida.join('\n') || '(ninguna)';
}

// Bloque de FAMILIA: otras publicaciones nuestras del MISMO producto (por SKU madre),
// verificadas EN VIVO (estado + stock). Se inyecta en cada pregunta para que la IA
// pueda decir "si, lo tenemos en blanco, aca esta el link" sin salir a buscar.
async function bloqueFamilia(cuenta, q, item) {
  const sku = item?.sku || null;
  const madre = skuMadre(sku);
  if (!madre) return '';
  let hermanas = [];
  try {
    const { data } = await db.from('pq_items')
      .select('item_id, sku, skus, titulo, estado')
      .eq('cuenta_id', cuenta.id).eq('sku_madre', madre)
      .neq('item_id', q.item_id).limit(8);
    hermanas = data || [];
  } catch (e) {}
  const lineas = [];
  // variantes DENTRO de esta misma publicacion (color + stock ya vienen en la ficha)
  const propias = (item?.variaciones || []).filter(v => v && (v.color || v.sku));
  if (propias.length > 1) {
    for (const v of propias) {
      lineas.push(`- EN ESTA MISMA PUBLICACION: ${v.color || v.sku || 'variante'}${v.sku ? ' (SKU ' + v.sku + ')' : ''} — ${Number(v.stock) > 0 ? (v.stock + ' en stock') : 'SIN STOCK'}`);
    }
  }
  // SKUs que YA estan en esta publicacion (para detectar duplicados de la misma cosa)
  const skusAca = new Set(
    [item?.sku, ...propias.map(v => v.sku)].filter(Boolean).map(s => String(s).toUpperCase())
  );
  // publicaciones hermanas (verificadas en vivo, con cache de 10 min)
  for (const h of hermanas.slice(0, 6)) {
    const e = await estadoDeItem(cuenta, h.item_id);
    const skusH = h.skus || h.sku || '';
    const listaH = String(skusH).toUpperCase().split(' ').filter(Boolean);
    const mismo = listaH.some(s => skusAca.has(s));   // misma cosa publicada aparte (ej: con/sin cuotas)
    const link = 'https://articulo.mercadolibre.com.ar/' + String(h.item_id).replace(/^MLA/, 'MLA-');
    if (mismo) {
      lineas.push(`- MISMO PRODUCTO publicado aparte (suele diferir el precio por cuotas o promos): "${(h.titulo || '').slice(0, 70)}" — ${e.ok ? `${e.motivo}${e.precio ? `, $${e.precio}` : ''}` : e.motivo}. OJO, STOCK COMPARTIDO: el stock que muestra esa publicacion es EL MISMO stock fisico que el de esta — son dos vidrieras del mismo deposito, NO unidades adicionales. JAMAS sumes los stocks de dos publicaciones del mismo SKU: el total disponible es el de UNA sola (la que mas muestre). REGLA: NO la menciones ni pases su link mientras ESTA publicacion tenga stock SUFICIENTE para la cantidad que pide. Si pide MAS unidades de las que muestra esta publicacion, NO prometas cubrirlo con la otra: deci con honestidad cuantas hay disponibles HOY (el stock de una sola publicacion) y sugerile escribirnos por mensajeria para ver plazos de reposicion por el resto. El link de la otra (${link}) va SOLO si esta publicacion esta pausada o sin stock. Si pregunta por diferencias de precio, explicale que varian por cuotas/promociones.`);
      continue;
    }
    lineas.push(e.ok
      ? `- OTRA PUBLICACION NUESTRA: "${(h.titulo || '').slice(0, 70)}" (SKUs: ${skusH}) — DISPONIBLE, ${e.motivo}${e.precio ? `, $${e.precio}` : ''} — LINK: ${link}`
      : `- OTRA PUBLICACION NUESTRA: "${(h.titulo || '').slice(0, 70)}" (SKUs: ${skusH}) — ${e.motivo} (NO pasar este link)`);
  }
  if (!lineas.length) return '';
  return `\nCOLORES Y VARIANTES DE ESTE MISMO PRODUCTO (verificado recien, USA ESTO para responder por colores/versiones):\n${lineas.join('\n')}\n- COMPRAS DE VARIOS PRODUCTOS O COLORES JUNTOS: si pregunta como comprar varias unidades o colores distintos, explicale el CARRITO de Mercado Libre: que toque "Agregar al carrito" en cada publicacion/color que quiera y al final haga UNA SOLA compra con todo el carrito. Asi la compra queda agrupada y los envios se combinan: salen mas baratos o incluso gratis segun el monto y la distancia. NUNCA le recomiendes hacer compras separadas.
- TEXTO PLANO SIEMPRE: nada de markdown, ni asteriscos (**), ni listas con guiones. Mercado Libre muestra esos simbolos tal cual y la respuesta queda desprolija.
- REGLA DE ORO: el comprador esta parado en ESTA publicacion. Si lo que pide esta disponible ACA (en esta publicacion o sus variantes) EN CANTIDAD SUFICIENTE, responde sobre ESTA y NO pases NINGUN link de otra publicacion. Si pide MAS unidades de las que quedan aca, SOLO ofrece otra publicacion si es de OTRO producto o variante (otro SKU): esas si tienen stock propio.\n- STOCK COMPARTIDO (MUY IMPORTANTE): dos publicaciones con el MISMO SKU muestran el MISMO stock fisico. NUNCA sumes sus stocks ni digas "entre las dos llegamos a X": el disponible real es el de UNA sola. Sumar vidrieras es prometer unidades que no existen.\n- Los links de otras publicaciones son SOLO para: un color/variante que no esta aca, o cuando aca no hay stock.\n- Si preguntan por un color/variante que figura DISPONIBLE en otra publicacion, ofrecelo con su LINK (es una venta).\n- Cuando ofrezcas otra publicacion nuestra, menciona tambien su PRECIO (y las cuotas, si figuran en los datos): al comprador le sirve para decidir.\n- Si NO figura en esta lista ni en la ficha, recien ahi podes decir que por ahora no lo tenemos.\n`;
}

// PARCHE PUBLICACION PAUSADA: ML no deja responder preguntas de publicaciones
// pausadas. Truco de vendedor, automatizado: si esta pausada -> le aseguramos
// 1 de stock -> la activamos un instante -> respondemos -> la volvemos a pausar
// -> y dejamos el stock como estaba. Si algo falla al volver, avisamos fuerte.
// Vendedores MULTI-DEPOSITO (como PONTEC): el stock no vive en la publicacion
// sino en /user-products repartido por deposito. Spec oficial de ML:
// - GET /user-products/{up}/stock devuelve las ubicaciones Y el header x-version
// - PUT /user-products/{up}/stock/type/seller_warehouse (header x-version, body
//   {locations:[{store_id, quantity}]}) modifica SOLO depositos del vendedor.
async function _upStockGet(cuenta, upId) {
  const token = await getAccessToken(cuenta);
  const r = await fetch(`https://api.mercadolibre.com/user-products/${upId}/stock`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('ML GET /user-products/' + upId + '/stock -> ' + r.status + ' ' + JSON.stringify(data).slice(0, 200));
  return { data, version: r.headers.get('x-version') };
}
async function _upStockSet(cuenta, upId, store, quantity) {
  // La forma de escribir stock varia segun la configuracion de la cuenta.
  // Probamos las variantes documentadas EN ORDEN y usamos la que ML acepte:
  //  1) selling_address {quantity}            <- deposito propio = direccion de venta (stock distribuido)
  //  2) seller_warehouse {quantity}           <- un solo deposito propio
  //  3) seller_warehouse {locations:[store]}  <- multi-origen (varios locales)
  //  4) idem + network_node_id
  const intentos = [
    { path: '/stock/type/selling_address', body: { quantity: Number(quantity) } },
    { path: '/stock/type/seller_warehouse', body: { quantity: Number(quantity) } },
    { path: '/stock/type/seller_warehouse', body: { locations: [{ store_id: String(store && store.id || ''), quantity: Number(quantity) }] } },
    { path: '/stock/type/seller_warehouse', body: { locations: [{ store_id: String(store && store.id || ''), network_node_id: store && store.network_node_id || undefined, quantity: Number(quantity) }] } }
  ];
  const errores = [];
  for (const intento of intentos) {
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const { version } = await _upStockGet(cuenta, upId);
      const token = await getAccessToken(cuenta);
      const r = await fetch(`https://api.mercadolibre.com/user-products/${upId}${intento.path}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-version': String(version || '') },
        body: JSON.stringify(intento.body)
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      if (r.status === 409 && vuelta === 0) continue;   // version vieja: refrescar y reintentar
      errores.push(intento.path.split('/').pop() + ': ' + r.status + ' ' + JSON.stringify(data).slice(0, 120));
      break;
    }
  }
  throw new Error('ML stock: ninguna variante acepto la escritura -> ' + errores.join(' | '));
}

async function _bumpStockMultiDeposito(cuenta, itemId) {
  const info = await mlGet(`/items/${itemId}?attributes=id,user_product_id,variations`, cuenta);
  const upId = (info.variations && info.variations[0] && info.variations[0].user_product_id) || info.user_product_id;
  if (!upId) throw new Error('multideposito: no encontre el user_product_id de la publicacion');
  // 1) TUS depositos reales (Mis depositos en ML): de aca salen los ids validos para escribir
  const tiendas = await mlGet(`/users/${cuenta.ml_user_id}/stores/search?tags=stock_location`, cuenta);
  const stores = (tiendas.results || []).filter(s => s.status === 'active');
  if (!stores.length) throw new Error('multideposito: no encontre depositos propios activos en la cuenta');
  // 2) stock actual de esta publicacion por ubicacion (solo depositos propios, nunca Full)
  const { data: st } = await _upStockGet(cuenta, upId);
  const locs = ((st && st.locations) || []).filter(l => l.type === 'seller_warehouse');
  if (locs.some(l => Number(l.quantity) > 0)) return null;   // ya hay stock propio en algun deposito
  // 3) elegir el deposito: el que matchee una ubicacion existente de esta publicacion;
  //    si la publicacion no tiene ubicaciones inicializadas, el primer deposito activo
  let store = null;
  for (const l of locs) {
    const m = stores.find(s =>
      String(s.id) === String(l.store_id) ||
      String(s.network_node_id) === String(l.network_node_id) ||
      String(s.network_node_id) === String(l.store_id));
    if (m) { store = m; break; }
  }
  if (!store) store = stores[0];
  await _upStockSet(cuenta, upId, store, 1);
  return { tipo: 'up', upId, store: { id: String(store.id), network_node_id: store.network_node_id || null }, antes: 0 };
}

async function responderEnML(cuenta, questionId, texto, itemId) {
  let textoFinal = String(texto || '').trim();
  const enviar = () => mlPost('/answers', { question_id: Number(questionId), text: textoFinal }, cuenta);
  if (!itemId) { await enviar(); return { reactivada: false, texto: textoFinal }; }
  let it = null;
  try { it = await mlGet(`/items/${itemId}?attributes=id,status,available_quantity,variations`, cuenta); } catch (e) {}
  if (!it || it.status !== 'paused') { await enviar(); return { reactivada: false, texto: textoFinal }; }

  // La publicacion esta pausada = sin stock: la respuesta ARRANCA avisandolo,
  // salvo que el texto ya lo mencione (para no repetirlo).
  if (!/(sin stock|nos quedamos|agotad|reposici|no tenemos stock|pausad)/i.test(textoFinal)) {
    const cuerpo = textoFinal.replace(/^\s*[¡!]*hola[\s,!.:-]*/i, '');
    textoFinal = '¡Hola! Lamentablemente en este momento nos quedamos sin stock de este producto. ' + cuerpo;
  }

  // 1) armar la activacion: si no hay stock, el stock y el estado van JUNTOS
  //    en el mismo pedido (ML rechaza "activar sin stock" si van separados)
  let stockTocado = null;   // que restaurar despues
  const bodyAct = { status: 'active' };
  if (it.variations && it.variations.length) {
    const conStock = it.variations.some(v => Number(v.available_quantity) > 0);
    if (!conStock) {
      const v0 = it.variations[0];
      bodyAct.variations = [{ id: v0.id, available_quantity: 1 }];
      stockTocado = { tipo: 'var', id: v0.id, antes: Number(v0.available_quantity) || 0 };
    }
  } else if (!(Number(it.available_quantity) > 0)) {
    bodyAct.available_quantity = 1;
    stockTocado = { tipo: 'item', antes: Number(it.available_quantity) || 0 };
  }
  // 2) activar un instante
  try {
    await mlPut(`/items/${itemId}`, bodyAct, cuenta);
  } catch (e1) {
    if (/not_updatable|multi warehouse/i.test(e1.message)) {
      // VENDEDOR MULTI-DEPOSITO: el stock no va en el item.
      // Primero probamos activar sola (quizas hay stock en algun deposito);
      // si ML dice "sin stock", ponemos 1 unidad en un deposito propio y reintentamos.
      stockTocado = null;
      try {
        await mlPut(`/items/${itemId}`, { status: 'active' }, cuenta);
      } catch (e2) {
        if (/without stock|out_of_stock|sin stock/i.test(e2.message)) {
          stockTocado = await _bumpStockMultiDeposito(cuenta, itemId);
          await mlPut(`/items/${itemId}`, { status: 'active' }, cuenta);
        } else { throw e2; }
      }
    } else if (stockTocado) {
      // plan B clasico: primero el stock, despues el estado
      if (stockTocado.tipo === 'var') await mlPut(`/items/${itemId}`, { variations: [{ id: stockTocado.id, available_quantity: 1 }] }, cuenta);
      else await mlPut(`/items/${itemId}`, { available_quantity: 1 }, cuenta);
      await mlPut(`/items/${itemId}`, { status: 'active' }, cuenta);
    } else { throw e1; }
  }
  // ML tarda en propagar la activacion. En vez de adivinar el tiempo,
  // VERIFICAMOS: consultamos la publicacion hasta que ML la muestre ACTIVA
  // (hasta 30s), y recien ahi respondemos, con reintentos (hasta ~25s mas).
  const dormir = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 6; i++) {
    await dormir(5000);
    try {
      const chk = await mlGet(`/items/${itemId}?attributes=id,status`, cuenta);
      if (chk && chk.status === 'active') break;   // ML ya la ve activa: adelante
    } catch (e) {}
  }
  let errEnvio = null;
  for (let intento = 1; intento <= 5; intento++) {
    try { await enviar(); errEnvio = null; break; }
    catch (e) {
      errEnvio = e;
      // solo reintentamos si el motivo es que ML aun la ve inactiva
      if (!/not_active_item/i.test(e.message) || intento === 5) break;
      await dormir(5000);
    }
  }
  // 3) volver a pausar SIEMPRE (aunque el envio haya fallado)
  let repausada = true;
  try { await mlPut(`/items/${itemId}`, { status: 'paused' }, cuenta); } catch (e) { repausada = false; }
  // 4) restaurar el stock original si lo tocamos
  if (stockTocado) {
    try {
      if (stockTocado.tipo === 'var') await mlPut(`/items/${itemId}`, { variations: [{ id: stockTocado.id, available_quantity: stockTocado.antes }] }, cuenta);
      else if (stockTocado.tipo === 'up') await _upStockSet(cuenta, stockTocado.upId, stockTocado.store, stockTocado.antes);
      else await mlPut(`/items/${itemId}`, { available_quantity: stockTocado.antes }, cuenta);
    } catch (e) {}
  }
  if (errEnvio) {
    if (!repausada) errEnvio.message += ' | ATENCION: la publicacion ' + itemId + ' quedo ACTIVA (no pude volver a pausarla). Pausala a mano.';
    throw errEnvio;
  }
  if (!repausada) throw new Error('La respuesta SE ENVIO, pero no pude volver a pausar la publicacion ' + itemId + ': quedo ACTIVA. Pausala a mano.');
  return { reactivada: true, texto: textoFinal };
}

async function generarRespuesta(cuenta, q, item, hilo, modeloOverride, esPrueba) {
  const cfg = configDe(cuenta);
  // que IA usar: override (Duelo) o la elegida para la cuenta (worker normal)
  const modelo = modeloOverride || modeloDe(cfg.ia_responde);
  const _u = { in: 0, cacheWrite: 0, cacheRead: 0, out: 0 }; // acumula tokens de todas las pasadas
  const _acc = (r) => { _u.in += r.usage.in; _u.cacheWrite += r.usage.cacheWrite; _u.cacheRead += r.usage.cacheRead; _u.out += r.usage.out; return r.texto; };
  const sku = item?.sku || null;
  const madre = skuMadre(sku);

  // reglas: traigo las de la cuenta y filtro en JS por el modo de cada una
  // (soporta: exacto, madre, publicacion/item, prefijo "empieza con", lista con comas, global)
  const { data: reglasTodas } = await db.from('pq_reglas')
    .select('*').eq('cuenta_id', cuenta.id).eq('activa', true)
    .order('prioridad', { ascending: false });
  const reglas = (reglasTodas || []).filter(r => reglaAplica(r, { sku, madre, item_id: q.item_id }));

  // HISTORIAL INTELIGENTE: traigo hasta 80 candidatos de la familia y me quedo
  // con los 12 mas parecidos a la pregunta actual (por palabras en comun)
  let historial = [];
  if (madre || q.item_id) {
    const condsHist = [];
    if (madre) condsHist.push('sku_madre.eq.' + madre);
    if (q.item_id) condsHist.push('item_id.eq.' + q.item_id);
    const { data: h } = await db.from('pq_preguntas')
      .select('texto, ia_respuesta, respuesta_real, correccion, calificacion')
      .eq('cuenta_id', cuenta.id)
      .or(condsHist.join(','))
      .or('respuesta_real.not.is.null,calificacion.eq.bien,correccion.not.is.null')
      .order('fecha_pregunta', { ascending: false })
      .limit(80);
    const cand = h || [];
    const tp = new Set(tokens(q.texto));
    historial = cand
      .map(x => ({ x, s: similitud(tp, x.texto) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(e => e.x);
  }

  const estilo = cuenta.estilo_venta || '';
  const preciosDifieren = new Set((item?.variaciones || []).map(v => v.precio).filter(p => p != null)).size > 1;
  const stockTxt = (item?.variaciones || [])
    .map(v => `- ${v.color || 'unica variante'}: ${v.stock > 0 ? v.stock + ' en stock' : 'SIN STOCK'}${v.sku ? ' (SKU ' + v.sku + ')' : ''}${preciosDifieren && v.precio != null ? ' — $' + v.precio : ''}`).join('\n');
  const reglasTxt = await reglasConLinksVerificados(cuenta, reglas);
  const histTxt = historial.map(h => `P: ${h.texto}\nR: ${h.correccion || h.respuesta_real || h.ia_respuesta}`).join('\n---\n') || '(sin historial todavia)';
  const hiloTxt = (hilo || []).map(h => `Comprador: ${h.texto}\nVendedor: ${h.correccion || h.respuesta_real || h.ia_respuesta || '(sin respuesta aun)'}`).join('\n---\n');
  const atributosTxt = item?.atributos
    ? Object.entries(item.atributos).slice(0, 40).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : '';

  // PROMPT EN BLOQUES CON CACHE:
  //  bloque 1 (por cuenta, estable): instrucciones + estilo + saludos
  //  bloque 2 (por producto, estable mientras no cambie): ficha + stock + reglas + historial
  //  user (varia siempre): hilo del comprador + pregunta
  const bloqueInstrucciones = {
    type: 'text',
    text:
`Sos el asistente de respuestas de un vendedor de Mercado Libre en Argentina.
Redacta la respuesta a una pregunta de un comprador, como la escribiria el vendedor.
REGLAS:
- Usa SOLO la informacion que te paso (producto, ficha tecnica, stock, reglas, historial, conversacion previa). No inventes datos ni precios.
- Respeta SIEMPRE las reglas fijas.
- Si preguntan por un color/variante, mira el stock real: si hay, ofrecelo; si no, decilo y ofrece alternativa.
- Las VARIANTES listadas abajo son TODAS las opciones existentes de esta publicacion (colores, modelos, acabados). ANTES de negar que exista una opcion, verifica esa lista: si el comprador pregunta por una opcion que figura ahi, existe.
- Si hay CONVERSACION PREVIA con este comprador, LEE TODO EL HILO y entende de que venia hablando ANTES de responder. No te enganches con una sola palabra: identifica de que PARTE o TEMA del producto habla (ej: capota, manija, rueda, freno, tela) y responde a ESO. Si no te queda claro a que parte se refiere, NO adivines: marca confianza "baja" y pedile amablemente que aclare a que parte del producto se refiere.
- Si el comprador parece molesto o insatisfecho con respuestas anteriores, marca confianza "baja" para que lo atienda una persona.
- POSVENTA: si el comprador reporta un PROBLEMA FISICO del producto (algo no engancha, no entra, se cae, vino fallado, roto, incompleto, le falta una pieza, no puede armar/colocar una parte), eso NO se resuelve con informacion: marca "necesita_posventa": true. NO afirmes que "es asi de fabrica" ni cierres el tema; hay que derivarlo a atencion.
- LINKS: siempre que ofrezcas un producto NUESTRO DISPONIBLE que NO esta en esta publicacion, pasa su LINK completo (copiado TAL CUAL te lo damos, nunca inventado). PERO si lo que pide esta disponible EN ESTA publicacion, no pases links de otras: que compre aca mismo. Si un link viene marcado como SIN STOCK o PAUSADA, NO lo pases.
- IMPORTANTISIMO (colores y variantes): en esta cuenta cada color o variante suele estar en una PUBLICACION SEPARADA. NUNCA afirmes que un color/medida/variante "no existe", "no lo tenemos" o "no hay version en X" mirando solo esta publicacion: primero completa "busca_producto" para revisar el catalogo. Que no este en ESTA publicacion NO significa que no lo vendamos.
- Si la info no alcanza para responder con seguridad, decilo con honestidad y marca confianza "baja". NUNCA adivines.
- MENSAJERIA INTERNA (NO derivar): quien hace una PREGUNTA todavia no compro, y la mensajeria interna de Mercado Libre SOLO existe DESPUES de la compra. Por eso NUNCA le digas que te escriba "por la mensajeria interna" ni "desde el detalle de tu compra/publicacion": no tiene ese canal. Si te falta un dato o no podes confirmar algo, decilo con honestidad y ofrece confirmarlo por ACA (respondiendo su consulta); nunca lo mandes a un canal que no puede usar.
${(cfg.msg_sin_dato || '').trim() ? `- IMPORTANTE: si te falta un dato del producto para responder, basa tu respuesta en esta plantilla del vendedor: "${cfg.msg_sin_dato.trim()}"${/mensajer|detalle de (tu|su|la) (compra|publicaci)/i.test(cfg.msg_sin_dato) ? '. PERO como es una PREGUNTA (preventa) y el comprador NO tiene mensajeria interna, OMITI la parte de la plantilla que lo manda a escribir por la mensajeria interna o al detalle de la compra, y en su lugar ofrece confirmar el dato por ACA.' : ' (podes usarla tal cual).'}` : ''}
- SALUDO DE INICIO: ${(cfg.saludo_inicial || '').trim()
    ? `empeza la respuesta EXACTAMENTE con "${cfg.saludo_inicial.trim()}" y segui directo con la respuesta. NO agregues ninguna presentacion tuya extra al principio (no digas "soy el asistente...", no te presentes de nuevo, no pongas otro saludo).`
    : `arranca directo con la respuesta, sin ningun saludo al principio.`}
- CIERRE: ${(cfg.saludo_final || '').trim()
    ? `termina la respuesta EXACTAMENTE con "${cfg.saludo_final.trim()}". No repitas el saludo del inicio ni firmes dos veces.`
    : `no agregues ningun cierre ni firma al final.`}
- Estilo de venta: ${estilo}
Responde UNICAMENTE con un JSON valido, sin texto extra:
{"respuesta":"...","confianza":"alta|media|baja","fuente":"regla|historial|descripcion|ficha|stock|conversacion|imagenes|general|catalogo|posventa","dato_faltante":"si confianza es baja por falta de un dato del producto, nombra ESE dato en pocas palabras (ej: peso que soporta, medidas, si incluye X, compatibilidad). Si no aplica, deja \\"\\".","busca_producto":"2-5 palabras para buscar en el catalogo del vendedor. Usalo en DOS casos: (1) pide OTRO producto distinto (otro modelo, un repuesto, un combo); (2) pide OTRO COLOR, MEDIDA o VARIANTE de ESTE MISMO producto que no figura en esta publicacion (ej: pregunta si lo hay en blanco pero aca solo esta el negro). En el caso (2) busca por el nombre corto del producto + el color pedido (ej: rack tv blanco). Si no aplica, deja \\"\\".","necesita_posventa":"true SOLO si el comprador reporta un problema fisico del producto (no engancha/no entra/se cae/vino fallado/roto/incompleto/falta pieza/no puede armar una parte). Si no aplica, false.","pide_cantidad":"si el comprador pide o pregunta por una CANTIDAD concreta de unidades de ESTE producto (ej: 'necesito 4', 'tenes 10?', 'quiero llevar 6'), pone aca SOLO el numero. Si no menciona cantidad, deja \\"\\"."}`,
    cache_control: { type: 'ephemeral' }
  };

  const bloqueProducto = {
    type: 'text',
    text:
`PRODUCTO: ${item?.titulo || '(desconocido)'} (SKU ${sku || 's/d'})
FICHA TECNICA:
${atributosTxt || '(sin ficha)'}
DESCRIPCION:
${(item?.descripcion || '').slice(0, 1500)}

VARIANTES DE ESTA PUBLICACION (todas las opciones que existen) Y SU STOCK:
${stockTxt || '(sin datos)'}
NOTA DE REPOSICION: ${item?.nota_reposicion || '(ninguna)'}

REGLAS FIJAS:
${reglasTxt}

ASI RESPONDIMOS ANTES EN ESTE PRODUCTO (lo mas parecido a la pregunta actual):
${histTxt}`,
    cache_control: { type: 'ephemeral' }
  };

  const famTxt = await bloqueFamilia(cuenta, q, item);
  // ¿la publicacion tiene OFERTA vigente? -> motivador de venta
  let ofertaTxt = '';
  try {
    const base = await mlGet(`/items/${q.item_id}?attributes=price`, cuenta);
    const real = await precioRealDe(cuenta, q.item_id, base.price);
    if (base && base.price && real && Number(real) < Number(base.price)) {
      ofertaTxt = `OFERTA VIGENTE EN ESTA PUBLICACION: hoy $${real} (precio de lista $${base.price}). Mencionala como motivacion para cerrar la venta cuando sume (ej: "aprovecha que justo ahora esta con descuento"), SIN inventar porcentajes ni plazos ni decir hasta cuando dura.\n\n`;
    }
  } catch (e) {}
  const userTexto =
`${hiloTxt ? `CONVERSACION PREVIA CON ESTE COMPRADOR (mismo producto, ultimos dias):\n${hiloTxt}\n\n` : ''}${famTxt}${ofertaTxt}PREGUNTA DEL COMPRADOR:
${q.texto}`;

  const systemBlocks = [bloqueInstrucciones, bloqueProducto];

  // PRIMERA PASADA: solo texto
  let ia = parsearJson(_acc(await llamarIA(modelo, systemBlocks, userTexto)));
  let usoImagenes = 0;

  // CASCADA DE CATALOGO: el comprador pide OTRO producto -> lo buscamos en el
  // catalogo con stock en vivo y regeneramos la respuesta con esa info.
  if (ia.busca_producto && String(ia.busca_producto).trim()) {
    try {
      const candidatos = await buscarEnCatalogo(cuenta, ia.busca_producto);
      const conStock = candidatos.filter(c => c.stock > 0);
      const sinStock = candidatos.filter(c => c.stock <= 0);
      const catTxt = [
        conStock.length ? 'DISPONIBLES AHORA (podes ofrecerlos CON su link):\n' + conStock.map(c => `- ${c.titulo} — $${c.precio}${c.cuotas ? ` (${c.cuotas})` : ''} — ${c.stock} en stock — LINK: ${c.link}`).join('\n') : '',
        sinStock.length ? 'SIN STOCK (NO pasar link; si es lo que pide, decir que por ahora no esta disponible y que van a reponer):\n' + sinStock.map(c => `- ${c.titulo}`).join('\n') : '',
        !candidatos.length ? '(no se encontro ese producto en el catalogo: decir con honestidad que no lo tenemos publicado por ahora)' : ''
      ].filter(Boolean).join('\n\n');
      const contenidoCat = userTexto + `\n\nEL COMPRADOR PIDE OTRO PRODUCTO O UNA VARIANTE (otro color/medida) QUE NO ESTA EN ESTA PUBLICACION. BUSQUE EN EL CATALOGO DEL VENDEDOR (stock verificado recien):\n${catTxt}\n\nREGLAS PARA ESTA RESPUESTA:\n- SOLO ofrece y pasa el LINK de productos de la lista DISPONIBLES AHORA (copia el link tal cual).\n- NUNCA pases link de algo sin stock ni inventes links.\n- Si el producto exacto que pide esta sin stock o no aparece, decilo con honestidad (\"por ahora no lo tenemos disponible\") e invita a seguir la publicacion o consultar mas adelante. Si hay una alternativa MUY similar con stock, podes ofrecerla.\n- Si el comprador preguntaba por un COLOR o VARIANTE y aparece en DISPONIBLES AHORA, ofrecelo y pasale el link: es una venta. Solo deci que no lo tenemos si de verdad no aparece.\n- Si no estas seguro de que el producto encontrado sea EXACTAMENTE lo que pide, confianza \"media\".`;
      const ia3 = parsearJson(_acc(await llamarIA(modelo, systemBlocks, contenidoCat)));
      if (ia3 && ia3.respuesta) { ia = ia3; ia.fuente = 'catalogo'; }
    } catch (e) { /* si falla la busqueda, queda la primera respuesta */ }
  }

  // CASCADA DE STOCK HERMANO: el comprador pide MAS unidades de las que tiene
  // ESTA publicacion (tipico: publicacion Full con pocas unidades, pero hay
  // otra publicacion nuestra del mismo producto con stock de deposito).
  // Buscamos publicaciones hermanas EN VIVO y ofrecemos el link de la que alcanza.
  const _cant = parseInt(ia.pide_cantidad, 10) || 0;
  if (_cant > 0 && item) {
    const stockAca = (item.variantes || []).reduce((s, v) => s + (Number(v.stock) || 0), 0);
    if (stockAca >= 0 && _cant > stockAca) {
      try {
        const terminos = (item.titulo || '').split(' ').slice(0, 5).join(' ') || (item.sku || '');
        const candidatos = (await buscarEnCatalogo(cuenta, terminos))
          .filter(c => c.id !== q.item_id && c.stock > 0)
          .sort((a, b) => b.stock - a.stock);
        const alcanza = candidatos.filter(c => c.stock >= _cant);
        const parcial = candidatos.filter(c => c.stock < _cant);
        if (candidatos.length) {
          const lista = (arr) => arr.map(c => `- ${c.titulo} — $${c.precio} — ${c.stock} en stock — LINK: ${c.link}`).join('\n');
          const guiaStock = userTexto + `\n\nSITUACION DE STOCK: el comprador pide ${_cant} unidades y ESTA publicacion tiene solo ${stockAca}. PERO tenemos OTRAS publicaciones nuestras del mismo producto (stock verificado recien):\n` +
            (alcanza.length ? `\nCON STOCK SUFICIENTE (ofrece ESTA opcion con su link, copialo tal cual):\n${lista(alcanza)}\n` : '') +
            (!alcanza.length && parcial.length ? `\nCON STOCK PARCIAL (entre esta publicacion y estas puede llegar a juntar las ${_cant}):\n${lista(parcial)}\n` : '') +
            `\nREGLAS PARA ESTA RESPUESTA:\n- Primero deci con claridad cuantas hay en ESTA publicacion (${stockAca}).\n- Despues ofrece la publicacion hermana CON SU LINK para completar las ${_cant} unidades (solo si tiene stock suficiente o ayuda a completar).\n- NUNCA inventes links ni stock. Solo usa los de la lista.\n- Tono vendedor y resolutivo: la idea es NO perder la venta de ${_cant} unidades. Confianza "alta" si la solucion es clara.`;
          const iaS = parsearJson(_acc(await llamarIA(modelo, systemBlocks, guiaStock)));
          if (iaS && iaS.respuesta) { ia = iaS; ia.fuente = 'stock_hermano'; }
        }
      } catch (e) { /* si falla la busqueda, queda la respuesta anterior */ }
    }
  }

  // CASCADA DE POSVENTA: el comprador reporta un problema fisico (no se resuelve
  // con info). Chequeamos si YA COMPRO este producto para derivarlo bien:
  //  - si compro  -> mensajeria interna DESDE EL DETALLE DE SU COMPRA
  //  - si no compro -> NO existe "su compra": respondemos sin mandarlo ahi
  const pideePosventa = ia.necesita_posventa === true || String(ia.necesita_posventa) === 'true';
  if (pideePosventa) {
    try {
      const { compro } = await compradorCompro(cuenta, q.comprador_id, q.item_id);
      const guia = compro
        ? `EL COMPRADOR YA COMPRO ESTE PRODUCTO. Es un tema de posventa. Redacta una respuesta con TACTO:\n- Reconoce su problema (no lo minimices ni digas "es asi de fabrica").\n- Explicale que para resolverlo, nos escriba por la MENSAJERIA INTERNA de Mercado Libre DESDE EL DETALLE DE SU COMPRA, que ahi lo ayudamos.\n- No prometas resultados; solo abri el canal de ayuda. Confianza "alta".`
        : `EL COMPRADOR NO FIGURA COMO COMPRADOR (es una pregunta publica, todavia no compro). NO lo mandes a "el detalle de tu compra" porque no tiene ninguna. Redacta con TACTO:\n- Reconoce su consulta y responde lo mejor posible con la info del producto.\n- Si el problema requiere tener el producto en la mano (armado, una pieza que no engancha, un posible defecto), aclarale que una vez realizada la compra podra escribirnos por la mensajeria interna desde el detalle de su compra y lo ayudamos. Confianza "media".`;
      const contenidoPv = userTexto + `\n\n${guia}`;
      const iaPv = parsearJson(_acc(await llamarIA(modelo, systemBlocks, contenidoPv)));
      if (iaPv && iaPv.respuesta) { ia = iaPv; ia.fuente = 'posventa'; }
    } catch (e) { /* si falla el chequeo, queda la respuesta anterior */ }
  }

  // CASCADA CON IMAGENES: si la confianza quedo baja y el producto tiene fotos,
  // segunda pasada mirando las imagenes (solo cuando hace falta, para cuidar costo)
  const fotos = (item?.imagenes || []).slice(0, 3);
  if (ia.confianza === 'baja' && fotos.length) {
    try {
      const contenidoConFotos = [
        ...fotos.map(u => ({ type: 'image', source: { type: 'url', url: u } })),
        { type: 'text', text: userTexto + '\n\n(La informacion de texto no alcanzo. MIRA LAS IMAGENES del producto: si en ellas se ve la respuesta (color, forma, que incluye, medidas visibles, detalles), usala. Si tampoco se ve, confianza "baja".)' }
      ];
      const ia2 = parsearJson(_acc(await llamarIA(modelo, systemBlocks, contenidoConFotos)));
      usoImagenes = 1;
      const rango = { alta: 3, media: 2, baja: 1 };
      if ((rango[ia2.confianza] || 0) > (rango[ia.confianza] || 0)) {
        ia = ia2; ia.fuente = 'imagenes';
      }
    } catch (e) { /* si falla la pasada con fotos, queda la primera */ }
  }

  // registrar consumo (control de costo por cuenta; si falla no rompe nada)
  // en pruebas (Duelo / Comparador) NO se registra, para no ensuciar contadores
  if (!esPrueba) {
    try { await db.rpc('pq_sumar_uso', { p_cuenta: cuenta.id, p_imagenes: usoImagenes }); } catch (e) {}
  }

  // META de costo: modelo + tokens (con desglose de cache) + costo real de ESTA respuesta
  ia._meta = {
    modelo,
    inTok: _u.in + _u.cacheWrite + _u.cacheRead,  // total de entrada (para mostrar)
    outTok: _u.out,
    cacheRead: _u.cacheRead,
    costo: costoUSD(modelo, _u)
  };
  return ia;
}

// Procesa una pregunta: arma hilo, genera respuesta y decide su destino
// (demo/revision o programada para envio automatico).
// Apodo publico del comprador (cache en memoria para no repetir llamadas)
const _nicks = new Map();
async function nickComprador(cuenta, compradorId) {
  if (!compradorId) return null;
  if (_nicks.has(compradorId)) return _nicks.get(compradorId);
  try {
    const u = await mlGet('/users/' + compradorId, cuenta);
    const nick = u.nickname || null;
    if (_nicks.size > 5000) _nicks.clear();
    _nicks.set(compradorId, nick);
    return nick;
  } catch (e) { return null; }
}

// USO DEL MES: RESPUESTAS ENVIADAS POR EL BOT este mes (la unidad facturable).
// El modo sombra (generar sugerencias para calificar) NO consume del pack.
async function usoDelMes(cuentaId) {
  // el mes del pack corta el 1ro a las 00:00 de ARGENTINA (00:00 BA = 03:00 UTC)
  const hoyBA = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  const inicio = new Date(hoyBA.slice(0, 8) + '01T03:00:00Z');
  const { count } = await db.from('pq_preguntas')
    .select('id', { count: 'exact', head: true })
    .eq('cuenta_id', cuentaId)
    .eq('respondida_por', 'RespondIA')
    .gte('enviada_at', inicio.toISOString());
  return count || 0;
}

async function procesarPregunta(cuenta, qml) {
  const cfg = configDe(cuenta);

  // ESTADO REAL EN ML: solo procesamos preguntas vivas.
  // ML marca: ANSWERED, UNANSWERED, DELETED, DISABLED, BANNED, CLOSED_UNANSWERED, UNDER_REVIEW.
  const st = (qml.status || '').toUpperCase();
  const muerta = ['DELETED', 'DISABLED', 'BANNED', 'CLOSED_UNANSWERED', 'UNDER_REVIEW'].includes(st);
  if (muerta) {
    // pregunta borrada/cerrada/baneada: la guardamos como historico para que NO
    // aparezca en "sin responder" ni gaste IA. Preserva el registro sin ensuciar la bandeja.
    await db.from('pq_preguntas').upsert({
      id: qml.id, cuenta_id: cuenta.id, item_id: qml.item_id || null,
      comprador_id: qml.from?.id || null, texto: qml.text || '',
      fecha_pregunta: qml.date_created || null,
      estado: 'historico', revisada: true,
      respuesta_real: qml.answer?.text || null
    });
    return;
  }

  const item = qml.item_id ? await traerItem(cuenta, qml.item_id) : null;
  const q = {
    id: qml.id, item_id: qml.item_id || null, sku: item?.sku || null,
    comprador_id: qml.from?.id || null, texto: qml.text || '',
    fecha_pregunta: qml.date_created || null, respuesta_real: qml.answer?.text || null
  };

  // ya respondida en ML (por answer o por status ANSWERED)
  const yaRespondida = !!q.respuesta_real || st === 'ANSWERED';
  const hilo = await hiloComprador(cuenta, q.comprador_id, q.item_id, q.id, cfg.ventana_hilo_dias);

  let ia = { respuesta: null, confianza: null, fuente: null };
  try { ia = await generarRespuesta(cuenta, q, item, hilo); }
  catch (e) { ia = { respuesta: 'ERROR IA: ' + e.message, confianza: 'baja', fuente: 'error' }; }

  // Destino de la respuesta
  let estado = yaRespondida ? 'historico' : 'demo';
  let enviar_at = null;

  if (!yaRespondida && cfg.auto_responder) {
    const respuestasPrevias = (hilo || []).length;
    const faltaDato = ia.confianza === 'baja' && !!ia.dato_faltante && String(ia.dato_faltante).trim() !== '';
    if (respuestasPrevias >= (cfg.max_respuestas_seguidas ?? 2)) {
      estado = 'demo'; // limite anti-pelea: derivar a humano
    } else if (faltaDato && cfg.auto_sin_dato && (cfg.msg_sin_dato || '').trim()
               && !/mensajer|detalle de (tu|su|la) (compra|publicaci)/i.test(cfg.msg_sin_dato)) {
      // FALTA UN DATO y el usuario configuro respuesta automatica para ese caso:
      // se envia SU plantilla (texto exacto, determineistico), no lo que redacto la IA.
      // OJO: si la plantilla manda a la MENSAJERIA INTERNA, NO la auto-enviamos (el
      // que pregunta no tiene ese canal): cae a revision humana con el borrador ya
      // corregido por la IA. Editando la plantilla en Ajustes (sacando esa parte) el
      // auto-envio vuelve a funcionar.
      ia.respuesta = cfg.msg_sin_dato.trim();
      ia.fuente = 'sin_dato';
      const envio = calcularEnvio(cfg);
      if (envio.enviar_at) { estado = 'programada'; enviar_at = envio.enviar_at.toISOString(); }
      else estado = 'demo';
    } else if ((({ alta: 3, media: 2, baja: 1 })[ia.confianza] || 0) < (({ alta: 3, media: 2 })[cfg.confianza_minima] || 3)) {
      estado = 'demo'; // por debajo de la precision minima configurada -> revision humana
    } else {
      const envio = calcularEnvio(cfg);
      if (envio.enviar_at) { estado = 'programada'; enviar_at = envio.enviar_at.toISOString(); }
      else estado = 'demo';
    }
    // LIMITE DE PLAN: el pack cuenta respuestas ENVIADAS por el bot. Si se agoto,
    // la sugerencia queda igual (para revisar/responder a mano) pero no se auto-envia.
    if (estado === 'programada' && cuenta.limite_mensual != null) {
      const usadas = await usoDelMes(cuenta.id);
      if (usadas >= cuenta.limite_mensual) {
        estado = 'demo'; enviar_at = null;
        ia.fuente = (ia.fuente || '') + '|pack_agotado';
      }
    }
  }

  const nick = await nickComprador(cuenta, q.comprador_id);
  let precioRef = null;
  try { precioRef = await precioRealDe(cuenta, q.item_id, null); } catch (e) {}
  await db.from('pq_preguntas').upsert({
    id: q.id, cuenta_id: cuenta.id, item_id: q.item_id, sku: q.sku, sku_madre: skuMadre(q.sku),
    comprador_id: q.comprador_id, comprador_nick: nick,
    ...(await (async () => {
      // TODAS las compras del comprador (60 dias): badge por cada una + link
      try {
        const compras = await compradorCompras(cuenta, q.comprador_id);
        const deEste = compras.find(c => c.item_id === q.item_id);
        return { orden_previa_id: (deEste || compras[0] || {}).id || null,
                 ordenes_previas: compras.length ? compras : null };
      } catch (e) { return { orden_previa_id: null, ordenes_previas: null }; }
    })()),
    precio_ref: precioRef,
    texto: q.texto, fecha_pregunta: q.fecha_pregunta, estado,
    ia_respuesta: ia.respuesta, ia_confianza: ia.confianza, ia_fuente: ia.fuente,
    dato_faltante: (ia.confianza === 'baja' && ia.dato_faltante) ? String(ia.dato_faltante).slice(0, 120) : null,
    respuesta_real: q.respuesta_real, enviar_at
  });
}

// =====================================================================
// WORKER DE ENVIO PROGRAMADO
// Cada 60s: busca respuestas programadas cuya hora llego y las envia.
// Solo actua si la cuenta sigue con auto ON en ese momento.
// =====================================================================
let workerOcupado = false;
async function workerEnvios() {
  if (workerOcupado) return;
  workerOcupado = true;
  try {
    const ahora = new Date().toISOString();
    const { data: pendientes } = await db.from('pq_preguntas')
      .select('id, cuenta_id, ia_respuesta, item_id')
      .eq('estado', 'programada')
      .lte('enviar_at', ahora)
      .limit(20);

    for (const p of (pendientes || [])) {
      // RECLAMO ATOMICO: solo este proceso pasa la pregunta a 'enviando'.
      // Si otra instancia (o un redeploy solapado) ya la reclamo, el update
      // no matchea ninguna fila y la salteamos -> imposible enviar duplicado.
      const { data: reclamada } = await db.from('pq_preguntas')
        .update({ estado: 'enviando' })
        .eq('id', p.id).eq('estado', 'programada')
        .select('id');
      if (!reclamada || reclamada.length === 0) continue; // otro proceso la tomo

      const cuenta = await getCuentaPorId(p.cuenta_id);
      const cfg = configDe(cuenta);
      if (!cuenta || !cfg.auto_responder) {
        // apagaron el automatico mientras esperaba -> vuelve a revision
        await db.from('pq_preguntas').update({ estado: 'demo', enviar_at: null }).eq('id', p.id);
        continue;
      }
      // LIMITE DE PLAN (chequeo final, autoritativo): si el pack se agoto,
      // la respuesta vuelve a revision con el motivo visible. No se envia.
      if (cuenta.limite_mensual != null) {
        const usadas = await usoDelMes(cuenta.id);
        if (usadas >= cuenta.limite_mensual) {
          await db.from('pq_preguntas').update({
            estado: 'demo', enviar_at: null,
            envio_error: 'PACK AGOTADO: ' + usadas + '/' + cuenta.limite_mensual + ' respuestas del bot este mes. Ampliar el plan para que siga respondiendo solo.'
          }).eq('id', p.id);
          continue;
        }
      }
      try {
        const _rw = await responderEnML(cuenta, p.id, p.ia_respuesta, p.item_id);
        await db.from('pq_preguntas').update({
          estado: 'enviada', enviada_at: new Date().toISOString(), envio_error: null,
          respondida_por: 'RespondIA',
          ...(_rw.reactivada ? { ia_respuesta: _rw.texto } : {})
        }).eq('id', p.id);
      } catch (e) {
        // ¿ML dice que YA estaba respondida (desde otro lado)? La sincronizamos sola.
        if (/not_unanswered_question|question_already_answered/i.test(e.message)) {
          try {
            const qml = await mlGet('/questions/' + p.id, cuenta);
            const real = qml && qml.answer && qml.answer.text ? String(qml.answer.text).trim() : null;
            if (real) {
              await db.from('pq_preguntas').update({
                estado: 'enviada', respuesta_real: real, envio_error: null, enviar_at: null,
                enviada_at: (qml.answer.date_created || new Date().toISOString()),
                respondida_por: 'Mercado Libre', revisada: true, revisada_at: new Date().toISOString()
              }).eq('id', p.id);
              continue;
            }
          } catch (e2) {}
        }
        // si falla (ej: falta permiso de escritura), queda para revision con el error visible
        await db.from('pq_preguntas').update({
          estado: 'demo', enviar_at: null, envio_error: e.message.slice(0, 500)
        }).eq('id', p.id);
      }
    }

    // RECUPERACION: si un proceso murio a mitad de envio, la pregunta queda en
    // 'enviando' colgada. Tras 10 min la pasamos a revision humana con aviso
    // (NUNCA reenvio automatico: pudo haberse enviado justo antes del crash).
    const hace10 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: colgadas } = await db.from('pq_preguntas')
      .select('id').eq('estado', 'enviando').lte('enviar_at', hace10).limit(20);
    for (const c of (colgadas || [])) {
      await db.from('pq_preguntas').update({
        estado: 'demo', enviar_at: null,
        envio_error: 'envio interrumpido: VERIFICA EN ML si salio antes de responder a mano'
      }).eq('id', c.id).eq('estado', 'enviando');
    }
  } catch (e) { console.error('worker error:', e.message); }
  finally { workerOcupado = false; }
}
setInterval(workerEnvios, 60 * 1000);

// =====================================================================
// OAUTH ML
// =====================================================================
app.get('/oauth', (req, res) => {
  const state = req.query.token ? '&state=' + encodeURIComponent(String(req.query.token).slice(0, 128)) : '';
  res.redirect('https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=' + ML_CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(ML_REDIRECT_URI) + state);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET,
        code: req.query.code, redirect_uri: ML_REDIRECT_URI
      })
    });
    const tok = await r.json();
    if (!tok.access_token) return res.status(400).send('Error: ' + JSON.stringify(tok));
    const expires_at = new Date(Date.now() + (tok.expires_in - 300) * 1000).toISOString();

    let nombre = 'Cuenta ' + tok.user_id;
    try { const me = await fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + tok.access_token } }).then(x => x.json()); if (me.nickname) nombre = me.nickname; } catch (e) {}

    // pack de regalo para cuentas NUEVAS (no pisa el plan de las existentes)
    const { data: existente } = await db.from('pq_cuentas').select('id').eq('ml_user_id', tok.user_id).single();
    const regalo = existente ? {} : { limite_mensual: parseInt(process.env.PACK_GRATIS || '10') };
    await db.from('pq_cuentas').upsert(Object.assign({
      ml_user_id: tok.user_id, nombre,
      ml_access_token: tok.access_token, ml_refresh_token: tok.refresh_token, ml_expires_at: expires_at
    }, regalo), { onConflict: 'ml_user_id' });

    // VINCULO AUTOMATICO: si vino con sesion (state), atamos la cuenta al usuario.
    // Es seguro: ML acaba de probar que esa persona ES duenia de esa cuenta de ML.
    let vinculado = false;
    if (req.query.state) {
      const u = await usuarioPorToken(String(req.query.state));
      if (u && !u.cuenta_id) {
        const { data: cta } = await db.from('pq_cuentas').select('*').eq('ml_user_id', tok.user_id).single();
        if (cta) {
          await db.from('pq_usuarios').update({ cuenta_id: cta.id }).eq('id', u.id);
          vinculado = true;
          // ENTRENAMIENTO INICIAL: si la cuenta esta vacia, traemos SOLO las
          // ultimas 30 preguntas (tope de costo) para que tenga que calificar.
          const { count } = await db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', cta.id);
          if (!count) entrenamientoInicial(cta).catch(() => {});
        }
      }
    }

    res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;display:grid;place-items:center;min-height:90vh;background:#f4f6fb"><div style="background:#fff;border-radius:18px;padding:36px;max-width:400px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.1)"><div style="font-size:40px">\u2705</div><h2>\u00a1Cuenta de Mercado Libre conectada!</h2><p style="color:#666">${vinculado ? 'Tu usuario qued\u00f3 vinculado. Volv\u00e9 al panel para empezar.' : 'La cuenta qued\u00f3 autorizada.'}</p><a href="https://respondia-frontend.vercel.app" style="display:inline-block;background:#2f6bff;color:#fff;padding:12px 24px;border-radius:11px;text-decoration:none;font-weight:700;margin-top:8px">Ir al panel</a></div></body>`);
  } catch (e) { res.status(500).send(e.message); }
});

// ENTRENAMIENTO INICIAL de una cuenta recien conectada: procesa SOLO las
// ultimas N preguntas (tope de tokens) para que el cliente tenga material
// que calificar apenas entra. N configurable con ENTRENAMIENTO_INICIAL.
async function entrenamientoInicial(cuenta) {
  const max = parseInt(process.env.ENTRENAMIENTO_INICIAL || '30');
  try {
    const data = await mlGet(`/questions/search?seller_id=${cuenta.ml_user_id}&api_version=4&sort_fields=date_created&sort_types=DESC&limit=${Math.min(max, 50)}&offset=0`, cuenta);
    for (const qml of (data.questions || []).slice(0, max)) {
      await procesarPregunta(cuenta, qml);
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) { console.error('entrenamiento inicial:', e.message); }
}

// =====================================================================
// WEBHOOK
// =====================================================================
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const n = req.body || {};
      if (n.topic !== 'questions') return;
      const cuenta = await getCuentaPorMlUser(n.user_id);
      if (!cuenta) return;
      const qid = String(n.resource || '').split('/').pop();
      if (!qid) return;
      const qml = await mlGet('/questions/' + qid + '?api_version=4', cuenta);
      await procesarPregunta(cuenta, qml);
    } catch (e) { console.error('webhook error:', e.message); }
  })();
});

// =====================================================================
// BACKFILL  ->  /backfill?dias=30&clave=...&cuenta_id=...   (dias=0 = todo)
// =====================================================================
app.get('/backfill', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  if (backfill.corriendo) return res.json({ ok: false, msg: 'ya hay un backfill corriendo', backfill });

  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).send('no encontre la cuenta');

  const dias = req.query.dias !== undefined ? parseInt(req.query.dias) : 30;
  const corte = dias > 0 ? new Date(Date.now() - dias * 24 * 3600 * 1000) : null;
  backfill = { corriendo: true, procesadas: 0, total: 0, desde: corte ? corte.toISOString() : 'todo', error: null, cuenta: cuenta.nombre };
  res.json({ ok: true, msg: 'backfill arrancado', cuenta: cuenta.nombre, dias });

  (async () => {
    try {
      const force = req.query.force === '1';
      const topeNoMaster = parseInt(process.env.ENTRENAMIENTO_INICIAL || '30');
      const esMaster = req.usuario && req.usuario.rol === 'master';
      let offset = 0; const limit = 50; let seguir = true;
      while (seguir) {
        const data = await mlGet(`/questions/search?seller_id=${cuenta.ml_user_id}&api_version=4&sort_fields=date_created&sort_types=DESC&limit=${limit}&offset=${offset}`, cuenta);
        const qs = data.questions || [];
        if (qs.length === 0) break;

        // saltear las que ya tienen respuesta de IA generada (ahorra costo), salvo force=1
        let yaHechas = new Set();
        if (!force) {
          const { data: exist } = await db.from('pq_preguntas').select('id')
            .in('id', qs.map(x => x.id)).not('ia_respuesta', 'is', null);
          yaHechas = new Set((exist || []).map(e => e.id));
        }

        for (const qml of qs) {
          if (corte && qml.date_created && new Date(qml.date_created) < corte) { seguir = false; break; }
          if (!esMaster && backfill.procesadas >= topeNoMaster) { seguir = false; break; } // tope de tokens para clientes
          if (yaHechas.has(qml.id)) continue;
          await procesarPregunta(cuenta, qml);
          backfill.procesadas++;
          await new Promise(r => setTimeout(r, 250));
        }
        offset += limit;
        if (offset > 20000) break;
      }
    } catch (e) { backfill.error = e.message; console.error('backfill error:', e.message); }
    finally { backfill.corriendo = false; }
  })();
});

// =====================================================================
// SUGERENCIAS (por cuenta)
// =====================================================================
app.post('/api/sugerencias/generar', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });

    const { data: pregs } = await db.from('pq_preguntas').select('sku, texto, item_id')
      .eq('cuenta_id', cuenta.id).not('sku', 'is', null).limit(800);
    const porSku = {};
    (pregs || []).forEach(p => { (porSku[p.sku] = porSku[p.sku] || { item_id: p.item_id, textos: [] }).textos.push(p.texto); });
    const candidatos = Object.entries(porSku).filter(([, v]) => v.textos.length >= 3)
      .sort((a, b) => b[1].textos.length - a[1].textos.length).slice(0, 10);

    await db.from('pq_sugerencias').delete().eq('cuenta_id', cuenta.id).eq('estado', 'pendiente');

    for (const [sku, v] of candidatos) {
      const system = `Sos analista de un vendedor de Mercado Libre. Te paso preguntas frecuentes de un producto.
Detecta que conviene mejorar en la publicacion para que dejen de preguntar lo mismo.
Responde SOLO un JSON array (puede ser vacio): {"tipo":"descripcion|foto|video|stock|titulo|otro","motivo":"...","tarea":"..."}.`;
      const userText = `SKU ${sku}. Preguntas:\n` + v.textos.slice(0, 40).map(t => '- ' + t).join('\n');
      let arr = [];
      try { const _sg = await llamarClaude(MODELO_IA, system, userText); arr = parsearJson(_sg.texto); } catch (e) {}
      if (!Array.isArray(arr)) arr = [];
      for (const s of arr) {
        await db.from('pq_sugerencias').insert({
          cuenta_id: cuenta.id, tipo: s.tipo || 'otro', sku, item_id: v.item_id,
          motivo: s.motivo, tarea: s.tarea, frecuencia: v.textos.length, estado: 'pendiente'
        });
      }
    }
    res.json({ ok: true, skus_analizados: candidatos.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// =====================================================================
// ENDPOINTS DEL PANEL
// (el middleware soloPanel esta definido arriba, en USUARIOS Y SESIONES)
// =====================================================================

app.get('/api/cuentas', soloPanel, async (req, res) => {
  const { data } = await db.from('pq_cuentas').select('id, nombre, ml_user_id, plan, activa').order('creado_at');
  res.json(data || []);
});

// PLAN DE LA CUENTA (solo master): fija el limite mensual de preguntas con IA
app.post('/api/cuenta/limite', soloPanel, requiereRol('master'), async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const lim = req.body.limite_mensual;
  const valor = (lim === null || lim === '' || lim === undefined) ? null : Math.max(0, parseInt(lim) || 0);
  const { error } = await db.from('pq_cuentas').update({ limite_mensual: valor }).eq('id', cuenta.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, limite_mensual: valor });
});

app.get('/api/estado', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const c = cuenta.id;
  // Las estadisticas respetan el MISMO rango de fechas que la lista (dias de Argentina).
  // "En cola" y la campana quedan sin filtrar: son estado operativo actual.
  const rango = (q) => {
    if (req.query.desde) q = q.gte('fecha_pregunta', req.query.desde + 'T00:00:00-03:00');
    if (req.query.hasta) q = q.lte('fecha_pregunta', req.query.hasta + 'T23:59:59-03:00');
    return q;
  };
  const total  = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c));
  const sinRev = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('revisada', false));
  const malas  = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('calificacion', 'mal'));
  const buenas = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('calificacion', 'bien'));
  const prog   = await db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('estado', 'programada');
  const env    = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('estado', 'enviada'));
  const vend   = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('convirtio', true));
  const verif  = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).not('convirtio', 'is', null));
  // conversion DE LA IA: de las que respondio RespondIA (y ya se verificaron), cuantas terminaron en compra POSTERIOR a la pregunta
  const vendIa  = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('convirtio', true).eq('respondida_por', 'RespondIA'));
  const verifIa = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).not('convirtio', 'is', null).eq('respondida_por', 'RespondIA'));
  // cuanto trabajo saca la IA: respondidas SOLA por RespondIA vs total respondidas
  const autoIa = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).eq('respondida_por', 'RespondIA'));
  const respTot = await rango(db.from('pq_preguntas').select('id', { count: 'exact', head: true }).eq('cuenta_id', c).not('respuesta_real', 'is', null));
  const hace7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const sinResp = await db.from('pq_preguntas').select('id', { count: 'exact', head: true })
    .eq('cuenta_id', c).is('respuesta_real', null).not('estado', 'in', '(enviada,historico,enviando,programada)').gte('fecha_pregunta', hace7);
  const cfg = configDe(cuenta);
  res.json({
    cuenta: cuenta.nombre, preguntas: total.count || 0, sin_revisar: sinRev.count || 0,
    buenas: buenas.count || 0, malas: malas.count || 0,
    programadas: prog.count || 0, enviadas: env.count || 0,
    vendidas: vend.count || 0, conv_verificadas: verif, vend_ia: vendIa, conv_verificadas_ia: verifIa.count || 0,
    sin_responder: sinResp.count || 0,
    auto_ia: autoIa.count || 0, respondidas: respTot.count || 0,
    auto_responder: !!cfg.auto_responder,
    limite_mensual: cuenta.limite_mensual ?? null,
    uso_mes: await usoDelMes(c),
    backfill, conversiones, refresco, sincro, encolado, nicksJob
  });
});

app.get('/api/ranking', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const dias = req.query.dias !== undefined ? parseInt(req.query.dias) : 90;
  const { data, error } = await db.rpc('pq_ranking', { p_cuenta: cuenta.id, p_dias: dias });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/metricas', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data, error } = await db.rpc('pq_metricas', { p_cuenta: cuenta.id });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || {});
});

app.get('/api/evolucion', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data, error } = await db.rpc('pq_evolucion', { p_cuenta: cuenta.id });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || {});
});

// CHEQUEO DE SALUD: verifica cada pieza del sistema y dice como arreglar lo que falle
app.get('/api/salud', soloPanel, async (req, res) => {
  const checks = [];
  const add = (nombre, ok, detalle, solucion) => checks.push({ nombre, ok, detalle, solucion: ok ? null : solucion });

  const cuenta = await resolverCuenta(req);
  add('Cuenta configurada', !!cuenta, cuenta ? cuenta.nombre : 'no encontrada', 'Verifica ML_USER_ID en Railway o autoriza en /oauth');

  // base de datos
  try { await db.from('pq_preguntas').select('id', { head: true, count: 'exact' }).limit(1); add('Base de datos', true, 'conectada'); }
  catch (e) { add('Base de datos', false, e.message, 'Verifica SUPABASE_URL y SUPABASE_SERVICE_KEY en Railway'); }

  // funciones SQL
  for (const fn of ['pq_ranking', 'pq_metricas', 'pq_sumar_uso']) {
    try {
      const args = fn === 'pq_sumar_uso' ? { p_cuenta: cuenta?.id || 0, p_imagenes: 0 } : (fn === 'pq_ranking' ? { p_cuenta: cuenta?.id || 0, p_dias: 1 } : { p_cuenta: cuenta?.id || 0 });
      const { error } = await db.rpc(fn, args);
      add('Funcion SQL ' + fn, !error, error ? error.message : 'ok', 'Corre el SQL correspondiente en Supabase (ranking/metricas)');
    } catch (e) { add('Funcion SQL ' + fn, false, e.message, 'Corre el SQL correspondiente en Supabase'); }
  }

  if (cuenta) {
    // token ML + permisos
    try { const me = await mlGet('/users/me', cuenta); add('Token de Mercado Libre', true, 'autorizado como ' + (me.nickname || me.id)); }
    catch (e) { add('Token de Mercado Libre', false, e.message.slice(0, 120), 'Entra a /oauth logueado con la cuenta y reautoriza'); }

    try {
      const { data: unItem } = await db.from('pq_items').select('item_id').eq('cuenta_id', cuenta.id).limit(1).single();
      if (unItem) { await mlGet('/items/' + unItem.item_id, cuenta); add('Permiso: leer publicaciones', true, 'ok'); }
      else add('Permiso: leer publicaciones', true, 'sin items cacheados aun para probar');
    } catch (e) { add('Permiso: leer publicaciones', false, e.message.slice(0, 120), 'En el DevCenter: permiso de publicaciones en Lectura + reautorizar en /oauth'); }

    try { await mlGet(`/orders/search?seller=${cuenta.ml_user_id}&limit=1`, cuenta); add('Permiso: leer ventas (conversiones)', true, 'ok'); }
    catch (e) { add('Permiso: leer ventas (conversiones)', false, e.message.slice(0, 120), 'En el DevCenter: "Venta y envios" en Lectura + reautorizar en /oauth'); }
  }

  // IA
  try {
    await llamarClaude(MODELO_IA, 'Responde solo la palabra ok', 'ok', 5);
    add('IA (Anthropic)', true, 'clave valida y con credito');
  } catch (e) {
    const msg = e.message.toLowerCase();
    add('IA (Anthropic)', false, e.message.slice(0, 140),
      msg.includes('credit') || msg.includes('billing') ? 'Carga credito en console.anthropic.com -> Billing'
      : 'Verifica ANTHROPIC_API_KEY en Railway (console.anthropic.com -> API Keys)');
  }

  const cfg = cuenta ? configDe(cuenta) : null;
  if (cfg) add('Modo actual', true, cfg.auto_responder ? 'AUTOMATICO encendido' : 'SOMBRA (solo sugiere)');

  res.json({ ok: checks.every(c => c.ok), checks });
});

app.post('/api/regla', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const { ambito, sku, item_id, disparador, respuesta, tipo, origen } = req.body;
  // ANTI-DUPLICADOS: si ya existe una regla identica (mismo alcance y texto),
  // no creamos otra. Protege contra doble-click y re-guardados.
  const skuVal = (ambito && ambito !== 'global' && ambito !== 'item') ? (sku || null) : null;
  const itemVal = ambito === 'item' ? (item_id || null) : null;
  let qd = db.from('pq_reglas').select('id')
    .eq('cuenta_id', cuenta.id).eq('ambito', ambito || 'global')
    .eq('respuesta', respuesta).eq('activa', true);
  qd = skuVal === null ? qd.is('sku', null) : qd.eq('sku', skuVal);
  qd = itemVal === null ? qd.is('item_id', null) : qd.eq('item_id', itemVal);
  const { data: dup } = await qd.limit(1);
  if (dup && dup.length) return res.json({ ok: true, duplicada: true });
  const { error } = await db.from('pq_reglas').insert({
    cuenta_id: cuenta.id, ambito: ambito || 'global',
    sku: (ambito && ambito !== 'global' && ambito !== 'item') ? sku : null,
    item_id: ambito === 'item' ? item_id : null,
    disparador: disparador || null, respuesta, tipo: tipo || 'texto', origen: origen || 'manual'
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// SKUs de una publicacion (para el modo "todos los SKUs de esta publicacion")
app.get('/api/skus-publicacion', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const { data } = await db.from('pq_items').select('variaciones, sku').eq('cuenta_id', cuenta.id).eq('item_id', req.query.item_id).single();
  if (!data) return res.json({ skus: [] });
  const skus = [...new Set([data.sku, ...((data.variaciones || []).map(v => v.sku))].filter(Boolean))];
  res.json({ skus });
});

// ---- TAREAS (datos faltantes) ----
app.get('/api/tareas', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const orden = { alta: 0, media: 1, baja: 2 };
  const { data } = await db.from('pq_tareas').select('*').eq('cuenta_id', cuenta.id).eq('estado', 'pendiente');
  const lista = (data || []).sort((a, b) => (orden[a.prioridad] - orden[b.prioridad]) || (b.frecuencia - a.frecuencia));
  res.json(lista);
});

app.post('/api/tareas/generar', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const { data, error } = await db.rpc('pq_generar_tareas', { p_cuenta: cuenta.id });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, tareas: data });
});

app.post('/api/tarea', soloPanel, async (req, res) => {
  // crear/actualizar tarea manual, o cambiar prioridad/estado de una existente
  const cuenta = await resolverCuenta(req);
  const { id, sku, item_id, dato, prioridad, estado, origen } = req.body;
  if (id) {
    const upd = {}; if (prioridad) upd.prioridad = prioridad; if (estado) upd.estado = estado;
    upd.actualizado_at = new Date().toISOString();
    const { error } = await db.from('pq_tareas').update(upd).eq('id', id).eq('cuenta_id', cuenta.id);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    const { error } = await db.from('pq_tareas').insert({
      cuenta_id: cuenta.id, sku: sku || null, item_id: item_id || null,
      dato: dato || 'dato faltante', prioridad: prioridad || 'media', origen: origen || 'manual'
    });
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// HILO DEL COMPRADOR (para el panel): preguntas previas del mismo comprador
// en la misma publicacion + si ya compro alguna vez.
app.get('/api/hilo', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { comprador_id, item_id, excluir } = req.query;
  if (!comprador_id) return res.json({ hilo: [], compro_antes: false });

  let q = db.from('pq_preguntas')
    .select('id, texto, respuesta_real, ia_respuesta, correccion, fecha_pregunta, estado, convirtio, respondida_por')
    .eq('cuenta_id', cuenta.id).eq('comprador_id', comprador_id)
    .order('fecha_pregunta', { ascending: true }).limit(20);
  if (item_id) q = q.eq('item_id', item_id);
  if (excluir) q = q.neq('id', excluir);
  const { data } = await q;

  const { count } = await db.from('pq_preguntas').select('id', { count: 'exact', head: true })
    .eq('cuenta_id', cuenta.id).eq('comprador_id', comprador_id).eq('convirtio', true);

  res.json({ hilo: data || [], compro_antes: (count || 0) > 0 });
});

app.get('/api/preguntas', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  // anti fuga masiva: solo el master puede pedir paginas grandes
  const cap = (req.usuario && req.usuario.rol === 'master') ? 1000 : 60;
  const lim = Math.min(parseInt(req.query.limit) || 60, cap);
  const off = parseInt(req.query.offset) || 0;
  let q = db.from('pq_preguntas').select('*').eq('cuenta_id', cuenta.id)
    .order('fecha_pregunta', { ascending: false }).range(off, off + lim - 1);
  if (req.query.sku)   q = q.eq('sku', req.query.sku);
  if (req.query.calif) q = q.eq('calificacion', req.query.calif);
  if (req.query.estado) q = q.eq('estado', req.query.estado);
  if (req.query.sin_revisar === '1') q = q.eq('revisada', false);
  if (req.query.vendidas === '1') q = q.eq('convirtio', true);
  if (req.query.auto === '1') q = q.eq('respondida_por', 'RespondIA');
  if (req.query.sin_responder === '1') q = q.is('respuesta_real', null).not('estado', 'in', '(enviada,historico,enviando,programada)');
  if (req.query.busca) {
    const t = String(req.query.busca).replace(/[%_,()]/g, ' ').trim();
    if (t) q = q.or(`texto.ilike.%${t}%,ia_respuesta.ilike.%${t}%,sku.ilike.%${t}%,item_id.ilike.%${t}%`);
  }
  // los dias del filtro son dias de ARGENTINA (-03:00, sin horario de verano)
  if (req.query.desde) q = q.gte('fecha_pregunta', req.query.desde + 'T00:00:00-03:00');
  if (req.query.hasta) q = q.lte('fecha_pregunta', req.query.hasta + 'T23:59:59-03:00');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// MINIATURAS: primera foto de cada publicacion, desde el cache pq_items (0 llamadas a ML)
// BUSCAR PUBLICACIONES: para el autocompletado con "#" al escribir una respuesta.
// Busca por SKU o por titulo. Primero en el cache (instantaneo) y, si hace falta,
// completa con una busqueda en vivo en ML (asi encuentra publicaciones que nunca
// tuvieron preguntas). Devuelve el link listo para pegar.
const linkDe = (id) => 'https://articulo.mercadolibre.com.ar/' + String(id).replace(/^MLA/, 'MLA-');
// SINCRONIZAR CATALOGO COMPLETO: trae TODAS las publicaciones del vendedor a
// pq_items (id, sku, sku_madre, titulo, foto, estado). Asi el buscador con "#" y
// la busqueda de variantes encuentran cualquier producto, aunque nunca haya
// tenido una pregunta. Se corre a mano desde el panel o cada tanto.
async function sincronizarCatalogo(cuenta, opts) {
  opts = opts || {};
  const incremental = !!opts.desde;   // si viene 'desde', solo traemos lo modificado despues
  let scroll = '', total = 0, guardados = 0, vueltas = 0;
  do {
    // Orden por ultima actualizacion, para poder cortar apenas llegamos a lo ya conocido.
    const base = `/users/${cuenta.ml_user_id}/items/search?limit=100&orders=last_updated_desc`;
    const url = incremental
      ? base + (scroll ? '&offset=' + scroll : '')            // paginado por offset (incremental es corto)
      : `/users/${cuenta.ml_user_id}/items/search?search_type=scan&limit=100` + (scroll ? '&scroll_id=' + encodeURIComponent(scroll) : '');
    const d = await mlGet(url, cuenta);
    total = (d.paging && d.paging.total) || total;
    const ids = d.results || [];
    if (!ids.length) break;
    scroll = incremental ? String((Number(scroll) || 0) + ids.length) : (d.scroll_id || '');

    let cortar = false;
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      let items = [];
      try {
        const mg = await mlGet(`/items?ids=${lote.join(',')}&attributes=id,title,seller_sku,seller_custom_field,attributes,variations,status,thumbnail,last_updated`, cuenta);
        items = (mg || []).map(x => x.body).filter(Boolean);
      } catch (e) { continue; }
      // en incremental, si ya llegamos a un item mas viejo que 'desde', cortamos
      const filas = [];
      for (const it of items) {
        if (incremental && it.last_updated && it.last_updated < opts.desde) { cortar = true; continue; }
        // SKUs de TODAS las variantes (en ML el SKU vive en cada variante, no en la publicacion)
        const skusVar = (it.variations || []).map(v => sacarSku(v)).filter(Boolean);
        const sku = sacarSku(it) || skusVar[0] || null;
        const todos = [...new Set([sku, ...skusVar].filter(Boolean))];
        filas.push({
          cuenta_id: cuenta.id, item_id: it.id, sku, sku_madre: skuMadre(sku),
          skus: todos.join(' ') || null,
          titulo: it.title || '', estado: it.status || null,
          imagenes: it.thumbnail ? [it.thumbnail.replace(/^http:/, 'https:')] : []
        });
      }
      if (filas.length) { try { await db.from('pq_items').upsert(filas); guardados += filas.length; } catch (e) {} }
      if (cortar) break;
    }
    vueltas++;
    if (cortar) break;                                        // incremental: ya alcanzamos lo conocido
  } while (scroll && vueltas < 200);
  return { total, guardados, incremental };
}

// AUTO: una vez al dia, sincroniza el catalogo de cada cuenta SOLO con lo nuevo/modificado.
async function autoSyncCatalogos() {
  try {
    const { data: cuentas } = await db.from('pq_cuentas').select('id, ml_user_id, config').eq('activa', true);
    for (const cuenta of (cuentas || [])) {
      try {
        const cfg = cuenta.config || {};
        const ult = cfg.ult_sync_catalogo || null;
        // la primera vez trae todo; despues, solo lo modificado desde la ultima corrida
        const r = await sincronizarCatalogo(cuenta, ult ? { desde: ult } : {});
        const nuevoCfg = Object.assign({}, cfg, { ult_sync_catalogo: new Date().toISOString() });
        await db.from('pq_cuentas').update({ config: nuevoCfg }).eq('id', cuenta.id);
        console.log(`[auto-sync] cuenta ${cuenta.id}: ${r.guardados} publicaciones (${r.incremental ? 'incremental' : 'completo'})`);
      } catch (e) { console.log('[auto-sync] error cuenta', cuenta.id, e.message); }
    }
  } catch (e) { console.log('[auto-sync] error general', e.message); }
}
// corre una vez por dia; primer disparo 2 min despues de arrancar (para no pegarle a ML en el boot)
setTimeout(autoSyncCatalogos, 2 * 60 * 1000);
setInterval(autoSyncCatalogos, 24 * 60 * 60 * 1000);

app.post('/api/sync-catalogo', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const r = await sincronizarCatalogo(cuenta);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/buscar-items', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const q = String(req.query.q || '').replace(/[%_,()]/g, ' ').trim().slice(0, 60);
    if (q.length < 2) return res.json([]);

    const salida = [], vistos = new Set();
    // 1) cache local: si parece SKU, buscamos por SKU madre (trae TODA la familia,
    //    incluidas las variantes que la busqueda de texto de ML no encuentra)
    try {
      const t = q.toUpperCase();
      const esSku = /^[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(t);
      const filtro = esSku
        ? `sku.ilike.${t}%,skus.ilike.%${t}%,sku_madre.eq.${skuMadre(t)}`
        : `sku.ilike.%${q}%,skus.ilike.%${q}%,sku_madre.ilike.%${q}%,titulo.ilike.%${q}%`;
      const { data } = await db.from('pq_items')
        .select('item_id, sku, skus, titulo, imagenes, estado').eq('cuenta_id', cuenta.id)
        .or(filtro).limit(10);
      for (const it of (data || [])) {
        if (vistos.has(it.item_id)) continue;
        vistos.add(it.item_id);
        // si lo que escribiste matchea el SKU de una variante, mostramos ESE
        const lista = String(it.skus || it.sku || '').split(' ').filter(Boolean);
        const match = lista.find(s => s.toUpperCase().startsWith(q.toUpperCase())) || it.sku || lista[0] || null;
        const extra = lista.length > 1 ? (' (+' + (lista.length - 1) + ' var.)') : '';
        salida.push({
          id: it.item_id, sku: match ? (match + extra) : null, titulo: it.titulo || '',
          foto: (it.imagenes && it.imagenes[0]) || null,
          pausada: it.estado && it.estado !== 'active',
          link: linkDe(it.item_id)
        });
      }
    } catch (e) {}

    // 2) si el cache trajo poco, completamos con ML en vivo
    if (salida.length < 5) {
      try {
        const d = await mlGet(`/sites/MLA/search?seller_id=${cuenta.ml_user_id}&q=${encodeURIComponent(q)}&limit=8`, cuenta);
        for (const r of (d.results || [])) {
          if (vistos.has(r.id) || salida.length >= 8) continue;
          vistos.add(r.id);
          salida.push({
            id: r.id, sku: r.seller_custom_field || null, titulo: r.title || '',
            foto: r.thumbnail || null,
            pausada: r.status && r.status !== 'active',
            link: r.permalink || linkDe(r.id)
          });
        }
      } catch (e) {}
    }
    // precio real (con descuento) + cuotas para cada candidato — referencia del vendedor
    const finales = salida.slice(0, 8);
    let cuotasMap = new Map();
    try {
      const s = await mlGet(`/sites/MLA/search?seller_id=${cuenta.ml_user_id}&q=${encodeURIComponent(q)}&limit=20`, cuenta);
      for (const r of (s.results || [])) {
        if (r.installments && r.installments.quantity) {
          cuotasMap.set(r.id, `${r.installments.quantity}x $${Math.round(r.installments.amount || 0).toLocaleString('es-AR')}`);
        }
      }
    } catch (e) {}
    await Promise.all(finales.map(async f => {
      try { f.precio = await precioRealCached(cuenta, f.id, null); } catch (e) { f.precio = null; }
      f.cuotas = cuotasMap.get(f.id) || null;
    }));
    res.json(finales);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/thumbs', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const ids = String(req.query.items || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.json({});
  const { data } = await db.from('pq_items').select('item_id, imagenes').eq('cuenta_id', cuenta.id).in('item_id', ids);
  const out = {};
  for (const it of (data || [])) out[it.item_id] = (it.imagenes && it.imagenes[0]) || null;
  res.json(out);
});

// LATIDO: endpoint liviano para el "en vivo" del panel. Devuelve cuantas preguntas
// sin responder hay y el id mas nuevo, para detectar novedades sin bajar todo.
app.get('/api/latido', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  // MISMO criterio que la campana del panel (ultimos 7 dias), para que el numero
  // del hub y el del panel coincidan siempre.
  const hace7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { count } = await db.from('pq_preguntas')
    .select('id', { count: 'exact', head: true })
    .eq('cuenta_id', cuenta.id)
    .is('respuesta_real', null)
    .not('estado', 'in', '(enviada,historico,enviando,programada)')
    .gte('fecha_pregunta', hace7d);
  const { data: ult } = await db.from('pq_preguntas')
    .select('id, texto, sku').eq('cuenta_id', cuenta.id)
    .order('id', { ascending: false }).limit(1);
  // pendientes de POSVENTA: conversaciones en "Nuevos" (esperan respuesta nuestra)
  let pvCount = 0;
  try {
    const { count: pc } = await db.from('pq_conversaciones')
      .select('id', { count: 'exact', head: true })
      .eq('cuenta_id', cuenta.id).eq('estado', 'nuevo');
    pvCount = pc || 0;
  } catch (e) {}
  res.json({ sin_responder: count || 0, pv_sin_responder: pvCount, ultima_id: ult && ult[0] ? ult[0].id : 0, ultima_texto: ult && ult[0] ? (ult[0].texto || '').slice(0, 80) : '', ultima_sku: ult && ult[0] ? ult[0].sku : null });
});

// ELIMINAR PREGUNTA: la borra en Mercado Libre y del panel.
// Permiso: master y dueno siempre; gerente/operador solo si tienen el tilde
// "eliminar" en sus permisos (se activa por usuario en Ajustes > Usuarios).
app.post('/api/eliminar-pregunta', soloPanel, async (req, res) => {
  try {
    const u = req.usuario || {};
    const puede = u.rol === 'master'
      || (u.rol === 'dueno' ? !(u.permisos && u.permisos.eliminar === false) : !!(u.permisos && u.permisos.eliminar));
    if (!puede) return res.status(403).json({ error: 'Tu usuario no tiene permiso para eliminar preguntas. Pediselo al dueño en Ajustes → Usuarios.' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'falta el id' });
    const { data: preg } = await db.from('pq_preguntas').select('id, cuenta_id').eq('id', id).single();
    if (!preg) return res.status(404).json({ error: 'pregunta no encontrada' });
    const cuenta = await getCuentaPorId(preg.cuenta_id);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    await mlDelete(`/questions/${id}`, cuenta);           // primero en ML
    await db.from('pq_preguntas').delete().eq('id', id);  // despues aca
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 400) }); }
});

app.post('/api/calificar', soloPanel, async (req, res) => {
  const { id, calificacion, correccion, enviar } = req.body;
  const { error } = await db.from('pq_preguntas').update({
    calificacion: calificacion || null, correccion: correccion || null,
    revisada: true, revisada_at: new Date().toISOString()
  }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  // Si la aprobaste ("bien"), pediste enviar, y la pregunta AUN NO se respondio,
  // mandamos la respuesta de la IA al comprador en Mercado Libre.
  let enviada = false, envio_error = null;
  if (calificacion === 'bien' && enviar) {
    try {
      const { data: preg } = await db.from('pq_preguntas')
        .select('id, cuenta_id, estado, ia_respuesta, respuesta_real, item_id').eq('id', id).single();
      if (preg && preg.estado !== 'enviada' && !preg.respuesta_real
          && preg.ia_respuesta && !String(preg.ia_respuesta).startsWith('ERROR')) {
        const cuenta = await getCuentaPorId(preg.cuenta_id);
        let texto = String(preg.ia_respuesta).trim();
        const _ra = await responderEnML(cuenta, id, texto, preg.item_id);
        if (_ra && _ra.reactivada) texto = _ra.texto;
        await db.from('pq_preguntas').update({
          estado: 'enviada', enviada_at: new Date().toISOString(), envio_error: null,
          respondida_por: 'RespondIA', respuesta_real: texto, enviar_at: null
        }).eq('id', id);
        enviada = true;
      }
    } catch (e) { envio_error = e.message.slice(0, 300); }
  }
  res.json({ ok: true, enviada, envio_error });
});

// FRENAR: saca una respuesta de la cola de envio automatico -> queda para humano
app.post('/api/frenar', soloPanel, requierePermiso('responder'), async (req, res) => {
  const { error } = await db.from('pq_preguntas').update({
    estado: 'demo', enviar_at: null
  }).eq('id', req.body.id).eq('estado', 'programada');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// RESPONDER YO: envia AHORA la respuesta escrita por el humano a Mercado Libre
app.post('/api/responder', soloPanel, requierePermiso('responder'), async (req, res) => {
  try {
    const { id, texto } = req.body;
    if (!texto || !String(texto).trim()) return res.status(400).json({ error: 'falta el texto' });
    const { data: preg } = await db.from('pq_preguntas').select('id, cuenta_id, estado, item_id').eq('id', id).single();
    if (!preg) return res.status(404).json({ error: 'pregunta no encontrada' });
    if (preg.estado === 'enviada') return res.status(400).json({ error: 'esta pregunta ya fue respondida' });
    const cuenta = await getCuentaPorId(preg.cuenta_id);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });

    const _rea = await responderEnML(cuenta, id, String(texto).trim(), preg.item_id);

    await db.from('pq_preguntas').update({
      estado: 'enviada', enviada_at: new Date().toISOString(), envio_error: null,
      respondida_por: (req.usuario && req.usuario.email !== 'master') ? req.usuario.email : 'panel',
      respuesta_real: (_rea && _rea.texto) || String(texto).trim(), enviar_at: null,
      revisada: true, revisada_at: new Date().toISOString()
    }).eq('id', id);

    res.json({ ok: true, reactivada: !!(_rea && _rea.reactivada) });
  } catch (e) {
    const msg = String(e.message || '');
    // ML avisa que esa pregunta YA estaba respondida (se respondio por fuera del
    // panel). En vez de dejar el error, traemos la respuesta real de ML y
    // sincronizamos la ficha: la tarjeta deja de figurar como pendiente.
    if (msg.includes('not_unanswered_question') || msg.includes('question_already_answered')) {
      try {
        const { data: p2 } = await db.from('pq_preguntas').select('cuenta_id').eq('id', req.body.id).single();
        const cta = p2 && await getCuentaPorId(p2.cuenta_id);
        const qml = cta && await mlGet('/questions/' + req.body.id, cta);
        const real = qml && qml.answer && qml.answer.text ? String(qml.answer.text).trim() : null;
        if (real) {
          await db.from('pq_preguntas').update({
            estado: 'enviada', respuesta_real: real, envio_error: null, enviar_at: null,
            enviada_at: (qml.answer.date_created || new Date().toISOString()),
            respondida_por: 'Mercado Libre', revisada: true, revisada_at: new Date().toISOString()
          }).eq('id', req.body.id);
          return res.json({ ok: false, ya_respondida: true, respuesta: real });
        }
      } catch (e2) { /* si no la pudimos traer, cae al error normal */ }
      return res.json({ ok: false, ya_respondida: true });
    }
    // tipico: falta el permiso de escritura en ML
    res.status(500).json({ error: e.message.slice(0, 400) });
  }
});

app.get('/api/reglas', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const { data } = await db.from('pq_reglas').select('*').eq('cuenta_id', cuenta.id).order('creado_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/regla', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const { ambito, sku, disparador, respuesta, tipo, origen } = req.body;
  const { error } = await db.from('pq_reglas').insert({
    cuenta_id: cuenta.id, ambito: ambito || 'global', sku: ambito === 'sku' ? sku : null,
    disparador: disparador || null, respuesta, tipo: tipo || 'texto', origen: origen || 'manual'
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/regla/editar', soloPanel, async (req, res) => {
  const { id, respuesta, disparador, ambito, sku } = req.body;
  if (!id || !respuesta || !String(respuesta).trim()) return res.status(400).json({ error: 'falta la respuesta' });
  const { error } = await db.from('pq_reglas').update({
    respuesta: String(respuesta).trim(),
    disparador: disparador || null,
    ambito: ambito || 'global',
    sku: ambito === 'sku' ? (sku || null) : null
  }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/regla/borrar', soloPanel, async (req, res) => {
  await db.from('pq_reglas').delete().eq('id', req.body.id);
  res.json({ ok: true });
});

// ---- CONFIG COMPLETA (estilo + todos los ajustes nuevos) ----
app.get('/api/config', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  res.json({ estilo: cuenta.estilo_venta || '', config: configDe(cuenta) });
});

app.post('/api/config', soloPanel, requiereRol('master','dueno','gerente'), async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const upd = {};
  if (req.body.estilo !== undefined) upd.estilo_venta = req.body.estilo || '';
  if (req.body.config !== undefined) {
    // merge sobre lo existente para no perder claves
    upd.config = Object.assign({}, configDe(cuenta), req.body.config);
    // sanidad de franjas: filtrar filas incompletas
    if (Array.isArray(upd.config.franjas)) {
      upd.config.franjas = upd.config.franjas.filter(f => f && f.desde && f.hasta);
    }
  }
  const { error } = await db.from('pq_cuentas').update(upd).eq('id', cuenta.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, config: upd.config || configDe(cuenta) });
});

app.get('/api/sugerencias', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  const { data } = await db.from('pq_sugerencias').select('*').eq('cuenta_id', cuenta.id)
    .eq('estado', 'pendiente').order('frecuencia', { ascending: false });
  res.json(data || []);
});

app.post('/api/sugerencia/estado', soloPanel, async (req, res) => {
  await db.from('pq_sugerencias').update({ estado: req.body.estado }).eq('id', req.body.id);
  res.json({ ok: true });
});

app.post('/api/item/nota', soloPanel, async (req, res) => {
  await db.from('pq_items').update({ nota_reposicion: req.body.nota || null }).eq('item_id', req.body.item_id);
  res.json({ ok: true });
});

// =====================================================================
// DIAGNOSTICO: /diag/item?id=MLA...&clave=...
// =====================================================================
app.get('/diag/item', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'falta ?id=MLA...' });

    const item = await mlGet('/items/' + id, cuenta);
    const attrSku = (item.attributes || []).find(a => a.id === 'SELLER_SKU');

    res.json({
      item_id: item.id,
      titulo: item.title,
      seller_custom_field: item.seller_custom_field || null,
      seller_sku: item.seller_sku || null,
      atributo_SELLER_SKU: attrSku ? attrSku.value_name : null,
      variaciones: (item.variations || []).map(v => ({
        color: descVariante(v.attribute_combinations), sku: sacarSku(v),
        stock: v.available_quantity, precio: v.price ?? null
      })),
      todos_los_atributos: (item.attributes || []).map(a => ({ id: a.id, nombre: a.name, valor: a.value_name }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORTAR HISTORICO: POST /api/importar {filas:[{id,item_id,texto,respuesta,fecha,vendio}]}
// Viene del panel (CSV de GoBots parseado). Inserta sin pisar lo existente.
app.post('/api/importar', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
    if (!filas.length) return res.status(400).json({ error: 'sin filas' });
    if (filas.length > 500) return res.status(400).json({ error: 'maximo 500 filas por lote' });

    // mapear item_id -> sku con el cache que ya tenemos
    const itemIds = [...new Set(filas.map(f => f.item_id).filter(Boolean))];
    const { data: items } = await db.from('pq_items').select('item_id, sku').eq('cuenta_id', cuenta.id).in('item_id', itemIds);
    const skuDe = {}; (items || []).forEach(i => skuDe[i.item_id] = i.sku);

    const registros = filas
      .filter(f => f.id && String(f.id).match(/^\d+$/))
      .map(f => {
        const sku = skuDe[f.item_id] || null;
        return {
          id: Number(f.id),
          cuenta_id: cuenta.id,
          item_id: f.item_id || null,
          sku, sku_madre: skuMadre(sku),
          texto: (f.texto || '').slice(0, 4000),
          respuesta_real: (f.respuesta || '').slice(0, 4000) || null,
          fecha_pregunta: f.fecha ? String(f.fecha).replace(' ', 'T') + '-03:00' : null,
          estado: 'historico',
          revisada: true,
          convirtio: f.vendio === true ? true : (f.vendio === false ? false : null)
        };
      });

    const { error, count } = await db.from('pq_preguntas')
      .upsert(registros, { onConflict: 'id', ignoreDuplicates: true, count: 'exact' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, recibidas: filas.length, insertadas: count ?? registros.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// MANTENIMIENTO: /admin/refrescar-skus?clave=... -> relee todos los productos de ML
// con la prioridad de SKU correcta y corrige items + preguntas guardadas.
let refresco = { corriendo: false, items: 0, corregidos: 0, error: null };
app.get('/admin/refrescar-skus', soloPanel, async (req, res) => {
  if (refresco.corriendo) return res.json({ ok: false, msg: 'ya esta corriendo', refresco });
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  refresco = { corriendo: true, items: 0, corregidos: 0, error: null };
  res.json({ ok: true, msg: 'refresco de SKUs arrancado. Mira el avance en /api/estado o repitiendo esta URL.' });

  (async () => {
    try {
      const { data: items } = await db.from('pq_items').select('item_id, sku').eq('cuenta_id', cuenta.id);
      const conocidos = new Set((items || []).map(i => i.item_id));
      // sumar items que aparecen en preguntas (ej. historico importado) y no estan cacheados
      const { data: sinSku } = await db.from('pq_preguntas').select('item_id')
        .eq('cuenta_id', cuenta.id).is('sku', null).not('item_id', 'is', null).limit(8000);
      const faltantes = [...new Set((sinSku || []).map(p => p.item_id))].filter(i => !conocidos.has(i));
      const lista = [...(items || []), ...faltantes.map(i => ({ item_id: i, sku: null }))];

      for (const it of lista) {
        try {
          const nuevo = await traerItem(cuenta, it.item_id, true); // force: relee de ML
          refresco.items++;
          if (nuevo && nuevo.sku && nuevo.sku !== it.sku) {
            await db.from('pq_preguntas').update({ sku: nuevo.sku, sku_madre: skuMadre(nuevo.sku) })
              .eq('cuenta_id', cuenta.id).eq('item_id', it.item_id);
            refresco.corregidos++;
          }
          await new Promise(r => setTimeout(r, 150));
        } catch (e) { /* item puntual fallo, seguimos */ }
      }
    } catch (e) { refresco.error = e.message; }
    finally { refresco.corriendo = false; }
  })();
});

// MANTENIMIENTO: /admin/verificar-conversiones?clave=... -> cruza preguntas con ventas de ML.
// Marca convirtio=true cuando el mismo comprador compro ese producto DESPUES de preguntar.
let conversiones = { corriendo: false, revisadas: 0, convertidas: 0, error: null };
app.get('/admin/verificar-conversiones', soloPanel, async (req, res) => {
  if (conversiones.corriendo) return res.json({ ok: false, msg: 'ya esta corriendo', conversiones });
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  conversiones = { corriendo: true, revisadas: 0, convertidas: 0, error: null };
  res.json({ ok: true, msg: 'verificacion de conversiones arrancada. Repeti esta URL para ver el avance.' });

  (async () => {
    try {
      // pendientes: nunca verificadas, o no-convertidas recientes (el comprador pudo comprar despues)
      const hace30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data: pendientes } = await db.from('pq_preguntas')
        .select('id, comprador_id, item_id, fecha_pregunta')
        .eq('cuenta_id', cuenta.id)
        .not('comprador_id', 'is', null)
        .not('item_id', 'is', null)
        .or(`conv_check_at.is.null,and(convirtio.eq.false,fecha_pregunta.gte.${hace30})`)
        .order('fecha_pregunta', { ascending: false })
        .limit(500);

      // cache por comprador para no pedir dos veces las mismas ordenes
      const ordenesDe = {};
      for (const p of (pendientes || [])) {
        try {
          if (!(p.comprador_id in ordenesDe)) {
            const d = await mlGet(`/orders/search?seller=${cuenta.ml_user_id}&buyer=${p.comprador_id}`, cuenta);
            ordenesDe[p.comprador_id] = d.results || [];
            await new Promise(r => setTimeout(r, 200));
          }
          const ordenes = ordenesDe[p.comprador_id];
          const desde = p.fecha_pregunta ? new Date(p.fecha_pregunta) : null;
          const match = ordenes.find(o =>
            (o.order_items || []).some(oi => oi.item && oi.item.id === p.item_id) &&
            (!desde || new Date(o.date_created) >= desde)
          );
          await db.from('pq_preguntas').update({
            convirtio: !!match,
            orden_id: match ? match.id : null,
            convirtio_at: match ? match.date_created : null,
            conv_check_at: new Date().toISOString()
          }).eq('id', p.id);
          conversiones.revisadas++;
          if (match) conversiones.convertidas++;
        } catch (e) { /* pregunta puntual fallo (ej. permiso), seguimos */ conversiones.error = e.message.slice(0, 200); }
      }
    } catch (e) { conversiones.error = e.message; }
    finally { conversiones.corriendo = false; }
  })();
});

// SINCRONIZAR SIN-RESPONDER: pregunta a ML el estado real de cada una marcada
// como sin responder. Si ML dice que ya esta respondida, la sincroniza y la saca.
let sincro = { corriendo: false, revisadas: 0, sincronizadas: 0, siguen: 0, error: null };
app.get('/admin/sincronizar-preguntas', soloPanel, async (req, res) => {
  if (sincro.corriendo) return res.json({ ok: false, msg: 'ya esta corriendo', sincro });
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  sincro = { corriendo: true, revisadas: 0, sincronizadas: 0, siguen: 0, error: null };
  res.json({ ok: true, msg: 'sincronizacion arrancada. Repeti esta URL para ver el avance.' });

  (async () => {
    try {
      const { data: pend } = await db.from('pq_preguntas')
        .select('id')
        .eq('cuenta_id', cuenta.id)
        .is('respuesta_real', null).neq('estado', 'enviada').neq('estado', 'historico')
        .limit(2000);

      for (const p of (pend || [])) {
        try {
          const qml = await mlGet('/questions/' + p.id + '?api_version=4', cuenta);
          const respondida = qml.status === 'ANSWERED' || !!qml.answer;
          if (respondida) {
            await db.from('pq_preguntas').update({
              respuesta_real: qml.answer?.text || '(respondida en ML)',
              estado: 'historico',
              revisada: true
            }).eq('id', p.id);
            sincro.sincronizadas++;
          } else if (['DELETED','DISABLED','BANNED','CLOSED_UNANSWERED','UNDER_REVIEW'].includes(qml.status)) {
            // pregunta que ya no se puede responder (borrada/cerrada): la archivamos
            await db.from('pq_preguntas').update({ estado: 'historico', revisada: true }).eq('id', p.id);
            sincro.sincronizadas++;
          } else {
            sincro.siguen++;
          }
          sincro.revisadas++;
          await new Promise(r => setTimeout(r, 120));
        } catch (e) {
          // si ML da 404 (pregunta borrada) o similar, la archivamos para sacarla de la bandeja
          if (String(e.message).includes('404') || String(e.message).includes('not_found')) {
            await db.from('pq_preguntas').update({ estado: 'historico', revisada: true }).eq('id', p.id);
            sincro.sincronizadas++;
          }
          sincro.revisadas++;
        }
      }
    } catch (e) { sincro.error = e.message; }
    finally { sincro.corriendo = false; }
  })();
});

// PROCESAR PENDIENTES: reprocesa las preguntas sin responder que quedaron de
// antes. Verifica contra ML que sigan vivas, regenera respuesta con el contexto
// actual y las encola al automatico (solo confianza ALTA; media/baja a revision).
let encolado = { corriendo: false, revisadas: 0, encoladas: 0, revision: 0, archivadas: 0, error: null };
app.get('/admin/procesar-pendientes', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  if (encolado.corriendo) return res.json({ ok: false, msg: 'ya esta corriendo', encolado });
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const cfg = configDe(cuenta);
  if (!cfg.auto_responder) return res.json({ ok: false, msg: 'el automatico esta APAGADO: prendelo primero en Ajustes para que esto tenga efecto' });
  encolado = { corriendo: true, revisadas: 0, encoladas: 0, revision: 0, archivadas: 0, error: null };
  res.json({ ok: true, msg: 'procesando pendientes. Repeti esta URL o mira el panel para el avance.' });

  (async () => {
    try {
      const { data: pend } = await db.from('pq_preguntas')
        .select('id')
        .eq('cuenta_id', cuenta.id)
        .is('respuesta_real', null)
        .not('estado', 'in', '(enviada,historico,programada,enviando)')
        .order('fecha_pregunta', { ascending: false })
        .limit(200);

      for (const p of (pend || [])) {
        try {
          const qml = await mlGet('/questions/' + p.id + '?api_version=4', cuenta);
          await procesarPregunta(cuenta, qml); // aplica status ML + auto + franjas + anti-pelea
          const { data: fila } = await db.from('pq_preguntas').select('estado').eq('id', p.id).single();
          if (fila?.estado === 'programada') encolado.encoladas++;
          else if (fila?.estado === 'historico') encolado.archivadas++;
          else encolado.revision++;
          encolado.revisadas++;
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          if (String(e.message).includes('404')) {
            await db.from('pq_preguntas').update({ estado: 'historico', revisada: true }).eq('id', p.id);
            encolado.archivadas++;
          }
          encolado.revisadas++;
        }
      }
    } catch (e) { encolado.error = e.message; }
    finally { encolado.corriendo = false; }
  })();
});

// RELLENO DE APODOS: completa comprador_nick en preguntas viejas (pre v4.1).
let nicksJob = { corriendo: false, revisadas: 0, completadas: 0, error: null };
app.get('/admin/rellenar-nicks', soloPanel, requiereRol('master'), async (req, res) => {
  if (nicksJob.corriendo) return res.json({ ok: false, msg: 'ya esta corriendo', nicksJob });
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  nicksJob = { corriendo: true, revisadas: 0, completadas: 0, error: null };
  res.json({ ok: true, msg: 'relleno de apodos arrancado. Repeti esta URL para ver el avance.' });

  (async () => {
    try {
      // en tandas hasta agotar (compradores repetidos salen del cache: rapido)
      for (let vuelta = 0; vuelta < 40; vuelta++) {
        const { data: filas } = await db.from('pq_preguntas')
          .select('id, comprador_id')
          .eq('cuenta_id', cuenta.id)
          .is('comprador_nick', null)
          .not('comprador_id', 'is', null)
          .limit(500);
        if (!filas || !filas.length) break;
        for (const f of filas) {
          const nick = await nickComprador(cuenta, f.comprador_id);
          await db.from('pq_preguntas').update({ comprador_nick: nick || '(sin apodo)' }).eq('id', f.id);
          nicksJob.revisadas++;
          if (nick) nicksJob.completadas++;
          if (!_nicks.has(f.comprador_id)) await new Promise(r => setTimeout(r, 80));
        }
      }
    } catch (e) { nicksJob.error = e.message; }
    finally { nicksJob.corriendo = false; }
  })();
});

// DIAGNOSTICO de config/franjas: /diag/envio?clave=... -> que haria ahora mismo
app.get('/diag/envio', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const cfg = configDe(cuenta);
  const envio = calcularEnvio(cfg);
  res.json({
    cuenta: cuenta.nombre,
    auto_responder: !!cfg.auto_responder,
    hora_local: horaLocal(cfg.timezone),
    timezone: cfg.timezone,
    decision_ahora: envio.enviar_at ? { enviar_at: envio.enviar_at, motivo: envio.motivo } : { enviar_at: null, motivo: envio.motivo },
    franjas: cfg.franjas,
    max_respuestas_seguidas: cfg.max_respuestas_seguidas,
    ventana_hilo_dias: cfg.ventana_hilo_dias
  });
});

// =====================================================================
// =====================================================================
// DUELO DE IAs (Claude vs GPT) + COMPARADOR + selector de IA por cuenta
// =====================================================================

// Elige una pregunta real de la cuenta (o una puntual por id) y genera la
// respuesta con AMBAS IA sobre el MISMO contexto (ficha/reglas/historial).
async function armarPelea(cuenta, preguntaId, excluir) {
  const skip = new Set((excluir || []).map(String));
  let fila = null;
  if (preguntaId) {
    const { data } = await db.from('pq_preguntas').select('*')
      .eq('id', preguntaId).eq('cuenta_id', cuenta.id).single();
    fila = data || null;
  } else {
    const { data } = await db.from('pq_preguntas')
      .select('*').eq('cuenta_id', cuenta.id)
      .not('item_id', 'is', null).not('texto', 'is', null)
      .order('fecha_pregunta', { ascending: false }).limit(200);
    // dedupe por texto (preguntas iguales de distintos compradores colapsan a una)
    const vistas = new Set(); const unicas = [];
    for (const x of (data || [])) {
      const t = (x.texto || '').trim();
      if (t.length < 3) continue;
      const k = t.toLowerCase();
      if (vistas.has(k)) continue;
      vistas.add(k); unicas.push(x);
    }
    // sacar las ya mostradas en esta sesion; si no queda ninguna, empezar de nuevo
    let pool = unicas.filter(x => !skip.has(String(x.id)));
    if (!pool.length) pool = unicas;
    if (pool.length) fila = pool[Math.floor(Math.random() * pool.length)];
  }
  if (!fila) throw new Error('No hay preguntas reales con producto para pelear. Sincroniza preguntas primero.');

  const item = fila.item_id ? await traerItem(cuenta, fila.item_id) : null;
  const q = {
    id: fila.id, item_id: fila.item_id || null, sku: item?.sku || fila.sku || null,
    comprador_id: fila.comprador_id || null, texto: fila.texto || '',
    fecha_pregunta: fila.fecha_pregunta || null, respuesta_real: fila.respuesta_real || null
  };
  const cfg = configDe(cuenta);
  const hilo = await hiloComprador(cuenta, q.comprador_id, q.item_id, q.id, cfg.ventana_hilo_dias);

  // las TRES IA en PARALELO, mismo contexto, marcado como prueba (no consume pack)
  const [claudeIa, gptIa, gemIa] = await Promise.all([
    generarRespuesta(cuenta, q, item, hilo, MODELO_IA, true),
    generarRespuesta(cuenta, q, item, hilo, MODELO_GPT, true),
    generarRespuesta(cuenta, q, item, hilo, MODELO_GEMINI, true)
  ]);

  const pack = (ia, clave) => ({
    ia: clave, modelo: ia._meta.modelo, respuesta: ia.respuesta,
    confianza: ia.confianza, fuente: ia.fuente,
    costo: ia._meta.costo, inTok: ia._meta.inTok, outTok: ia._meta.outTok
  });

  return {
    pregunta: { id: q.id, texto: q.texto, item_id: q.item_id, titulo: item?.titulo || null, respuesta_real: q.respuesta_real },
    claude: pack(claudeIa, 'claude'),
    gpt: pack(gptIa, 'gpt'),
    gemini: pack(gemIa, 'gemini')
  };
}

// --- DUELO A CIEGAS (solo master): A/B/C mezclados, se revela al votar ---
app.get('/api/duelo/generar', soloPanel, requiereRol('master'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const excluir = (req.query.excluir || '').split(',').map(s => s.trim()).filter(Boolean);
    const pelea = await armarPelea(cuenta, req.query.pregunta_id, excluir);

    // mezclar los 3 al azar en A/B/C (a ciegas)
    const baraja = [pelea.claude, pelea.gpt, pelea.gemini].sort(() => Math.random() - 0.5);
    const [A, B, C] = baraja;

    const { data: row, error } = await db.from('pq_duelo').insert({
      cuenta_id: cuenta.id, pregunta_id: pelea.pregunta.id, pregunta_texto: pelea.pregunta.texto,
      item_id: pelea.pregunta.item_id,
      modelo_a: A.ia, modelo_b: B.ia, modelo_c: C.ia,
      resp_a: A.respuesta, resp_b: B.respuesta, resp_c: C.respuesta,
      costo_a: A.costo, costo_b: B.costo, costo_c: C.costo,
      in_a: A.inTok, out_a: A.outTok, in_b: B.inTok, out_b: B.outTok, in_c: C.inTok, out_c: C.outTok
    }).select('id').single();
    if (error) return res.status(500).json({ error: error.message });

    // A CIEGAS: no se manda ni modelo ni costo todavia. Se manda pregunta.id para no repetir.
    res.json({
      duelo_id: row.id,
      pregunta: { id: pelea.pregunta.id, texto: pelea.pregunta.texto, titulo: pelea.pregunta.titulo, respuesta_real: pelea.pregunta.respuesta_real },
      A: { respuesta: A.respuesta, confianza: A.confianza },
      B: { respuesta: B.respuesta, confianza: B.confianza },
      C: { respuesta: C.respuesta, confianza: C.confianza }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- VOTAR: registra el voto y RECIEN AHI revela quien fue quien ---
app.post('/api/duelo/votar', soloPanel, requiereRol('master'), async (req, res) => {
  try {
    const { duelo_id, voto } = req.body; // 'A' | 'B' | 'C' | 'empate'
    if (!duelo_id || !['A', 'B', 'C', 'empate'].includes(voto)) return res.status(400).json({ error: 'voto invalido' });
    const { data: d } = await db.from('pq_duelo').select('*').eq('id', duelo_id).single();
    if (!d) return res.status(404).json({ error: 'duelo no encontrado' });
    const mapa = { A: d.modelo_a, B: d.modelo_b, C: d.modelo_c };
    const ganador = voto === 'empate' ? 'empate' : mapa[voto];
    await db.from('pq_duelo').update({ voto, ganador, votado_at: new Date().toISOString() }).eq('id', duelo_id);
    res.json({ ok: true, ganador, revelado: {
      A: { ia: d.modelo_a, costo: d.costo_a },
      B: { ia: d.modelo_b, costo: d.costo_b },
      C: { ia: d.modelo_c, costo: d.costo_c }
    } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- TANTEADOR: marcador acumulado + costo promedio + proyeccion mensual ---
app.get('/api/duelo/tanteador', soloPanel, requiereRol('master'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const volumen = Number(req.query.volumen) || 20000;
    const { data: filas } = await db.from('pq_duelo').select('*').eq('cuenta_id', cuenta.id);
    const todas = filas || [];
    const votadas = todas.filter(d => d.ganador);
    const ganan = (g) => votadas.filter(d => d.ganador === g).length;

    const costos = { claude: [], gpt: [], gemini: [] };
    for (const d of todas) {
      if (costos[d.modelo_a]) costos[d.modelo_a].push(Number(d.costo_a) || 0);
      if (costos[d.modelo_b]) costos[d.modelo_b].push(Number(d.costo_b) || 0);
      if (costos[d.modelo_c]) costos[d.modelo_c].push(Number(d.costo_c) || 0);
    }
    const prom = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const pC = prom(costos.claude), pG = prom(costos.gpt), pM = prom(costos.gemini);

    res.json({
      total_peleas: todas.length, votadas: votadas.length,
      gana_claude: ganan('claude'), gana_gpt: ganan('gpt'), gana_gemini: ganan('gemini'), empates: ganan('empate'),
      costo_prom_claude: pC, costo_prom_gpt: pG, costo_prom_gemini: pM,
      volumen, proy_claude: pC * volumen, proy_gpt: pG * volumen, proy_gemini: pM * volumen,
      modelo_claude: MODELO_IA, modelo_gpt: MODELO_GPT, modelo_gemini: MODELO_GEMINI
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- COMPARADOR (cliente nuevo): a CARA DESCUBIERTA, con costo y recomendacion ---
app.get('/api/comparador/generar', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const excluir = (req.query.excluir || '').split(',').map(s => s.trim()).filter(Boolean);
    const pelea = await armarPelea(cuenta, req.query.pregunta_id, excluir);
    try {
      await db.from('pq_duelo').insert({
        cuenta_id: cuenta.id, pregunta_id: pelea.pregunta.id, pregunta_texto: pelea.pregunta.texto,
        item_id: pelea.pregunta.item_id,
        modelo_a: 'claude', modelo_b: 'gpt', modelo_c: 'gemini',
        resp_a: pelea.claude.respuesta, resp_b: pelea.gpt.respuesta, resp_c: pelea.gemini.respuesta,
        costo_a: pelea.claude.costo, costo_b: pelea.gpt.costo, costo_c: pelea.gemini.costo,
        in_a: pelea.claude.inTok, out_a: pelea.claude.outTok, in_b: pelea.gpt.inTok, out_b: pelea.gpt.outTok,
        in_c: pelea.gemini.inTok, out_c: pelea.gemini.outTok,
        origen: 'comparador'
      });
    } catch (e) {}
    const trio = [pelea.claude, pelea.gpt, pelea.gemini];
    const mas_barato = trio.slice().sort((a, b) => a.costo - b.costo)[0].ia;
    res.json({
      pregunta: { id: pelea.pregunta.id, texto: pelea.pregunta.texto, titulo: pelea.pregunta.titulo, respuesta_real: pelea.pregunta.respuesta_real },
      claude: pelea.claude, gpt: pelea.gpt, gemini: pelea.gemini,
      mas_barato
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ELEGIR QUE IA RESPONDE ESTA CUENTA (master elige por cuenta; el dueno la suya) ---
app.post('/api/cuenta/ia', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const ia = req.body.ia === 'gpt' ? 'gpt' : 'claude';
    const nuevaConfig = Object.assign({}, configDe(cuenta), { ia_responde: ia });
    const { error } = await db.from('pq_cuentas').update({ config: nuevaConfig }).eq('id', cuenta.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, ia_responde: ia });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================================
// MODULO POSVENTA: mensajeria de ML + embudo + IA + adjuntos (manuales)
// =====================================================================
const PV_ESTADOS = ['nuevo', 'encurso', 'esperando', 'resuelto'];
const PV_MOTIVOS = ['manual', 'pieza', 'armado', 'envio', 'factura', 'devolucion', 'otro'];

// Candidatos de SKU madre para matchear archivos de la biblioteca:
// el SKU completo, el madre (hasta el 1er guion) y los dos primeros tramos
// (para familias con guion en el nombre, ej: AL-120-NE -> AL-120).
function pvCandidatosSku(sku) {
  const s = String(sku || '').trim().toUpperCase();
  if (!s) return [];
  const partes = s.split('-');
  const c = new Set([s, partes[0]]);
  if (partes.length >= 2) c.add(partes[0] + '-' + partes[1]);
  return [...c].filter(Boolean);
}

// ¿Este archivo de la biblioteca aplica a este SKU? (mismo criterio que las reglas)
function pvArchivoAplica(a, sku) {
  const s = String(sku || '').trim().toUpperCase();
  const pat = String(a.patron || a.sku_madre || '').trim().toUpperCase();
  const amb = a.ambito || (a.sku_madre ? 'madre' : 'global');
  if (amb === 'global') return true;
  if (!s || !pat) return false;
  const cands = pvCandidatosSku(s);
  if (amb === 'sku')     return s === pat;
  if (amb === 'madre')   return cands.includes(pat);
  if (amb === 'prefijo') return s.startsWith(pat);
  if (amb === 'lista')   return pat.split(',').map(x => x.trim()).filter(Boolean)
                                 .some(x => x === s || cands.includes(x));
  return false;
}

// Sube un archivo a la mensajeria de ML y devuelve el id del adjunto
async function mlSubirAdjunto(cuenta, buf, nombre, mime) {
  const token = await getAccessToken(cuenta);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'application/pdf' }), nombre);
  const r = await fetch('https://api.mercadolibre.com/messages/attachments?tag=post_sale&site_id=MLA', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error('ML adjunto -> ' + r.status + ' ' + JSON.stringify(d).slice(0, 200));
  return d.id;
}

// Baja un archivo de la biblioteca (Supabase Storage, bucket "manuales")
async function bajarArchivo(ruta) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/manuales/${ruta}`, {
    headers: { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('No pude bajar el archivo de la biblioteca (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}

// estado de envio de ML -> criollo
function pvEnvioTxt(s) {
  return ({ pending: 'pendiente de preparar', handling: 'en preparacion', ready_to_ship: 'listo para despachar',
    shipped: 'en camino', delivered: 'ya entregado', not_delivered: 'con problema de entrega (no entregado)',
    cancelled: 'cancelado' })[String(s || '').toLowerCase()] || s || null;
}

// Baja un adjunto de la mensajeria de ML en base64, para que la IA lo MIRE
async function bajarAdjuntoMLB64(cuenta, attId) {
  const token = await getAccessToken(cuenta);
  const r = await fetch(`https://api.mercadolibre.com/messages/attachments/${attId}?tag=post_sale&site_id=MLA`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) throw new Error('adjunto ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('adjunto muy grande para analizar');
  return { mime: r.headers.get('content-type') || 'image/jpeg', b64: buf.toString('base64') };
}

// IA de posventa: clasifica el motivo y redacta un borrador (SIEMPRE a revision)
async function generarBorradorPV(cuenta, conv, mensajes) {
  const cfg = configDe(cuenta);
  let item = null;
  try { if (conv.item_id) item = await traerItem(cuenta, conv.item_id); } catch (e) {}
  let archivos = [];
  try {
    const { data } = await db.from('pq_archivos').select('id, nombre, sku_madre, ambito, patron, disparador')
      .eq('cuenta_id', cuenta.id).limit(200);
    archivos = (data || []).filter(a => pvArchivoAplica(a, conv.sku || item?.sku)).slice(0, 12);
  } catch (e) {}
  const hiloTxt = (mensajes || []).slice(-12)
    .map(m => `${m.de === 'comprador' ? 'COMPRADOR' : 'NOSOTROS'}: ${(m.texto || '').slice(0, 400)}`).join('\n');
  // REGLAS DE RESPUESTA del vendedor (la lista de Ajustes de posventa): entran
  // solo las que aplican a este SKU, con el mismo criterio que los archivos.
  const reglasPV = (Array.isArray(cfg.pv_reglas_lista) ? cfg.pv_reglas_lista : [])
    .filter(r => r && r.activa !== false && String(r.texto || '').trim())
    .filter(r => (r.ambito || 'global') === 'global' || pvArchivoAplica(r, conv.sku || item?.sku))
    .slice(0, 25);
  const sys = `Sos el asistente de POSVENTA de ${cuenta.nombre || 'la tienda'} en Mercado Libre. El comprador YA COMPRO (orden ${conv.orden_id || conv.pack_id}). Tu unico objetivo es RESOLVER su problema con empatia y sin vueltas.
REGLAS:
- LIMITE DURO: la mensajeria de ML corta en 350 caracteres. Tu "respuesta" DEBE tener MENOS de 330 caracteres. Se breve, directo y resolutivo: un solo parrafo, sin rodeos.
- Tono calido, humano y resolutivo. Reconoce el problema, nunca lo minimices ni culpes al comprador.
- NUNCA prometas reembolsos, cambios ni plazos que no puedas cumplir. Si pide devolver, explicale que la devolucion se gestiona desde su compra en Mercado Libre.
- PROTOCOLO FALTANTES/DANOS: si reporta pieza faltante, rota o producto danado: (1) si NO mando fotos, pedile foto del producto/la pieza Y SIEMPRE preguntale en que condiciones llego el EMBALAJE (caja golpeada, abierta, mojada): ese dato define el reclamo al transporte; (2) si YA mando fotos, MIRALAS y responde sobre lo que se ve, SIN volver a pedirselas; decile que lo resolvemos, sin prometer plazos.
- Si mando FOTOS de comprobantes (constancia de inscripcion, factura, CUIT): LEE los datos de la foto y usalos. NUNCA le pidas datos que ya te paso en una imagen.
- MANUALES Y ARCHIVOS, REGLA ESTRICTA: solo se adjunta un archivo si el comprador reporta un FALTANTE (le falta una pieza o parte) o si PIDE EXPLICITAMENTE el manual/instructivo. En CUALQUIER otro caso (dudas de armado, envio, factura, devolucion, consultas generales) el campo "adjunto" va VACIO, aunque un archivo parezca relacionado. Ademas debe coincidir el "cuando" del archivo. Cuando adjuntes, avisale que se lo mandas aca mismo.
- Si pregunta por el ENVIO, decile que el estado se ve en su compra de ML; no inventes fechas.
- Firma al final: "${(cfg.pv_firma || cfg.saludo_final || 'Saludos.').trim()}"
${cfg.pv_reglas ? `REGLAS DEL VENDEDOR PARA POSVENTA (respetalas SIEMPRE):\n${String(cfg.pv_reglas).slice(0, 2000)}` : ''}
${reglasPV.length ? `REGLAS DE RESPUESTA DEL VENDEDOR (OBLIGATORIAS; todas aplican a ESTE producto):\n${reglasPV.map(r => '- ' + String(r.texto).slice(0, 300)).join('\n')}` : ''}
${item ? `PRODUCTO: ${item.titulo} (SKU ${conv.sku || item.sku || 's/d'})` : ''}
${conv.envio_estado ? `ENVIO: el estado ACTUAL del envio de esta venta es "${pvEnvioTxt(conv.envio_estado)}" (dato real de ML, usalo si pregunta por su pedido).` : ''}
${conv.fact_doc_nro ? `FACTURACION: la venta esta cargada con ${conv.fact_doc_tipo || 'documento'} ${conv.fact_doc_nro}.` : ''}${conv.fact_cuit_msg ? ` El comprador paso por mensaje el CUIT ${conv.fact_cuit_msg}${conv.fact_doc_nro && String(conv.fact_cuit_msg).replace(/\D/g, '') !== String(conv.fact_doc_nro).replace(/\D/g, '') ? ' que es DISTINTO al cargado en la venta: pide FACTURA A con esos datos; confirmale que la emitimos con ese CUIT.' : ' (coincide con el de la venta).'}` : ''}
ARCHIVOS DISPONIBLES PARA ADJUNTAR (id | nombre | cuando se envia):
${archivos.map(a => `- ${a.id} | ${a.nombre} | cuando: ${a.disparador || 'pide el manual o instrucciones'}`).join('\n') || '(ninguno)'}
Responde SOLO este JSON:
{"motivo":"manual|pieza|armado|envio|factura|devolucion|otro","respuesta":"...","adjunto":"id del archivo elegido o vacio","confianza":"alta|media|baja","cuit_detectado":"CUIT visible en el texto o en las fotos (solo numeros) o vacio"}`;
  // fotos que mando el comprador (hasta 3, las ultimas): la IA las MIRA
  const bloquesImg = [];
  try {
    const conFotos = (mensajes || []).filter(m => m.de === 'comprador' && m.adjuntos && m.adjuntos.length).slice(-3);
    for (const m of conFotos) for (const a of m.adjuntos) {
      if (bloquesImg.length >= 3 || !a.id) continue;
      if (!/\.(jpe?g|png|webp)$/i.test(a.nombre || '')) continue;
      try {
        const f = await bajarAdjuntoMLB64(cuenta, a.id);
        bloquesImg.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.b64 } });
      } catch (e) {}
    }
  } catch (e) {}
  const userTxt = `CONVERSACION:\n${hiloTxt}\n\nRedacta la mejor respuesta para el ultimo mensaje del comprador.`;
  const contenido = bloquesImg.length
    ? [...bloquesImg, { type: 'text', text: userTxt + '\nMIRA LAS FOTOS ADJUNTAS: pueden traer el CUIT de un comprobante, la pieza rota o el estado del embalaje.' }]
    : userTxt;
  const r = await llamarIA(modeloDe(cfg.pv_ia || cfg.ia_responde), sys, contenido, 800);
  const j = parsearJson(r.texto);
  const adjOk = archivos.find(a => a.id === String(j.adjunto || '').trim());
  const cuitDig = String(j.cuit_detectado || '').replace(/\D/g, '');
  return {
    motivo: PV_MOTIVOS.includes(j.motivo) ? j.motivo : 'otro',
    borrador: j.respuesta || null,
    adjunto_id: adjOk ? adjOk.id : null,
    confianza: j.confianza || 'media',
    cuit: /^\d{11}$/.test(cuitDig) ? cuitDig : null
  };
}

// Sincroniza la mensajeria: packs con mensajes sin leer -> conversaciones + borrador IA
let _pvSyncOcupado = false;
const _pvSalud = { fin: null, packs: 0, unread_err: null, error: null };
async function sincronizarMensajesPV(cuenta) {
  const uid = cuenta.ml_user_id;
  let noLeidos = [];
  try {
    for (let off = 0; off < 150; off += 50) {
      const d = await mlGet(`/messages/unread?role=seller&tag=post_sale&limit=50&offset=${off}`, cuenta);
      const rs = (d.results || []);
      noLeidos.push(...rs.map(x => String(x.resource || '').match(/\d{6,}/)?.[0]).filter(Boolean));
      if (rs.length < 50) break;
    }
    _pvSalud.no_leidos = noLeidos.length;
  } catch (e) {
    _pvSalud.unread_err = String(e.message).slice(0, 150);
    // plan B: el modo simple de siempre (por si ML rechaza limit/offset aca)
    try {
      const d = await mlGet(`/messages/unread?role=seller&tag=post_sale`, cuenta);
      noLeidos = (d.results || []).map(x => String(x.resource || '').match(/\d{6,}/)?.[0]).filter(Boolean);
      _pvSalud.no_leidos = noLeidos.length;
      _pvSalud.unread_err = null;
    } catch (e2) {}
  }
  // Ademas de lo sin leer, re-leemos las conversaciones ABIERTAS: asi captamos
  // las respuestas que mandaste desde ML web (esas nunca figuran como "sin leer").
  // ROTACION: re-leemos las abiertas ordenadas por "hace cuanto no las miro"
  // (actualizado_at asc). Asi TODAS las conversaciones abiertas se refrescan
  // en pocos ciclos, aunque haya muchas — ML marca leidos los mensajes cuando
  // seguis el caso desde su web y dejan de figurar en "sin leer".
  let abiertas = [];
  try {
    const { data } = await db.from('pq_conversaciones').select('pack_id')
      .eq('cuenta_id', cuenta.id).neq('estado', 'resuelto')
      .order('actualizado_at', { ascending: true }).limit(50);
    abiertas = (data || []).map(x => x.pack_id);
  } catch (e) {}
  let procesados = 0;
  let fallidos = 0;
  let ultFallo = null;
  let borradoresHechos = 0;
  const TOPE_BORRADORES = 8;                    // la IA redacta de a 8 por ciclo: la INGESTA nunca espera
  const topeTiempo = Date.now() + 150 * 1000;   // 150s por ciclo: corta prolijo y sigue en el proximo
  for (const pack of [...new Set([...noLeidos, ...abiertas])].slice(0, 50)) {
    if (Date.now() > topeTiempo) break;
    try {
      let hilo = await mlGet(`/messages/packs/${pack}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=40`, cuenta);
      // ML devuelve los mensajes MAS VIEJOS primero: si la conversacion tiene
      // mas de 40 (tipico con el bot del menu), los nuevos quedaban AFUERA.
      // Pedimos la ultima pagina para tener siempre los 40 MAS RECIENTES.
      const totalMsgs = (hilo && hilo.paging && Number(hilo.paging.total)) || 0;
      if (totalMsgs > 40) {
        try {
          hilo = await mlGet(`/messages/packs/${pack}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=40&offset=${totalMsgs - 40}`, cuenta);
        } catch (e) {}
      }
      const msgs = (hilo.messages || []).map(m => ({
        ml_msg_id: String(m.id || m.message_id || ''),
        de: String(m.from?.user_id) === String(uid) ? 'vendedor' : 'comprador',
        texto: m.text || '',
        adjuntos: (m.message_attachments || []).map(a => ({ nombre: a.original_filename || a.filename || 'archivo', id: a.filename || null })),
        fecha: (m.message_date && (m.message_date.received || m.message_date.created)) || null
      })).filter(m => m.texto || (m.adjuntos && m.adjuntos.length));
      if (!msgs.length) continue;

      // La conversacion que YA tenemos guardada (si existe). Se lee ACA, antes
      // de usarla. OJO: si esta declaracion se baja despues del calculo de
      // "enriquecer", cada vuelta del for muere con "Cannot access 'conv'
      // before initialization" y el catch del final se lo come en silencio:
      // el sync termina con 0 conversaciones y no entra NINGUN mensaje.
      let { data: conv } = await db.from('pq_conversaciones').select('*')
        .eq('cuenta_id', cuenta.id).eq('pack_id', String(pack)).single();

      // datos de la orden (mejor esfuerzo). Si el pack no es una orden directa
      // (compra de carrito), lo resolvemos via /packs -> orden real.
      let orden = null;
      try { orden = await mlGet(`/orders/${pack}`, cuenta); } catch (e) {}
      if (!orden || !orden.order_items) {
        try {
          const pk = await mlGet(`/packs/${pack}`, cuenta);
          const oid = pk && pk.orders && pk.orders[0] && pk.orders[0].id;
          if (oid) orden = await mlGet(`/orders/${oid}`, cuenta);
        } catch (e) {}
      }
      const oi = orden && orden.order_items && orden.order_items[0];
      // Solo vale la pena re-consultar reclamos/envio/facturacion si hay
      // mensajes sin leer, si faltan datos, o si pasaron 20+ min de la ultima
      // pasada. Ahorra ~3 llamadas a ML por conversacion en cada ciclo.
      const enriquecer = !conv || noLeidos.includes(pack) || !conv.envio_estado
        || (Date.now() - new Date(conv.actualizado_at || 0).getTime()) > 20 * 60000;
      // ¿tiene un reclamo abierto en ML? (se refresca cuando corresponde)
      let reclamo = null;
      if (enriquecer) try {
        if (orden && orden.id) {
          const cl = await mlGet(`/post-purchase/v1/claims/search?resource=order&resource_id=${orden.id}`, cuenta);
          const abierto = (cl.data || cl.results || []).find(x => x.status && String(x.status).toLowerCase() !== 'closed');
          if (abierto) reclamo = String(abierto.stage || abierto.status || 'abierto');
        }
      } catch (e) {}
      // estado del envio (para el panel y para que la IA responda con datos reales)
      let envioEstado = null;
      if (enriquecer) try {
        const shipId = orden && orden.shipping && orden.shipping.id;
        if (shipId) {
          const sh = await mlGet(`/shipments/${shipId}`, cuenta);
          envioEstado = sh && sh.status ? String(sh.status) : null;
        }
      } catch (e) {}
      // facturacion: documento cargado en la venta de ML
      let factTipo = null, factNro = null;
      if (enriquecer) try {
        if (orden && orden.id) {
          const bi = await mlGet(`/orders/${orden.id}/billing_info`, cuenta);
          const b = (bi && (bi.billing_info || bi)) || {};
          factTipo = b.doc_type || null; factNro = b.doc_number || null;
        }
      } catch (e) {}
      // CUIT que el comprador paso POR MENSAJE (para factura A)
      let cuitMsg = null;
      for (const m of msgs) {
        if (m.de !== 'comprador') continue;
        const mm = String(m.texto || '').match(/\b(20|23|24|25|26|27|30|33|34)[-.\s]?(\d{8})[-.\s]?(\d)\b/);
        if (mm) cuitMsg = (mm[1] + mm[2] + mm[3]);
      }
      // ¿el ultimo mensaje del comprador es SOLO un cierre/agradecimiento?
      const esCierre = (m) => {
        if (!m || m.de !== 'comprador') return false;
        const t = String(m.texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (t.length > 60 || /\?/.test(t)) return false;
        if (m.adjuntos && m.adjuntos.length) return false;
        const toks = t.replace(/[^a-zn ]/g, ' ').split(/\s+/).filter(Boolean);
        if (!toks.length) return false;
        const okSet = ['gracias','muchas','mil','ok','okey','oka','dale','perfecto','genial','buenisimo','excelente','listo','barbaro','joya','igualmente','saludos','buenas','vale','si','sii','buen','dia','tardes','noches','crack','capo','gral'];
        const fuertes = ['gracias','perfecto','listo','genial','excelente','buenisimo','ok','okey','dale','joya','barbaro'];
        return toks.every(x => okSet.includes(x)) && toks.some(x => fuertes.includes(x));
      };
      const compradorMsg = msgs.find(m => m.de === 'comprador');

      // upsert de la conversacion (conv ya se leyo arriba, antes de "enriquecer")
      const base = {
        cuenta_id: cuenta.id, pack_id: String(pack),
        orden_id: orden ? String(orden.id) : String(pack),
        comprador_id: orden?.buyer?.id ? String(orden.buyer.id) : (conv?.comprador_id || null),
        comprador_nick: orden?.buyer?.nickname || conv?.comprador_nick || null,
        item_id: oi?.item?.id || conv?.item_id || null,
        sku: oi?.item?.seller_sku || oi?.item?.seller_custom_field || conv?.sku || null,
        titulo: oi?.item?.title || conv?.titulo || null,
        reclamo: enriquecer ? reclamo : ((conv && conv.reclamo) || null),
        fecha_venta: (orden && orden.date_created) || conv?.fecha_venta || null,
        envio_estado: envioEstado || conv?.envio_estado || null,
        fact_doc_tipo: factTipo || conv?.fact_doc_tipo || null,
        fact_doc_nro: factNro || conv?.fact_doc_nro || null,
        fact_cuit_msg: cuitMsg || conv?.fact_cuit_msg || null,
        actualizado_at: new Date().toISOString()
      };
      if (!conv) {
        const ins = await db.from('pq_conversaciones').insert({ ...base, estado: 'nuevo' }).select('*').single();
        conv = ins.data;
      } else {
        await db.from('pq_conversaciones').update(base).eq('id', conv.id);
        Object.assign(conv, base);
      }
      if (!conv) continue;

      // mensajes nuevos, reconciliando nuestra copia local con la real de ML
      // (evita el mensaje duplicado tras responder desde el panel)
      const _res = await _guardarMensajesSinDuplicar(conv.id, msgs);
      const nuevos = _res.insertados;   // solo lo realmente nuevo (para no regenerar de mas)
      // mensajes viejos guardados sin el ID del adjunto: se lo completamos
      try {
        const { data: viejos } = await db.from('pq_mensajes').select('id, ml_msg_id, adjuntos').eq('conversacion_id', conv.id);
        for (const v of (viejos || [])) {
          const m = msgs.find(x => x.ml_msg_id === v.ml_msg_id);
          if (!m || !m.adjuntos || !m.adjuntos.length) continue;
          const sinId = !(v.adjuntos || []).length || (v.adjuntos || []).some(a => !a.id);
          if (sinId && m.adjuntos.some(a => a.id)) {
            await db.from('pq_mensajes').update({ adjuntos: m.adjuntos }).eq('id', v.id);
          }
        }
      } catch (e) {}

      // estado del embudo + borrador de la IA si el ultimo hablo el comprador
      const ultimo = msgs[msgs.length - 1];
      const upd = {
        ult_de: ultimo.de, ult_mensaje_at: ultimo.fecha || new Date().toISOString(),
        ult_texto: (ultimo.texto || ((ultimo.adjuntos && ultimo.adjuntos.length) ? '📎 mando un archivo adjunto' : '')).slice(0, 300),
        no_leidos: msgs.filter(m => m.de === 'comprador').length,
        actualizado_at: new Date().toISOString()
      };
      if (ultimo.de === 'comprador' && esCierre(ultimo)) {
        // "Gracias" / "perfecto" y nada mas: no hay nada que responder -> resuelta sola
        upd.estado = 'resuelto';
        if (!conv.resuelta_at) upd.resuelta_at = ultimo.fecha || new Date().toISOString();
        upd.ia_borrador = null; upd.ia_adjunto_id = null; upd.no_leidos = 0;
      } else if (ultimo.de === 'comprador') {
        if (conv.estado === 'resuelto' || conv.estado === 'esperando') upd.estado = 'nuevo'; // se reabre
        if ((nuevos.some(m => m.de === 'comprador') || !conv.ia_borrador) && configDe(cuenta).pv_activa !== false
            && borradoresHechos < TOPE_BORRADORES) {
          try {
            borradoresHechos++;
            const b = await generarBorradorPV(cuenta, { ...conv, ...base }, msgs);
            upd.motivo = b.motivo; upd.ia_borrador = b.borrador;
            upd.ia_adjunto_id = b.adjunto_id; upd.ia_confianza = b.confianza;
            if (b.cuit && !(cuitMsg || conv.fact_cuit_msg)) upd.fact_cuit_msg = b.cuit;   // leido de la FOTO
          } catch (e) {}
        }
      } else {
        // el ultimo mensaje es NUESTRO (quizas respondido desde ML web):
        // la sacamos de la bandeja de Nuevos y queda esperando al cliente.
        if (conv.estado === 'nuevo' || conv.estado === 'encurso') upd.estado = 'esperando';
        upd.no_leidos = 0;
        if (!conv.primera_resp_at) upd.primera_resp_at = ultimo.fecha || new Date().toISOString();
      }
      await db.from('pq_conversaciones').update(upd).eq('id', conv.id);
      // AUTO CONTABILIUM: si esta tildado en Ajustes, carga el CUIT + padron
      // apenas se detecta un CUIT distinto. Una sola vez por venta; si falla,
      // NO reintenta en loop (queda el error visible y el boton manual).
      try {
        if (configDe(cuenta).pv_auto_cuit === true && !conv.cb_cuit_at && !conv.cb_cuit_err) {
          const cuitFinal = upd.fact_cuit_msg || cuitMsg || conv.fact_cuit_msg;
          const docVenta = factNro || conv.fact_doc_nro;
          const distinto = cuitFinal && docVenta && String(cuitFinal).replace(/\D/g, '') !== String(docVenta).replace(/\D/g, '');
          if (distinto) {
            try {
              const rCb = await cbCargarCuitVenta(cuenta, { ...conv, ...upd, fact_cuit_msg: cuitFinal, fact_doc_nro: docVenta, orden_id: conv.orden_id }, null);
              await db.from('pq_conversaciones').update({ cb_cuit_at: new Date().toISOString(), cb_cuit_err: null }).eq('id', conv.id);
              // si ARCA no contesto o el nombre no quedo escrito, queda pendiente
              // y el reintento lo agarra despues
              if (rCb && rCb.padron && rCb.razon_ok !== false) await _marcarPadronHecho(conv.id);
            } catch (eCb) {
              await db.from('pq_conversaciones').update({ cb_cuit_err: String(eCb.message).slice(0, 200) }).eq('id', conv.id);
            }
          }
        }
      } catch (e) {}
      procesados++;
    } catch (e) {
      // un pack puntual fallo: seguimos con el resto, pero lo DEJAMOS ANOTADO.
      // Antes esto se tragaba los errores en silencio y el panel mostraba
      // "0 conversaciones" sin explicar por que.
      fallidos++;
      ultFallo = 'pack ' + pack + ': ' + String(e && e.message || e).slice(0, 140);
    }
  }
  _pvSalud.fin = new Date().toISOString();
  _pvSalud.packs = procesados;
  _pvSalud.mirados = [...new Set([...noLeidos, ...abiertas])].slice(0, 50).length;
  _pvSalud.fallidos = fallidos;
  _pvSalud.ult_fallo = ultFallo;
  _pvSalud.borradores = borradoresHechos;
  return { packs: procesados, fallidos, ult_fallo: ultFallo };
}

async function autoSyncPV() {
  if (_pvSyncOcupado) return;
  _pvSyncOcupado = true;
  try {
    const { data: cuentas } = await db.from('pq_cuentas').select('*').eq('activa', true);
    for (const c of (cuentas || [])) {
      if (configDe(c).pv_activa === false) continue;   // posventa apagada para esta cuenta
      try { _pvSalud.error = null; _pvSalud.unread_err = null; await sincronizarMensajesPV(c); }
      catch (e) { _pvSalud.error = String(e.message).slice(0, 200); }
    }
  } catch (e) { _pvSalud.error = String(e.message).slice(0, 200); } finally { _pvSyncOcupado = false; }
}
setTimeout(autoSyncPV, 90 * 1000);
setInterval(autoSyncPV, 3 * 60 * 1000);   // cada 3 minutos

// ---- endpoints del embudo ----
// DIAGNOSTICO PUNTA A PUNTA de UNA conversacion: compara ML vs nuestra base
app.get('/api/pv/debug', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const { data: conv } = await db.from('pq_conversaciones').select('*').eq('id', req.query.conv).eq('cuenta_id', cuenta.id).single();
    if (!conv) return res.status(404).json({ error: 'conversacion no encontrada' });
    const uid = cuenta.ml_user_id, pack = conv.pack_id;
    const out = { conversacion: { pack, estado: conv.estado, ult_de: conv.ult_de, ult_mensaje_at: conv.ult_mensaje_at, ultima_pasada_sync: conv.actualizado_at } };
    // 1) ¿figura entre los "sin leer" de ML?
    try {
      const u = await mlGet(`/messages/unread?role=seller&tag=post_sale&limit=50`, cuenta);
      out.figura_en_sin_leer = (u.results || []).some(x => String(x.resource || '').includes(String(pack)));
    } catch (e) { out.figura_en_sin_leer = 'ERROR ' + e.message.slice(0, 120); }
    // 2) el hilo REAL en ML (con la paginacion nueva)
    let mlIds = null;
    try {
      let h = await mlGet(`/messages/packs/${pack}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=40`, cuenta);
      const total = (h.paging && Number(h.paging.total)) || (h.messages || []).length;
      if (total > 40) h = await mlGet(`/messages/packs/${pack}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=40&offset=${total - 40}`, cuenta);
      const msgs = h.messages || [];
      const ult = msgs[msgs.length - 1] || null;
      out.ml = {
        total_mensajes: total, traidos: msgs.length,
        ultimo: ult ? {
          de: String(ult.from && ult.from.user_id) === String(uid) ? 'vendedor' : 'comprador',
          fecha: (ult.message_date && (ult.message_date.received || ult.message_date.created)) || ult.date_created || null,
          texto: String((ult.text && ult.text.plain) || ult.text || '').slice(0, 90)
        } : null
      };
      mlIds = msgs.map(m => String(m.id || m.message_id || '')).filter(Boolean);
    } catch (e) { out.ml = 'ERROR ' + e.message.slice(0, 200); }
    // 3) lo que tenemos guardado
    const { data: rows } = await db.from('pq_mensajes').select('ml_msg_id, de, fecha, texto').eq('conversacion_id', conv.id).order('fecha', { ascending: true });
    const ultDb = (rows || [])[rows ? rows.length - 1 : 0] || null;
    out.nuestra_base = {
      total_mensajes: (rows || []).length,
      ultimo: ultDb ? { de: ultDb.de, fecha: ultDb.fecha, texto: String(ultDb.texto || '').slice(0, 90) } : null
    };
    // 4) el veredicto: ¿cuantos mensajes de ML nos faltan?
    if (Array.isArray(mlIds)) {
      const setDb = new Set((rows || []).map(r => String(r.ml_msg_id)));
      out.VEREDICTO_mensajes_de_ML_que_faltan_en_base = mlIds.filter(x => !setDb.has(x)).length;
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 300) }); }
});

// RESCATE: el bot respondia al instante y ML marcaba la conversacion como
// leida -> nunca entraba por "sin leer" -> las conversaciones nuevas quedaban
// invisibles. Este job recorre las ventas recientes, detecta packs CON
// mensajes que no tenemos, y les crea la ficha: la rotacion normal del sync
// las adopta y las completa en los ciclos siguientes.
let _rescateOcupado = false;
async function _pvRescate(cuenta, dias) {
  if (_rescateOcupado) return;
  _rescateOcupado = true;
  const R = _pvSalud.rescate = {
    estado: 'corriendo', dias, ordenes: 0, con_mensajes: 0, creadas: 0,
    err: null, inicio: new Date().toISOString(), fin: null
  };
  try {
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    R.desde = desde;
    const uid = cuenta.ml_user_id;
    const { data: existentes } = await db.from('pq_conversaciones').select('pack_id').eq('cuenta_id', cuenta.id);
    const ya = new Set((existentes || []).map(x => String(x.pack_id)));
    for (let off = 0; off < 3000; off += 50) {
      let d;
      try {
        d = await mlGet(`/orders/search?seller=${uid}&order.date_created.from=${encodeURIComponent(desde)}&sort=date_desc&limit=50&offset=${off}`, cuenta);
      } catch (e) { R.err = 'orders: ' + e.message.slice(0, 120); break; }
      const rs = d.results || [];
      if (!rs.length) break;
      for (const o of rs) {
        R.ordenes++;
        const pack = String(o.pack_id || o.id);
        if (!pack || ya.has(pack)) continue;
        ya.add(pack);
        try {
          const h = await mlGet(`/messages/packs/${pack}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=1`, cuenta);
          const tot = (h.paging && Number(h.paging.total)) || ((h.messages || []).length);
          if (tot > 0) {
            R.con_mensajes++;
            await db.from('pq_conversaciones').upsert({
              cuenta_id: cuenta.id, pack_id: pack, estado: 'nuevo',
              ult_mensaje_at: o.date_created || new Date().toISOString(),
              actualizado_at: new Date(0).toISOString()   // primera en la rotacion
            }, { onConflict: 'cuenta_id,pack_id', ignoreDuplicates: true });
            R.creadas++;
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 450));   // respeto del rate limit de ML
      }
      if (rs.length < 50) break;
    }
    R.estado = 'terminado';
  } catch (e) { R.err = String(e.message).slice(0, 200); R.estado = 'error'; }
  R.fin = new Date().toISOString();
  _rescateOcupado = false;
}
app.post('/api/pv/rescatar', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  if (_rescateOcupado) return res.json({ ok: true, msg: 'ya hay un refresco corriendo', rescate: _pvSalud.rescate || null });
  // ventana en dias: 1 a 30. Cuanto mas larga, mas tarda (mira ~2 ventas por segundo).
  const dias = Math.max(1, Math.min(Number(req.body && req.body.dias) || 3, 30));
  _pvRescate(cuenta, dias);   // corre de fondo
  res.json({ ok: true, dias, msg: 'refresco arrancado (ultimos ' + dias + ' dias)' });
});

app.get('/api/pv/salud', soloPanel, async (req, res) => {
  res.json({ ..._pvSalud, padron_job: _padronJob, ahora: new Date().toISOString(), version: 'v13.36' });
});
app.get('/api/pv/lista', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data } = await db.from('pq_conversaciones').select('*')
    .eq('cuenta_id', cuenta.id).order('ult_mensaje_at', { ascending: false }).limit(300);
  const lista = data || [];
  // PREVIEW EN LA TARJETA: los ultimos 3 mensajes (con adjuntos) de las
  // conversaciones accionables, para leer las fotos y responder sin abrir el
  // hilo. Solo Nuevos y En curso, que es donde se labura; una sola consulta.
  try {
    const ids = lista.filter(c => c.estado === 'nuevo' || c.estado === 'encurso').slice(0, 80).map(c => c.id);
    if (ids.length) {
      const { data: msjs } = await db.from('pq_mensajes')
        .select('conversacion_id, de, texto, adjuntos, fecha')
        .in('conversacion_id', ids).order('fecha', { ascending: false }).limit(800);
      const porConv = {};
      for (const m of (msjs || [])) (porConv[m.conversacion_id] = porConv[m.conversacion_id] || []).push(m);
      for (const c of lista) if (porConv[c.id]) {
        c.ultimos = porConv[c.id].slice(0, 3).reverse().map(m => ({
          de: m.de, texto: String(m.texto || '').slice(0, 600),
          adjuntos: m.adjuntos || [], fecha: m.fecha
        }));
      }
    }
  } catch (e) { /* si el preview falla, la lista sale igual que siempre */ }
  res.json(lista);
});

// Refresco EN VIVO de UNA conversacion contra ML. Es la version liviana del
// sync: trae los mensajes nuevos del pack (incluidos los que respondiste desde
// la web de ML) y acomoda el estado. Sin IA ni facturacion: eso lo completa el
// sync grande. Se usa al ABRIR un caso, para que nunca veas el hilo viejo.
// Inserta los mensajes que vienen de ML en la base SIN duplicar. El caso feo:
// cuando respondemos desde el panel guardamos una copia local (ml_msg_id
// "local-...") para que la veas al instante; despues el sync trae ESE MISMO
// mensaje con su id real de ML. Como los id no coinciden, antes se guardaba dos
// veces. Aca reconciliamos por texto: si ya existe una copia local nuestra con
// el mismo texto, le ponemos el id real en vez de insertar otra fila. Y si
// quedaron duplicados de antes, los limpiamos.
async function _guardarMensajesSinDuplicar(convId, msgsML) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const { data: exist } = await db.from('pq_mensajes')
    .select('id, ml_msg_id, de, texto').eq('conversacion_id', convId);
  const filas = exist || [];
  const idsReales = new Set(filas.filter(f => !String(f.ml_msg_id || '').startsWith('local-')).map(f => f.ml_msg_id));
  // copias locales nuestras (aun sin id real de ML), por texto
  const localesPorTexto = new Map();
  for (const f of filas) {
    if (String(f.ml_msg_id || '').startsWith('local-') && f.de === 'vendedor') {
      localesPorTexto.set(norm(f.texto), f);
    }
  }
  const aInsertar = [];
  let nuevos = 0;
  for (const m of msgsML) {
    if (!m.ml_msg_id) continue;
    if (idsReales.has(m.ml_msg_id)) continue;         // ya lo tenemos con su id real
    if (m.de === 'vendedor') {
      const local = localesPorTexto.get(norm(m.texto));
      if (local) {
        // era nuestra copia local: le ponemos el id real y no insertamos otra
        await db.from('pq_mensajes').update({ ml_msg_id: m.ml_msg_id, fecha: m.fecha || undefined, adjuntos: (m.adjuntos && m.adjuntos.length) ? m.adjuntos : undefined }).eq('id', local.id);
        idsReales.add(m.ml_msg_id);
        localesPorTexto.delete(norm(m.texto));
        continue;
      }
    }
    aInsertar.push({ ...m, conversacion_id: convId });
    idsReales.add(m.ml_msg_id);
    nuevos++;
  }
  if (aInsertar.length) await db.from('pq_mensajes').insert(aInsertar);
  // limpieza de duplicados viejos: copias locales cuyo texto YA existe como real
  const textosReales = new Set(filas.filter(f => !String(f.ml_msg_id || '').startsWith('local-')).map(f => norm(f.texto)));
  for (const [txt, f] of localesPorTexto) {
    if (textosReales.has(txt)) { try { await db.from('pq_mensajes').delete().eq('id', f.id); } catch (e) {} }
  }
  // devolvemos SOLO los mensajes realmente nuevos (no las copias reconciliadas):
  // asi el que llama sabe si entro algo del comprador sin regenerar de mas.
  return { n: nuevos, insertados: aInsertar };
}

async function refrescarConv(cuenta, conv) {
  const uid = cuenta.ml_user_id;
  let hilo = await mlGet(`/messages/packs/${conv.pack_id}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=40`, cuenta);
  const total = (hilo && hilo.paging && Number(hilo.paging.total)) || 0;
  if (total > 40) {
    try { hilo = await mlGet(`/messages/packs/${conv.pack_id}/sellers/${uid}?tag=post_sale&mark_as_read=false&limit=40&offset=${total - 40}`, cuenta); } catch (e) {}
  }
  const msgs = (hilo.messages || []).map(m => ({
    ml_msg_id: String(m.id || m.message_id || ''),
    de: String(m.from?.user_id) === String(uid) ? 'vendedor' : 'comprador',
    texto: m.text || '',
    adjuntos: (m.message_attachments || []).map(a => ({ nombre: a.original_filename || a.filename || 'archivo', id: a.filename || null })),
    fecha: (m.message_date && (m.message_date.received || m.message_date.created)) || null
  })).filter(m => m.texto || (m.adjuntos && m.adjuntos.length));
  if (!msgs.length) return false;
  const nuevosN = (await _guardarMensajesSinDuplicar(conv.id, msgs)).n;
  const ultimo = msgs[msgs.length - 1];
  const upd = {
    ult_de: ultimo.de,
    ult_texto: (ultimo.texto || ((ultimo.adjuntos && ultimo.adjuntos.length) ? '📎 mando un archivo adjunto' : '')).slice(0, 300),
    ult_mensaje_at: ultimo.fecha || conv.ult_mensaje_at,
    actualizado_at: new Date().toISOString()
  };
  if (ultimo.de === 'vendedor') {
    // ya lo respondimos (desde donde sea): sale de Nuevos
    if (conv.estado === 'nuevo' || conv.estado === 'encurso') upd.estado = 'esperando';
    upd.no_leidos = 0;
    if (!conv.primera_resp_at) upd.primera_resp_at = ultimo.fecha || new Date().toISOString();
  } else if (conv.estado === 'resuelto' || conv.estado === 'esperando') {
    upd.estado = 'nuevo';   // el comprador volvio a escribir: se reabre
  }
  await db.from('pq_conversaciones').update(upd).eq('id', conv.id);
  Object.assign(conv, upd);
  return nuevosN > 0;
}

app.get('/api/pv/conv', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data: conv } = await db.from('pq_conversaciones').select('*')
    .eq('id', req.query.id).eq('cuenta_id', cuenta.id).single();
  if (!conv) return res.status(404).json({ error: 'no encontrada' });
  // vivo=1: antes de mostrar, traer de ML lo que falte (respuestas hechas desde
  // la web de ML incluidas). Si ML no contesta, se muestra lo que hay en la base.
  if (String(req.query.vivo || '') === '1' && conv.pack_id) {
    try { await refrescarConv(cuenta, conv); } catch (e) {}
  }
  const { data: msjs } = await db.from('pq_mensajes').select('*')
    .eq('conversacion_id', conv.id).order('fecha', { ascending: true }).limit(100);
  const { data: archTodos } = await db.from('pq_archivos')
    .select('id, nombre, sku_madre, ambito, patron, disparador')
    .eq('cuenta_id', cuenta.id).limit(200);
  const archivos = (archTodos || []).filter(a => pvArchivoAplica(a, conv.sku)).slice(0, 20);
  res.json({ conv, mensajes: msjs || [], archivos: archivos || [] });
});

app.post('/api/pv/estado', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { id, estado } = req.body;
  if (!PV_ESTADOS.includes(estado)) return res.status(400).json({ error: 'estado invalido' });
  await db.from('pq_conversaciones').update({
    estado, actualizado_at: new Date().toISOString(),
    resuelta_at: estado === 'resuelto' ? new Date().toISOString() : null
  }).eq('id', id).eq('cuenta_id', cuenta.id);
  res.json({ ok: true });
});

app.post('/api/pv/sync', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  try { res.json({ ok: true, ...(await sincronizarMensajesPV(cuenta)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// responder por la mensajeria de ML (con adjunto opcional de la biblioteca)
app.post('/api/pv/responder', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const { id, texto, archivo_id } = req.body;
    if (!texto || !String(texto).trim()) return res.status(400).json({ error: 'falta el texto' });
    const largo = String(texto).trim().length;
    if (largo > 350) return res.status(400).json({ error: 'Mercado Libre permite hasta 350 caracteres por mensaje y este tiene ' + largo + '. Acortalo o mandalo en dos mensajes.' });
    const { data: conv } = await db.from('pq_conversaciones').select('*')
      .eq('id', id).eq('cuenta_id', cuenta.id).single();
    if (!conv) return res.status(404).json({ error: 'conversacion no encontrada' });
    if (!conv.comprador_id) return res.status(400).json({ error: 'no tengo el comprador de esta venta (reintenta el sync)' });

    let attachments;
    if (archivo_id) {
      const { data: arch } = await db.from('pq_archivos').select('*')
        .eq('id', archivo_id).eq('cuenta_id', cuenta.id).single();
      if (!arch) return res.status(404).json({ error: 'archivo no encontrado en la biblioteca' });
      const buf = await bajarArchivo(arch.ruta);
      const adjId = await mlSubirAdjunto(cuenta, buf, arch.nombre, arch.mime);
      attachments = [adjId];
    }
    const body = {
      from: { user_id: String(cuenta.ml_user_id) },
      to: { user_id: String(conv.comprador_id) },
      text: String(texto).trim()
    };
    if (attachments) body.attachments = attachments;
    await mlPost(`/messages/packs/${conv.pack_id}/sellers/${cuenta.ml_user_id}?tag=post_sale`, body, cuenta);

    await db.from('pq_mensajes').insert({
      conversacion_id: conv.id, ml_msg_id: 'local-' + Date.now(), de: 'vendedor',
      texto: String(texto).trim(),
      adjuntos: attachments ? [{ nombre: 'adjunto enviado' }] : null,
      fecha: new Date().toISOString()
    });
    const _norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const editado = _norm(texto) !== _norm(conv.ia_borrador);
    await db.from('pq_conversaciones').update({
      estado: 'esperando', ult_de: 'vendedor', no_leidos: 0,
      envios: (Number(conv.envios) || 0) + 1,
      ...(conv.primera_resp_at ? {} : { primera_resp_at: new Date().toISOString() }),
      envios_sin_editar: (Number(conv.envios_sin_editar) || 0) + (editado ? 0 : 1),
      ult_envio_editado: editado,
      ult_mensaje_at: new Date().toISOString(), actualizado_at: new Date().toISOString()
    }).eq('id', conv.id);
    // CALIFICACION AUTOMATICA: mandar el borrador tal cual = 👍 (la IA acerto);
    // editarlo antes de mandar = 👎 con tu correccion. Es el mismo aprendizaje
    // que en preguntas. Best-effort: si faltan las columnas, no rompe el envio.
    if (conv.ia_borrador) {
      try {
        await db.from('pq_conversaciones').update({
          pv_calificacion: editado ? 'mal' : 'bien',
          pv_correccion: editado ? String(texto).trim().slice(0, 600) : null,
          pv_calif_at: new Date().toISOString()
        }).eq('id', conv.id);
      } catch (e) {}
    }
    res.json({ ok: true, con_adjunto: !!attachments, calificacion: conv.ia_borrador ? (editado ? 'mal' : 'bien') : null });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 400) }); }
});

// CALIFICAR el borrador de la IA SIN enviar (modo sombra, para entrenar).
// 👍 bien = "asi esta perfecto"; 👎 mal = "no, deberia decir esto" (+correccion).
// No manda nada al comprador: es puro aprendizaje. Si faltan las columnas,
// devuelve el SQL para crearlas una vez (igual patron que el padron).
const _SQL_CALIF = 'alter table pq_conversaciones add column if not exists pv_calificacion text; '
  + 'alter table pq_conversaciones add column if not exists pv_correccion text; '
  + 'alter table pq_conversaciones add column if not exists pv_calif_at timestamptz;';
app.post('/api/pv/calificar', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { id, calificacion, correccion } = req.body || {};
  if (!['bien', 'mal'].includes(calificacion)) return res.status(400).json({ error: 'calificacion invalida (bien|mal)' });
  const { error } = await db.from('pq_conversaciones').update({
    pv_calificacion: calificacion,
    pv_correccion: calificacion === 'mal' ? (String(correccion || '').trim().slice(0, 600) || null) : null,
    pv_calif_at: new Date().toISOString()
  }).eq('id', id).eq('cuenta_id', cuenta.id);
  if (error) {
    if (/column .* does not exist|pv_calificacion/i.test(error.message)) {
      return res.status(400).json({ error: 'FALTA_COLUMNA', sql: _SQL_CALIF });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// bajar un adjunto de la mensajeria de ML (fotos del comprador, etc.)
app.get('/api/pv/adjunto', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const { data: conv } = await db.from('pq_conversaciones').select('id')
      .eq('id', req.query.conv).eq('cuenta_id', cuenta.id).single();
    if (!conv) return res.status(404).json({ error: 'conversacion no encontrada' });
    const attId = String(req.query.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!attId) return res.status(400).json({ error: 'falta el id del adjunto' });
    const token = await getAccessToken(cuenta);
    const r = await fetch(`https://api.mercadolibre.com/messages/attachments/${attId}?tag=post_sale&site_id=MLA`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return res.status(502).json({ error: 'ML adjunto -> ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    // FOTOS DE IPHONE (.heic): ningun navegador las muestra. Si esta instalada
    // la libreria heic-convert (agregala a package.json: "heic-convert": "^2"),
    // las convertimos a JPEG al vuelo y el panel las previsualiza como cualquier
    // foto. Si no esta, se manda el original y el panel muestra el boton de
    // descarga. Nada se rompe en ningun caso.
    if (/heic|heif/i.test(ct) || /\.hei[cf]/i.test(attId)) {
      const lib = _heicLib();
      if (lib) {
        try {
          const jpg = await lib({ buffer: buf, format: 'JPEG', quality: 0.82 });
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'private, max-age=3600');
          return res.send(Buffer.from(jpg));
        } catch (e) { /* conversion fallo: va el original */ }
      }
    }
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
let _heic = undefined;
function _heicLib() {
  if (_heic === undefined) { try { _heic = require('heic-convert'); } catch (e) { _heic = null; } }
  return _heic;
}

// METRICAS DE POSVENTA: motivos, productos problematicos y madurez para el AUTO
app.get('/api/pv/stats', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  // pedimos tambien pv_calificacion; si la columna no existe todavia, reintentamos
  // sin ella para que las metricas salgan igual.
  let rows = [];
  {
    const r = await db.from('pq_conversaciones')
      .select('estado,motivo,sku,titulo,reclamo,creado_at,resuelta_at,envios,envios_sin_editar,pv_calificacion')
      .eq('cuenta_id', cuenta.id).order('creado_at', { ascending: false }).limit(1000);
    if (r.error) {
      const r2 = await db.from('pq_conversaciones')
        .select('estado,motivo,sku,titulo,reclamo,creado_at,resuelta_at,envios,envios_sin_editar')
        .eq('cuenta_id', cuenta.id).order('creado_at', { ascending: false }).limit(1000);
      rows = r2.data || [];
    } else rows = r.data || [];
  }
  const tot = rows.length;
  const abiertas = rows.filter(r => r.estado !== 'resuelto').length;
  const reclamos = rows.filter(r => r.reclamo).length;
  const conTiempo = rows.filter(r => r.resuelta_at && r.creado_at);
  const t_medio = conTiempo.length
    ? Math.round(conTiempo.reduce((a, r) => a + (new Date(r.resuelta_at) - new Date(r.creado_at)), 0) / conTiempo.length / 36e5 * 10) / 10
    : null;
  const porMot = {};
  for (const r of rows) {
    const m = r.motivo || 'otro';
    porMot[m] = porMot[m] || { motivo: m, casos: 0, abiertos: 0, envios: 0, sin_editar: 0 };
    porMot[m].casos++;
    if (r.estado !== 'resuelto') porMot[m].abiertos++;
    porMot[m].envios += Number(r.envios) || 0;
    porMot[m].sin_editar += Number(r.envios_sin_editar) || 0;
    if (r.pv_calificacion === 'bien') { porMot[m].bien = (porMot[m].bien || 0) + 1; }
    else if (r.pv_calificacion === 'mal') { porMot[m].mal = (porMot[m].mal || 0) + 1; }
  }
  const motivos = Object.values(porMot).sort((a, b) => b.casos - a.casos).map(m => {
    const bien = m.bien || 0, mal = m.mal || 0, calif = bien + mal;
    return {
      ...m, bien, mal,
      pct_sin_editar: m.envios ? Math.round(100 * m.sin_editar / m.envios) : null,
      pct_bien: calif ? Math.round(100 * bien / calif) : null,
      // candidato a automatico: suficientes calificaciones y casi todas 👍.
      // Si todavia no hay calificaciones, cae al criterio viejo (sin editar).
      candidato_auto: calif >= 10 ? (bien / calif) >= 0.9 : (m.envios >= 10 && (m.sin_editar / m.envios) >= 0.9)
    };
  });
  // calidad global de la IA de posventa
  const calif_bien = rows.filter(r => r.pv_calificacion === 'bien').length;
  const calif_mal = rows.filter(r => r.pv_calificacion === 'mal').length;
  const porSku = {};
  for (const r of rows) {
    if (!r.sku) continue;
    porSku[r.sku] = porSku[r.sku] || { sku: r.sku, titulo: r.titulo, casos: 0, mot: {} };
    porSku[r.sku].casos++;
    const m = r.motivo || 'otro';
    porSku[r.sku].mot[m] = (porSku[r.sku].mot[m] || 0) + 1;
  }
  const skus = Object.values(porSku).sort((a, b) => b.casos - a.casos).slice(0, 10).map(s => ({
    sku: s.sku, titulo: s.titulo, casos: s.casos,
    motivo_top: Object.entries(s.mot).sort((a, b) => b[1] - a[1])[0][0]
  }));
  res.json({ tot, abiertas, resueltas: tot - abiertas, reclamos, t_medio_horas: t_medio,
    calif_bien, calif_mal, calif_pct: (calif_bien + calif_mal) ? Math.round(100 * calif_bien / (calif_bien + calif_mal)) : null,
    motivos, skus });
});

// =====================================================================
// RECLAMOS Y MEDIACIONES  (canal APARTE de la mensajeria de posventa)
// ---------------------------------------------------------------------
// La posventa lee la BANDEJA de mensajes (tag=post_sale). Cuando un caso
// escala a RECLAMO o MEDIACION, la conversacion se muda al centro de
// reclamos de ML (vendedor <-> Mercado Libre), que es OTRA API: por eso
// esos casos NO aparecian en Posventa (buscabas el Nº de venta y "no habia
// nada en ningun estado"). Este modulo los trae directo desde
// /post-purchase/v1/claims con su ETAPA, MOTIVO, VENCIMIENTO y si AFECTA la
// reputacion. Es SOLO LECTURA + link a ML para accionar: a proposito nada
// automatico toca un caso que ya escalo (un error aca cuesta plata).
// =====================================================================
const _SQL_REC =
  'create table if not exists pq_reclamos (' +
  ' id text primary key, cuenta_id bigint, orden_id text, pack_id text,' +
  ' tipo text, etapa text, estado text, reason_id text, motivo text,' +
  ' titulo text, sku text, item_id text, responsable text,' +
  ' vence_at timestamptz, afecta_reputacion text,' +
  ' ult_mensaje text, ult_de text, ult_mensaje_at timestamptz,' +
  ' date_created timestamptz, last_updated timestamptz,' +
  ' actualizado_at timestamptz default now());' +
  ' create index if not exists pq_reclamos_cuenta on pq_reclamos(cuenta_id);';
// NOTA: cuenta_id es bigint (igual que en pq_conversaciones); una version
// anterior lo creo como uuid por error y se corrigio en vivo con
// "alter table pq_reclamos alter column cuenta_id type bigint".

const _recSalud = { fin: null, listados: 0, enriquecidos: 0, qbase: null, error: null, falta_tabla: false };
let _recSyncOcupado = false;
const _RE_FALTA_TABLA = /relation .*pq_reclamos.* does not exist|could not find the table/i;

// texto legible del motivo: primero lo que da ML en el detalle, si no un mapa
function _motivoReclamo(cl, det) {
  const t = det && (det.title || det.problem || det.description);
  if (t) return String(t).slice(0, 90);
  const porRazon = { PNR: 'Producto no recibido', PDD: 'Producto con defectos', CS: 'Cancelacion' };
  const porTipo = { mediations: 'Mediacion', return: 'Devolucion', cancel_sale: 'Cancelacion',
    cancel_purchase: 'Cancelacion', change: 'Cambio de producto', fulfillment: 'Problema de envio' };
  return porRazon[cl.reason_id] || porTipo[cl.tipo] || porTipo[cl.type] || 'Reclamo';
}

// ML expone la busqueda de claims de distintas formas segun el vendedor/pais.
// Probamos variantes en el primer pedido y nos quedamos con la que responde.
async function _recBuscar(cuenta, qbase, off) {
  return mlGet(`/post-purchase/v1/claims/search?${qbase}&sort=date_desc&limit=50&offset=${off}`, cuenta);
}

async function sincronizarReclamos(cuenta) {
  const uid = cuenta.ml_user_id;
  // lo que ya tenemos guardado (para decidir a quien re-enriquecer y no re-pedir de mas)
  const previos = {};
  {
    const { data, error } = await db.from('pq_reclamos')
      .select('id,last_updated,item_id,titulo,sku,pack_id,vence_at,responsable').eq('cuenta_id', cuenta.id);
    if (error) { if (_RE_FALTA_TABLA.test(String(error.message))) { _recSalud.falta_tabla = true; return; } }
    for (const r of (data || [])) previos[r.id] = r;
  }
  // 1) LISTAR los reclamos ABIERTOS del vendedor (paginado). qbase es LOCAL a
  // esta cuenta: nunca reusamos entre cuentas una variante que lleve el uid.
  const variantes = [`status=opened`, `player_user_id=${uid}&status=opened`, `user_id=${uid}&status=opened`];
  let qbase = null;
  let paginadoOk = true;
  const claims = [];
  for (let off = 0; off < 500; off += 50) {
    let d = null;
    if (!qbase) {
      // primera pagina: probamos las variantes hasta que una responda
      let errUlt = null;
      for (const v of variantes) {
        try { d = await _recBuscar(cuenta, v, off); qbase = v; break; }
        catch (e) { errUlt = e; }
      }
      if (!d) { _recSalud.error = 'search: ' + String(errUlt && errUlt.message).slice(0, 160); return; }  // ninguna variante anduvo
    } else {
      try { d = await _recBuscar(cuenta, qbase, off); }
      catch (e) { _recSalud.error = 'search: ' + String(e.message).slice(0, 160); paginadoOk = false; break; }
    }
    const rs = d.data || d.results || [];
    claims.push(...rs);
    const tot = (d.paging && Number(d.paging.total)) || rs.length;
    if (rs.length < 50 || off + 50 >= tot) break;
  }
  _recSalud.qbase = qbase;
  _recSalud.listados = claims.length;
  if (paginadoOk) _recSalud.error = null;

  let enr = 0;
  for (const cl of claims) {
    try {
      const id = String(cl.id);
      const orden = (cl.resource === 'order' && cl.resource_id) ? String(cl.resource_id)
        : (cl.order_id ? String(cl.order_id) : (previos[id]?.pack_id || null));
      // vencimiento + responsable: del player que soy yo (o el 'respondent')
      let vence = null, responsable = null;
      const players = cl.players || [];
      const yo = players.find(p => String(p.user_id) === String(uid)) || players.find(p => p.role === 'respondent');
      if (yo && yo.due_date) vence = yo.due_date;
      if (yo && Array.isArray(yo.available_actions) && yo.available_actions.length) responsable = 'seller';

      const prev = previos[id];
      const cambio = !prev || String(prev.last_updated || '') !== String(cl.last_updated || '');
      let det = null, afecta = null;
      let item = { id: prev?.item_id || null, titulo: prev?.titulo || null, sku: prev?.sku || null };
      let ultMsg, ultDe, ultAt;   // undefined => no pisar lo que ya estaba
      if (cambio) {
        try { det = await mlGet(`/post-purchase/v1/claims/${id}/detail`, cuenta); } catch (e) {}
        if (det) { if (!vence && det.due_date) vence = det.due_date; if (det.action_responsible) responsable = det.action_responsible; }
        try {
          const ar = await mlGet(`/post-purchase/v1/claims/${id}/affects-reputation`, cuenta);
          afecta = ar && ar.affects_reputation ? String(ar.affects_reputation) : null;
        } catch (e) {}
        try {
          const mm = await mlGet(`/post-purchase/v1/claims/${id}/messages`, cuenta);
          const arr = mm.data || mm.results || mm.messages || (Array.isArray(mm) ? mm : []);
          const last = arr[arr.length - 1];
          if (last) { ultMsg = String(last.message || '').slice(0, 300); ultDe = last.sender_role || null; ultAt = last.date_created || null; }
        } catch (e) {}
        if (orden && !item.titulo) {
          try {
            const o = await mlGet(`/orders/${orden}`, cuenta);
            const oi = o && o.order_items && o.order_items[0] && o.order_items[0].item;
            if (oi) item = { id: oi.id || null, titulo: oi.title || null, sku: oi.seller_sku || oi.seller_custom_field || null };
          } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 350));   // respeto del rate limit de ML
        enr++;
      }
      const fila = {
        id, cuenta_id: cuenta.id, orden_id: orden,
        pack_id: cl.pack_id ? String(cl.pack_id) : (prev?.pack_id || null),
        tipo: cl.type || null, etapa: cl.stage || null, estado: cl.status || 'opened',
        reason_id: cl.reason_id || null, motivo: _motivoReclamo(cl, det),
        titulo: item.titulo, sku: item.sku, item_id: item.id,
        responsable: responsable || prev?.responsable || undefined,
        vence_at: vence || prev?.vence_at || undefined,
        afecta_reputacion: afecta !== null ? afecta : undefined,
        ult_mensaje: ultMsg, ult_de: ultDe, ult_mensaje_at: ultAt,
        date_created: cl.date_created || null, last_updated: cl.last_updated || null,
        actualizado_at: new Date().toISOString()
      };
      Object.keys(fila).forEach(k => fila[k] === undefined && delete fila[k]);
      const up = await db.from('pq_reclamos').upsert(fila, { onConflict: 'id' });
      if (up.error && _RE_FALTA_TABLA.test(String(up.error.message))) { _recSalud.falta_tabla = true; return; }
    } catch (e) { /* un reclamo puntual fallo: seguimos con el resto */ }
  }
  // los que ya no figuran abiertos -> los marcamos cerrados (salen de la bandeja).
  // SOLO si el listado se completo sin error: si el paginado se corto a la mitad,
  // NO cerramos nada (cerrariamos reclamos que en realidad siguen abiertos).
  if (paginadoOk) try {
    const vivos = new Set(claims.map(c => String(c.id)));
    for (const id of Object.keys(previos)) {
      if (!vivos.has(id)) await db.from('pq_reclamos').update({ estado: 'closed', actualizado_at: new Date().toISOString() }).eq('id', id).eq('cuenta_id', cuenta.id);
    }
  } catch (e) {}
  _recSalud.enriquecidos = enr;
  _recSalud.falta_tabla = false;
}

async function autoSyncRec() {
  if (_recSyncOcupado) return;
  _recSyncOcupado = true;
  try {
    const { data: cuentas } = await db.from('pq_cuentas').select('*').eq('activa', true);
    for (const c of (cuentas || [])) {
      if (configDe(c).rec_activa === false) continue;   // reclamos apagados para esta cuenta
      try { await sincronizarReclamos(c); }
      catch (e) { _recSalud.error = String(e.message).slice(0, 200); }
    }
  } catch (e) { _recSalud.error = String(e.message).slice(0, 200); }
  finally { _recSalud.fin = new Date().toISOString(); _recSyncOcupado = false; }
}
setTimeout(autoSyncRec, 120 * 1000);
setInterval(autoSyncRec, 5 * 60 * 1000);   // cada 5 minutos

// ---- endpoints de reclamos ----
app.get('/api/rec/lista', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data, error } = await db.from('pq_reclamos').select('*')
    .eq('cuenta_id', cuenta.id).order('vence_at', { ascending: true, nullsFirst: false }).limit(300);
  if (error) {
    if (_RE_FALTA_TABLA.test(String(error.message))) return res.json({ falta_tabla: true, sql: _SQL_REC, lista: [] });
    return res.status(500).json({ error: error.message });
  }
  res.json({ lista: data || [], salud: { fin: _recSalud.fin, listados: _recSalud.listados, error: _recSalud.error } });
});

// hilo de la mediacion EN VIVO desde ML (solo lectura). Para RESPONDER se abre
// en ML: no mandamos nada por API en un caso escalado.
app.get('/api/rec/hilo', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const id = String(req.query.id || '').replace(/[^0-9]/g, '');
    if (!id) return res.status(400).json({ error: 'falta el id del reclamo' });
    const { data: r } = await db.from('pq_reclamos').select('id,orden_id').eq('id', id).eq('cuenta_id', cuenta.id).single();
    if (!r) return res.status(404).json({ error: 'reclamo no encontrado' });
    let det = null; try { det = await mlGet(`/post-purchase/v1/claims/${id}/detail`, cuenta); } catch (e) {}
    let msgs = [];
    try {
      const mm = await mlGet(`/post-purchase/v1/claims/${id}/messages`, cuenta);
      const arr = mm.data || mm.results || mm.messages || (Array.isArray(mm) ? mm : []);
      msgs = (arr || []).map(m => ({
        de: m.sender_role || null, para: m.receiver_role || null,
        texto: String(m.message || ''), fecha: m.date_created || null,
        adjuntos: (m.attachments || []).map(a => a.original_filename || a.filename || 'adjunto')
      }));
    } catch (e) {}
    res.json({ id, orden_id: r.orden_id,
      detalle: det ? { titulo: det.title || null, problema: det.problem || null, descripcion: det.description || null, vence: det.due_date || null, responsable: det.action_responsible || null } : null,
      mensajes: msgs });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 300) }); }
});

// salud del sync de reclamos (diagnostico)
app.get('/api/rec/salud', soloPanel, async (req, res) => {
  res.json({ ..._recSalud, ahora: new Date().toISOString(), version: 'v13.36' });
});

// Clasifica por NOMBRE cuales PDFs son manuales para el comprador y cuales
// son archivos de packaging/etiquetas/imprenta (que no hay que mandarle a nadie).
app.post('/api/clasificar-manuales', soloPanel, async (req, res) => {
  try {
    const nombres = (req.body.nombres || []).slice(0, 300).map(n => String(n).slice(0, 120));
    if (!nombres.length) return res.json({ descartar: [] });
    const cuenta = await resolverCuenta(req);
    const cfg = cuenta ? configDe(cuenta) : {};
    const sys = `Sos el bibliotecario de una tienda. Te paso nombres de PDFs que estan en carpetas "Manual y Packaging" de productos. Descarta SOLO los que CLARAMENTE son material de imprenta/packaging por su nombre: caja, packaging, etiqueta, label, troquel, arte, marca, EAN, codigo de barras.
IMPORTANTISIMO: ante la MINIMA duda, NO lo descartes. Un PDF cuyo nombre es solo un codigo de producto (ej: MEIN200.pdf) casi siempre ES el manual. "Manual", "Instructivo", "Armado", "Instrucciones", "Guia" SIEMPRE son manuales: nunca los descartes.
Responde SOLO este JSON: {"descartar":[indices de los CLARAMENTE packaging, empezando en 0]}`;
    const lista = nombres.map((n, i) => i + ': ' + n).join('\n');
    const r = await llamarIA(modeloDe(cfg.ia_responde), sys, lista, 400);
    const j = parsearJson(r.texto);
    const descartar = Array.isArray(j.descartar) ? j.descartar.map(Number).filter(x => x >= 0 && x < nombres.length) : [];
    res.json({ descartar });
  } catch (e) { res.json({ descartar: [], error: e.message }); }
});

// TIEMPOS DE RESPUESTA: promedio y evolucion semanal (para ver si mejoramos)
app.get('/api/tiempos', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const desde = new Date(Date.now() - 60 * 864e5).toISOString();
  const { data: pq } = await db.from('pq_preguntas').select('fecha_pregunta, enviada_at')
    .eq('cuenta_id', cuenta.id).gte('fecha_pregunta', desde).not('enviada_at', 'is', null).limit(3000);
  const { data: pv } = await db.from('pq_conversaciones').select('creado_at, primera_resp_at, resuelta_at')
    .eq('cuenta_id', cuenta.id).gte('creado_at', desde).limit(2000);
  const sem = f => { const x = new Date(f); const l = new Date(x); l.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return l.toISOString().slice(0, 10); };
  const agg = {};
  const add = (k, campo, h) => { agg[k] = agg[k] || { sem: k, pre: [], pv1: [], pvr: [] }; agg[k][campo].push(h); };
  (pq || []).forEach(r => {
    const h = (new Date(r.enviada_at) - new Date(r.fecha_pregunta)) / 36e5;
    if (h >= 0 && h < 24 * 14) add(sem(r.fecha_pregunta), 'pre', h);
  });
  (pv || []).forEach(r => {
    if (r.primera_resp_at && r.creado_at) { const h = (new Date(r.primera_resp_at) - new Date(r.creado_at)) / 36e5; if (h >= 0 && h < 24 * 30) add(sem(r.creado_at), 'pv1', h); }
    if (r.resuelta_at && r.creado_at) { const h = (new Date(r.resuelta_at) - new Date(r.creado_at)) / 36e5; if (h >= 0 && h < 24 * 60) add(sem(r.creado_at), 'pvr', h); }
  });
  const prom = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
  const semanas = Object.values(agg).sort((a, b) => a.sem < b.sem ? 1 : -1).slice(0, 8)
    .map(x => ({ sem: x.sem, pre: prom(x.pre), pv_primera: prom(x.pv1), pv_resolucion: prom(x.pvr) }));
  const junta = c => prom([].concat(...Object.values(agg).map(x => x[c])));
  res.json({ prom_pre: junta('pre'), prom_pv_primera: junta('pv1'), prom_pv_resolucion: junta('pvr'), semanas });
});

// INFO DE UNA PUBLICACION: precio real (con descuento) + cuotas.
// Referencia interna para el vendedor: NO se le informa al comprador.
app.get('/api/pub-info', soloPanel, async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    const id = String(req.query.item || '').replace(/[^A-Za-z0-9]/g, '');
    if (!cuenta || !/^MLA\d+$/.test(id)) return res.status(400).json({ error: 'item invalido' });
    const it = await mlGet(`/items/${id}?attributes=id,title,price`, cuenta);
    const real = await precioRealDe(cuenta, id, it.price || null);
    let cuotas = null;
    try {
      const q = encodeURIComponent(String(it.title || '').split(' ').slice(0, 4).join(' '));
      const s = await mlGet(`/sites/MLA/search?seller_id=${cuenta.ml_user_id}&q=${q}&limit=20`, cuenta);
      const hit = (s.results || []).find(r => r.id === id);
      if (hit && hit.installments && hit.installments.quantity) cuotas = `${hit.installments.quantity} cuotas de $${Math.round(hit.installments.amount || 0).toLocaleString('es-AR')}`;
    } catch (e) {}
    res.json({ id, precio: real, lista: it.price || null, cuotas });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});

// ══ CONTABILIUM: actualizar el CLIENTE de una venta con el CUIT del mensaje ══
// Automatiza el proceso manual: buscar la venta en Integraciones ML, editar el
// cliente (CUIT + categoria) y guardar, para que la Factura A salga bien.
let _cbTok = null;
async function cbToken() {
  if (_cbTok && _cbTok.exp > Date.now()) return _cbTok.v;
  const id = process.env.CONTABILIUM_CLIENT_ID, sec = process.env.CONTABILIUM_CLIENT_SECRET;
  if (!id || !sec) throw new Error('Faltan credenciales: copia CONTABILIUM_CLIENT_ID y CONTABILIUM_CLIENT_SECRET (las mismas de MargenML) a las Variables de RespondIA en Railway.');
  const r = await fetch('https://rest.contabilium.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(sec)}`
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Contabilium token -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 150));
  _cbTok = { v: j.access_token, exp: Date.now() + 50 * 60000 };
  return _cbTok.v;
}
async function cbApi(metodo, path, body) {
  const t = await cbToken();
  const r = await fetch('https://rest.contabilium.com' + path, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text().catch(() => '');
  let j = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = {}; }
  if (!r.ok) {
    // si es 405, la cabecera Allow dice QUE metodos acepta esa ruta: la mostramos
    const allow = r.headers.get('allow') || r.headers.get('access-control-allow-methods');
    // los 400 de Contabilium a veces vienen con el cuerpo vacio o en texto plano:
    // mostramos el crudo, que dice mas que un "{}" pelado.
    const detalle = (txt && txt.trim()) ? txt.slice(0, 400) : '(respondio con el cuerpo vacio)';
    throw new Error('Contabilium ' + metodo + ' ' + path + ' -> ' + r.status
      + (allow ? ' [esta ruta acepta: ' + allow + ']' : '') + ' ' + detalle);
  }
  return j;
}

// DIAGNOSTICO SOLO LECTURA de la API de Contabilium.
// Manda OPTIONS y GET a las rutas que le pases y devuelve el estado y la cabecera
// Allow, que es la que dice que metodos acepta cada ruta. NUNCA manda POST, PUT
// ni DELETE: no puede crear, modificar ni borrar nada en tu cuenta.
// Uso: /api/cb-metodos?clave=...&path=/api/clientes,/api/comprobantes-venta
app.get('/api/cb-metodos', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const t = await cbToken();
    const rutas = String(req.query.path || '/api/clientes')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
    const out = [];
    for (const p of rutas) {
      const fila = { path: p };
      for (const metodo of ['OPTIONS', 'GET']) {   // <- los dos unicos permitidos aca
        try {
          const r = await fetch('https://rest.contabilium.com' + p, {
            method: metodo, headers: { Authorization: 'Bearer ' + t }
          });
          const txt = await r.text().catch(() => '');
          fila[metodo] = {
            status: r.status,
            acepta: r.headers.get('allow') || r.headers.get('access-control-allow-methods') || null,
            muestra: txt.slice(0, 300)
          };
        } catch (e) { fila[metodo] = { error: String(e.message).slice(0, 150) }; }
      }
      out.push(fila);
    }
    res.json({ ok: true, nota: 'solo OPTIONS y GET: este diagnostico no modifica nada', rutas: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Padron de ARCA/AFIP: con el CUIT devuelve razon social y si es
// Monotributista o Responsable Inscripto (lo que hace el boton ARCA).
// ---------------------------------------------------------------------
// PADRON VIA CONTABILIUM
// Es el mismo metodo que usa su boton ARCA. Acepta pedidos sin sesion y el
// parametro se llama nroDocumento (lo dijo el propio error de la API).
// OJO: NO es una API documentada, es un metodo interno de su aplicacion web.
// Puede cambiar o cerrarse sin aviso, por eso queda AFIP como respaldo y el
// boton manual de Contabilium como ultima red.
// ---------------------------------------------------------------------
const CB_PADRON_URL = 'https://app.contabilium.com/common.aspx/ObtenerDatosAfipPersona';

// Los WebMethod de ASP.NET envuelven la respuesta en {"d": ...} y a veces "d"
// viene como texto JSON. Aplanamos todo y buscamos los campos por nombre, para
// no depender de la forma exacta que devuelva.
function _cbPadronParse(j) {
  let d = (j && j.d !== undefined) ? j.d : j;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
  if (!d || typeof d !== 'object') return { razon: null, cat: null, cat_texto: null, crudo: d };
  const plano = {};
  (function aplanar(o, pre) {
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) aplanar(v, pre + k + '.');
      else plano[(pre + k).toLowerCase()] = v;
    }
  })(d, '');
  const buscar = re => { for (const k of Object.keys(plano)) if (re.test(k) && plano[k]) return String(plano[k]); return null; };
  const directo = k => (d[k] !== undefined && d[k] !== null && String(d[k]).trim() !== '') ? String(d[k]).trim() : null;

  // Contabilium devuelve un ContribuyenteAfipDTO con estos nombres exactos.
  // Los miramos primero; la busqueda difusa queda de respaldo.
  let razon = directo('RazonSocial') || buscar(/razon|denomin/);
  if (!razon) {
    const ape = buscar(/apellido/), nom = buscar(/(^|\.)nombre/);
    razon = [ape, nom].filter(Boolean).join(' ').trim() || null;
  }
  // El CODIGO tal cual lo usa Contabilium: MO = Monotributo, RI = Responsable
  // Inscripto, CF = Consumidor Final, EX = Exento. Hay que guardarlo TAL CUAL en
  // el cliente: si le mandamos un valor inventado como "MT", no lo entiende.
  const catCodigo = directo('CategoriaImpositiva') || buscar(/categoriaimpositiv|condicioniva/) || null;
  const c = String(catCodigo || '').trim().toUpperCase();
  let cat = null;
  if (/^MO|^MT|MONOTRIB/.test(c)) cat = 'MT';
  else if (/^RI|INSCRIPT|RESPONSABLE/.test(c)) cat = 'RI';
  return {
    razon, cat, cat_codigo: catCodigo, cat_texto: catCodigo,
    tipo_doc: directo('TipoDoc'),
    domicilio: directo('Domicilio'), provincia: directo('ProvinciaNombre'),
    ciudad: directo('CiudadNombre'), cp: directo('CodigoPostal'),
    provincia_id: directo('ProvinciaId'), ciudad_id: directo('CiudadId'),
    crudo: d
  };
}

// Escribe un valor en la primera clave que el objeto YA tenga. Si la clave no
// existe, agregarla no sirve: Contabilium ignora los campos que no conoce (por
// eso la razon social no se aplicaba aunque la mandaramos).
function _ponerCampo(obj, claves, valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return false;
  for (const k of claves) if (k in obj) { obj[k] = valor; return true; }
  return false;
}

// Escribe la categoria impositiva en la clave que el cliente realmente usa,
// sin inventar campos nuevos (un campo desconocido puede hacer fallar el PUT).
function _ponerCategoria(obj, valor) {
  if (valor === null || valor === undefined || valor === '') return;
  if ('CondicionIva' in obj) obj.CondicionIva = valor;
  else if ('condicionIva' in obj) obj.condicionIva = valor;
  else if ('CategoriaImpositiva' in obj) obj.CategoriaImpositiva = valor;
  else if ('categoriaImpositiva' in obj) obj.categoriaImpositiva = valor;
  else obj.CondicionIva = valor;
}

async function padronContabilium(cuit, log) {
  const anotar = o => { if (log) log.push(Object.assign({ fuente: 'contabilium' }, o)); };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);   // su consulta a ARCA es lenta
    const r = await fetch(CB_PADRON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
      body: JSON.stringify({ nroDocumento: String(cuit).replace(/\D/g, '') }),
      signal: ctl.signal
    }).finally(() => clearTimeout(timer));
    const txt = await r.text().catch(() => '');
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    if (!r.ok || !j) { anotar({ status: r.status, muestra: txt.slice(0, 200) }); return null; }
    const p = _cbPadronParse(j);
    anotar({ status: r.status, razon: p.razon, cat: p.cat, cat_codigo: p.cat_codigo });
    return (p.razon || p.cat_codigo) ? p : null;   // devolvemos todo: tambien el domicilio fiscal
  } catch (e) { anotar({ error: String(e && e.message || e).slice(0, 150) }); return null; }
}

// El parametro "log" es opcional: si le pasas un array, va anotando que contesto
// cada servidor en cada intento. Sirve para saber POR QUE no vino el padron en
// vez de quedarnos con un null mudo.
async function arcaPadron(cuit, log) {
  // 1) Contabilium primero: es la fuente que hoy funciona.
  const cb = await padronContabilium(cuit, log);
  if (cb) return cb;
  // 2) AFIP publico como respaldo (hoy devuelve 404, pero si lo reviven sirve).
  return _arcaPadronAfip(cuit, log);
}
async function _arcaPadronAfip(cuit, log) {
  const dormir = ms => new Promise(r => setTimeout(r, ms));
  const urls = [
    `https://soa.afip.gob.ar/sr-padron/v2/persona/${cuit}`,
    `https://aws.afip.gov.ar/sr-padron/v2/persona/${cuit}`
  ];
  // ARCA/AFIP se cae seguido un ratito: hasta 3 vueltas por los 2 servidores,
  // con espera creciente. Tope de 6s por consulta para no colgarnos.
  // ARCA puede tardar bastante: la consulta al padron es lenta de por si (el
  // boton de Contabilium tarda ~15 segundos). Con 6s de tope cortabamos antes
  // de tiempo, asi que damos 20s por consulta y hacemos menos vueltas.
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    if (vuelta > 0) await dormir(2000);
    const res = await _arcaIntento(urls, log, vuelta + 1);
    if (res) return res;
  }
  return null;
}
async function _arcaIntento(urls, log, vuelta) {
  for (const u of urls) {
    const anotar = o => { if (log) log.push(Object.assign({ vuelta, servidor: u.split('/')[2] }, o)); };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);   // ARCA es lento: 20s
      const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: ctl.signal }).finally(() => clearTimeout(timer));
      if (!r.ok) { anotar({ status: r.status, cuerpo: (await r.text().catch(() => '')).slice(0, 160) }); continue; }
      const j = await r.json().catch(() => null);
      const p = (j && (j.data || j)) || null;
      if (!p) { anotar({ status: r.status, nota: 'respondio OK pero sin cuerpo util' }); continue; }
      const dg = p.datosGenerales || p;
      const razon = dg.razonSocial || [dg.apellido, dg.nombre].filter(Boolean).join(' ').trim() || null;
      let cat = null;
      if (p.datosMonotributo) cat = 'MT';
      else if (p.datosRegimenGeneral) cat = 'RI';
      if (!cat) {
        const imps = (p.datosRegimenGeneral && p.datosRegimenGeneral.impuesto) || p.impuestos || [];
        if (Array.isArray(imps)) {
          if (imps.some(x => (x.idImpuesto || x) == 32 || /monotrib/i.test(String(x.descripcionImpuesto || x.descripcion || '')))) cat = 'MT';
          else if (imps.some(x => (x.idImpuesto || x) == 30)) cat = 'RI';
        }
      }
      anotar({ status: r.status, razon, cat, claves: Object.keys(p).slice(0, 12) });
      if (razon || cat) return { razon, cat };
    } catch (e) { anotar({ error: String(e && e.message || e).slice(0, 160) }); }
  }
  return null;
}

// DIAGNOSTICO SOLO LECTURA del padron de ARCA/AFIP: proba el CUIT que le pases y
// te devuelve lo que contesto cada servidor en cada intento. No modifica nada.
app.get('/api/arca', soloPanel, async (req, res) => {
  const cuit = String(req.query.cuit || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(cuit)) return res.status(400).json({ error: 'pasame ?cuit= con 11 digitos' });
  const intentos = [];
  let r = null, err = null;
  try { r = await arcaPadron(cuit, intentos); } catch (e) { err = String(e.message).slice(0, 200); }
  res.json({ ok: true, cuit, resultado: r, error: err, intentos });
});

// SONDA: el boton ARCA de Contabilium llama a este metodo de su aplicacion web.
// Probamos si se puede llamar desde afuera, sin la sesion del navegador.
// Es una CONSULTA (Obtener...): manda un CUIT y no modifica nada de tu cuenta.
// Si contesta los datos, tenemos padron sin depender de AFIP ni de un pago.
// Si pide login, no hay forma de usarlo desde el backend.
app.get('/api/arca-cb', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  const cuit = String(req.query.cuit || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(cuit)) return res.status(400).json({ error: 'pasame ?cuit= con 11 digitos' });
  const URL_CB = 'https://app.contabilium.com/common.aspx/ObtenerDatosAfipPersona';
  // no sabemos como se llama el parametro: probamos los nombres mas probables
  const cuerpos = [
    { nroDocumento: cuit },
    { nroDocumento: cuit, tipoDocumento: 'CUIT' },
    { nroDocumento: cuit, idTipoDoc: 80 }
  ];
  const intentos = [];
  for (const cuerpo of cuerpos) {
    try {
      const r = await fetch(URL_CB, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
        body: JSON.stringify(cuerpo)
      });
      const txt = await r.text().catch(() => '');
      const pideLogin = /login|iniciar sesi|<html/i.test(txt);
      let leido = null;
      try { leido = _cbPadronParse(JSON.parse(txt)); } catch (e) {}
      intentos.push({
        envie: cuerpo, status: r.status, pide_login: pideLogin,
        lo_que_entendi: leido ? { razon: leido.razon, cat: leido.cat, cat_texto: leido.cat_texto } : null,
        muestra: txt.slice(0, 900)
      });
      if (r.ok && !pideLogin && leido && (leido.razon || leido.cat)) break;   // le pegamos
    } catch (e) { intentos.push({ envie: cuerpo, error: String(e.message).slice(0, 150) }); }
  }
  res.json({ ok: true, nota: 'solo consulta: no modifica nada', url: URL_CB, intentos });
});

// DIAGNOSTICO SOLO LECTURA: como ve Contabilium a un cliente, con los NOMBRES
// EXACTOS de cada campo. Sirve para saber, por ejemplo, en que campo guarda la
// categoria impositiva. Solo hace GET: no modifica nada.
app.get('/api/cb-cliente-json', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const filtro = String(req.query.filtro || req.query.cuit || '').trim();
    if (!filtro) return res.status(400).json({ error: 'pasame ?filtro= con el CUIT, el nro de venta o el nombre' });
    const s = await cbApi('GET', `/api/clientes/search?filtro=${encodeURIComponent(filtro)}&page=1&pageSize=10`);
    const items = Array.isArray(s) ? s : ((s && (s.Items || s.items)) || []);
    const detalles = [];
    for (const it of items.slice(0, 3)) {
      const id = it.Id || it.id || it.IdCliente || it.idCliente || null;
      let ficha = null;
      if (id) { try { ficha = await cbApi('GET', '/api/clientes/' + id); } catch (e) { ficha = { error: String(e.message).slice(0, 250) }; } }
      detalles.push({ id, resumen_de_la_busqueda: it, ficha_completa: ficha });
    }
    res.json({ ok: true, encontrados: items.length, detalles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DIAGNOSTICO SOLO LECTURA de una ORDEN DE VENTA de integracion (ML).
// Busca la orden por el nro de venta de ML (?nro=) o por su id interno (?id=) y
// devuelve la orden completa + un resumen de los campos clave (IDVentaIntegracion,
// IDIntegracion, cliente, items, si ya tiene comprobante). Solo GET: no modifica nada.
// Sirve para armar/verificar la reasignacion de cliente sin tocar la orden.
app.get('/api/cb-orden', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const nro = String(req.query.nro || req.query.orden || '').trim();
    const idint = String(req.query.idint || req.query.idIntegracion || '').trim();
    const id = String(req.query.id || '').trim();
    const desde = String(req.query.desde || req.query.fechaDesde || '').trim();
    const hasta = String(req.query.hasta || req.query.fechaHasta || '').trim();
    if (!nro && !id) return res.status(400).json({ error: 'pasame ?nro= (nro de venta de ML) o ?id= (id interno de la orden). Opcional ?idint= y ?desde=&hasta=' });
    let resumen = null, orden = null;
    if (id) {
      orden = await _cbOrdenDetalle(id);
    } else {
      resumen = await _cbBuscarOrden(nro, idint, { fechaDesde: desde || undefined, fechaHasta: hasta || undefined });
      const oid = resumen && (resumen.Id || resumen.id);
      if (oid) orden = await _cbOrdenDetalle(oid);
    }
    const b = (orden && !orden.error) ? orden : resumen;
    const clave = b ? {
      Id: b.Id || b.id,
      NumeroOrden: b.NumeroOrden || b.numeroOrden,
      IDVentaIntegracion: b.IDVentaIntegracion || b.idVentaIntegracion,
      IDIntegracion: b.IDIntegracion || b.idIntegracion,
      Integracion: b.Integracion || b.integracion,
      IDPack: b.IDPack || b.idPack,
      IDComprobante: b.IDComprobante || b.idComprobante || 0,
      cliente: b.IDPersona || b.idPersona || b.IdCliente || b.idCliente || (b.Cliente && (b.Cliente.Id || b.Cliente.id)),
      estado: b.Estado || b.estado || b.IDEstadoIntegracion,
      total: b.Total || b.total,
      items_n: Array.isArray(b.Items || b.items) ? (b.Items || b.items).length : null
    } : null;
    res.json({ ok: true, nota: 'solo lectura (GET): no modifica nada', encontrada: !!b, clave, resumen, orden });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Valida el digito verificador de un CUIT. Es barato y evita escribir un numero
// mal leido de un mensaje o de una foto en un dato fiscal.
function cuitValido(cuit) {
  const d = String(cuit || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(d[i]) * pesos[i];
  let ver = 11 - (suma % 11);
  if (ver === 11) ver = 0; else if (ver === 10) ver = 9;
  return ver === Number(d[10]);
}

// LA VENTA PRIMERO (idea de Agustin, y es la correcta): la venta de Contabilium
// apunta directo a su cliente, asi que buscamos el comprobante por el numero de
// venta de ML y sacamos el cliente de ahi. No sabemos como se llama la ruta del
// modulo de ventas en la API, asi que probamos las posibles UNA vez y nos
// acordamos cual respondio (o que ninguna existe).
// ORDENES DE VENTA DE INTEGRACION (Mercado Libre) EN CONTABILIUM.
// La API tiene un modulo propio para las ordenes que llegan desde integraciones:
//   GET /api/ordenesVenta/search?IDIntegracion=&filtro=   -> lista (resumen)
//   GET /api/ordenesVenta/?id=<id interno>                 -> detalle con items
// (Antes sondeabamos /api/ventas, /api/comprobantes, etc. que dan 404: el modulo
//  real es /api/ordenesVenta, confirmado en la doc oficial de Contabilium.)
// La orden apunta directo a SU cliente (IDPersona), asi que es la fuente mas
// confiable para saber a quien se le va a facturar la venta de ML. Solo hace GET.
async function _cbBuscarOrden(ordenNro, idIntegracion, opts) {
  if (!ordenNro) return null;
  const nro = String(ordenNro);
  opts = opts || {};
  const idInt = idIntegracion || opts.idIntegracion || null;
  // OJO (probado en produccion): /api/ordenesVenta/search EXIGE fechaDesde, y el
  // parametro "filtro" NO matchea por numero de orden (devuelve 0 aunque exista).
  // Por eso listamos las ordenes de la integracion por rango de fechas y matcheamos
  // el numero en codigo, paginando.
  const iso = d => d.toISOString().slice(0, 10);
  const hasta = opts.fechaHasta || iso(new Date());
  let desde = opts.fechaDesde;
  if (!desde) { const d = new Date(); d.setDate(d.getDate() - 120); desde = iso(d); }
  const matchNro = x => [x.NumeroOrden, x.numeroOrden, x.IDVentaIntegracion, x.idVentaIntegracion, x.IDPack, x.idPack]
    .map(v => String(v || '')).includes(nro);
  const PAGE = 50;
  for (let page = 1; page <= 15; page++) {
    let s;
    try {
      const qs = ['fechaDesde=' + desde, 'fechaHasta=' + hasta, 'page=' + page, 'pageSize=' + PAGE];
      if (idInt) qs.push('IDIntegracion=' + encodeURIComponent(idInt));
      s = await cbApi('GET', '/api/ordenesVenta/search?' + qs.join('&'));
    } catch (e) { break; }
    const items = Array.isArray(s) ? s : ((s && (s.Items || s.items)) || []);
    if (!items.length) break;
    const it = items.find(matchNro);
    if (it) return it;
    const total = Number(s && (s.TotalItems || s.totalItems)) || 0;
    if (total && page * PAGE >= total) break;
    await new Promise(r => setTimeout(r, 300)); // respetar el rate limit de Contabilium
  }
  return null;
}

// Detalle completo de una orden (incluye los items). Solo GET.
async function _cbOrdenDetalle(id) {
  if (!id) return null;
  try { return await cbApi('GET', '/api/ordenesVenta/?id=' + encodeURIComponent(id)); }
  catch (e) { return null; }
}

// Saca el id del cliente al que apunta una orden de venta de ML.
async function _cbClientePorVenta(ordenId, idIntegracion) {
  const o = await _cbBuscarOrden(ordenId, idIntegracion);
  if (!o) return null;
  const cid = o.IDPersona || o.idPersona || o.IdCliente || o.idCliente
    || (o.Cliente && (o.Cliente.Id || o.Cliente.id))
    || (o.cliente && (o.cliente.Id || o.cliente.id)) || null;
  return cid ? { clienteId: cid, ruta: '/api/ordenesVenta/search', orden: o } : null;
}

// Carga el CUIT del mensaje en el cliente de la venta + padron ARCA.
// Lo usan el boton manual y el modo automatico del sync.
async function cbCargarCuitVenta(cuenta, conv, categoria) {
    // Antes de tocar nada: que el CUIT sea un CUIT. Si lo leimos mal de un
    // mensaje o de una foto, mejor frenar aca que escribir el dato de otra persona.
    if (!cuitValido(conv.fact_cuit_msg)) {
      throw new Error('El CUIT "' + conv.fact_cuit_msg + '" no es valido (no cierra el digito verificador o no tiene 11 digitos). '
        + 'Reviselo con el comprador antes de cargarlo: no lo escribo por las dudas.');
    }
    // el token primero, a cara descubierta: si faltan credenciales, que se vea
    await cbToken();
    // el NOMBRE REAL del comprador (asi figura como razon social en Contabilium)
    let nombreReal = '';
    // Ademas del nombre, juntamos TODOS los documentos que ML conoce del
    // comprador. Ojo: el que viene en billing_info suele ser distinto del que
    // figura como identificacion del comprador, y Contabilium crea el cliente
    // con este ultimo. Buscando por uno solo, no lo encontrabamos.
    const docsConocidos = new Set();
    const sumarDoc = v => { const d = String(v || '').replace(/\D/g, ''); if (d.length >= 7) docsConocidos.add(d); };
    sumarDoc(conv.fact_doc_nro);
    try {
      const ord = await mlGet(`/orders/${conv.orden_id}`, cuenta);
      nombreReal = [ord?.buyer?.first_name, ord?.buyer?.last_name].filter(Boolean).join(' ').trim();
      sumarDoc(ord?.buyer?.identification?.number);
      sumarDoc(ord?.buyer?.billing_info?.doc_number);
      sumarDoc(ord?.buyer?.billing_info?.identification?.number);
      for (const p of (ord?.payments || [])) sumarDoc(p?.payer?.identification?.number);
    } catch (e) {}
    // buscar el cliente: 1) por nro de venta (el email de ML lo incluye)
    // 2) por el documento cargado en la venta 3) por el nombre real
    let cli = null, motivoMatch = null;
    const intentosLog = [];
    const candidatos = [];
    const soloDig = s => String(s || '').replace(/\D/g, '');
    const cuitPedido = soloDig(conv.fact_cuit_msg);
    // Nombre normalizado: sin acentos, sin orden. Asi "ZAPATA DARIO IGNACIO"
    // y "Dario Ignacio Zapata" se reconocen como la misma persona.
    const normNombre = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
    const nombreBuscado = normNombre(nombreReal);

    // CAMINO 1 — POR LA VENTA: el comprobante de Contabilium apunta directo a
    // su cliente. Si esto anda, no hay nada que adivinar. Probamos por numero
    // de venta y tambien por numero de carrito (los packs de ML facturan con
    // el numero de carrito y el de venta segun el caso).
    try {
      const numerosVenta = [...new Set([conv.orden_id, conv.pack_id].filter(Boolean).map(String))];
      for (const nro of numerosVenta) {
        const porVenta = await _cbClientePorVenta(nro);
        if (!porVenta) continue;
        const f = await cbApi('GET', '/api/clientes/' + porVenta.clienteId);
        if (f && (f.Id || f.id)) {
          cli = f;
          motivoMatch = 'la venta ' + nro + ' en Contabilium apunta a este cliente';
          break;
        }
      }
    } catch (e) {}

    // CAMINO 2 — BUSQUEDAS: por numero de venta, por el CUIT que estamos
    // cargando (si una corrida anterior ya lo puso, esta es la UNICA busqueda
    // que lo encuentra), por los documentos que ML conoce, y por el nombre.
    const filtros = [String(conv.orden_id || ''), cuitPedido, ...docsConocidos, nombreReal].filter(Boolean);
    if (!cli) for (const filtro of filtros) {
      try {
        const s = await cbApi('GET', `/api/clientes/search?filtro=${encodeURIComponent(filtro)}&page=1&pageSize=50`);
        const items = Array.isArray(s) ? s : ((s && (s.Items || s.items)) || []);
        intentosLog.push(`"${filtro}": ${items.length} resultados`);
        for (const it of items) {
          const id = it.Id || it.id;
          if (id && !candidatos.some(c => String(c.Id || c.id) === String(id))) candidatos.push(it);
        }
        // SOLO aceptamos coincidencias FUERTES. Elegir "el primero que aparezca"
        // es la forma mas facil de escribirle el CUIT al cliente equivocado.
        const nrosVenta = [conv.orden_id, conv.pack_id].filter(Boolean).map(String);
        const porEmail = nrosVenta.length && items.find(x => { const e = String(x.Email || x.email || ''); return nrosVenta.some(n => e.includes(n)); });
        if (porEmail) { cli = porEmail; motivoMatch = 'el email del cliente tiene el nro de esta venta'; break; }
        const porDoc = items.find(x => docsConocidos.has(soloDig(x.NroDoc || x.nroDoc)));
        if (porDoc) { cli = porDoc; motivoMatch = 'el documento del cliente (' + (porDoc.NroDoc || porDoc.nroDoc) + ') es uno de los que ML tiene del comprador'; break; }
        const porCuit = cuitPedido && items.find(x => soloDig(x.NroDoc || x.nroDoc) === cuitPedido);
        if (porCuit) { cli = porCuit; motivoMatch = 'el cliente ya tiene cargado ese CUIT'; break; }
      } catch (e) {
        intentosLog.push(`"${filtro}": ERROR ${e.message.slice(0, 180)}`);
      }
    }
    // Ultimo recurso, y solo si es INEQUIVOCO: el nombre completo coincide exacto
    // con el del comprador de ML y hay UN SOLO candidato con ese nombre.
    if (!cli && nombreBuscado && nombreBuscado.split(' ').length >= 2) {
      // ML suele traer menos partes del nombre que Contabilium ("Dario Zapata"
      // vs "DARIO IGNACIO ZAPATA"), asi que pedimos que esten TODAS las del
      // comprador, no que sean identicos. Y descartamos razones sociales de
      // empresa: un "ZAPATA HERMANOS SRL" no es la persona que compro.
      const esEmpresa = s => /(\bS\.?\s?R\.?\s?L\b|\bS\.?\s?A\.?\s?S?\b|\bSOC\b|\bSOCIEDAD\b|\bS\.?\s?H\b|\bCOOP|\bLTDA\b)/i.test(String(s || ''));
      const tokensML = nombreBuscado.split(' ').filter(Boolean);
      const porNombre = candidatos.filter(x => {
        const bruto = x.RazonSocial || x.razonSocial || '';
        if (!bruto || esEmpresa(bruto)) return false;
        const suyos = new Set(normNombre(bruto).split(' ').filter(Boolean));
        return tokensML.every(t => suyos.has(t));
      });
      if (porNombre.length === 1) {
        cli = porNombre[0];
        motivoMatch = 'el nombre del cliente ("' + (porNombre[0].RazonSocial || porNombre[0].razonSocial)
          + '") contiene el del comprador de ML ("' + nombreReal + '") y es el unico asi';
      }
    }
    if (!cli) {
      const lista = candidatos.slice(0, 8)
        .map(x => '#' + (x.Id || x.id) + ' ' + (x.RazonSocial || x.razonSocial || 'sin nombre') + ' (doc ' + (x.NroDoc || x.nroDoc || 's/d') + ')')
        .join(' | ');
      throw new Error('No pude identificar CON SEGURIDAD cual es el cliente de esta venta en Contabilium, asi que no toque nada. '
        + 'Documentos que ML tiene del comprador: ' + ([...docsConocidos].join(', ') || 'ninguno')
        + '. Nombre del comprador: "' + (nombreReal || 's/d') + '". '
        + 'Busquedas hechas: ' + intentosLog.join(' ; ')
        + (lista ? '. Aparecieron estos candidatos, pero ninguno coincide por nro de venta ni por documento: ' + lista : '')
        + '. Cargalo a mano eligiendo vos el cliente correcto.');
    }
    // El id del cliente: sin el, no hay forma de actualizarlo (ver el PUT de abajo).
    const cliId = cli.Id || cli.id || cli.IdCliente || cli.idCliente || null;
    if (!cliId) throw new Error('El cliente encontrado no trae id. Campos que devolvio Contabilium: ' + Object.keys(cli).join(', '));
    // QUE OBJETO LE MANDAMOS AL PUT.
    // El resumen que devuelve /clientes/search es el que Contabilium acepta.
    // La ficha completa de /clientes/{id} trae campos que el PUT rechaza con un
    // 400 de cuerpo vacio, asi que va SOLO como plan B si el primero falla.
    let ficha = cli;
    let fichaCompleta = null;
    try {
      const full = await cbApi('GET', '/api/clientes/' + cliId);
      if (full && (full.Id || full.id)) fichaCompleta = full;
    } catch (e) { /* si no se puede leer, seguimos con el resumen nomas */ }

    // El PRIMER intento de PUT va siempre con un cuerpo chico de claves
    // conocidas (el PUT es un merge: lo que no mandas queda como esta). Esto
    // importa sobre todo cuando el cliente vino del camino de la venta, donde
    // "cli" es la ficha completa: mandarla entera de entrada es la forma que
    // historicamente devolvio 400.
    {
      const CLAVES_BASE = ['Id', 'id', 'RazonSocial', 'razonSocial', 'Nombre', 'nombre',
        'NroDoc', 'nroDoc', 'TipoDoc', 'tipoDoc', 'CondicionIva', 'condicionIva', 'Email', 'email'];
      const chico = {};
      for (const k of CLAVES_BASE) if (k in ficha) chico[k] = ficha[k];
      if (chico.Id || chico.id) ficha = chico;
    }

    // Foto del cliente ANTES de tocarlo. Es la referencia honesta para despues
    // saber si algo cambio: comparar contra el cuerpo que mandamos da falsos
    // positivos, porque el resumen no trae todos los campos.
    const base0 = fichaCompleta || cli;
    const previo = {
      razon: String(base0.RazonSocial || base0.razonSocial || ''),
      iva: String((base0.CondicionIva !== undefined ? base0.CondicionIva : base0.condicionIva) || '')
    };

    const antes = ficha.NroDoc || ficha.nroDoc || '';
    const cuitNuevo = String(conv.fact_cuit_msg).replace(/\D/g, '');
    const docActual = String(antes).replace(/\D/g, '');
    // IDEMPOTENCIA: si el cliente YA tiene ese CUIT (porque lo cargamos antes),
    // no se lo volvemos a mandar. Contabilium valida que el CUIT sea unico y NO
    // se excluye a si mismo: reenviarle el mismo numero devuelve
    // 400 "El CUIT ingresado ya se encuentra registrado".
    const yaLoTenia = !!cuitNuevo && docActual === cuitNuevo;

    // CHEQUEO PREVIO ANTIDUPLICADO. Contabilium NO permite el mismo CUIT en dos
    // clientes. Si el CUIT pedido ya pertenece a OTRO cliente, hay casos en que
    // Contabilium NO tira el error "ya se encuentra registrado" sino que acepta el
    // PUT y deja el numero de documento VACIO, corrompiendo la ficha del cliente de
    // la venta (visto en produccion). Por eso, ANTES de tocar nada, buscamos si ese
    // CUIT ya tiene dueno. Si lo tiene, cortamos sin ningun PUT (no se corrompe nada)
    // y le decimos al operador a que cliente facturar.
    if (!yaLoTenia && /^\d{11}$/.test(cuitNuevo)) {
      let duenio = null;
      try {
        const s = await cbApi('GET', `/api/clientes/search?filtro=${encodeURIComponent(cuitNuevo)}&page=1&pageSize=10`);
        const its = Array.isArray(s) ? s : ((s && (s.Items || s.items)) || []);
        duenio = its.find(x => String(x.NroDoc || x.nroDoc || '').replace(/\D/g, '') === cuitNuevo
          && String(x.Id || x.id) !== String(cliId)) || null;
      } catch (e) { /* si la busqueda falla, seguimos con el flujo normal */ }
      if (duenio) {
        const dId = duenio.Id || duenio.id;
        const dNom = duenio.RazonSocial || duenio.razonSocial || 'sin nombre';
        throw new Error('El CUIT ' + conv.fact_cuit_msg + ' ya pertenece a OTRO cliente de Contabilium: "'
          + dNom + '" (id ' + dId + '). Contabilium no permite el mismo CUIT en dos clientes, asi que NO lo puedo '
          + 'poner en el cliente que creo Mercado Libre para esta venta (id ' + cliId + '). '
          + 'Para emitir la Factura A: en Contabilium factura esta venta directamente al cliente "' + dNom + '" (id ' + dId + ').');
      }
    }

    // EL TIPO DE DOCUMENTO NO ES UN DETALLE.
    // Si el cliente queda con TipoDoc = DNI, Contabilium recorta el numero a 8
    // digitos: un CUIT de 11 se guarda mutilado (27295540023 -> 27295540) y
    // ademas no aparece el boton ARCA. SIEMPRE hay que pasarlo a CUIT, no solo
    // cuando la ficha ya traia esa clave.
    // Algunos sistemas usan el codigo de AFIP (80 = CUIT, 96 = DNI) en vez del
    // texto. Deducimos cual usa este mirando que forma tiene el valor actual.
    const tipoActual = (ficha.TipoDoc !== undefined) ? ficha.TipoDoc : ficha.tipoDoc;
    const usaCodigos = tipoActual !== undefined && tipoActual !== null
      && /^\d+$/.test(String(tipoActual).trim());
    const valorCuit = usaCodigos ? 80 : 'CUIT';
    const tipoYaEsCuit = /CUIT/i.test(String(tipoActual || '')) || String(tipoActual || '').trim() === '80';
    if (!yaLoTenia) ficha.NroDoc = String(conv.fact_cuit_msg);
    // se manda siempre: aunque el numero ya estuviera bien, el tipo puede estar mal
    if ('tipoDoc' in ficha && !('TipoDoc' in ficha)) ficha.tipoDoc = valorCuit;
    else ficha.TipoDoc = valorCuit;
    // el "boton ARCA" automatico: padron -> razon social + categoria
    let padron = null;
    const padronLog = [];
    try { padron = await arcaPadron(String(conv.fact_cuit_msg), padronLog); }
    catch (e) { padronLog.push({ error: String(e && e.message || e).slice(0, 160) }); }
    // Todos los datos del padron, cada uno en la clave que la ficha ya usa.
    const aplicarPadron = obj => {
      if (!padron) return;
      _ponerCampo(obj, ['RazonSocial', 'razonSocial', 'Nombre', 'nombre'], padron.razon);
      _ponerCampo(obj, ['Domicilio', 'domicilio', 'Direccion', 'direccion'], padron.domicilio);
      _ponerCampo(obj, ['CodigoPostal', 'codigoPostal', 'CP', 'cp'], padron.cp);
      _ponerCampo(obj, ['ProvinciaId', 'provinciaId', 'IdProvincia'], padron.provincia_id);
      _ponerCampo(obj, ['CiudadId', 'ciudadId', 'IdCiudad'], padron.ciudad_id);
      _ponerCampo(obj, ['ProvinciaNombre', 'provinciaNombre', 'Provincia', 'provincia'], padron.provincia);
      _ponerCampo(obj, ['CiudadNombre', 'ciudadNombre', 'Ciudad', 'ciudad', 'Localidad', 'localidad'], padron.ciudad);
    };
    aplicarPadron(ficha);
    const cat = (padron && padron.cat) || (categoria ? String(categoria).toUpperCase() : null);
    // Si el padron vino de Contabilium, usamos SU codigo tal cual (MO/RI/CF...).
    // Si no, traducimos lo que tengamos a los codigos que su sistema entiende.
    const catCodigo = (padron && padron.cat_codigo) || (cat === 'MT' ? 'MO' : (cat === 'RI' ? 'RI' : null));
    _ponerCategoria(ficha, catCodigo);

    // Si el CUIT ya estaba, el tipo YA dice CUIT y ARCA no trajo nada, no hay
    // literalmente nada que escribir: no molestamos a la API (y de paso evitamos
    // el 400 por duplicado). Si el tipo esta mal, hay que escribir igual.
    if (yaLoTenia && tipoYaEsCuit && !padron && !cat) {
      return {
        ok: true, sin_cambios: true, cliente_id: cliId, motivo_match: motivoMatch, verificado: true,
        cliente: ficha.RazonSocial || ficha.razonSocial || '',
        antes, ahora: String(conv.fact_cuit_msg),
        razon_social: null, categoria: null, padron: false, padron_detalle: padronLog
      };
    }
    // OJO CON LA RUTA: la API de Contabilium acepta POST en /api/clientes (que CREA
    // uno nuevo) y PUT en /api/clientes/{id} (que actualiza). Un PUT a /api/clientes
    // sin el id contesta 405, y un POST te crearia un cliente duplicado.
    // Probamos en cascada, del cuerpo mas conservador al mas completo, y nos
    // quedamos con el primero que Contabilium acepte.
    const intentos = [{ como: 'resumen de la busqueda', cuerpo: ficha }];
    if (yaLoTenia) {
      // el cliente ya tiene ese CUIT: puede que la API se queje solo porque el
      // numero viene en el cuerpo, aunque no lo estemos cambiando. Lo sacamos.
      const sinDoc = Object.assign({}, ficha);
      delete sinDoc.NroDoc; delete sinDoc.nroDoc;
      delete sinDoc.TipoDoc; delete sinDoc.tipoDoc;
      intentos.push({ como: 'sin el documento (el cliente ya lo tenia)', cuerpo: sinDoc });
    }
    if (fichaCompleta) {
      const fc = Object.assign({}, fichaCompleta);
      if (!yaLoTenia) { fc.NroDoc = String(conv.fact_cuit_msg); fc.TipoDoc = valorCuit; }
      aplicarPadron(fc);
      _ponerCategoria(fc, catCodigo);
      intentos.push({ como: 'ficha completa', cuerpo: fc });
    }

    let formaQueAnduvo = null;
    const errores = [];
    for (const it of intentos) {
      try {
        await cbApi('PUT', '/api/clientes/' + cliId, it.cuerpo);
        ficha = it.cuerpo; formaQueAnduvo = it.como; break;
      } catch (ePut) {
        errores.push(it.como + ' -> ' + ePut.message);
        // CUIT DE OTRO CLIENTE: Contabilium no deja repetir el CUIT. Aca no sirve
        // reintentar de otra forma; hay que facturarle al cliente que ya lo tiene.
        if (/ya se encuentra registrado/i.test(ePut.message) && !yaLoTenia) {
          let duenio = null;
          try {
            const s2 = await cbApi('GET', `/api/clientes/search?filtro=${encodeURIComponent(cuitNuevo)}&page=1&pageSize=10`);
            const its = Array.isArray(s2) ? s2 : ((s2 && (s2.Items || s2.items)) || []);
            duenio = its.find(x => String(x.NroDoc || x.nroDoc || '').replace(/\D/g, '') === cuitNuevo) || null;
          } catch (e) {}
          if (duenio && String(duenio.Id || duenio.id) !== String(cliId)) {
            throw new Error('El CUIT ' + conv.fact_cuit_msg + ' ya esta registrado en OTRO cliente de Contabilium: "'
              + (duenio.RazonSocial || duenio.razonSocial || 'sin nombre') + '" (id ' + (duenio.Id || duenio.id) + '). '
              + 'Contabilium no permite el mismo CUIT en dos clientes, asi que no lo puedo mover. '
              + 'Para facturar esta venta, en Contabilium elegi ese cliente en vez del que creo Mercado Libre.');
          }
        }
      }
    }
    if (!formaQueAnduvo) {
      throw new Error('Contabilium no acepto el cambio de ninguna forma:\n'
        + errores.map((x, i) => (i + 1) + ') ' + x).join('\n'));
    }
    // VERIFICACION. Releemos el cliente y confirmamos DOS cosas: que el numero
    // quedo completo y que el tipo de documento quedo en CUIT. Lo segundo es
    // clave: con el tipo en DNI, Contabilium recorta el CUIT a 8 digitos y la
    // factura sale con un numero mutilado.
    // El resumen de la busqueda a veces no alcanza para cambiar el NOMBRE
    // (Contabilium ignora las claves que no reconoce). Si el padron trajo razon
    // social y no quedo aplicada, reintentamos con la ficha completa.
    // LA RAZON SOCIAL ES LA MAS DURA DE CAMBIAR: vimos clientes donde el PUT
    // aplica CUIT, categoria y domicilio pero deja el NOMBRE viejo. La causa mas
    // probable es que para personas fisicas la API espere el nombre en otra
    // clave. Cascada de formas, releyendo el cliente despues de cada una, y nos
    // quedamos con la primera que efectivamente lo cambie.
    const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const intentoCompleto = intentos.find(x => x.como === 'ficha completa');
    let nombreQuedo = null;
    if (padron && (padron.razon || padron.domicilio)) {
      const leer = async () => { try { return await cbApi('GET', '/api/clientes/' + cliId); } catch (e) { return null; } };
      const nombreOk = d => !padron.razon || norm(d && (d.RazonSocial || d.razonSocial || d.Nombre || d.nombre)) === norm(padron.razon);
      const domOk = d => !padron.domicilio || norm(d && (d.Domicilio || d.domicilio)) === norm(padron.domicilio);

      const base = intentoCompleto ? JSON.parse(JSON.stringify(intentoCompleto.cuerpo)) : JSON.parse(JSON.stringify(ficha));
      // forma 2: el nombre en TODAS las claves posibles, existan o no en la ficha
      const conTodasLasClaves = Object.assign({}, base);
      if (padron.razon) for (const k of ['RazonSocial', 'razonSocial', 'Nombre', 'nombre']) conTodasLasClaves[k] = padron.razon;
      // forma 3: cuerpo minimo (el PUT es un merge: lo que no mandas queda como esta).
      // SOLO si el padron trajo nombre: jamas mandar RazonSocial en null.
      const formas = [
        ['ficha completa', base],
        ['nombre en todas las claves', conTodasLasClaves]
      ];
      if (padron.razon) {
        formas.push(['cuerpo minimo solo nombre+doc',
          { Id: cliId, id: cliId, RazonSocial: padron.razon, Nombre: padron.razon, NroDoc: String(conv.fact_cuit_msg), TipoDoc: valorCuit }]);
      }
      for (const [como, cuerpo] of formas) {
        let d = await leer();
        if (d && nombreOk(d) && domOk(d)) { nombreQuedo = true; break; }   // ya esta bien: no tocar mas
        if (!padron.razon && d && domOk(d)) { nombreQuedo = null; break; }
        try {
          await cbApi('PUT', '/api/clientes/' + cliId, cuerpo);
          ficha = cuerpo;
          if (formaQueAnduvo.indexOf(como) < 0) formaQueAnduvo += ' (+ ' + como + ')';
        } catch (e) { continue; }
      }
      const fin = await leer();
      nombreQuedo = fin ? nombreOk(fin) : null;
    }

    let verificado = null, tipoFinal = null, nroFinal = null, contabilium_completo = null, razon_ok = null;
    try {
      const despues = await cbApi('GET', '/api/clientes/' + cliId);
      if (padron && padron.razon) {
        const rz = String((despues && (despues.RazonSocial || despues.razonSocial)) || '').trim().toUpperCase();
        razon_ok = rz === String(padron.razon).trim().toUpperCase();
      }
      nroFinal = String((despues && (despues.NroDoc || despues.nroDoc)) || '').replace(/\D/g, '');
      tipoFinal = (despues && (despues.TipoDoc !== undefined ? despues.TipoDoc : despues.tipoDoc));
      const nroOk = nroFinal === cuitNuevo;
      const tipoOk = /CUIT/i.test(String(tipoFinal || '')) || String(tipoFinal || '').trim() === '80';
      verificado = nroOk && tipoOk;
      // De paso, sin esperar nada: si AFIP no nos contesto pero la razon social o
      // la categoria cambiaron igual, quiere decir que las completo Contabilium.
      if (!padron) {
        const razonLuego = String((despues && (despues.RazonSocial || despues.razonSocial)) || '');
        const ivaLuego = String((despues && (despues.CondicionIva !== undefined ? despues.CondicionIva : despues.condicionIva)) || '');
        contabilium_completo = (razonLuego !== previo.razon || ivaLuego !== previo.iva)
          ? { razon: razonLuego, iva: ivaLuego } : false;
      }
    } catch (e) { /* si no se puede releer, queda en null: lo avisamos igual */ }
    if (verificado === false) {
      throw new Error('Contabilium acepto el cambio pero al releer el cliente ' + cliId + ' quedo mal: '
        + 'documento "' + nroFinal + '" (esperaba "' + cuitNuevo + '") y tipo "' + tipoFinal + '" (esperaba CUIT). '
        + (nroFinal && nroFinal.length === 8
            ? 'El numero quedo recortado a 8 digitos: eso pasa cuando el tipo quedo en DNI. '
            : '')
        + 'NO factures esta venta hasta corregirlo a mano en Contabilium.');
    }
    return {
      ok: true, cliente_id: cliId, motivo_match: motivoMatch,
      verificado, razon_ok, tipo_doc: tipoFinal, nro_doc: nroFinal, forma: formaQueAnduvo,
      // si el nombre no entro de ninguna forma, mostramos las claves reales de la
      // ficha: ahi se ve en que campo guarda el nombre este cliente, sin adivinar.
      claves_ficha: (razon_ok === false && fichaCompleta) ? Object.keys(fichaCompleta) : undefined,
      domicilio_padron: padron ? [padron.domicilio, padron.ciudad, padron.provincia].filter(Boolean).join(', ') : null,
      contabilium_completo,
      cliente: ficha.RazonSocial || ficha.razonSocial || '', antes, ahora: String(conv.fact_cuit_msg),
      razon_social: (padron && padron.razon) || null,
      categoria: (cat === 'MT' ? 'Monotributista' : (cat === 'RI' ? 'Responsable Inscripto' : null))
        || (catCodigo ? ('código ' + catCodigo) : null),
      categoria_codigo: catCodigo || null,
      padron: !!padron,
      // si el padron no vino, aca queda el detalle de que contesto cada servidor
      padron_detalle: padron ? null : padronLog
    };
}
// Marca que el padron YA se aplico en esta venta. Va en su propio try porque si
// la columna cb_padron_at todavia no existe en la base, no queremos romper el
// flujo principal: el CUIT ya se cargo igual.
async function _marcarPadronHecho(convId) {
  try { await db.from('pq_conversaciones').update({ cb_padron_at: new Date().toISOString() }).eq('id', convId); }
  catch (e) {}
}

// REINTENTO DEL PADRON DE ARCA
// Cuando ARCA se cae, el CUIT igual queda cargado en Contabilium pero la razon
// social y la categoria impositiva quedan sin completar. Este trabajo las vuelve
// a pedir cada 20 minutos durante las 48hs siguientes, hasta que ARCA conteste.
// Es idempotente: volver a llamar a cbCargarCuitVenta reescribe el mismo CUIT.
let _padronJob = { corriendo: false, ultimo: null, pendientes: 0, resueltos: 0, error: null, falta_columna: false };
async function reintentarPadronPendiente() {
  if (_padronJob.corriendo) return;
  _padronJob.corriendo = true;
  try {
    const { data: cuentas } = await db.from('pq_cuentas').select('*').eq('activa', true);
    let pendientes = 0;
    for (const cuenta of (cuentas || [])) {
      const desde = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const { data, error } = await db.from('pq_conversaciones')
        .select('id, orden_id, pack_id, fact_cuit_msg, fact_doc_nro, cb_cuit_at')
        .eq('cuenta_id', cuenta.id)
        .not('cb_cuit_at', 'is', null)
        .is('cb_padron_at', null)
        .gte('cb_cuit_at', desde)
        .limit(10);
      if (error) {
        // tipico: la columna todavia no fue creada en Supabase
        _padronJob.falta_columna = true;
        _padronJob.error = 'No puedo leer cb_padron_at: ' + String(error.message).slice(0, 140)
          + ' -> corre en Supabase: alter table pq_conversaciones add column if not exists cb_padron_at timestamptz;';
        continue;
      }
      _padronJob.falta_columna = false;
      pendientes += (data || []).length;
      for (const conv of (data || [])) {
        // sin CUIT no hay nada que consultar: la damos por cerrada
        if (!conv.fact_cuit_msg) { await _marcarPadronHecho(conv.id); continue; }
        try {
          const r = await cbCargarCuitVenta(cuenta, conv, null);
          if (r && r.padron && r.razon_ok !== false) { await _marcarPadronHecho(conv.id); _padronJob.resueltos++; }
        } catch (e) { /* esta venta fallo, seguimos con las otras */ }
        await new Promise(r => setTimeout(r, 800));
      }
    }
    _padronJob.pendientes = pendientes;
    _padronJob.ultimo = new Date().toISOString();
    if (!_padronJob.falta_columna) _padronJob.error = null;
  } catch (e) { _padronJob.error = String(e.message).slice(0, 200); }
  finally { _padronJob.corriendo = false; }
}
setTimeout(reintentarPadronPendiente, 5 * 60 * 1000);
setInterval(reintentarPadronPendiente, 20 * 60 * 1000);

// Disparar el reintento a mano, sin esperar los 20 minutos
app.post('/api/pv/padron-reintentar', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  reintentarPadronPendiente();
  res.json({ ok: true, msg: 'reintento del padron arrancado, mira el avance en Ajustes' });
});

app.post('/api/pv/cb-cliente', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const { id, categoria } = req.body || {};
    const { data: conv } = await db.from('pq_conversaciones').select('*').eq('id', id).eq('cuenta_id', cuenta.id).single();
    if (!conv) return res.status(404).json({ error: 'conversacion no encontrada' });
    if (!conv.fact_cuit_msg) return res.status(400).json({ error: 'esta conversacion no tiene un CUIT detectado en los mensajes' });
    const r = await cbCargarCuitVenta(cuenta, conv, categoria);
    await db.from('pq_conversaciones').update({ cb_cuit_at: new Date().toISOString(), cb_cuit_err: null }).eq('id', conv.id);
    // Queda cerrado SOLO si el padron contesto Y el nombre realmente quedo
    // escrito. Si el nombre no entro, el reintento lo sigue peleando despues.
    if (r && r.padron && r.razon_ok !== false) await _marcarPadronHecho(conv.id);
    res.json(r);
  } catch (e) {
    // que el motivo SIEMPRE llegue al panel legible, y quede en el log de Railway
    console.error('cb-cliente ERROR:', e && e.stack || e);
    res.status(500).json({ error: String(e && e.message || e).slice(0, 500) });
  }
});

// ============================================================================
// REASIGNAR EL CLIENTE DE UNA ORDEN DE VENTA DE ML  (Factura A a un tercero)
// ----------------------------------------------------------------------------
// Caso: el comprador pide la factura a nombre de OTRO CUIT (por ej. el de su
// empresa). Cambiarle el CUIT a la ficha del comprador no sirve, y ademas
// Contabilium bloquea repetir un CUIT que ya es de otro cliente. La forma correcta
// segun la doc de Contabilium es REENVIAR la orden de venta de integracion con el
// MISMO IDVentaIntegracion + IDIntegracion pero con el objeto Cliente apuntando al
// CUIT destino: eso ACTUALIZA la orden (no crea otra) y la deja a nombre del cliente
// correcto, lista para facturar con emitirFE.
//   POST https://rest.contabilium.com/notificador/ecommerce
//
// SEGURIDAD:
//  - NO emite la factura. Solo reasigna el cliente. La emision a AFIP (emitirFE) es
//    un paso aparte, consecuente e irreversible, que queda a criterio del operador.
//  - Reenvia los MISMOS items de la orden (leidos del detalle) para no alterar el
//    contenido ni el importe, y despues verifica que el total no cambio.
//  - Si la orden YA tiene comprobante (IDComprobante != 0), NO toca nada.
//  - Pendiente de confirmacion de Contabilium (ticket api@contabilium.com) sobre el
//    comportamiento del reenvio en ordenes creadas por la integracion de ML. Por eso
//    queda detras de un endpoint MANUAL con confirmar:true, sin auto-run.
// ============================================================================
async function cbReasignarClienteOrden(cuenta, opts) {
  const { ordenNro, cuit, idIntegracion } = opts || {};
  if (!ordenNro) throw new Error('falta el numero de la orden de venta de ML');
  if (!cuitValido(cuit)) throw new Error('El CUIT "' + cuit + '" no es valido: no lo uso por las dudas.');
  await cbToken();
  const cuitLimpio = String(cuit).replace(/\D/g, '');

  // 1) ubicar la orden y su detalle (items, integracion, estado, comprobante)
  const resumen = await _cbBuscarOrden(ordenNro, idIntegracion);
  if (!resumen) throw new Error('No encontre la orden de venta ' + ordenNro + ' en Contabilium (Ventas - Integraciones).');
  const ordenId = resumen.Id || resumen.id;
  const detalle = (await _cbOrdenDetalle(ordenId)) || resumen;
  const idInt = idIntegracion || detalle.IDIntegracion || detalle.idIntegracion || resumen.IDIntegracion || resumen.idIntegracion;
  const idVentaInt = detalle.IDVentaIntegracion || detalle.idVentaIntegracion || detalle.NumeroOrden || detalle.numeroOrden || resumen.NumeroOrden || ordenNro;
  const idComprobante = detalle.IDComprobante || detalle.idComprobante || resumen.IDComprobante || 0;
  if (idComprobante && String(idComprobante) !== '0') {
    throw new Error('La orden ' + ordenNro + ' YA esta facturada (comprobante ' + idComprobante + '). No la toco: '
      + 'para cambiar el cliente de una factura emitida hay que anularla con nota de credito y rehacerla.');
  }
  if (!idInt) throw new Error('No pude determinar el IDIntegracion de la orden ' + ordenNro + '. Pasalo a mano como idIntegracion.');

  // 2) padron ARCA del CUIT destino -> razon social, categoria, domicilio
  const padronLog = [];
  let padron = null;
  try { padron = await arcaPadron(cuitLimpio, padronLog); } catch (e) { padronLog.push({ error: String(e && e.message || e).slice(0, 150) }); }

  // 3) armar los items TAL CUAL estan en la orden (no alterar importes)
  const itemsOrden = detalle.Items || detalle.items || resumen.Items || resumen.items || [];
  const items = (Array.isArray(itemsOrden) ? itemsOrden : []).map(x => ({
    Cantidad: Number(x.Cantidad || x.cantidad || 1),
    Codigo: String(x.Codigo || x.codigo || (x.Concepto && (x.Concepto.Codigo || x.Concepto.codigo)) || ''),
    Concepto: String((x.Concepto && (x.Concepto.Nombre || x.Concepto.nombre)) || x.Descripcion || x.descripcion || x.Detalle || x.detalle || (typeof x.Concepto === 'string' ? x.Concepto : '') || ''),
    PrecioUnitario: Number(x.PrecioUnitario || x.precioUnitario || x.Precio || x.precio || 0),
    Bonificacion: Number(x.Bonificacion || x.bonificacion || 0)
  })).filter(i => i.Cantidad > 0 && i.PrecioUnitario !== 0);
  if (!items.length) throw new Error('No pude leer los items de la orden ' + ordenNro + ' para reenviarla sin alterarla. Aborto por seguridad.');

  // 4) cliente destino: por documento (Contabilium lo resuelve/crea por el CUIT)
  const cli = {
    Nombre: (padron && padron.razon) ? String(padron.razon) : '',
    Apellido: '',
    TipoDocumento: 'CUIT',
    Documento: cuitLimpio,
    Email: '', Telefono: '',
    LineaDireccion1: (padron && padron.domicilio) ? String(padron.domicilio) : '',
    LineaDireccion2: '',
    Ciudad: (padron && padron.ciudad) ? String(padron.ciudad) : '',
    Provincia: (padron && padron.provincia) ? String(padron.provincia) : '',
    Pais: 'Argentina',
    CodigoPostal: (padron && padron.cp) ? String(padron.cp) : ''
  };

  // 5) reenviar la orden (MISMO IDVentaIntegracion + IDIntegracion => actualiza)
  const estado = detalle.IDEstadoIntegracion || detalle.Estado || detalle.estado || 'Aceptada';
  const cuerpo = {
    Cliente: cli,
    IDVentaIntegracion: Number(idVentaInt) || idVentaInt,
    IDEstadoIntegracion: estado,
    IDIntegracion: Number(idInt) || idInt,
    Observaciones: 'Reasignacion de cliente por pedido del comprador (RespondIA). Orden ' + ordenNro,
    Items: items
  };
  const antes = {
    cliente: resumen.IDPersona || resumen.idPersona || resumen.IdCliente || resumen.idCliente || (detalle.Cliente && (detalle.Cliente.Id || detalle.Cliente.id)) || null,
    total: detalle.Total || detalle.total || resumen.Total || null,
    items_n: items.length
  };
  const resp = await fetch('https://rest.contabilium.com/notificador/ecommerce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await cbToken()) },
    body: JSON.stringify(cuerpo)
  });
  const txt = await resp.text().catch(() => '');
  let out = null; try { out = txt ? JSON.parse(txt) : null; } catch (e) {}
  // la API devuelve -3 (IDIntegracion no existe / body vacio) o -1 (item invalido)
  if (String(out) === '-3' || String(out) === '-1' || (out && typeof out === 'object' && (out.Error || out.error))) {
    throw new Error('Contabilium rechazo el reenvio (respuesta: ' + String(txt || '').slice(0, 120) + '). No se modifico la orden.');
  }
  if (!resp.ok) throw new Error('Contabilium /notificador/ecommerce -> ' + resp.status + ' ' + String(txt || '').slice(0, 200));

  // 6) releer y verificar: mismo total, cliente cambiado
  await new Promise(r => setTimeout(r, 1500));
  const despues = await _cbBuscarOrden(ordenNro, idInt);
  const detDesp = despues ? ((await _cbOrdenDetalle(despues.Id || despues.id)) || despues) : null;
  const totalDesp = detDesp && (detDesp.Total || detDesp.total);
  const clienteDesp = detDesp && (detDesp.IDPersona || detDesp.idPersona || detDesp.IdCliente || detDesp.idCliente || (detDesp.Cliente && (detDesp.Cliente.Id || detDesp.Cliente.id)));
  return {
    ok: true, no_facturado: true,
    orden: ordenNro, id_interno: ordenId, idIntegracion: idInt,
    cuit_destino: cuitLimpio, razon_social: (padron && padron.razon) || null,
    padron: !!padron, padron_detalle: padron ? null : padronLog,
    antes,
    despues: { cliente: clienteDesp || null, total: totalDesp != null ? totalDesp : null, items_n: detDesp ? (detDesp.Items || detDesp.items || []).length : null },
    total_preservado: (antes.total != null && totalDesp != null) ? (Number(antes.total) === Number(totalDesp)) : null,
    cliente_cambio: (antes.cliente != null && clienteDesp != null) ? (String(antes.cliente) !== String(clienteDesp)) : null,
    respuesta_cb: out,
    aviso: 'Solo se reasigno el cliente. La factura NO se emitio. Para emitir la Factura A al nuevo CUIT: emitirFE cuando lo confirmes.'
  };
}

// Endpoint MANUAL. Reasigna el cliente de una orden REAL: exige confirmar:true.
// NO emite factura. Solo master/dueno.
app.post('/api/pv/cb-orden-cliente', soloPanel, requiereRol('master', 'dueno'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const { orden, cuit, idIntegracion, confirmar } = req.body || {};
    if (confirmar !== true) {
      return res.status(400).json({ error: 'Esto reasigna el cliente de una orden REAL en Contabilium. Volve a llamarlo con confirmar:true para ejecutarlo.', requiere_confirmar: true });
    }
    const r = await cbReasignarClienteOrden(cuenta, { ordenNro: orden, cuit, idIntegracion });
    res.json(r);
  } catch (e) {
    console.error('cb-orden-cliente ERROR:', e && e.stack || e);
    res.status(500).json({ error: String(e && e.message || e).slice(0, 500) });
  }
});

// AUDITORIA DE FACTURACION: que ventas se tocaron en Contabilium y cuales fallaron.
// Es SOLO LECTURA: no llama a Contabilium ni a ML, solo mira lo que quedo anotado
// en la base. cb_cuit_at se escribe UNICAMENTE despues de un PUT exitoso, asi que
// si la lista vuelve vacia es porque no se modifico ningun cliente.
app.get('/api/pv/cb-log', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const COLS = 'id, orden_id, comprador_nick, titulo, fact_doc_tipo, fact_doc_nro, fact_cuit_msg, cb_cuit_at, cb_cuit_err, actualizado_at';
  let filas = null;
  // camino rapido: que filtre la base
  try {
    const r = await db.from('pq_conversaciones').select(COLS).eq('cuenta_id', cuenta.id)
      .or('cb_cuit_at.not.is.null,cb_cuit_err.not.is.null')
      .order('cb_cuit_at', { ascending: false }).limit(300);
    if (!r.error && Array.isArray(r.data)) filas = r.data;
  } catch (e) {}
  // plan B por si la sintaxis del .or() no le gusta a esta version: filtramos aca
  if (!filas) {
    const { data } = await db.from('pq_conversaciones').select(COLS).eq('cuenta_id', cuenta.id)
      .order('actualizado_at', { ascending: false }).limit(2000);
    filas = (data || []).filter(f => f.cb_cuit_at || f.cb_cuit_err);
  }
  res.json({
    auto: configDe(cuenta).pv_auto_cuit === true,   // lo que dice la BASE, no el checkbox
    cargadas: filas.filter(f => f.cb_cuit_at).length,
    fallidas: filas.filter(f => !f.cb_cuit_at && f.cb_cuit_err).length,
    padron_job: _padronJob,
    filas
  });
});

// ---- biblioteca de archivos (manuales) ----
app.get('/api/pv/archivos', soloPanel, async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data } = await db.from('pq_archivos').select('*')
    .eq('cuenta_id', cuenta.id).order('creado_at', { ascending: false }).limit(200);
  res.json(data || []);
});

app.post('/api/pv/archivos', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  try {
    const cuenta = await resolverCuenta(req);
    if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
    const { nombre, sku_madre, base64, mime, ambito, patron, disparador } = req.body;
    if (!nombre || !base64) return res.status(400).json({ error: 'faltan datos' });
    const AMBITOS = ['global', 'sku', 'madre', 'prefijo', 'lista'];
    const amb = AMBITOS.includes(ambito) ? ambito : (sku_madre ? 'madre' : 'global');
    const pat = (patron || sku_madre || '').trim().toUpperCase() || null;
    if (amb !== 'global' && !pat) return res.status(400).json({ error: 'indica el SKU / familia / prefijo para ese ambito' });
    const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    // 25MB: es el tope de la mensajeria de ML para adjuntos. Subir algo mas
    // grande seria guardarlo para despues no poder mandarlo nunca.
    if (buf.length > 25 * 1024 * 1024) {
      return res.status(400).json({ error: 'archivo muy grande: ' + (buf.length / 1024 / 1024).toFixed(1)
        + 'MB. El maximo es 25MB porque es lo que acepta la mensajeria de Mercado Libre. Comprimi el PDF (ilovepdf.com/compress_pdf) y volve a subirlo.' });
    }
    const limpio = String(nombre).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const ruta = `${cuenta.id}/${Date.now()}_${limpio}`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/manuales/${ruta}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY, 'Content-Type': mime || 'application/pdf' },
      body: buf
    });
    if (!up.ok) return res.status(500).json({ error: 'no pude subir al bucket "manuales" (' + up.status + '). ¿Creaste el bucket en Supabase → Storage?' });
    const { data, error } = await db.from('pq_archivos').insert({
      cuenta_id: cuenta.id, sku_madre: amb === 'madre' ? pat : null,
      ambito: amb, patron: amb === 'global' ? null : pat,
      disparador: (disparador || '').trim().slice(0, 200) || null,
      nombre: limpio, ruta, mime: mime || 'application/pdf'
    }).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, archivo: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pv/archivos', soloPanel, requiereRol('master', 'dueno', 'gerente'), async (req, res) => {
  const cuenta = await resolverCuenta(req);
  if (!cuenta) return res.status(400).json({ error: 'sin cuenta' });
  const { data: arch } = await db.from('pq_archivos').select('*')
    .eq('id', req.query.id).eq('cuenta_id', cuenta.id).single();
  if (!arch) return res.status(404).json({ error: 'no encontrado' });
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/manuales/${arch.ruta}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + SUPABASE_KEY, apikey: SUPABASE_KEY }
    });
  } catch (e) {}
  await db.from('pq_archivos').delete().eq('id', arch.id);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('RespondIA backend v13.36 (facturacion ML: busqueda de orden por rango de fechas+match de numero; reasignar el cliente de la orden por API /notificador/ecommerce, sin emitir factura, endpoint manual /api/pv/cb-orden-cliente + diagnostico /api/cb-orden) OK. /oauth para autorizar una cuenta de ML.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('RespondIA backend v2 escuchando en ' + PORT));

// exports para testing local (no afecta a Railway)
if (typeof module !== 'undefined') {
  module.exports = { horaLocal, aMinutos, franjaActiva, minutosHastaProximaFranja, calcularEnvio, configDe, CONFIG_DEFAULT };
}

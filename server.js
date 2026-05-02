'use strict';

const express        = require('express');
const session        = require('express-session');
const bcrypt         = require('bcryptjs');
const { Pool }       = require('pg');
const pgSession      = require('connect-pg-simple')(session);
const path           = require('path');

const app  = express();
app.set('trust proxy', 1);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sessions stored in PostgreSQL so they survive restarts
app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'plandocente_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

// Serve the static HTML app
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.rol !== 'admin')
    return res.status(403).json({ error: 'Solo administradores.' });
  next();
}

// ── DB init ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id          SERIAL PRIMARY KEY,
      nombre      VARCHAR(200) NOT NULL,
      email       VARCHAR(200) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      rol         VARCHAR(20)  NOT NULL DEFAULT 'docente',
      estado      VARCHAR(20)  NOT NULL DEFAULT 'activo',
      fecha_alta  DATE         NOT NULL DEFAULT CURRENT_DATE
    )
  `);

  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plan_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plan_ilimitado BOOLEAN NOT NULL DEFAULT FALSE`);

  // Cuenta admin principal (admin@plandocenteia.com / Admin1234)
  const exists = await pool.query(
    "SELECT id FROM usuarios WHERE email = 'admin@plandocenteia.com'"
  );
  if (exists.rows.length === 0) {
    const hash = await bcrypt.hash('Admin1234', 10);
    await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ('Administradora', 'admin@plandocenteia.com', $1, 'admin')`,
      [hash]
    );
    console.log('✅ Cuenta admin creada: admin@plandocenteia.com / Admin1234');
  }
}

// ── API: sesión actual ────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const r = await pool.query(
      'SELECT id, nombre, email, rol, estado FROM usuarios WHERE id = $1',
      [req.session.userId]
    );
    if (r.rows.length === 0) { req.session.destroy(); return res.json({ user: null }); }
    const u = r.rows[0];
    if (u.estado === 'inactivo') { req.session.destroy(); return res.json({ user: null }); }
    res.json({ user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: login ────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Campos requeridos.' });
  try {
    const r = await pool.query(
      'SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [email.trim()]
    );
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

    const u = r.rows[0];
    if (u.estado === 'inactivo')
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contactá al administrador.' });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

    req.session.userId = u.id;
    req.session.rol    = u.rol;
    res.json({ user: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: logout ───────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── API: listar usuarios (admin) ──────────────────────────────────────────────
app.get('/api/usuarios', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, nombre, email, rol, estado, fecha_alta, plan_count, plan_ilimitado FROM usuarios ORDER BY id ASC'
    );
    res.json({ usuarios: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: crear usuario (admin) ────────────────────────────────────────────────
app.post('/api/usuarios', requireAdmin, async (req, res) => {
  const { nombre, email, password, rol } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, email, rol, estado, fecha_alta`,
      [nombre.trim(), email.trim().toLowerCase(), hash, rol === 'admin' ? 'admin' : 'docente']
    );
    res.json({ usuario: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });
    res.status(500).json({ error: e.message });
  }
});

// ── API: toggle estado activo/inactivo (admin) ────────────────────────────────
app.put('/api/usuarios/:id/estado', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE usuarios
         SET estado = CASE WHEN estado = 'activo' THEN 'inactivo' ELSE 'activo' END
       WHERE id = $1 AND rol != 'admin'
       RETURNING estado`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No se puede modificar este usuario.' });
    res.json({ estado: r.rows[0].estado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: cambiar rol (admin) ──────────────────────────────────────────────────
app.put('/api/usuarios/:id/rol', requireAdmin, async (req, res) => {
  const { rol } = req.body;
  if (!['admin', 'docente'].includes(rol))
    return res.status(400).json({ error: 'Rol inválido.' });
  try {
    const r = await pool.query(
      `UPDATE usuarios SET rol = $1
       WHERE id = $2 AND email != 'admin@plandocente.com'
       RETURNING rol`,
      [rol, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No se puede cambiar este usuario.' });
    res.json({ rol: r.rows[0].rol });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: reset contraseña (admin) ─────────────────────────────────────────────
app.put('/api/usuarios/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `UPDATE usuarios SET password_hash = $1
       WHERE id = $2 AND email != 'admin@plandocente.com'
       RETURNING id`,
      [hash, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No se puede modificar este usuario.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: el docente cambia su propia contraseña ───────────────────────────────
app.put('/api/me/password', requireAuth, async (req, res) => {
  const { actual, nueva } = req.body;
  if (!actual || !nueva || nueva.length < 6)
    return res.status(400).json({ error: 'Datos inválidos. La nueva contraseña debe tener al menos 6 caracteres.' });
  try {
    const r = await pool.query(
      'SELECT password_hash FROM usuarios WHERE id = $1', [req.session.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const ok = await bcrypt.compare(actual, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
    const hash = await bcrypt.hash(nueva, 10);
    await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: eliminar usuario (admin) ─────────────────────────────────────────────
app.delete('/api/usuarios/:id', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM usuarios
       WHERE id = $1 AND email != 'admin@plandocente.com'
       RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No se puede eliminar este usuario.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: cliente OpenAI ────────────────────────────────────────────────────────
// Prioridad: OPENAI_API_KEY (clave directa del usuario) > AI_INTEGRATIONS_OPENAI_API_KEY (proxy Replit)
let _openaiClient = null;
function _getOpenAI() {
  if (!_openaiClient) {
    const OpenAI = require('openai');
    const directKey  = process.env.OPENAI_API_KEY;
    const proxyKey   = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const proxyBase  = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (directKey && directKey.length > 20) {
      // Clave real de OpenAI — sin proxy
      console.log('[IA BACKEND] Usando OPENAI_API_KEY directa (len=' + directKey.length + ')');
      _openaiClient = new OpenAI({ apiKey: directKey });
    } else if (proxyKey) {
      console.log('[IA BACKEND] Usando AI_INTEGRATIONS proxy');
      _openaiClient = new OpenAI({ apiKey: proxyKey, baseURL: proxyBase });
    } else {
      throw new Error('No hay API key de OpenAI configurada.');
    }
  }
  return _openaiClient;
}

const IA_MODEL = 'gpt-4o-mini';

// ── API: generar material educativo con IA ────────────────────────────────────
// ── Helpers MercadoPago ───────────────────────────────────────────────────────
function _mpToken() { return process.env.MP_ACCESS_TOKEN || null; }
function _appBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (domain) return `https://${domain}`;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5000';
  return `https://${host}`;
}

// ── API: crear preferencia de pago MercadoPago ────────────────────────────────
app.post('/api/crear-pago', requireAuth, async (req, res) => {
  const token = _mpToken();
  if (!token) {
    return res.status(503).json({ error: 'El sistema de pago aún no está configurado. Contactá al administrador.' });
  }
  const userId   = req.session.userId;
  const baseUrl  = _appBaseUrl(req);

  const preference = {
    items: [{
      title:      'PlanDocente IA - Suscripción mensual',
      quantity:   1,
      unit_price: 10000,
      currency_id: 'ARS'
    }],
    back_urls: {
      success: `${baseUrl}/?pago=ok`,
      failure: `${baseUrl}/?pago=error`,
      pending: `${baseUrl}/?pago=pendiente`
    },
    auto_return:        'approved',
    external_reference: String(userId),
    notification_url:   `${baseUrl}/api/mp-webhook`,
    statement_descriptor: 'PlanDocente IA'
  };

  try {
    const mpRes  = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(preference)
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok) {
      console.error('[MP] Error al crear preferencia:', JSON.stringify(mpData));
      return res.status(502).json({ error: 'Error al conectar con MercadoPago. Intentá nuevamente.' });
    }
    console.log('[MP] Preferencia creada:', mpData.id, '| usuario:', userId);
    res.json({ init_point: mpData.init_point, preference_id: mpData.id });
  } catch (e) {
    console.error('[MP] fetch error:', e.message);
    res.status(500).json({ error: 'Error de red con MercadoPago.' });
  }
});

// ── API: webhook IPN de MercadoPago ──────────────────────────────────────────
// MercadoPago envía POST con { type: "payment", data: { id: "PAYMENT_ID" } }
app.post('/api/mp-webhook', async (req, res) => {
  res.sendStatus(200); // Responder 200 de inmediato (requerido por MP)
  const token = _mpToken();
  if (!token) return;

  const { type, data } = req.body || {};
  const paymentId = data?.id || req.query.id;
  const topic     = type || req.query.topic;

  if ((topic === 'payment' || !topic) && paymentId) {
    try {
      const mpRes   = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const payment = await mpRes.json();
      console.log('[MP WEBHOOK] payment', paymentId, '| status:', payment.status, '| ref:', payment.external_reference);

      if (payment.status === 'approved' && payment.external_reference) {
        const uid = parseInt(payment.external_reference);
        if (uid) {
          await pool.query('UPDATE usuarios SET plan_ilimitado = true WHERE id = $1', [uid]);
          console.log('[MP] ✅ Plan ilimitado activado para usuario ID:', uid);
        }
      }
    } catch (e) {
      console.error('[MP WEBHOOK ERROR]', e.message);
    }
  }
});

// ── API: verificar pago tras redirect de MP ───────────────────────────────────
app.get('/api/verificar-pago', requireAuth, async (req, res) => {
  const token     = _mpToken();
  const paymentId = req.query.payment_id;

  // Primero verificar si ya está activo (webhook puede haber llegado antes)
  const existing = await pool.query('SELECT plan_ilimitado FROM usuarios WHERE id = $1', [req.session.userId]);
  if (existing.rows[0]?.plan_ilimitado) return res.json({ activado: true });

  if (!token || !paymentId) return res.json({ activado: false });

  try {
    const mpRes   = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const payment = await mpRes.json();
    console.log('[MP VERIFICAR] payment', paymentId, '| status:', payment.status);

    if (payment.status === 'approved') {
      await pool.query('UPDATE usuarios SET plan_ilimitado = true WHERE id = $1', [req.session.userId]);
      console.log('[MP] ✅ Plan activado vía redirect para usuario ID:', req.session.userId);
      return res.json({ activado: true });
    }
    res.json({ activado: false, status: payment.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: estado del plan del usuario ─────────────────────────────────────────
const LIMITE_PLANES_GRATIS = 5;
app.get('/api/plan-status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT plan_count, plan_ilimitado FROM usuarios WHERE id = $1',
      [req.session.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const { plan_count, plan_ilimitado } = r.rows[0];
    res.json({
      count: plan_count,
      ilimitado: plan_ilimitado,
      limite: LIMITE_PLANES_GRATIS,
      bloqueado: !plan_ilimitado && plan_count >= LIMITE_PLANES_GRATIS
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: activar plan ilimitado (solo admin) ──────────────────────────────────
app.put('/api/usuarios/:id/plan-ilimitado', requireAdmin, async (req, res) => {
  try {
    const { activo } = req.body;
    await pool.query(
      'UPDATE usuarios SET plan_ilimitado = $1 WHERE id = $2',
      [activo !== false, parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generar-material', requireAuth, async (req, res) => {
  const { tipo, tema, materia, grado, nivel, indicaciones, gradoNum, duracion, tipoClas, esSecundaria } = req.body;
  if (!tipo || !tema || !materia || !grado) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  // ── Control de límite para planificaciones ────────────────────────────────
  if (tipo === 'planificacion_avanzada') {
    const uRow = await pool.query(
      'SELECT plan_count, plan_ilimitado FROM usuarios WHERE id = $1',
      [req.session.userId]
    );
    if (uRow.rows.length > 0) {
      const { plan_count, plan_ilimitado } = uRow.rows[0];
      if (!plan_ilimitado && plan_count >= LIMITE_PLANES_GRATIS) {
        return res.status(402).json({
          error: 'limite_alcanzado',
          count: plan_count,
          limite: LIMITE_PLANES_GRATIS
        });
      }
      // Incrementar contador
      await pool.query(
        'UPDATE usuarios SET plan_count = plan_count + 1 WHERE id = $1',
        [req.session.userId]
      );
    }
  }

  console.log('[IA BACKEND] generando material — tipo:', tipo, '| tema:', tema, '| grado:', grado);
  try {
    const ai = _getOpenAI();
    let systemPrompt, userPrompt;

    if (tipo === 'ficha') {
      systemPrompt = 'Sos un experto en educación primaria argentina. Generás fichas de actividades pedagógicamente sólidas, variadas y apropiadas para el nivel. Respondés SIEMPRE en JSON válido sin texto adicional.';
      userPrompt = `Generá una ficha de actividades para alumnos argentinos de escuela primaria.
Tema: ${tema}
Materia: ${materia}
Grado: ${grado}
Nivel de dificultad: ${nivel || 'intermedio'}
${indicaciones ? 'Indicaciones especiales: ' + indicaciones : ''}

Devolvé exactamente este JSON (5 actividades variadas, con contenido específico del tema):
{
  "actividades": [
    {"num": 1, "tipo": "verdadero_falso", "consigna": "Marcá V (verdadero) o F (falso) según corresponda.", "items": ["Afirmación 1 sobre el tema", "Afirmación 2 sobre el tema", "Afirmación 3 sobre el tema", "Afirmación 4 sobre el tema", "Afirmación 5 sobre el tema"]},
    {"num": 2, "tipo": "completar", "consigna": "Completá las oraciones con las palabras del recuadro.", "texto": "Oración sobre el tema con ___ para completar. Otra oración con ___ para completar. Una más con ___."},
    {"num": 3, "tipo": "multiple_choice", "consigna": "Marcá con una X la opción correcta.", "preguntas": [{"pregunta": "¿Pregunta sobre el tema?", "opciones": ["a) Opción A", "b) Opción B correcta", "c) Opción C", "d) Opción D"]}, {"pregunta": "¿Otra pregunta?", "opciones": ["a) Opción A correcta", "b) Opción B", "c) Opción C", "d) Opción D"]}]},
    {"num": 4, "tipo": "desarrollo", "consigna": "Respondé con tus palabras la siguiente pregunta sobre el tema.", "lineas": 5},
    {"num": 5, "tipo": "libre", "consigna": "Actividad de producción o reflexión creativa relacionada con el tema."}
  ]
}
Importante: usá contenido ESPECÍFICO del tema ${tema}, apropiado para ${grado}.`;

    } else if (tipo === 'fichas_secuencia') {
      const gNum = parseInt(gradoNum) || 3;
      const esPrimerCiclo = gNum <= 3;
      systemPrompt = 'Sos docente especialista en escuela primaria argentina. Generás secuencias de fichas de trabajo pedagógicamente correctas y adaptadas al grado. Respondés SIEMPRE en JSON válido sin texto adicional.';
      userPrompt = `Generá una secuencia de 5 fichas de trabajo para estudiantes argentinos.
Tema: ${tema}
Materia: ${materia}
Grado: ${grado}

${esPrimerCiclo ? `ATENCIÓN — PRIMER CICLO (${grado}): Los alumnos tienen ${gNum === 1 ? '6' : gNum === 2 ? '7' : '8'} años.
- Usá EXCLUSIVAMENTE estos tipos de actividad: "rodear" (rodear letras o palabras en una lista), "completar" (completar el espacio vacío con una letra o palabra), "unir" (unir con flecha, dos columnas), "copiar" (copiar texto en los renglones), "dibujar" (dibujar en un recuadro).
- PROHIBIDO: textos largos, comprensión lectora, definiciones teóricas, preguntas abiertas largas.
- Consignas MUY CORTAS: máximo 8 palabras, en imperativo (Rodeá, Completá, Uní, Copiá, Dibujá).
- Máximo 5 elementos por actividad. Contenido MUY CONCRETO y visual.` : `Actividades progresivas de menor a mayor complejidad para ${grado}.
Tipos disponibles: "rodear", "completar", "unir", "verdadero_falso", "opcion_multiple", "desarrollo", "produccion".`}

Devolvé exactamente este JSON (5 fichas, una por etapa):
{
  "fichas": [
    {
      "etapa": 1,
      "titulo": "Título corto (max 3 palabras)",
      "consigna": "Consigna corta en imperativo.",
      "tipo": "rodear",
      "items": ["item1", "item2", "item3", "item4", "item5"],
      "texto": null
    },
    {
      "etapa": 2,
      "titulo": "Título corto",
      "consigna": "Consigna corta.",
      "tipo": "completar",
      "items": ["p_labra", "_lefante", "m_sa"],
      "texto": null
    },
    {
      "etapa": 3,
      "titulo": "Título corto",
      "consigna": "Consigna corta.",
      "tipo": "unir",
      "items": ["columnaA1|columnaB1", "columnaA2|columnaB2", "columnaA3|columnaB3"],
      "texto": null
    },
    {
      "etapa": 4,
      "titulo": "Título corto",
      "consigna": "Consigna corta.",
      "tipo": "copiar",
      "items": null,
      "texto": "Texto a copiar relacionado con el tema"
    },
    {
      "etapa": 5,
      "titulo": "Título corto",
      "consigna": "Consigna corta.",
      "tipo": "dibujar",
      "items": ["etiqueta1", "etiqueta2", "etiqueta3"],
      "texto": null
    }
  ]
}
Importante: usá contenido MUY ESPECÍFICO del tema "${tema}" para ${grado}. Cada ficha es una hoja imprimible independiente.`;

    } else if (tipo === 'planificacion_avanzada') {
      const numClases = Math.min(parseInt(duracion) || 3, 10);
      const esSec = esSecundaria === true || esSecundaria === 'true';
      const nivelCiclo = esSec ? 'secundaria argentina' : 'primaria argentina';
      const tipoClase = tipoClas === 'practica' ? 'práctica y consolidación'
        : tipoClas === 'taller' ? 'taller / trabajo grupal'
        : tipoClas === 'repaso' ? 'repaso y revisión'
        : 'presentación de contenido nuevo';
      const adaptGrado = esSec
        ? 'Usá lenguaje técnico-disciplinar. Las actividades deben incluir análisis, debate, producción escrita fundamentada y fuentes. Evitá actividades infantilizadas.'
        : parseInt(gradoNum) <= 2
        ? 'Lenguaje MUY SIMPLE. Actividades concretas: rodear, unir con flechas, dibujar, completar palabras, copiar oraciones cortas. Consignas de máximo 8 palabras. Ejemplos: objetos de la clase o la casa, animales conocidos, familia.'
        : 'Lenguaje simple y claro. Actividades con cuaderno, pizarrón y trabajo en parejas. Consignas completas con ejemplos concretos del cotidiano argentino.';

      systemPrompt = `Sos docente especialista en planificación educativa para escuela ${nivelCiclo}. Usás el vocabulario real del aula argentina: cuaderno, carpeta, pizarrón, recreo, fila. Generás planificaciones con actividades concretas, consignas completas y ejemplos específicos del tema. Respondés SIEMPRE en JSON válido sin texto adicional ni markdown.`;

      const clasesEjemplo = Array.from({ length: numClases }, (_, i) => {
        const n = i + 1;
        const progresion = n === 1 ? 'introducción y saberes previos'
          : n === numClases ? 'integración y evaluación'
          : n <= Math.ceil(numClases / 2) ? 'práctica guiada'
          : 'aplicación autónoma';
        return `{"num":${n},"titulo":"[título específico para clase ${n}: ${progresion}]","objetivo":"[objetivo específico clase ${n} para ${tema} en ${grado}]","inicio":"[2-3 oraciones: actividad concreta para activar saberes al inicio de la clase ${n}. Mencionar materiales concretos]","actividad_1":"[consigna completa de la primera actividad de desarrollo. Mínimo 2 oraciones. Incluir ejemplo concreto con palabras/números/conceptos del tema ${tema}]","actividad_2":"[consigna completa de la segunda actividad. Diferente tipo que la anterior. Incluir ejemplo o producto esperado]","cierre":"[2 oraciones: cómo se cierra la clase ${n} y qué se registra en cuaderno]","evaluacion":"[qué observa el docente y qué evidencia recolecta en esta clase]"}`;
      }).join(',\n    ');

      userPrompt = `Generá una planificación avanzada para docentes argentinos de ${nivelCiclo}.

Tema: ${tema}
Materia: ${materia}
Grado/Año: ${grado}
Cantidad de clases: ${numClases}
Tipo de clase: ${tipoClase}
Nivel del grupo: ${nivel || 'medio'}
${indicaciones ? 'Indicaciones del docente: ' + indicaciones : ''}

CRITERIOS OBLIGATORIOS:
${adaptGrado}
- NO usar frases genéricas como "el docente explica", "los alumnos trabajan", "reflexionan sobre el tema".
- SÍ incluir: consignas con verbos imperativos (Rodeá, Completá, Escribí, Debatí), ejemplos concretos del tema, materiales que se usan, producciones esperadas.
- Cada clase debe ser DIFERENTE y PROGRESIVA: de lo más simple a lo más complejo.
- Contexto de aula real: cuaderno, carpeta, pizarrón, trabajo en parejas o grupos.

Devolvé EXACTAMENTE este JSON:
{
  "objetivo_general": "[objetivo general específico para la secuencia de ${numClases} clases sobre ${tema} en ${grado}]",
  "fundamentacion": "[3-4 oraciones sobre por qué enseñar ${tema} en ${grado}. Mencionar diseño curricular argentino y relevancia para los estudiantes de ese grado]",
  "contenidos": "[lista de 3-5 contenidos específicos del tema: conceptuales, procedimentales y actitudinales]",
  "clases": [
    ${clasesEjemplo}
  ]
}
Importante: todo el contenido debe ser ESPECÍFICO para el tema "${tema}" en ${grado}. Nada genérico.`;

    } else {
      systemPrompt = 'Sos un experto en planificación docente para escuela primaria argentina. Generás planificaciones de clase concisas, prácticas y pedagógicamente sólidas. Respondés SIEMPRE en JSON válido sin texto adicional.';
      userPrompt = `Generá una planificación de clase para docentes argentinos.
Tema: ${tema}
Materia: ${materia}
Grado: ${grado}

Devolvé exactamente este JSON:
{
  "obj": "Que los alumnos ... (objetivo específico para este tema y grado)",
  "inicio": "Descripción de la actividad de inicio — 15 min (motivadora, activa saberes previos, específica al tema)",
  "act1": "Descripción de la actividad de desarrollo 1 — 20 min (práctica guiada, específica al tema)",
  "act2": "Descripción de la actividad de desarrollo 2 — 15 min (práctica autónoma, específica al tema)",
  "cierre": "Descripción del cierre — 10 min (sistematización de lo aprendido, específica al tema)",
  "evaluacion": "Criterios e instrumentos de evaluación para esta clase"
}
Importante: cada campo debe ser específico al tema ${tema} para ${grado}, NO genérico.`;
    }

    const completion = await ai.chat.completions.create({
      model: IA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: tipo === 'planificacion_avanzada' ? 3500 : 1800
    });

    const raw  = completion.choices[0].message.content;
    const data = JSON.parse(raw);
    console.log('[IA OK] respuesta recibida del modelo, tokens:', completion.usage?.total_tokens);
    res.json({ ok: true, data, source: 'ia', model: IA_MODEL });
  } catch (e) {
    console.error('[IA ERROR]', e.message);
    res.status(500).json({ error: 'Servicio IA no disponible.', detail: e.message });
  }
});

// ── Fallback: servir index.html (Express 5 wildcard) ─────────────────────────
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Arranque ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`PlanDocente IA corriendo en puerto ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Error al iniciar la base de datos:', err);
    process.exit(1);
  });

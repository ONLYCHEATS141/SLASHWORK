/**
 * Slashwork · Backend de soporte
 * -------------------------------
 * Servidor 100% con módulos nativos de Node (http + node:sqlite),
 * así no hace falta "npm install" nada. Requiere Node >= 22.5.
 *
 * Arranque:
 *   node server.js
 *
 * Sirve la web estática (../) y expone la API de tickets bajo /api.
 * Base de datos SQLite en server/support.db (se crea sola al arrancar).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const SITE_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, 'support.db');

// Credenciales del panel admin.
// ⚠️ Cámbialas antes de poner esto en producción real (ver README.md).
const ADMIN_USER = process.env.ADMIN_USER || 'JUANCA';
const ADMIN_PASS = process.env.ADMIN_PASS || 'JUANCA';

const SESSION_COOKIE = 'sw_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

// ============ DB ============
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    contacto TEXT NOT NULL,
    asunto TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'abierto',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    autor TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ============ SESIONES (en memoria) ============
const sessions = new Map(); // token -> expiry timestamp

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

// ============ HELPERS ============
function nowISO() { return new Date().toISOString(); }

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function sendJSON(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => {
      chunks += c;
      if (chunks.length > 1e6) req.destroy(); // límite básico anti-abuso
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function ticketToPublic(t) {
  return { id: t.id, nombre: t.nombre, contacto: t.contacto, asunto: t.asunto, estado: t.estado, created_at: t.created_at, updated_at: t.updated_at };
}

function getTicketMessages(ticketId) {
  const stmt = db.prepare('SELECT autor, mensaje, created_at FROM messages WHERE ticket_id = ? ORDER BY id ASC');
  return stmt.all(ticketId);
}

// ============ MIME ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // proteger contra path traversal
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(SITE_ROOT, rel);
  if (!filePath.startsWith(SITE_ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - No encontrado');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ============ API ============
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // ---- Crear ticket (público) ----
  if (parts[1] === 'tickets' && parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req);
    const nombre = String(body.nombre || '').trim().slice(0, 120);
    const contacto = String(body.contacto || '').trim().slice(0, 120);
    const asunto = String(body.asunto || '').trim().slice(0, 160);
    const mensaje = String(body.mensaje || '').trim().slice(0, 4000);

    if (!nombre || !contacto || !asunto || !mensaje) {
      return sendJSON(res, 400, { error: 'Faltan campos obligatorios.' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const ts = nowISO();
    const insert = db.prepare(`INSERT INTO tickets (token, nombre, contacto, asunto, estado, created_at, updated_at)
                                VALUES (?, ?, ?, ?, 'abierto', ?, ?)`);
    const result = insert.run(token, nombre, contacto, asunto, ts, ts);
    const ticketId = Number(result.lastInsertRowid);

    db.prepare(`INSERT INTO messages (ticket_id, autor, mensaje, created_at) VALUES (?, 'user', ?, ?)`)
      .run(ticketId, mensaje, ts);

    return sendJSON(res, 201, { id: ticketId, token });
  }

  // ---- Consultar ticket propio (público, requiere token) ----
  if (parts[1] === 'tickets' && parts.length === 3 && req.method === 'GET') {
    const id = Number(parts[2]);
    const token = url.searchParams.get('token');
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!ticket || ticket.token !== token) return sendJSON(res, 404, { error: 'Ticket no encontrado.' });
    return sendJSON(res, 200, { ticket: ticketToPublic(ticket), messages: getTicketMessages(id) });
  }

  // ---- Añadir mensaje a ticket propio (público, requiere token) ----
  if (parts[1] === 'tickets' && parts.length === 4 && parts[3] === 'messages' && req.method === 'POST') {
    const id = Number(parts[2]);
    const body = await readBody(req);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!ticket || ticket.token !== body.token) return sendJSON(res, 404, { error: 'Ticket no encontrado.' });

    const mensaje = String(body.mensaje || '').trim().slice(0, 4000);
    if (!mensaje) return sendJSON(res, 400, { error: 'Mensaje vacío.' });

    const ts = nowISO();
    db.prepare(`INSERT INTO messages (ticket_id, autor, mensaje, created_at) VALUES (?, 'user', ?, ?)`).run(id, mensaje, ts);
    db.prepare(`UPDATE tickets SET estado = 'abierto', updated_at = ? WHERE id = ?`).run(ts, id);

    return sendJSON(res, 200, { ok: true });
  }

  // ---- Login admin ----
  if (parts[1] === 'admin' && parts[2] === 'login' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.usuario === ADMIN_USER && body.contrasena === ADMIN_PASS) {
      const token = createSession();
      return sendJSON(res, 200, { ok: true }, {
        'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
      });
    }
    return sendJSON(res, 401, { error: 'Usuario o contraseña incorrectos.' });
  }

  // ---- Logout admin ----
  if (parts[1] === 'admin' && parts[2] === 'logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    sessions.delete(cookies[SESSION_COOKIE]);
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` });
  }

  // ---- A partir de aquí, todo requiere sesión admin ----
  const cookies = parseCookies(req);
  const authed = isValidSession(cookies[SESSION_COOKIE]);

  if (parts[1] === 'admin' && parts[2] === 'session' && req.method === 'GET') {
    return sendJSON(res, 200, { authed });
  }

  if (!authed) return sendJSON(res, 401, { error: 'No autenticado.' });

  // ---- Listar tickets (admin) ----
  if (parts[1] === 'admin' && parts[2] === 'tickets' && parts.length === 3 && req.method === 'GET') {
    const tickets = db.prepare('SELECT * FROM tickets ORDER BY updated_at DESC').all();
    return sendJSON(res, 200, { tickets: tickets.map(ticketToPublic) });
  }

  // ---- Ver ticket (admin) ----
  if (parts[1] === 'admin' && parts[2] === 'tickets' && parts.length === 4 && req.method === 'GET') {
    const id = Number(parts[3]);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!ticket) return sendJSON(res, 404, { error: 'Ticket no encontrado.' });
    return sendJSON(res, 200, { ticket: ticketToPublic(ticket), messages: getTicketMessages(id) });
  }

  // ---- Responder / cambiar estado (admin) ----
  if (parts[1] === 'admin' && parts[2] === 'tickets' && parts.length === 5 && parts[4] === 'reply' && req.method === 'POST') {
    const id = Number(parts[3]);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!ticket) return sendJSON(res, 404, { error: 'Ticket no encontrado.' });

    const body = await readBody(req);
    const mensaje = String(body.mensaje || '').trim().slice(0, 4000);
    const estado = ['abierto', 'resuelto'].includes(body.estado) ? body.estado : ticket.estado;
    const ts = nowISO();

    if (mensaje) {
      db.prepare(`INSERT INTO messages (ticket_id, autor, mensaje, created_at) VALUES (?, 'admin', ?, ?)`).run(id, mensaje, ts);
    }
    db.prepare(`UPDATE tickets SET estado = ?, updated_at = ? WHERE id = ?`).run(estado, ts, id);

    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Ruta no encontrada.' });
}

// ============ SERVIDOR ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Error interno del servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`Slashwork backend escuchando en http://localhost:${PORT}`);
  console.log(`Panel admin: http://localhost:${PORT}/admin.html  (usuario: ${ADMIN_USER})`);
});

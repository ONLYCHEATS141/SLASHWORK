(function () {
  const API = '';
  const loginSection = document.getElementById('adminLogin');
  const panelSection = document.getElementById('adminPanel');
  const ticketItemsEl = document.getElementById('ticketItems');
  const ticketDetailEl = document.getElementById('ticketDetail');

  let activeTicketId = null;
  let pollTimer = null;

  // ---------- arranque: comprobar sesión ----------
  checkSession();

  async function checkSession() {
    try {
      const res = await fetch(`${API}/api/admin/session`);
      const data = await res.json();
      if (data.authed) showPanel();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginSection.style.display = 'flex';
    panelSection.style.display = 'none';
  }

  function showPanel() {
    loginSection.style.display = 'none';
    panelSection.style.display = 'block';
    loadTickets();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      loadTickets(true);
      if (activeTicketId) loadTicketDetail(activeTicketId, true);
    }, 8000);
  }

  // ---------- login ----------
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const usuario = document.getElementById('loginUser').value.trim();
    const contrasena = document.getElementById('loginPass').value;
    const errorEl = document.getElementById('loginError');
    errorEl.style.display = 'none';

    try {
      const res = await fetch(`${API}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario, contrasena }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo entrar.');
      showPanel();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch(`${API}/api/admin/logout`, { method: 'POST' });
    clearInterval(pollTimer);
    activeTicketId = null;
    showLogin();
  });

  document.getElementById('refreshBtn').addEventListener('click', () => loadTickets());

  // ---------- listar tickets ----------
  async function loadTickets(silent) {
    try {
      const res = await fetch(`${API}/api/admin/tickets`);
      if (res.status === 401) return showLogin();
      const data = await res.json();
      renderTicketList(data.tickets);
    } catch {
      if (!silent) ticketItemsEl.innerHTML = '<p class="admin-hint">No se pudieron cargar los tickets.</p>';
    }
  }

  function renderTicketList(tickets) {
    if (!tickets.length) {
      ticketItemsEl.innerHTML = '<p class="admin-hint">Todavía no hay tickets.</p>';
      return;
    }
    ticketItemsEl.innerHTML = '';
    tickets.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'ticket-item' + (t.id === activeTicketId ? ' active' : '');
      btn.innerHTML = `
        <div class="ticket-item-top">
          <span class="ticket-item-name">${escapeHtml(t.nombre)}</span>
          <span class="chip ${t.estado === 'abierto' ? 'chip-abierto' : 'chip-resuelto'}">${t.estado}</span>
        </div>
        <div class="ticket-item-asunto">${escapeHtml(t.asunto)}</div>
        <div class="ticket-item-meta">
          <span>#${t.id} · ${escapeHtml(t.contacto)}</span>
          <span>${fmtDate(t.updated_at)}</span>
        </div>
      `;
      btn.addEventListener('click', () => loadTicketDetail(t.id));
      ticketItemsEl.appendChild(btn);
    });
  }

  // ---------- detalle de ticket ----------
  async function loadTicketDetail(id, silent) {
    activeTicketId = id;
    try {
      const res = await fetch(`${API}/api/admin/tickets/${id}`);
      if (res.status === 401) return showLogin();
      const data = await res.json();
      renderTicketDetail(data.ticket, data.messages);
      // resaltar en la lista
      document.querySelectorAll('.ticket-item').forEach(el => el.classList.remove('active'));
    } catch {
      if (!silent) ticketDetailEl.innerHTML = '<p class="admin-hint">No se pudo cargar el ticket.</p>';
    }
  }

  function renderTicketDetail(ticket, messages) {
    ticketDetailEl.innerHTML = `
      <div class="ticket-detail-head">
        <div>
          <div class="ticket-detail-title">${escapeHtml(ticket.asunto)}</div>
          <div class="ticket-detail-sub">#${ticket.id} · ${escapeHtml(ticket.nombre)} · ${escapeHtml(ticket.contacto)}</div>
        </div>
        <div class="ticket-detail-actions">
          <button class="btn btn-ghost btn-sm" id="toggleEstadoBtn">
            ${ticket.estado === 'abierto' ? 'Marcar como resuelto' : 'Reabrir'}
          </button>
        </div>
      </div>
      <div class="ticket-thread" id="ticketThread"></div>
      <div class="ticket-reply">
        <textarea id="adminReplyText" placeholder="Escribe tu respuesta..." maxlength="4000"></textarea>
        <button class="btn btn-primary" id="adminReplySend">Enviar</button>
      </div>
    `;

    const thread = document.getElementById('ticketThread');
    messages.forEach(m => {
      const div = document.createElement('div');
      div.className = `sw-msg ${m.autor === 'admin' ? 'sw-msg-admin' : 'sw-msg-user'}`;
      div.style.alignSelf = m.autor === 'admin' ? 'flex-end' : 'flex-start';
      div.innerHTML = `${escapeHtml(m.mensaje)}<span class="sw-msg-time">${fmtDate(m.created_at)}</span>`;
      thread.appendChild(div);
    });
    thread.scrollTop = thread.scrollHeight;

    document.getElementById('toggleEstadoBtn').addEventListener('click', async () => {
      const nuevoEstado = ticket.estado === 'abierto' ? 'resuelto' : 'abierto';
      await fetch(`${API}/api/admin/tickets/${ticket.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: '', estado: nuevoEstado }),
      });
      loadTicketDetail(ticket.id);
      loadTickets(true);
    });

    document.getElementById('adminReplySend').addEventListener('click', async () => {
      const textarea = document.getElementById('adminReplyText');
      const mensaje = textarea.value.trim();
      if (!mensaje) return;
      textarea.disabled = true;
      try {
        await fetch(`${API}/api/admin/tickets/${ticket.id}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mensaje, estado: 'abierto' }),
        });
        loadTicketDetail(ticket.id);
        loadTickets(true);
      } finally {
        textarea.disabled = false;
      }
    });
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();

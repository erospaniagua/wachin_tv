const form = document.getElementById('add-form');
const nameEl = document.getElementById('name');
const emailEl = document.getElementById('email');
const roleEl = document.getElementById('role-admin');
const inviteEl = document.getElementById('send-invite');
const addBtn = document.getElementById('add-btn');
const msg = document.getElementById('add-msg');
const listEl = document.getElementById('user-list');

let me = null;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Gate: must be a signed-in admin.
async function guard() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('unauth');
    const { user } = await res.json();
    if (user.role !== 'admin') { window.location.replace('/'); return false; }
    me = user;
    return true;
  } catch {
    window.location.replace('/login.html');
    return false;
  }
}

async function loadUsers() {
  listEl.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { users } = await (await fetch('/api/admin/users')).json();
    listEl.innerHTML = '';
    const table = document.createElement('div');
    table.className = 'user-table';
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'user-row';
      const isMe = u.id === me.id;
      row.innerHTML = `
        <div class="u-main">
          <span class="u-name">${esc(u.name)}</span>
          <span class="u-email">${esc(u.email)}</span>
        </div>
        <span class="u-role ${u.role}">${u.role}</span>
        <div class="u-actions">
          <button class="mini" data-invite="${u.id}">Send link</button>
          ${isMe ? '' : `<button class="mini danger" data-del="${u.id}" data-name="${esc(u.name)}">Remove</button>`}
        </div>`;
      table.appendChild(row);
    }
    listEl.appendChild(table);
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p class="muted">Could not load users.</p>';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  addBtn.disabled = true;
  msg.textContent = '';
  msg.className = 'admin-msg';
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nameEl.value.trim(),
        email: emailEl.value.trim(),
        role: roleEl.checked ? 'admin' : 'user',
        invite: inviteEl.checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    msg.textContent = `✓ ${data.user.name} added${data.invited ? ' and emailed a sign-in link' : ''}.`;
    msg.className = 'admin-msg ok';
    form.reset();
    inviteEl.checked = true;
    loadUsers();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'admin-msg err';
  } finally {
    addBtn.disabled = false;
  }
});

listEl.addEventListener('click', async (e) => {
  const inviteId = e.target.getAttribute('data-invite');
  const delId = e.target.getAttribute('data-del');
  if (inviteId) {
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    await fetch(`/api/admin/users/${inviteId}/invite`, { method: 'POST' }).catch(() => {});
    e.target.textContent = 'Sent ✓';
  }
  if (delId) {
    if (!confirm(`Remove ${e.target.getAttribute('data-name')}? They will lose access.`)) return;
    const res = await fetch(`/api/admin/users/${delId}`, { method: 'DELETE' });
    if (res.ok) loadUsers();
    else alert('Could not remove user.');
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('/login.html');
});

guard().then((ok) => { if (ok) loadUsers(); });

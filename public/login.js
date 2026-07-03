const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submit-btn');
const msg = document.getElementById('login-msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim();
  if (!email) return;

  submitBtn.disabled = true;
  msg.textContent = 'Sending…';
  msg.className = 'login-msg';

  try {
    const res = await fetch('/api/auth/request-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    msg.textContent = data.message || 'Check your email for a sign-in link.';
    msg.className = 'login-msg ok';
    form.reset();
  } catch (err) {
    console.error(err);
    msg.textContent = 'Something went wrong. Please try again.';
    msg.className = 'login-msg err';
  } finally {
    submitBtn.disabled = false;
  }
});

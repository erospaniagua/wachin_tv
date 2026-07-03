// Telegram admin notifications. Reads config at call time (not import time) so
// it's robust to module load order, and no-ops with a warning until configured.
let warned = false;

export async function notify(text) {
  const { TELEGRAM_BOT, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT || !TELEGRAM_CHAT_ID) {
    if (!warned) { console.warn('Telegram not configured (TELEGRAM_BOT / TELEGRAM_CHAT_ID) — skipping notifications.'); warned = true; }
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) { console.error('Telegram sendMessage failed:', res.status, await res.text()); return false; }
    return true;
  } catch (err) {
    console.error('Telegram notify error:', err.message);
    return false;
  }
}

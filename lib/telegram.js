'use strict';
// ZERNO Telegram boti: /start bosilganda "Zernoga kirish" tugmasini yuboradi.
// Tugma saytni Telegram ichida (Web App) ochadi.
// Ishlashi uchun Render'da TELEGRAM_BOT_TOKEN qo'yilgan bo'lishi kifoya.

const crypto = require('crypto');

function setupTelegram(app) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return;

  const siteUrl = (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const api = (method, body) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
      .then((r) => r.json())
      .then((j) => { if (!j.ok) console.error(`Telegram ${method}:`, j.description); return j; })
      .catch((e) => console.error(`Telegram ${method}:`, e.message));

  const button = () =>
    siteUrl.startsWith('https://')
      ? { text: '🚀 Zernoga kirish', web_app: { url: siteUrl + '/' } }
      : { text: '🚀 Zernoga kirish', url: siteUrl || 'https://zerno-1xm7.onrender.com' };

  async function handle(update) {
    const msg = update.message;
    if (!msg || !msg.chat || typeof msg.text !== 'string') return;
    if (!/^\/start\b/.test(msg.text) && msg.chat.type !== 'private') return;
    await api('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Assalomu alaykum! 👋\n\n<b>ZERNO</b> — bepul onlayn testlar va elektron darsliklar.\nKirish uchun pastdagi tugmani bosing 👇',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[button()]] },
    });
  }

  // Webhook manzili tokendan hosil qilinadi — tashqaridan taxmin qilib bo'lmaydi
  const hookPath = '/tg/' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
  const secret = crypto.createHash('sha256').update('zerno:' + token).digest('hex').slice(0, 48);

  app.post(hookPath, (req, res) => {
    if (req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.sendStatus(403);
    res.sendStatus(200);
    handle(req.body || {});
  });

  (async () => {
    await api('setMyCommands', { commands: [{ command: 'start', description: 'Zernoga kirish' }] });
    if (siteUrl.startsWith('https://')) {
      await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Zerno', web_app: { url: siteUrl + '/' } } });
      const r = await api('setWebhook', { url: siteUrl + hookPath, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });
      if (r && r.ok) console.log('🤖 Telegram bot ulandi (webhook)');
      return;
    }
    // Lokal ishga tushirishda — long polling
    await api('deleteWebhook', {});
    console.log('🤖 Telegram bot ulandi (polling)');
    let offset = 0;
    for (;;) {
      try {
        const r = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of (r && r.result) || []) { offset = u.update_id + 1; await handle(u); }
      } catch (e) { await new Promise((s) => setTimeout(s, 5000)); }
    }
  })();
}

module.exports = { setupTelegram };

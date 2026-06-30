import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATCHES_PATH = path.join(__dirname, '..', 'data', 'matches.json');
const NOTIFIED_PATH = path.join(__dirname, '..', 'data', 'notified.json');

// Ventana de aviso: dispara entre 28 y 42 minutos antes del partido
// (cubre el cron de cada 10 min con margen para jitter de GitHub Actions).
const WINDOW_MAX_MIN = 42;
const WINDOW_MIN_MIN = 28;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM; // ej. 'whatsapp:+14155238886'
const RECIPIENTS = (process.env.WHATSAPP_RECIPIENTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM) {
  console.error('Faltan credenciales de Twilio (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM).');
  process.exit(1);
}
if (!RECIPIENTS.length) {
  console.error('No hay destinatarios configurados en WHATSAPP_RECIPIENTS.');
  process.exit(1);
}

const matches = JSON.parse(readFileSync(MATCHES_PATH, 'utf8'));
const notified = new Set(
  existsSync(NOTIFIED_PATH) ? JSON.parse(readFileSync(NOTIFIED_PATH, 'utf8')) : []
);

function gtTime(timeET) {
  const [h, m] = timeET.split(':').map(Number);
  let g = h - 2;
  if (g < 0) g += 24;
  return `${String(g).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function predictedScore(ph, pd, pa) {
  if (ph >= pa && ph >= pd) return { fav: 'home', score: `${Math.round(ph / 30 + 0.4)}-${Math.round(pa / 35)}` };
  if (pa >= ph && pa >= pd) return { fav: 'away', score: `${Math.round(ph / 35)}-${Math.round(pa / 30 + 0.4)}` };
  return { fav: 'draw', score: '1-1' };
}

function buildMessage(m) {
  const { fav, score } = predictedScore(m.ph, m.pd, m.pa);
  const favText = fav === 'home' ? m.h : fav === 'away' ? m.a : 'Empate';
  return [
    '⚽ *¡Faltan 40 minutos!*',
    `${m.h} vs ${m.a}`,
    `🏟 ${m.venue}`,
    `🕐 ${gtTime(m.time)} GT`,
    '',
    '🤖 *Pronóstico:*',
    `${m.h}: ${m.ph}%  ·  Empate: ${m.pd}%  ·  ${m.a}: ${m.pa}%`,
    `Favorito: ${favText}  ·  Marcador estimado: ${score}`,
  ].join('\n');
}

async function sendWhatsApp(to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ From: FROM, To: `whatsapp:${to}`, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio error ${res.status} enviando a ${to}: ${text}`);
  }
}

async function main() {
  const now = Date.now();
  let changed = false;

  for (const m of matches) {
    if (notified.has(m.id)) continue;
    if (m.h === 'Por definir' || m.a === 'Por definir') continue;

    const kickoff = new Date(`${m.date}T${m.time}:00-04:00`).getTime();
    const diffMin = (kickoff - now) / 60000;

    if (diffMin <= WINDOW_MAX_MIN && diffMin > WINDOW_MIN_MIN) {
      const body = buildMessage(m);
      console.log(`Enviando aviso para partido ${m.id}: ${m.h} vs ${m.a}`);
      for (const to of RECIPIENTS) {
        try {
          await sendWhatsApp(to, body);
        } catch (e) {
          console.error(e.message);
        }
      }
      notified.add(m.id);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(NOTIFIED_PATH, JSON.stringify([...notified].sort((a, b) => a - b), null, 2) + '\n');
    console.log('data/notified.json actualizado.');
  } else {
    console.log('No hay partidos en ventana de aviso en esta ejecución.');
  }
}

main().catch(e => {
  console.error('Fallo inesperado:', e);
  process.exit(1);
});

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATCHES_PATH = path.join(__dirname, '..', 'data', 'matches.json');
const NOTIFIED_PATH = path.join(__dirname, '..', 'data', 'notified.json');

// Ventana de aviso: dispara entre 28 y 42 minutos antes del partido
// (cubre el cron de cada 10 min con margen para jitter de GitHub Actions).
const WINDOW_MAX_MIN = 42;
const WINDOW_MIN_MIN = 28;

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const RECIPIENTS = (process.env.EMAIL_RECIPIENTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error('Faltan credenciales de correo (EMAIL_USER / EMAIL_PASS).');
  process.exit(1);
}
if (!RECIPIENTS.length) {
  console.error('No hay destinatarios configurados en EMAIL_RECIPIENTS.');
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

function buildEmail(m) {
  const { fav, score } = predictedScore(m.ph, m.pd, m.pa);
  const favText = fav === 'home' ? m.h : fav === 'away' ? m.a : 'Empate';
  const subject = `⚽ En 40 min: ${m.h} vs ${m.a}`;
  const text = [
    `¡Faltan 40 minutos para el partido!`,
    ``,
    `${m.h} vs ${m.a}`,
    `Estadio: ${m.venue}`,
    `Hora: ${gtTime(m.time)} GT`,
    ``,
    `Pronóstico:`,
    `${m.h}: ${m.ph}%  ·  Empate: ${m.pd}%  ·  ${m.a}: ${m.pa}%`,
    `Favorito: ${favText}  ·  Marcador estimado: ${score}`,
  ].join('\n');
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto">
      <h2 style="color:#00a651;margin-bottom:4px">⚽ ¡Faltan 40 minutos!</h2>
      <p style="font-size:18px;font-weight:700;margin:8px 0">${m.h} vs ${m.a}</p>
      <p style="color:#5b6b7e;margin:2px 0">📍 ${m.venue}</p>
      <p style="color:#5b6b7e;margin:2px 0">🕐 ${gtTime(m.time)} GT</p>
      <div style="background:#f4f7fb;border-radius:10px;padding:12px 14px;margin-top:14px">
        <p style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5b6b7e;margin:0 0 6px">🤖 Pronóstico</p>
        <p style="margin:0 0 4px">${m.h}: <b>${m.ph}%</b> &nbsp;·&nbsp; Empate: <b>${m.pd}%</b> &nbsp;·&nbsp; ${m.a}: <b>${m.pa}%</b></p>
        <p style="margin:0">Favorito: <b>${favText}</b> &nbsp;·&nbsp; Marcador estimado: <b>${score}</b></p>
      </div>
    </div>`;
  return { subject, text, html };
}

async function main() {
  const now = Date.now();
  let changed = false;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  for (const m of matches) {
    if (notified.has(m.id)) continue;
    if (m.h === 'Por definir' || m.a === 'Por definir') continue;

    const kickoff = new Date(`${m.date}T${m.time}:00-04:00`).getTime();
    const diffMin = (kickoff - now) / 60000;

    if (diffMin <= WINDOW_MAX_MIN && diffMin > WINDOW_MIN_MIN) {
      const { subject, text, html } = buildEmail(m);
      console.log(`Enviando aviso por correo para partido ${m.id}: ${m.h} vs ${m.a}`);
      try {
        await transporter.sendMail({
          from: `Mundial 2026 ⚽ <${EMAIL_USER}>`,
          to: RECIPIENTS.join(','),
          subject,
          text,
          html,
        });
      } catch (e) {
        console.error(`Error enviando correo para partido ${m.id}:`, e.message);
        continue;
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

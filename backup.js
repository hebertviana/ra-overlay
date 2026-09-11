const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');

// Extensoes de memory card reconhecidas. O PCSX2 usa .ps2 para os cartoes
// padrao, mas mantemos .mcd e .mcr para cartoes importados de outros emuladores.
const CARD_EXT = ['.ps2', '.mcd', '.mcr'];

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slug(text, max = 48) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // tira acentos
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'sem-titulo';
}

async function listCards(mcdPath) {
  const entries = await fsp.readdir(mcdPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && CARD_EXT.includes(path.extname(e.name).toLowerCase()))
    .map(e => path.join(mcdPath, e.name))
    .sort();
}

function zip(files, destFile, comment) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destFile);
    const archive = archiver('zip', { zlib: { level: 9 } });

    out.on('close', () => resolve(archive.pointer()));
    out.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', err => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.pipe(out);
    for (const f of files) archive.file(f, { name: path.basename(f) });
    if (comment) archive.append(comment, { name: 'backup.txt' });
    archive.finalize();
  });
}

// O PCSX2 as vezes demora um pouco para persistir o save no arquivo depois
// da conquista ser detectada. Espera algum cartao ser regravado depois de
// `since`; se o timeout passar sem gravacao nova, segue com o que tiver.
async function waitFreshSave(cards, since, { timeoutMs = 15000, intervalMs = 1000 } = {}) {
  if (!since) return true;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const stats = await Promise.all(cards.map(c => fsp.stat(c)));
    if (stats.some(s => s.mtimeMs > since)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Remove os backups mais antigos da pasta do jogo quando passam do limite.
async function prune(dir, keep) {
  if (!keep || keep < 1) return;
  const files = (await fsp.readdir(dir))
    .filter(f => f.toLowerCase().endsWith('.zip'))
    .sort();                                   // nome comeca com a data, entao ordena cronologicamente
  const excess = files.length - keep;
  for (let i = 0; i < excess; i++) {
    await fsp.unlink(path.join(dir, files[i])).catch(() => {});
  }
}

/**
 * Compacta os memory cards em <mcdPath>/backups/<gameId>/.
 * O nome do arquivo comeca pela data, seguida do ID e do titulo da conquista.
 * `achievement` pode ser null para um backup manual.
 */
async function createBackup({ mcdPath, gameId, gameTitle, achievement, alsoUnlocked = 0, keep = 0, since = 0, waitTimeoutMs = 15000 }) {
  if (!mcdPath) throw new Error('Nenhuma pasta de memory cards configurada.');

  const cards = await listCards(mcdPath);
  if (!cards.length) throw new Error(`Nenhum memory card encontrado em ${mcdPath}`);

  const fresh = await waitFreshSave(cards, since, { timeoutMs: waitTimeoutMs });

  const dir = path.join(mcdPath, 'backups', String(gameId || 'sem-jogo'));
  await fsp.mkdir(dir, { recursive: true });

  const when = new Date();
  const tag = achievement
    ? `ach${achievement.id}_${slug(achievement.title)}`
    : 'manual';
  const suffix = alsoUnlocked > 0 ? `_mais${alsoUnlocked}` : '';
  const name = `${stamp(when)}_${tag}${suffix}.zip`;
  const dest = path.join(dir, name);

  const notes = [
    `Data: ${when.toLocaleString('pt-BR')}`,
    `Jogo: ${gameTitle || '?'} (ID ${gameId || '?'})`,
    achievement
      ? `Conquista: [${achievement.id}] ${achievement.title} (${achievement.points} pts)`
      : 'Backup manual',
    achievement?.description ? `Descrição: ${achievement.description}` : null,
    alsoUnlocked > 0 ? `Outras ${alsoUnlocked} conquistas saíram no mesmo ciclo.` : null,
    fresh ? null : 'Aviso: nenhuma gravação nova detectada a tempo; o cartão pode não refletir esta conquista ainda.',
    '',
    'Cartões incluídos:',
    ...cards.map(c => `  ${path.basename(c)}`)
  ].filter(Boolean).join('\n');

  const bytes = await zip(cards, dest, notes);
  await prune(dir, keep);

  return { file: dest, name, bytes, cards: cards.length, fresh };
}

module.exports = { createBackup, listCards };

/**
 * Maquina de estado do detector, isolada para ser testavel.
 * Devolve { action: 'seed' | 'newGame' | 'unlock' | 'none', unlocked: [...] }
 */
function classify(state, gameId, achievements, isEarnedFn) {
  const now = new Set(achievements.filter(isEarnedFn).map(a => a.ID));

  if (gameId !== state.gameId) {
    return { action: 'newGame', earned: now, unlocked: [] };
  }
  if (!state.seeded) {
    return { action: 'seed', earned: now, unlocked: [] };
  }
  const unlocked = achievements
    .filter(a => now.has(a.ID) && !state.earned.has(a.ID))
    .sort((a, b) => b.Points - a.Points);

  return { action: unlocked.length ? 'unlock' : 'none', earned: now, unlocked };
}

module.exports.classify = classify;

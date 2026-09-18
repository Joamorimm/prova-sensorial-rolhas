// Servidor da app "Prova Sensorial de Amostras de Rolhas" — Cork Supply Portugal
// Guarda os lotes numa base de dados Postgres (se DATABASE_URL estiver definida)
// ou, em alternativa, num ficheiro JSON local (pronto para um volume persistente
// no Railway) — e sincroniza todos os utilizadores ligados em tempo real via Socket.IO.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- Alerta por email: lote precisa do 3º provador ----------
// Só fica ativo se SMTP_HOST/SMTP_USER/SMTP_PASS e ALERT_EMAIL_TO estiverem definidos no Railway
// (Settings -> Variables). Sem isso, a app continua a funcionar normalmente — só não manda email
// (o aviso dentro da app, no ecrã Lotes e no separador Logística, continua a aparecer na mesma).
const SMTP_HOST = process.env.SMTP_HOST || '';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
let mailer = null;
if (SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', // true só para a porta 465
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
// proteção extra contra emails duplicados (o cliente já evita reenviar, isto é só uma rede de segurança
// dentro da mesma execução do servidor — reinicia-se quando o Railway reinicia o serviço)
const p3JaNotificados = new Set();

// ---------- Persistência: Postgres (preferido) ou ficheiro (fallback) ----------
// Se a variável de ambiente DATABASE_URL estiver definida (ex: ligando um serviço
// Postgres no Railway com ${{Postgres.DATABASE_URL}}), os lotes são guardados na
// base de dados. Caso contrário, usa-se um ficheiro JSON em DATA_DIR (ou pasta local).
const DATABASE_URL = process.env.DATABASE_URL || '';
let pool = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  // Ligações dentro da rede privada do Railway (*.railway.internal) não precisam de SSL.
  // Ligações externas (proxy público, outros fornecedores) normalmente precisam.
  const precisaSSL = !/localhost|127\.0\.0\.1|\.railway\.internal/i.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: precisaSSL ? { rejectUnauthorized: false } : false,
  });
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'lotes.json');
if (!pool && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Reset total no arranque (opcional, controlado pelo Railway) ----------
// Define a variável de ambiente WIPE_DATA_ON_START=true no Railway (Settings -> Variables) e
// reinicia o serviço uma vez: o servidor esvazia TODOS os lotes e o histórico de apagados
// (tombstones) logo ao arrancar, ficando pronto para um "dia 0" de importação — funciona quer
// os dados estejam em Postgres, quer em ficheiro. Não apaga a lista geral de Provadores.
// IMPORTANTE: depois de confirmares que a app está vazia, remove esta variável (ou põe "false")
// no Railway — caso contrário, o próximo reinício do serviço volta a esvaziar tudo outra vez.
const WIPE_DATA_ON_START = process.env.WIPE_DATA_ON_START === 'true';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lotes (
      numero TEXT PRIMARY KEY,
      dados JSONB NOT NULL,
      atualizado_em TEXT
    )
  `);
  // "Tombstones": nº de lote apagado + quando. Impede que um lote apagado seja
  // ressuscitado por um telemóvel/browser que ainda tenha uma cópia antiga em cache local
  // e a reenvie ao sincronizar (bug identificado em 17/09/2026 — lotes já limpos voltavam a aparecer).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lotes_removidos (
      numero TEXT PRIMARY KEY,
      removido_em TEXT NOT NULL
    )
  `);
  // Configuração partilhada (ex.: lista geral de provadores) — uma única linha por chave.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      chave TEXT PRIMARY KEY,
      valor JSONB NOT NULL,
      atualizado_em TEXT
    )
  `);
}

async function loadStore() {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT numero, dados FROM lotes');
      const lotes = {};
      rows.forEach((r) => { lotes[r.numero] = r.dados; });
      const removidos = {};
      try {
        const { rows: rowsRem } = await pool.query('SELECT numero, removido_em FROM lotes_removidos');
        rowsRem.forEach((r) => { removidos[r.numero] = r.removido_em; });
      } catch (e) {
        console.error('Erro a ler tombstones da base de dados, a começar vazio:', e.message);
      }
      let config = null;
      try {
        const { rows: rowsConfig } = await pool.query("SELECT valor, atualizado_em FROM app_config WHERE chave = 'provadores'");
        if (rowsConfig.length) config = { provadores: rowsConfig[0].valor, atualizadoEm: rowsConfig[0].atualizado_em };
      } catch (e) {
        console.error('Erro a ler configuração da base de dados, a começar vazio:', e.message);
      }
      return { lotes, removidos, config };
    } catch (e) {
      console.error('Erro a ler da base de dados, a começar vazio:', e.message);
      return { lotes: {}, removidos: {}, config: null };
    }
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.lotes) return { lotes: parsed.lotes, removidos: parsed.removidos || {}, config: parsed.config || null };
    }
  } catch (e) {
    console.error('Erro a ler ficheiro de dados, a começar vazio:', e.message);
  }
  return { lotes: {}, removidos: {}, config: null };
}

let store = { lotes: {}, removidos: {}, config: null };

// ---- Fallback em ficheiro (só usado quando não há Postgres) ----
let saveTimer = null;
function persistFile() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('Erro a guardar dados:', e.message);
    }
  }, 150);
}

// ---- Escrita por lote (usado com Postgres) ----
async function upsertLote(numero, lote) {
  if (pool) {
    await pool.query(
      `INSERT INTO lotes (numero, dados, atualizado_em) VALUES ($1, $2, $3)
       ON CONFLICT (numero) DO UPDATE SET dados = $2, atualizado_em = $3`,
      [numero, lote, lote.atualizadoEm || '']
    );
  } else {
    persistFile();
  }
}

async function deleteLoteStore(numero) {
  if (pool) {
    await pool.query('DELETE FROM lotes WHERE numero = $1', [numero]);
  } else {
    persistFile();
  }
}

// Regista, de forma persistente, que este lote foi apagado (e quando) — é o que impede
// que volte a aparecer se algum dispositivo ainda tiver uma cópia antiga guardada localmente.
async function marcarRemovido(numero, quando) {
  if (pool) {
    await pool.query(
      `INSERT INTO lotes_removidos (numero, removido_em) VALUES ($1, $2)
       ON CONFLICT (numero) DO UPDATE SET removido_em = $2`,
      [numero, quando]
    );
  } else {
    persistFile();
  }
}

// Quando um lote é (re)aceite com uma data mais recente do que a do tombstone, deixa de estar
// "apagado" — foi genuinamente recriado/reimportado depois disso (ex.: nº de lote reutilizado).
async function limparTombstone(numero) {
  if (pool) {
    await pool.query('DELETE FROM lotes_removidos WHERE numero = $1', [numero]);
  } else {
    persistFile();
  }
}

// Configuração partilhada (por ex., a lista geral de provadores) — guarda-se como uma única
// linha ("provadores"), com o mesmo mecanismo de "só aceita se for mais recente" dos lotes.
async function guardarConfigProvadores(provadores, atualizadoEm) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_config (chave, valor, atualizado_em) VALUES ('provadores', $1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = $2`,
      [JSON.stringify(provadores), atualizadoEm]
    );
  } else {
    persistFile();
  }
}

// ---------- Autenticação básica opcional ----------
// Define as variáveis de ambiente APP_USER e APP_PASS no Railway para pedir
// utilizador/password antes de abrir a app (recomendado, já que o link fica público).
if (process.env.APP_USER && process.env.APP_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization;
    if (hdr && hdr.startsWith('Basic ')) {
      const [u, p] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
      if (u === process.env.APP_USER && p === process.env.APP_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Prova Sensorial"');
    res.status(401).send('Autenticação necessária.');
  });
}

app.use(express.json({ limit: '10mb' })); // as fotos de etiqueta vão em base64, podem ser maiores
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API ----------
app.get('/api/lotes', (req, res) => {
  res.json({ lotes: store.lotes, removidos: store.removidos });
});

// O cliente envia sempre a sua coleção completa de lotes; o servidor só
// substitui, por lote, quando o que chega é mais recente (atualizadoEm),
// para não perder alterações feitas por outro utilizador entretanto.
// Nunca aceita de volta um lote que já foi apagado (tombstone em lotes_removidos) — a não ser
// que a versão que chega seja genuinamente mais recente do que o momento em que foi apagado,
// o que significa que foi recriado/reimportado de propósito depois disso.
app.put('/api/lotes', async (req, res) => {
  const incoming = (req.body && req.body.lotes) || {};
  const alterados = [];
  const tombstonesLimpos = [];
  Object.keys(incoming).forEach((numero) => {
    const novo = incoming[numero];
    const removidoEm = store.removidos[numero];
    if (removidoEm) {
      if ((novo.atualizadoEm || '') <= removidoEm) {
        return; // tentativa de ressuscitar um lote apagado — ignorado
      }
      delete store.removidos[numero];
      tombstonesLimpos.push(numero);
    }
    const atual = store.lotes[numero];
    if (!atual || (novo.atualizadoEm || '') > (atual.atualizadoEm || '')) {
      store.lotes[numero] = novo;
      alterados.push(numero);
    }
  });
  try {
    for (const numero of alterados) {
      await upsertLote(numero, store.lotes[numero]);
    }
    for (const numero of tombstonesLimpos) {
      await limparTombstone(numero);
    }
  } catch (e) {
    console.error('Erro a guardar no destino persistente:', e.message);
  }
  if (alterados.length || tombstonesLimpos.length) {
    io.emit('lotes:sync', { lotes: store.lotes, removidos: store.removidos });
  }
  res.json({ lotes: store.lotes, removidos: store.removidos });
});

app.delete('/api/lotes/:numero', async (req, res) => {
  const numero = req.params.numero;
  const agora = new Date().toISOString();
  const existia = !!store.lotes[numero];
  if (existia) delete store.lotes[numero];
  store.removidos[numero] = agora;
  try {
    if (existia) await deleteLoteStore(numero);
    await marcarRemovido(numero, agora);
  } catch (e) {
    console.error('Erro a apagar no destino persistente:', e.message);
  }
  io.emit('lotes:sync', { lotes: store.lotes, removidos: store.removidos });
  res.json({ ok: true });
});

// Avisa por email quando um lote passa a precisar do 3º provador (divergência entre Provador 1 e
// Provador 2 que a Revisão Conjunta não resolveu). O cliente só chama isto uma vez por lote.
app.post('/api/notify-provador3', async (req, res) => {
  const { numeroLote, prioridade } = req.body || {};
  if (!numeroLote) return res.status(400).json({ ok: false, erro: 'numeroLote em falta' });

  if (!mailer || !ALERT_EMAIL_TO) {
    return res.json({ ok: true, enviado: false, motivo: 'SMTP/ALERT_EMAIL_TO não configurados no Railway' });
  }
  if (p3JaNotificados.has(numeroLote)) {
    return res.json({ ok: true, enviado: false, motivo: 'já notificado nesta sessão do servidor' });
  }
  const prioridadeTxt = prioridade === 'vermelho' ? ' (prioridade: Urgente)' : (prioridade === 'amarelo' ? ' (prioridade: Prioritário)' : '');
  try {
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
      to: ALERT_EMAIL_TO,
      subject: `Prova Sensorial — lote ${numeroLote} precisa do 3º provador`,
      text: `O lote ${numeroLote}${prioridadeTxt} tem uma divergência entre o Provador 1 e o Provador 2 que a Revisão Conjunta não resolveu — é preciso o 3º provador.\n\nAbre a app "Prova Sensorial de Amostras de Rolhas" para o registar.`,
    });
    p3JaNotificados.add(numeroLote);
    res.json({ ok: true, enviado: true });
  } catch (e) {
    console.error('Erro a enviar email de alerta do 3º provador:', e.message);
    res.json({ ok: true, enviado: false, motivo: 'falha no envio' });
  }
});

// Lista geral de provadores (editável a partir do painel de administração da app, protegido por
// palavra-passe no cliente). "Último a gravar ganha" — não há por lote, é uma configuração única
// partilhada por todos.
app.get('/api/config', (req, res) => {
  res.json({ config: store.config });
});
app.put('/api/config', async (req, res) => {
  const provadores = (req.body && req.body.provadores) || [];
  const atualizadoEm = (req.body && req.body.atualizadoEm) || new Date().toISOString();
  if (!Array.isArray(provadores)) return res.status(400).json({ ok: false, erro: 'provadores tem de ser uma lista' });
  if (store.config && (store.config.atualizadoEm || '') > atualizadoEm) {
    // já existe uma versão mais recente no servidor — não perde a alteração de outro utilizador
    return res.json({ config: store.config });
  }
  store.config = { provadores, atualizadoEm };
  try {
    await guardarConfigProvadores(provadores, atualizadoEm);
  } catch (e) {
    console.error('Erro a guardar configuração no destino persistente:', e.message);
  }
  io.emit('config:sync', { config: store.config });
  res.json({ config: store.config });
});

io.on('connection', (socket) => {
  // ao ligar, cada utilizador recebe já o estado atual
  socket.emit('lotes:sync', { lotes: store.lotes, removidos: store.removidos });
  socket.emit('config:sync', { config: store.config });
});

async function start() {
  if (pool) {
    await initDb();
  }
  store = await loadStore();

  if (WIPE_DATA_ON_START) {
    console.log('⚠️  WIPE_DATA_ON_START=true — a esvaziar todos os lotes e o histórico de apagados (mantém a lista de Provadores)...');
    store.lotes = {};
    store.removidos = {};
    try {
      if (pool) {
        await pool.query('TRUNCATE lotes, lotes_removidos');
      } else {
        persistFile();
      }
      console.log('✅ Base de dados esvaziada — pronta para o dia 0 de importação. LEMBRA-TE de remover a variável WIPE_DATA_ON_START no Railway (ou pôr "false") para o próximo reinício não voltar a esvaziar tudo.');
    } catch (e) {
      console.error('Erro ao esvaziar a base de dados no arranque:', e.message);
    }
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Prova Sensorial — servidor a correr na porta ${PORT}`);
    console.log(pool
      ? 'A guardar dados em Postgres (DATABASE_URL definido).'
      : 'A guardar dados em ficheiro local/volume (DATABASE_URL não definido).');
    if (!process.env.APP_USER) console.log('(Sem APP_USER/APP_PASS definidos — a app fica acessível a quem tiver o link.)');
  });
}

start().catch((e) => {
  console.error('Falha a iniciar o servidor:', e);
  process.exit(1);
});

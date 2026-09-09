// Servidor da app "Prova Sensorial de Amostras de Rolhas" — Cork Supply Portugal
// Guarda os lotes numa base de dados Postgres (se DATABASE_URL estiver definida)
// ou, em alternativa, num ficheiro JSON local (pronto para um volume persistente
// no Railway) — e sincroniza todos os utilizadores ligados em tempo real via Socket.IO.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lotes (
      numero TEXT PRIMARY KEY,
      dados JSONB NOT NULL,
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
      return { lotes };
    } catch (e) {
      console.error('Erro a ler da base de dados, a começar vazio:', e.message);
      return { lotes: {} };
    }
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.lotes) return parsed;
    }
  } catch (e) {
    console.error('Erro a ler ficheiro de dados, a começar vazio:', e.message);
  }
  return { lotes: {} };
}

let store = { lotes: {} };

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
  res.json({ lotes: store.lotes });
});

// O cliente envia sempre a sua coleção completa de lotes; o servidor só
// substitui, por lote, quando o que chega é mais recente (atualizadoEm),
// para não perder alterações feitas por outro utilizador entretanto.
app.put('/api/lotes', async (req, res) => {
  const incoming = (req.body && req.body.lotes) || {};
  const alterados = [];
  Object.keys(incoming).forEach((numero) => {
    const atual = store.lotes[numero];
    const novo = incoming[numero];
    if (!atual || (novo.atualizadoEm || '') > (atual.atualizadoEm || '')) {
      store.lotes[numero] = novo;
      alterados.push(numero);
    }
  });
  if (alterados.length) {
    try {
      for (const numero of alterados) {
        await upsertLote(numero, store.lotes[numero]);
      }
    } catch (e) {
      console.error('Erro a guardar no destino persistente:', e.message);
    }
    io.emit('lotes:sync', { lotes: store.lotes });
  }
  res.json({ lotes: store.lotes });
});

app.delete('/api/lotes/:numero', async (req, res) => {
  if (store.lotes[req.params.numero]) {
    delete store.lotes[req.params.numero];
    try {
      await deleteLoteStore(req.params.numero);
    } catch (e) {
      console.error('Erro a apagar no destino persistente:', e.message);
    }
    io.emit('lotes:sync', { lotes: store.lotes });
  }
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // ao ligar, cada utilizador recebe já o estado atual
  socket.emit('lotes:sync', { lotes: store.lotes });
});

async function start() {
  if (pool) {
    await initDb();
  }
  store = await loadStore();

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

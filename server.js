// Servidor da app "Prova Sensorial de Amostras de Rolhas" — Cork Supply Portugal
// Guarda os lotes num ficheiro JSON (pronto para um volume persistente no Railway)
// e sincroniza todos os utilizadores ligados em tempo real via Socket.IO.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- Persistência ----------
// Define DATA_DIR como o caminho do teu volume persistente no Railway (ex: /data)
// para os dados sobreviverem a reinícios/deploys. Sem isso, usa uma pasta local.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'lotes.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
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

let store = loadStore();
let saveTimer = null;
function persist() {
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
app.put('/api/lotes', (req, res) => {
  const incoming = (req.body && req.body.lotes) || {};
  let mudou = false;
  Object.keys(incoming).forEach((numero) => {
    const atual = store.lotes[numero];
    const novo = incoming[numero];
    if (!atual || (novo.atualizadoEm || '') > (atual.atualizadoEm || '')) {
      store.lotes[numero] = novo;
      mudou = true;
    }
  });
  if (mudou) {
    persist();
    io.emit('lotes:sync', { lotes: store.lotes });
  }
  res.json({ lotes: store.lotes });
});

app.delete('/api/lotes/:numero', (req, res) => {
  if (store.lotes[req.params.numero]) {
    delete store.lotes[req.params.numero];
    persist();
    io.emit('lotes:sync', { lotes: store.lotes });
  }
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  // ao ligar, cada utilizador recebe já o estado atual
  socket.emit('lotes:sync', { lotes: store.lotes });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Prova Sensorial — servidor a correr na porta ${PORT}`);
  if (!process.env.APP_USER) console.log('(Sem APP_USER/APP_PASS definidos — a app fica acessível a quem tiver o link.)');
});

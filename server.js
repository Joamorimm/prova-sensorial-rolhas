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

// ---------- Cópia de segurança diária: SharePoint da empresa (preferido) ou email (30/09/2026, a
// pedido da Joana) ----------
// Todos os dias, a uma hora configurável, o servidor gera um CSV + um JSON com os lotes do dia
// (ainda por decidir + fechados hoje) e grava-os diretamente numa pasta de um site do SharePoint da
// empresa, via Microsoft Graph. Fica fora do Railway por completo — mesmo que a base de dados, o
// serviço ou todos os telemóveis falhem ao mesmo tempo, o dia continua recuperável a partir dessa
// pasta. Se o SharePoint ainda não estiver configurado (ou a gravação falhar), tenta enviar por
// email como alternativa (usando o mesmo SMTP dos alertas do 3º provador).
//
// IMPORTANTE (decisão de propósito, 30/09/2026): isto está ligado a um SITE DO SHAREPOINT DA
// EMPRESA — não à conta pessoal/OneDrive de ninguém. A Joana vai sair da empresa e não faz sentido
// nenhum backup automático depender da conta dela (ou da de qualquer outra pessoa em concreto):
// quando essa pessoa saísse, a conta seria desativada e o backup parava de funcionar sem ninguém dar
// por isso. Ligado ao SharePoint da empresa, continua a funcionar sempre, independentemente de quem
// lá trabalha — é a app (registada no Azure da empresa) a aceder a um recurso da empresa, não uma
// pessoa a aceder à sua própria conta.
//
// Passos (só alguém com acesso de administrador do Microsoft 365 da empresa consegue fazer isto —
// é comum ser alguém do departamento de TI):
//   1. https://portal.azure.com -> Microsoft Entra ID -> App registrations -> New registration
//      (nome, ex.: "Prova Sensorial - Backup"; Accounts in this organizational directory only).
//   2. Nessa app: API permissions -> Add a permission -> Microsoft Graph -> Application permissions
//      -> procurar e marcar "Sites.ReadWrite.All" -> Add permissions -> "Grant admin consent" (só um
//      admin consegue clicar neste botão). (Sites.ReadWrite.All é o equivalente do Files.ReadWrite.All
//      mas para SharePoint, em vez de para OneDrives pessoais.)
//   3. Certificates & secrets -> New client secret -> copiar o VALOR imediatamente (só aparece uma vez).
//   4. Na página "Overview" dessa app: copiar o "Application (client) ID" e o "Directory (tenant) ID".
//   5. Escolher (ou criar) o site do SharePoint onde os backups vão ficar (ex.: um site de equipa
//      "Qualidade" ou "Prova Sensorial") e anotar o endereço, ex.:
//      https://corksupply.sharepoint.com/sites/QualidadeRolhas
//      -> hostname: corksupply.sharepoint.com · caminho do site: /sites/QualidadeRolhas
//   6. No Railway (Settings -> Variables), define:
//        SHAREPOINT_TENANT_ID       — o Directory (tenant) ID
//        SHAREPOINT_CLIENT_ID       — o Application (client) ID
//        SHAREPOINT_CLIENT_SECRET   — o valor do client secret criado no passo 3
//        SHAREPOINT_SITE_HOSTNAME   — ex.: corksupply.sharepoint.com
//        SHAREPOINT_SITE_PATH       — ex.: /sites/QualidadeRolhas
//        SHAREPOINT_FOLDER_PATH     — pasta dentro da biblioteca de documentos desse site (por
//                                     omissão "ProvaSensorial/Backups"; criada sozinha se não existir)
// Sem estas variáveis, a app continua a funcionar normalmente e tenta só o email (BACKUP_EMAIL_TO).
//   BACKUP_EMAIL_TO  — destinatário do backup por email, se o SharePoint não estiver configurado (ou
//                      falhar) — por omissão, usa ALERT_EMAIL_TO
//   BACKUP_HORA      — hora do dia (Europa/Lisboa, formato "HH:mm") a partir da qual é gerado o
//                      backup, assim que o servidor verificar depois dessa hora (por omissão "23:50")
const SHAREPOINT_TENANT_ID = process.env.SHAREPOINT_TENANT_ID || '';
const SHAREPOINT_CLIENT_ID = process.env.SHAREPOINT_CLIENT_ID || '';
const SHAREPOINT_CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET || '';
const SHAREPOINT_SITE_HOSTNAME = process.env.SHAREPOINT_SITE_HOSTNAME || '';
const SHAREPOINT_SITE_PATH = process.env.SHAREPOINT_SITE_PATH || '';
const SHAREPOINT_FOLDER_PATH = (process.env.SHAREPOINT_FOLDER_PATH || 'ProvaSensorial/Backups').replace(/^\/+|\/+$/g, '');
const SHAREPOINT_CONFIGURADO = !!(SHAREPOINT_TENANT_ID && SHAREPOINT_CLIENT_ID && SHAREPOINT_CLIENT_SECRET && SHAREPOINT_SITE_HOSTNAME && SHAREPOINT_SITE_PATH);
const BACKUP_EMAIL_TO = process.env.BACKUP_EMAIL_TO || ALERT_EMAIL_TO;
const BACKUP_HORA = process.env.BACKUP_HORA || '23:50';

// Autenticação "app-only" (client credentials) — a app entra em nome dela própria, nunca em nome de
// uma pessoa, por isso o "Grant admin consent" do passo 2 acima é obrigatório e não expira quando
// alguém sai da empresa.
async function obterTokenSharePoint() {
  const url = `https://login.microsoftonline.com/${SHAREPOINT_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: SHAREPOINT_CLIENT_ID,
    client_secret: SHAREPOINT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`token Microsoft Graph: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}
// Resolve o ID interno do site do SharePoint a partir do hostname + caminho (só muda se o site for
// recriado, por isso é seguro guardar em memória entre chamadas, para não pedir isto sempre).
let sharepointSiteIdCache = null;
async function obterSiteIdSharePoint(token) {
  if (sharepointSiteIdCache) return sharepointSiteIdCache;
  const url = `https://graph.microsoft.com/v1.0/sites/${SHAREPOINT_SITE_HOSTNAME}:${SHAREPOINT_SITE_PATH}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`resolver site do SharePoint: ${res.status} ${await res.text()}`);
  const data = await res.json();
  sharepointSiteIdCache = data.id;
  return sharepointSiteIdCache;
}
// Grava um ficheiro na pasta configurada da biblioteca de documentos desse site (cria a pasta
// sozinho, o endpoint "root:/caminho/ficheiro:/content" trata disso). Ficheiros pequenos (<4MB, como
// estes) sobem numa única chamada PUT — não precisa de upload em pedaços.
async function gravarFicheiroSharePoint(token, siteId, nomeFicheiro, conteudo, tipo) {
  const caminho = `${SHAREPOINT_FOLDER_PATH}/${nomeFicheiro}`;
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${caminho.split('/').map(encodeURIComponent).join('/')}:/content`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': tipo },
    body: conteudo,
  });
  if (!res.ok) throw new Error(`gravar "${nomeFicheiro}" no SharePoint: ${res.status} ${await res.text()}`);
}
async function enviarBackupParaSharePoint(dia, csv, jsonCompleto) {
  if (!SHAREPOINT_CONFIGURADO) return { enviado: false, motivo: 'SharePoint não configurado (ver comentário no topo do ficheiro para as variáveis necessárias)' };
  try {
    const token = await obterTokenSharePoint();
    const siteId = await obterSiteIdSharePoint(token);
    await gravarFicheiroSharePoint(token, siteId, `prova-sensorial-backup-${dia}.csv`, csv, 'text/csv');
    await gravarFicheiroSharePoint(token, siteId, `prova-sensorial-backup-${dia}.json`, jsonCompleto, 'application/json');
    return { enviado: true };
  } catch (e) {
    console.error('Erro a gravar o backup diário no SharePoint:', e.message);
    return { enviado: false, motivo: 'falha no SharePoint: ' + e.message };
  }
}

function hojeStrLisboa(d) {
  // formata em Europa/Lisboa (não no fuso do servidor, normalmente UTC no Railway), para bater
  // certo com o "hoje" que os provadores veem na app; en-CA dá diretamente o formato AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function horaAtualLisboa(d) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit', hour12: false }).format(d || new Date());
}
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Os lotes que interessa proteger no backup de um dia: os ainda por decidir (de qualquer dia —
// espelha lotesDeHoje() no cliente) e os já fechados NESSE dia (decisao.data) — os restantes já
// ficaram fechados antes e já saíram num backup de um dia anterior.
function lotesDoDiaParaBackup(lotesObj, dia) {
  const out = {};
  Object.keys(lotesObj || {}).forEach((numero) => {
    const l = lotesObj[numero];
    const d = l && l.decisao;
    if (!d || !d.final || d.data === dia) out[numero] = l;
  });
  return out;
}
function construirCsvBackupDiario(lotesObj) {
  const cols = ['numero', 'prioridade', 'diaPrevisto', 'provador1', 'provador2', 'provador3',
    'decisaoFinal', 'decisaoData', 'temFrascosParaLevantar', 'comentariosDecisao',
    'observacoesP1', 'observacoesP2', 'observacoesP3'];
  const linhas = [cols.join(',')];
  Object.keys(lotesObj || {}).sort().forEach((numero) => {
    const l = lotesObj[numero] || {};
    const d = l.decisao || {};
    const r1 = (l.registos && l.registos.p1) || {};
    const r2 = (l.registos && l.registos.p2) || {};
    const r3 = (l.registos && l.registos.p3) || {};
    linhas.push([
      numero, l.prioridade || '', l.diaPrevisto || '', l.provador1 || '', l.provador2 || '', l.provador3 || '',
      d.final || '', d.data || '', d.temFrascosParaLevantar ? 'sim' : 'não', d.comentarios || '',
      r1.observacoes || '', r2.observacoes || '', r3.observacoes || '',
    ].map(csvEscape).join(','));
  });
  return linhas.join('\n');
}
async function enviarBackupPorEmail(dia, csv, jsonCompleto, motivo) {
  if (!mailer) return { enviado: false, motivo: 'SMTP não configurado (SMTP_HOST/SMTP_USER/SMTP_PASS)' };
  if (!BACKUP_EMAIL_TO) return { enviado: false, motivo: 'sem destinatário (BACKUP_EMAIL_TO/ALERT_EMAIL_TO)' };
  try {
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
      to: BACKUP_EMAIL_TO,
      subject: `Prova Sensorial — cópia de segurança do dia ${dia} (${motivo || 'agendado'})`,
      text: `Em anexo, a cópia de segurança dos lotes de ${dia} (ainda por decidir + fechados hoje).\n\nEsta cópia é gerada automaticamente para recuperação em caso de falha. Chegou por email porque o SharePoint não está configurado (ou falhou nesta tentativa) — ver SHAREPOINT_* no topo do server.js.`,
      attachments: [
        { filename: `prova-sensorial-backup-${dia}.csv`, content: csv },
        { filename: `prova-sensorial-backup-${dia}.json`, content: jsonCompleto },
      ],
    });
    return { enviado: true };
  } catch (e) {
    console.error('Erro a enviar o backup diário por email:', e.message);
    return { enviado: false, motivo: 'falha no envio: ' + e.message };
  }
}
// Gera o backup do dia e tenta gravá-lo primeiro no SharePoint; só se isso não estiver configurado
// ou falhar é que tenta o email como alternativa — para nunca ficar sem nenhuma cópia de segurança.
// Nunca lança erro para fora — devolve sempre {enviado, via, motivo/total}, para quem chamar decidir.
async function enviarBackupDiario(motivo) {
  const dia = hojeStrLisboa();
  const lotesDia = lotesDoDiaParaBackup(store.lotes, dia);
  const total = Object.keys(lotesDia).length;
  const csv = construirCsvBackupDiario(lotesDia);
  const jsonCompleto = JSON.stringify({ dia, lotes: lotesDia }, null, 2);

  // Opção B (01/10/2026): grava sempre localmente primeiro, independentemente de SharePoint/email
  // estarem configurados ou funcionarem — é a rede de segurança que nunca depende de nada externo.
  const guardadoLocalmente = gravarBackupLocal(dia, csv, jsonCompleto);

  const viaSharePoint = await enviarBackupParaSharePoint(dia, csv, jsonCompleto);
  if (viaSharePoint.enviado) return { enviado: true, via: 'sharepoint', dia, total, guardadoLocalmente };

  const viaEmail = await enviarBackupPorEmail(dia, csv, jsonCompleto, motivo);
  if (viaEmail.enviado) return { enviado: true, via: 'email', dia, total, avisoSharePoint: viaSharePoint.motivo, guardadoLocalmente };

  // Mesmo sem SharePoint nem email, se pelo menos ficou gravado localmente já não é um falhanço
  // completo — os dados continuam recuperáveis a partir do próprio Railway.
  return { enviado: guardadoLocalmente, via: guardadoLocalmente ? 'local' : undefined, dia, total, motivoSharePoint: viaSharePoint.motivo, motivoEmail: viaEmail.motivo, guardadoLocalmente };
}
// Verifica, de tempos a tempos, se já passou da hora combinada (BACKUP_HORA) e ainda não foi feito
// o backup de hoje — corre uma vez a seguir ao arranque e depois a cada 10 minutos. O registo de
// "já feito hoje" fica persistido (store.backupDiario), tal como os lotes, para não repetir o mesmo
// dia outra vez caso o serviço reinicie depois da hora combinada.
async function verificarBackupDiarioAgendado() {
  // 01/10/2026: já não há "return" por falta de SharePoint/email — a cópia local (Opção B) não
  // depende de nenhum dos dois, por isso o backup diário agendado corre sempre.
  const dia = hojeStrLisboa();
  if (store.backupDiario && store.backupDiario.data === dia) return; // já feito hoje
  if (horaAtualLisboa() < BACKUP_HORA) return; // ainda não chegou a hora
  const resultado = await enviarBackupDiario('agendado');
  if (resultado.enviado) {
    store.backupDiario = { data: dia, enviadoEm: new Date().toISOString(), via: resultado.via };
    try {
      await guardarUltimoBackupDiario(store.backupDiario);
    } catch (e) {
      console.error('Erro a guardar o registo do backup diário:', e.message);
    }
  } else {
    console.warn('Backup diário agendado não foi feito — SharePoint:', resultado.motivoSharePoint, '| Email:', resultado.motivoEmail);
  }
}

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

// ---------- Cópia de segurança diária — Opção B: guardar sempre uma cópia dentro da própria app
// (01/10/2026, a pedido da Joana, depois de descobrirmos que o SMTP da empresa ainda não está
// configurado): mesmo sem SharePoint nem email prontos, o backup do dia fica sempre gravado aqui,
// sem precisar de nenhuma conta nem acesso de administrador — é só um ficheiro em disco. Pode ser
// descarregado a partir da própria app (ecrã Logística -> "Backups diários").
// IMPORTANTE para sobreviver a reinícios/deploys do Railway: esta pasta precisa de estar dentro de um
// Volume persistente ligado ao serviço (Railway -> serviço da app -> Settings -> Volumes -> Add Volume,
// ex. mount path "/data") e a variável BACKUPS_DIR definida para lá apontar (ex.
// BACKUPS_DIR=/data/backups). Sem Volume, os ficheiros continuam a poder ser descarregados até ao
// próximo deploy/reinício do serviço, mas depois perdem-se (tal como aconteceria com qualquer ficheiro
// local no Railway sem Volume).
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
// Só aceita datas no formato AAAA-MM-DD, para nunca deixar escolher um caminho de ficheiro arbitrário
// a partir do nome recebido no pedido (proteção simples contra path traversal).
function diaValido(dia) {
  return typeof dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dia);
}
function gravarBackupLocal(dia, csv, jsonCompleto) {
  try {
    fs.writeFileSync(path.join(BACKUPS_DIR, `${dia}.csv`), csv, 'utf8');
    fs.writeFileSync(path.join(BACKUPS_DIR, `${dia}.json`), jsonCompleto, 'utf8');
    return true;
  } catch (e) {
    console.error('Erro a gravar o backup diário localmente (BACKUPS_DIR):', e.message);
    return false;
  }
}
function listarBackupsLocais() {
  try {
    const ficheiros = fs.readdirSync(BACKUPS_DIR);
    const porDia = {};
    ficheiros.forEach((nome) => {
      const m = nome.match(/^(\d{4}-\d{2}-\d{2})\.(csv|json)$/);
      if (!m) return;
      const [, dia, ext] = m;
      if (!porDia[dia]) porDia[dia] = { dia, csv: false, json: false };
      porDia[dia][ext] = true;
    });
    return Object.values(porDia).sort((a, b) => b.dia.localeCompare(a.dia));
  } catch (e) {
    return [];
  }
}

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
      let backupDiario = null;
      try {
        const { rows: rowsBackup } = await pool.query("SELECT valor FROM app_config WHERE chave = 'backupDiario'");
        if (rowsBackup.length) backupDiario = rowsBackup[0].valor;
      } catch (e) {
        console.error('Erro a ler o registo do backup diário da base de dados:', e.message);
      }
      let auditoria = [];
      try {
        const { rows: rowsAuditoria } = await pool.query("SELECT valor FROM app_config WHERE chave = 'auditoria'");
        if (rowsAuditoria.length && Array.isArray(rowsAuditoria[0].valor)) auditoria = rowsAuditoria[0].valor;
      } catch (e) {
        console.error('Erro a ler o registo de atividade da base de dados:', e.message);
      }
      return { lotes, removidos, config, backupDiario, auditoria };
    } catch (e) {
      console.error('Erro a ler da base de dados, a começar vazio:', e.message);
      return { lotes: {}, removidos: {}, config: null, backupDiario: null, auditoria: [] };
    }
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.lotes) return { lotes: parsed.lotes, removidos: parsed.removidos || {}, config: parsed.config || null, backupDiario: parsed.backupDiario || null, auditoria: parsed.auditoria || [] };
    }
  } catch (e) {
    console.error('Erro a ler ficheiro de dados, a começar vazio:', e.message);
  }
  return { lotes: {}, removidos: {}, config: null, backupDiario: null, auditoria: [] };
}

let store = { lotes: {}, removidos: {}, config: null, backupDiario: null, auditoria: [] };

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

// Guarda o registo de "já foi enviado o backup diário do dia X" — evita reenviar o mesmo dia outra
// vez se o serviço reiniciar depois da hora combinada (ver verificarBackupDiarioAgendado).
async function guardarUltimoBackupDiario(info) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_config (chave, valor, atualizado_em) VALUES ('backupDiario', $1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = $2`,
      [JSON.stringify(info), info.enviadoEm]
    );
  } else {
    persistFile(); // store.backupDiario já foi atualizado antes de chamar isto — persistFile grava o store inteiro
  }
}

// ---------- Registo de atividade (01/10/2026, a pedido da Joana) ----------
// Separado do código de supervisão (ADMIN_PASSWORD "8126" no index.html, que continua a servir só
// para editar informações do lote) — este é um login próprio, com nome + password individual para
// cada uma das pessoas, usado especificamente para ações sobre os BACKUPS/RESTAURO (e outras ações
// sensíveis semelhantes que venham a precisar do mesmo nível de rastreio). Cada vez que uma destas
// ações é usada, fica guardado quem foi, quando e o quê — consultável no ecrã "Registo de Atividade"
// dentro da app (Mais Opções). Guarda sempre as últimas 300 entradas (mais antigas vão caindo).
async function guardarAuditoria(lista) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_config (chave, valor, atualizado_em) VALUES ('auditoria', $1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = $2`,
      [JSON.stringify(lista), new Date().toISOString()]
    );
  } else {
    persistFile(); // store.auditoria já foi atualizado antes de chamar isto
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

// Rota de teste manual do backup diário — útil para confirmar que o email chega, sem esperar pela
// hora agendada. Protegida pela mesma autenticação básica (APP_USER/APP_PASS), se estiver definida.
app.post('/api/backup-diario/enviar-agora', async (req, res) => {
  const resultado = await enviarBackupDiario('manual, a pedido');
  res.json(resultado);
});

// Opção B (01/10/2026): lista os backups diários guardados localmente (BACKUPS_DIR), para a app
// mostrar um ecrã simples de onde descarregar qualquer dia disponível — sem precisar de SharePoint
// nem de email configurados.
app.get('/api/backup-diario/listar', (req, res) => {
  res.json({ backups: listarBackupsLocais() });
});
// Descarrega o ficheiro de um dia específico (csv ou json). "dia" tem de bater com AAAA-MM-DD —
// qualquer outro formato é recusado, para nunca ler um caminho fora de BACKUPS_DIR.
app.get('/api/backup-diario/:dia/download', (req, res) => {
  const dia = req.params.dia;
  const formato = req.query.formato === 'json' ? 'json' : 'csv';
  if (!diaValido(dia)) return res.status(400).json({ erro: 'data inválida — usa o formato AAAA-MM-DD' });
  const ficheiro = path.join(BACKUPS_DIR, `${dia}.${formato}`);
  if (!fs.existsSync(ficheiro)) return res.status(404).json({ erro: `não há backup de ${dia} em formato ${formato}` });
  res.download(ficheiro, `prova-sensorial-backup-${dia}.${formato}`);
});

// Lista as últimas entradas do registo de atividade (mais recente primeiro).
app.get('/api/auditoria', (req, res) => {
  const lista = (store.auditoria || []).slice().reverse();
  res.json({ auditoria: lista });
});
// Regista uma nova ação sensível (ex.: restaurar um backup) — nome e password já vêm validados pelo
// cliente (ver ADMIN_USERS no index.html; é um travão de front-end, tal como o código 8126 — não é
// segurança real, serve para rastreio e para desencorajar quem não deveria estar a mexer nisto).
app.post('/api/auditoria', async (req, res) => {
  const nome = (req.body && req.body.nome || '').trim();
  const acao = (req.body && req.body.acao || '').trim();
  const detalhe = (req.body && req.body.detalhe || '').trim();
  if (!nome || !acao) return res.status(400).json({ ok: false, erro: 'nome e ação são obrigatórios' });
  const entrada = { nome, acao, detalhe, quando: new Date().toISOString() };
  store.auditoria = store.auditoria || [];
  store.auditoria.push(entrada);
  if (store.auditoria.length > 300) store.auditoria = store.auditoria.slice(-300);
  try {
    await guardarAuditoria(store.auditoria);
  } catch (e) {
    console.error('Erro a guardar o registo de atividade:', e.message);
  }
  res.json({ ok: true, entrada });
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
    if (SHAREPOINT_CONFIGURADO) {
      console.log(`Backup diário ativo — grava no SharePoint (${SHAREPOINT_SITE_HOSTNAME}${SHAREPOINT_SITE_PATH}, pasta "${SHAREPOINT_FOLDER_PATH}"), a partir das ${BACKUP_HORA} (hora de Lisboa)${(mailer && BACKUP_EMAIL_TO) ? ', com email como alternativa se falhar.' : '.'}`);
    } else if (mailer && BACKUP_EMAIL_TO) {
      console.log(`Backup diário ativo — por email (destinatário: ${BACKUP_EMAIL_TO}), a partir das ${BACKUP_HORA} (hora de Lisboa). SharePoint ainda não configurado (ver comentário SHAREPOINT_* no topo do server.js).`);
    } else {
      console.log(`Backup diário — SharePoint e email ainda não configurados; a gravar só localmente (BACKUPS_DIR="${BACKUPS_DIR}"), a partir das ${BACKUP_HORA} (hora de Lisboa). Descarregável em "Backups diários" (ecrã Logística). Para sobreviver a reinícios do Railway, liga um Volume persistente a esta pasta (ver comentário BACKUPS_DIR no topo do server.js).`);
    }
  });
  // 1ª verificação pouco depois de arrancar (cobre o caso de reiniciar já depois da hora combinada),
  // e depois a cada 10 minutos.
  setTimeout(verificarBackupDiarioAgendado, 30 * 1000);
  setInterval(verificarBackupDiarioAgendado, 10 * 60 * 1000);
}

start().catch((e) => {
  console.error('Falha a iniciar o servidor:', e);
  process.exit(1);
});

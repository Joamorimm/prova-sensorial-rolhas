// Script de teste (não faz parte da app): confirma sincronização em tempo real entre
// dois "utilizadores" ligados, o guard por atualizadoEm, e o delete a propagar.
const { io } = require('socket.io-client');

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const clienteA = io('http://127.0.0.1:3000');
  const clienteB = io('http://127.0.0.1:3000');

  let ultimoBSync = null;
  clienteB.on('lotes:sync', (payload) => { ultimoBSync = payload; });

  await wait(800); // esperar ligacoes + sync inicial

  console.log('B recebeu sync inicial?', !!ultimoBSync);

  // A "utilizadora 1" cria/atualiza um lote via API (como o browser faria)
  const r1 = await fetch('http://127.0.0.1:3000/api/lotes', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ lotes: { 'LT-SYNC-1': {
      numeroLote: 'LT-SYNC-1', atualizadoEm: new Date().toISOString(),
      registos:{p1:{itens:[],concluido:true},p2:{itens:[],concluido:false},tania:{concluido:false}},
      decisao:{final:null}
    }}})
  });
  await r1.json();

  await wait(500); // dar tempo ao socket B de receber o evento

  console.log('B recebeu (em tempo real) o novo lote criado por A?', !!(ultimoBSync && ultimoBSync.lotes && ultimoBSync.lotes['LT-SYNC-1']));

  // Guard de timestamp: tentar sobrepor com uma versao MAIS ANTIGA nao deve alterar nada
  const antigo = await fetch('http://127.0.0.1:3000/api/lotes', {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ lotes: { 'LT-SYNC-1': {
      numeroLote: 'LT-SYNC-1', atualizadoEm: '2000-01-01T00:00:00.000Z',
      registos:{p1:{itens:[],concluido:false},p2:{itens:[],concluido:false},tania:{concluido:false}},
      decisao:{final:null}
    }}})
  });
  const antigoJson = await antigo.json();
  console.log('P1 concluido continua true (guard funcionou, nao deixou versao antiga sobrepor)?', antigoJson.lotes['LT-SYNC-1'].registos.p1.concluido === true);

  // Delete propaga por socket
  await fetch('http://127.0.0.1:3000/api/lotes/LT-SYNC-1', { method:'DELETE' });
  await wait(500);
  console.log('B recebeu o delete (lote deixou de estar no sync)?', !(ultimoBSync && ultimoBSync.lotes && ultimoBSync.lotes['LT-SYNC-1']));

  clienteA.close(); clienteB.close();
  process.exit(0);
})().catch(e=>{ console.error('EXCEPTION:', e); process.exit(1); });

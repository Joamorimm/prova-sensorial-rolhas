const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('OK   -', label); }
  else { fail++; console.log('FAIL -', label); }
}

const alerts = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'http://localhost/'
});
const { window } = dom;
window.fetch = () => Promise.reject(new Error('sem rede no teste'));
window.alert = (msg) => { alerts.push(msg); };
window.confirm = () => true;
window.localStorage.clear();

function lastAlert() { return alerts[alerts.length - 1] || ''; }

// espera o script principal correr (é síncrono no load, mas hydrate() é async)
setTimeout(() => {
  run();
}, 300);

function run() {
  const w = window;

  // ---------- 1) Apreciação Geral / Observações deixam de ser obrigatórias ----------
  w.eval(`state.lotes = {}; saveState();`);
  w.eval(`state.lotes['LT0001'] = criarLoteVazio('LT0001'); state.lotes['LT0001'].diaPrevisto = ontemStr(); saveState();`);
  w.eval(`ctxLote='LT0001'; ctxProvador='p1';`);
  // monta o modal de registo real para termos o textarea fObsRegisto no DOM
  w.eval(`openRegistoModal('LT0001','p1');`);
  const semApreciacao = w.eval(`concluirRegisto(); state.lotes['LT0001'].registos.p1.concluido && state.lotes['LT0001'].registos.p1.apreciacao==='';`);
  ok(semApreciacao === true, 'concluirRegisto() sem apreciação selecionada conclui na mesma (deixou de ser obrigatória)');

  // ---------- 2) Bloqueio de provador repetido ----------
  w.eval(`state.lotes = {}; saveState();`);
  w.eval(`state.lotes['LT0002'] = criarLoteVazio('LT0002'); state.lotes['LT0002'].diaPrevisto = ontemStr(); saveState();`);
  w.eval(`state.lotes['LT0002'].provador1='Ana Catarina Silva'; state.lotes['LT0002'].registos.p1={itens:[],apreciacao:'limpo',observacoes:'',concluido:true,assinadoEm:new Date(Date.now()-3600000).toISOString()};`);
  alerts.length = 0;
  w.eval(`confirmarEntradaProvadorTeste = function(numero, nome){
    const lote = state.lotes[numero];
    const slot = proximoSlotProva(lote);
    if(!slot) return 'sem-slot';
    document.getElementById('modalRoot').innerHTML = '<input id=\\'fNomeEntrada_tmp\\'>';
    if(nomesJaUsados(lote, slot).includes(nome)) return 'bloqueado';
    return 'ok:'+slot;
  };`);
  const repetido = w.eval(`confirmarEntradaProvadorTeste('LT0002', 'Ana Catarina Silva')`);
  ok(repetido === 'bloqueado', 'Provador que já assinou P1 é bloqueado de entrar como P2 no mesmo lote');
  const outraPessoa = w.eval(`confirmarEntradaProvadorTeste('LT0002', 'Francisca Braga')`);
  ok(outraPessoa === 'ok:p2', 'Provador diferente é aceite para o próximo lugar (P2)');

  // ---------- 3) Tempo mínimo de 30 minutos entre provadores ----------
  w.eval(`state.lotes['LT0002'].registos.p1.assinadoEm = new Date().toISOString();`); // agora mesmo
  const faltamAgora = w.eval(`tempoEsperaProvador(state.lotes['LT0002'], 'p2')`);
  ok(faltamAgora > 0 && faltamAgora <= 30, 'Menos de 30 min desde a assinatura do Provador 1 bloqueia a entrada do Provador 2 (faltam ' + faltamAgora + ' min)');
  w.eval(`state.lotes['LT0002'].registos.p1.assinadoEm = new Date(Date.now()-31*60000).toISOString();`); // há 31 min
  const faltamDepois = w.eval(`tempoEsperaProvador(state.lotes['LT0002'], 'p2')`);
  ok(faltamDepois === 0, 'Passados 31 minutos já não há bloqueio de tempo');

  // ---------- 4) Regra automática do LAB: 0 defeitos -> conclui sem frascos para levantar ----------
  w.eval(`state.lotes = {}; saveState();`);
  w.eval(`
    state.lotes['LT0003'] = criarLoteVazio('LT0003'); state.lotes['LT0003'].diaPrevisto = ontemStr();
    state.lotes['LT0003'].provador1='P1'; state.lotes['LT0003'].provador2='P2';
    state.lotes['LT0003'].registos.p1 = {itens:[],apreciacao:'limpo',observacoes:'',concluido:true};
    state.lotes['LT0003'].registos.p2 = {itens:[],apreciacao:'limpo',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0003');
  `);
  ok(w.eval(`state.lotes['LT0003'].decisao.final`) === 'concluido', 'Zero frascos com TCA/Mofo -> conclui automaticamente, sem clicar em nada');
  ok(w.eval(`state.lotes['LT0003'].decisao.temFrascosParaLevantar`) === false, 'Sem TCA/Mofo -> temFrascosParaLevantar fica false (nada para a Logística)');

  // ---------- 5) Nova regra (18/09/2026): abaixo do limiar (2 TCA coincidentes) -> conclui sem frascos para levantar ----------
  w.eval(`
    state.lotes['LT0004'] = criarLoteVazio('LT0004'); state.lotes['LT0004'].diaPrevisto = ontemStr();
    state.lotes['LT0004'].provador1='P1'; state.lotes['LT0004'].provador2='P2';
    const itens = [{frasco:1,tcaF:true},{frasco:2,tcaP:true}];
    state.lotes['LT0004'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0004'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0004');
  `);
  ok(w.eval(`state.lotes['LT0004'].decisao.final`) === 'concluido', '2 frascos com TCA coincidentes entre P1 e P2 (< 3) -> fecha automaticamente (regra nova)');
  ok(w.eval(`state.lotes['LT0004'].decisao.temFrascosParaLevantar`) === false, '2 TCA está abaixo do limiar -> sem frascos para levantar');
  ok(w.eval(`state.lotes['LT0004'].decisao.classificacao`) === null, 'Não leva nenhuma classificação especial');
  const comentarioLT0004 = w.eval(`state.lotes['LT0004'].decisao.comentarios`);
  ok(!/rejeição|aprovação/i.test(comentarioLT0004), 'O comentário da decisão automática não usa as palavras "rejeição"/"aprovação" — só descreve e conclui a prova');

  // ---------- 6) Nova regra: 3 TCA coincidentes (P1 e P2 concordam no mesmo frasco) -> conclui com frascos para levantar ----------
  w.eval(`
    state.lotes['LT0005'] = criarLoteVazio('LT0005'); state.lotes['LT0005'].diaPrevisto = ontemStr();
    state.lotes['LT0005'].provador1='P1'; state.lotes['LT0005'].provador2='P2';
    const itens = [{frasco:1,tcaF:true},{frasco:2,tcaP:true},{frasco:3,tcaF:true}];
    state.lotes['LT0005'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0005');
  `);
  ok(w.eval(`state.lotes['LT0005'].decisao.final`) === 'concluido', '3 frascos com TCA coincidentes -> conclui automaticamente (atinge o limiar)');
  ok(w.eval(`state.lotes['LT0005'].decisao.temFrascosParaLevantar`) === true, '3 TCA atinge o limiar -> fica com frascos para levantar (segue para a Logística)');

  // ---------- 6b) Nova regra: 4 Mofo coincidentes -> conclui com frascos para levantar (limiar próprio, diferente do TCA) ----------
  w.eval(`
    state.lotes['LT0005B'] = criarLoteVazio('LT0005B'); state.lotes['LT0005B'].diaPrevisto = ontemStr();
    state.lotes['LT0005B'].provador1='P1'; state.lotes['LT0005B'].provador2='P2';
    const itens = [{frasco:1,mofoP:true},{frasco:2,mofoP:true},{frasco:3,mofoF:true},{frasco:4,mofoP:true}];
    state.lotes['LT0005B'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005B'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0005B');
  `);
  ok(w.eval(`state.lotes['LT0005B'].decisao.final`) === 'concluido', '4 frascos com Mofo coincidentes -> conclui automaticamente (limiar do Mofo é 4, não 3)');
  ok(w.eval(`state.lotes['LT0005B'].decisao.temFrascosParaLevantar`) === true, '4 Mofo atinge o limiar -> fica com frascos para levantar');
  ok(w.eval(`state.lotes['LT0005B'].decisao.classificacao`) === null, 'A nova regra já não usa a etiqueta "TCA Forte" — fica sem classificação');

  // ---------- 6c) Divergência de CATEGORIA no mesmo frasco (os 2 marcam, mas um diz Mofo e outro
  // TCA) — confirmado com a Joana com um exemplo real (28/09/2026): conta sempre para uma das três
  // categorias, resolvendo por HIERARQUIA (TCA > Mofo > Outro), nunca ficando de fora. Aqui é Mofo
  // (Forte) vs TCA (Percetível) -> TCA vence -> conta como 1 TCA. ----------
  w.eval(`
    state.lotes['LT0005C'] = criarLoteVazio('LT0005C'); state.lotes['LT0005C'].diaPrevisto = ontemStr();
    state.lotes['LT0005C'].provador1='P1'; state.lotes['LT0005C'].provador2='P2';
    state.lotes['LT0005C'].registos.p1 = {itens:[{frasco:1,mofoF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005C'].registos.p2 = {itens:[{frasco:1,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
  `);
  const r6c = w.eval(`({analise: analiseCoincidenciaP1P2(state.lotes['LT0005C']), decidiu: tentarAutoFinalizar('LT0005C'), final: state.lotes['LT0005C'].decisao.final})`);
  ok(r6c.analise.temDiscordanteForte === false, 'Os 2 provadores marcaram o MESMO frasco (com categorias diferentes) — não é discordância, não bloqueia');
  ok(r6c.analise.tca === 1 && r6c.analise.mofo === 0, 'TCA vence Mofo na hierarquia -> conta como 1 TCA, não 1 Mofo nem fica de fora');
  ok(r6c.decidiu === true && r6c.final === 'concluido', 'Com só esse 1 TCA (abaixo do limiar de 3), conclui automaticamente sozinho');

  // ---------- 6c-bis) Divergência entre Mofo e Outro (sem TCA em jogo) — a hierarquia continua a
  // aplicar-se entre as duas categorias que sobram: Mofo > Outro -> conta como 1 Mofo, não 1 Outro
  // (caso real trazido pela Joana: frasco com Mofo-P de um lado e "Outro" do outro). ----------
  w.eval(`
    state.lotes['LT0005CTER'] = criarLoteVazio('LT0005CTER'); state.lotes['LT0005CTER'].diaPrevisto = ontemStr();
    state.lotes['LT0005CTER'].provador1='P1'; state.lotes['LT0005CTER'].provador2='P2';
    state.lotes['LT0005CTER'].registos.p1 = {itens:[{frasco:17,mofoP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005CTER'].registos.p2 = {itens:[{frasco:17,outro:true}],apreciacao:'',observacoes:'',concluido:true};
  `);
  const analise6cter = w.eval(`analiseCoincidenciaP1P2(state.lotes['LT0005CTER'])`);
  ok(analise6cter.mofo === 1 && analise6cter.outros === 0, 'Mofo vs Outro no mesmo frasco -> Mofo vence (hierarquia TCA > Mofo > Outro) -> conta como 1 Mofo, 0 Outros');

  // ---------- 6c-bis2) Mesma categoria, intensidade diferente (P1 Forte, P2 Percetível) — continua a
  // contar normalmente, a intensidade nunca decide a hierarquia entre categorias diferentes ----------
  w.eval(`
    state.lotes['LT0005CBIS'] = criarLoteVazio('LT0005CBIS'); state.lotes['LT0005CBIS'].diaPrevisto = ontemStr();
    state.lotes['LT0005CBIS'].provador1='P1'; state.lotes['LT0005CBIS'].provador2='P2';
    state.lotes['LT0005CBIS'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005CBIS'].registos.p2 = {itens:[{frasco:1,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
  `);
  const analise6cbis = w.eval(`analiseCoincidenciaP1P2(state.lotes['LT0005CBIS'])`);
  ok(analise6cbis.tca === 1, 'Mesma categoria (TCA nos dois) com intensidades diferentes (Forte vs Percetível) continua a contar como 1 TCA coincidente');

  // ---------- 6d) Um frasco discordante Forte bloqueia mesmo que os totais coincidentes ainda nem
  // cheguem perto do limiar — a discordância Forte tem sempre prioridade sobre a contagem ----------
  w.eval(`
    state.lotes['LT0005D'] = criarLoteVazio('LT0005D'); state.lotes['LT0005D'].diaPrevisto = ontemStr();
    state.lotes['LT0005D'].provador1='P1'; state.lotes['LT0005D'].provador2='P2';
    state.lotes['LT0005D'].registos.p1 = {itens:[{frasco:1,tcaP:true},{frasco:2,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005D'].registos.p2 = {itens:[{frasco:1,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
  `);
  const r6d = w.eval(`({decidiu: tentarAutoFinalizar('LT0005D'), status: computeStatus(state.lotes['LT0005D'])})`);
  ok(r6d.decidiu === false && r6d.status === 'aguarda_p3', 'Mesmo só com 1 TCA coincidente (frasco 1) e 1 discordante Forte (frasco 2, só o P1 marcou) -> a discordância Forte manda, vai a 3º provador');

  // ---------- 7) "Outro Aroma" não conta para nenhuma regra automática ----------
  w.eval(`
    state.lotes['LT0006'] = criarLoteVazio('LT0006'); state.lotes['LT0006'].diaPrevisto = ontemStr();
    state.lotes['LT0006'].provador1='P1'; state.lotes['LT0006'].provador2='P2';
    const itens = [{frasco:1,outro:true},{frasco:2,outro:true},{frasco:3,outro:true},{frasco:4,outro:true}];
    state.lotes['LT0006'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0006'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0006');
  `);
  ok(w.eval(`state.lotes['LT0006'].decisao.final`) === 'concluido', '4 frascos só com "Outro Aroma" (nenhum TCA/Mofo) -> continua a concluir automaticamente');
  ok(w.eval(`state.lotes['LT0006'].decisao.temFrascosParaLevantar`) === false, '"Outro Aroma" nunca conta -> sem frascos para levantar');

  // ---------- 8) Nova regra: frasco discordante (só um provador assinala) e Forte -> precisa do 3º provador,
  // mesmo havendo só esse único defeito (não decide sozinha com P1+P2) ----------
  w.eval(`
    state.lotes['LT0007'] = criarLoteVazio('LT0007'); state.lotes['LT0007'].diaPrevisto = ontemStr();
    state.lotes['LT0007'].provador1='P1'; state.lotes['LT0007'].provador2='P2';
    state.lotes['LT0007'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0007'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
  `);
  const r8 = w.eval(`({decidiu: tentarAutoFinalizar('LT0007'), status: computeStatus(state.lotes['LT0007']), final: state.lotes['LT0007'].decisao.final, slot: proximoSlotProva(state.lotes['LT0007'])})`);
  ok(r8.status === 'aguarda_p3' && !r8.final && r8.slot === 'p3', 'Frasco discordante (só o Provador 1 assinalou) e Forte -> não decide sozinha, fica "Aguarda Provador 3"');

  // ---------- 8b) Discordância só Percetível NÃO bloqueia e (22/09/2026) já NÃO conta para o total —
  // é como se não tivesse acontecido para efeitos da contagem, só não chama o 3º provador ----------
  w.eval(`
    state.lotes['LT0007B'] = criarLoteVazio('LT0007B'); state.lotes['LT0007B'].diaPrevisto = ontemStr();
    state.lotes['LT0007B'].provador1='P1'; state.lotes['LT0007B'].provador2='P2';
    state.lotes['LT0007B'].registos.p1 = {itens:[{frasco:1,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0007B'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
  `);
  const analise8b = w.eval(`analiseCoincidenciaP1P2(state.lotes['LT0007B'])`);
  ok(analise8b.tca === 0 && analise8b.temDiscordanteForte === false, 'Frasco discordante só Percetível já não conta para o total (tca fica 0, não 1) e não bloqueia');
  w.eval(`tentarAutoFinalizar('LT0007B');`);
  ok(w.eval(`state.lotes['LT0007B'].decisao.final`) === 'concluido', 'Frasco discordante só Percetível (não Forte) não bloqueia — conclui sozinho');
  ok(w.eval(`state.lotes['LT0007B'].decisao.temFrascosParaLevantar`) === false, 'Sem nenhum frasco em comum -> sem frascos para levantar');

  // ---------- 8c) Nova regra (22/09/2026): frascos discordantes NUNCA contam para o limiar de 3 TCA /
  // 4 Mofo, mesmo havendo vários — só os frascos EM COMUM (marcados pelos dois) contam. Aqui há 2 TCA
  // em comum (frascos 1 e 2) + 1 TCA discordante (frasco 3, só o P1 marcou) — antes desta regra
  // (18/09/2026) isto teria dado 3 TCA e atingido o limiar; agora fica em 2 e conclui sem levantar. ----------
  w.eval(`
    state.lotes['LT0009C'] = criarLoteVazio('LT0009C'); state.lotes['LT0009C'].diaPrevisto = ontemStr();
    state.lotes['LT0009C'].provador1='P1'; state.lotes['LT0009C'].provador2='P2';
    state.lotes['LT0009C'].registos.p1 = {itens:[{frasco:1,tcaF:true},{frasco:2,tcaF:true},{frasco:3,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0009C'].registos.p2 = {itens:[{frasco:1,tcaF:true},{frasco:2,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
  `);
  const analise8c = w.eval(`analiseCoincidenciaP1P2(state.lotes['LT0009C'])`);
  ok(analise8c.tca === 2, 'O frasco 3 (discordante, só o P1 marcou) não entra na contagem — fica em 2 TCA em comum, não 3 (' + analise8c.tca + ')');
  w.eval(`tentarAutoFinalizar('LT0009C');`);
  ok(w.eval(`state.lotes['LT0009C'].decisao.final`) === 'concluido' && w.eval(`state.lotes['LT0009C'].decisao.temFrascosParaLevantar`) === false, '2 TCA em comum fica abaixo do limiar de 3 -> conclui sem frascos para levantar, mesmo havendo um 3º frasco discordante');
  const frascosAssinaladosLT0009C = w.eval(`frascosAssinaladosDe(state.lotes['LT0009C']).map(f=>f.frasco)`);
  ok(JSON.stringify(frascosAssinaladosLT0009C) === JSON.stringify([1,2,3]), 'A função que lista os frascos assinalados continua a incluir o frasco discordante (comum e discordante juntos) — só a CONTAGEM para o limiar é que ignora os discordantes');

  // ---------- 9) Discordância Forte -> precisa do 3º provador (repete o caso 8 com Mofo, para o
  // fluxo do Provador 3 do teste seguinte) ----------
  w.eval(`
    state.lotes['LT0008'] = criarLoteVazio('LT0008'); state.lotes['LT0008'].diaPrevisto = ontemStr();
    state.lotes['LT0008'].provador1='P1'; state.lotes['LT0008'].provador2='P2';
    state.lotes['LT0008'].registos.p1 = {itens:[{frasco:1,mofoF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0008'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
  `);
  const r9 = w.eval(`({decidiu: tentarAutoFinalizar('LT0008'), status: computeStatus(state.lotes['LT0008'])})`);
  ok(r9.status === 'aguarda_p3' && r9.decidiu === false, 'Frasco discordante com Mofo Forte -> precisa sempre do 3º provador, mesmo sendo só 1 defeito');

  // ---------- 10) 3º provador só "conclui a prova" (sem ecrã de Aprovar/Rejeitar) e isso já decide ----------
  w.eval(`
    ctxLote='LT0008'; ctxProvador='p3';
    state.lotes['LT0008'].provador3='Teresa Pinto';
    openRegistoModal('LT0008','p3');
  `);
  const temBotaoAprovarRejeitar = w.eval(`document.getElementById('modalRoot').innerHTML.includes('Aprovar') || document.getElementById('modalRoot').innerHTML.includes('Rejeitar')`);
  ok(temBotaoAprovarRejeitar === false, 'O ecrã do 3º provador não mostra nenhum botão "Aprovar"/"Rejeitar" — é a mesma ficha de registo dos outros provadores');
  const concluiuP3 = w.eval(`concluirRegisto(); state.lotes['LT0008'].registos.p3.concluido`);
  ok(concluiuP3 === true, 'O 3º provador conclui a prova com o mesmo botão "Concluir e Assinar" de sempre');
  const l8 = w.eval(`state.lotes['LT0008'].decisao`);
  ok(l8.final === 'concluido' && l8.temFrascosParaLevantar === true && l8.decididoPor === 'Teresa Pinto', 'Ao assinar, o lote fica decidido sozinho (direto) — sem clicar em Aprovar/Rejeitar — conclui e fica pronto para o Levantamento');

  w.eval(`openLoteDetail('LT0008');`);
  const textoConcluidaFieldset = w.eval(`Array.from(document.querySelectorAll('#overlayLote fieldset')).find(fs=>fs.querySelector('legend') && fs.querySelector('legend').textContent==='Prova Concluída').textContent`);
  ok(/PROVA CONCLUÍDA/.test(textoConcluidaFieldset), 'A fieldset mostra "PROVA CONCLUÍDA"');
  ok(!/Comentários/.test(textoConcluidaFieldset) && !/por Automático/.test(textoConcluidaFieldset) && !/em \d{4}-\d{2}-\d{2}/.test(textoConcluidaFieldset), 'Já não mostra "por Automático... em DATA" nem "Comentários: ..." — só o texto "PROVA CONCLUÍDA"');
  const corPROVA = w.eval(`Array.from(document.querySelectorAll('#overlayLote fieldset')).find(fs=>fs.querySelector('legend') && fs.querySelector('legend').textContent==='Prova Concluída').querySelector('strong').getAttribute('style')`);
  ok(!corPROVA || !/color/.test(corPROVA), '"PROVA CONCLUÍDA" já não aparece colorida a vermelho/verde');

  // ---------- 11) Bloquear edição da identificação (Nº Frascos deixa de ter <input>) ----------
  w.eval(`
    state.lotes['LT0009'] = criarLoteVazio('LT0009'); state.lotes['LT0009'].diaPrevisto = ontemStr();
    openLoteDetail('LT0009');
  `);
  const temInputFrascos = w.eval(`!!document.querySelector('[onchange*="numeroFrascos"]')`);
  ok(temInputFrascos === false, 'Nº Frascos deixou de ser um campo editável na ficha do lote');
  const temApagarRegisto = w.eval(`document.body.innerHTML.includes('Apagar Registo')`);
  ok(temApagarRegisto === false, '"Apagar Registo" já não aparece na ficha do lote (só existe o apagar em massa em Prioridades)');

  // ---------- 11b) Datas na ficha do lote: Planeamento / Abertura da Prova / Conclusão ----------
  ok(w.eval(`formatarDataBR('')`) === '—', 'formatarDataBR devolve um traço quando não há data');
  ok(w.eval(`formatarDataBR('2026-09-14T10:30:00.000Z')`) === '14/09/2026', 'formatarDataBR converte ISO para DD/MM/AAAA');
  const textoLT0009 = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(/Data Planeamento/.test(textoLT0009), 'A ficha do lote mostra "Data Planeamento" (quando foi carregado)');
  ok(/Data Abertura da Prova/.test(textoLT0009), 'A ficha do lote mostra "Data Abertura da Prova"');
  ok(!/Data Conclusão/.test(textoLT0009), 'Um lote ainda não concluído não mostra "Data Conclusão"');
  // abre a prova (Provador 1 entra) — a data de abertura passa a estar preenchida
  w.eval(`
    abrirEntradaProvador('LT0009');
    document.getElementById('fNomeEntrada').value = 'Marta Santos';
    confirmarEntradaProvador('LT0009');
  `);
  ok(w.eval(`!!state.lotes['LT0009'].provaAbertaEm`), 'Ao entrar o Provador 1, fica guardada a data de abertura da prova');
  w.eval(`closeModal('overlayRegisto'); openLoteDetail('LT0009');`);
  const textoLT0009Aberta = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(!/Data Abertura da Prova[\s\S]{0,40}—/.test(textoLT0009Aberta), 'Depois do Provador 1 entrar, a Data Abertura da Prova já não mostra "—"');
  // conclui o lote (0 defeitos -> conclui automaticamente) e confirma que a Data Conclusão aparece
  w.eval(`
    ctxLote='LT0009'; ctxProvador='p1';
    fecharRegistoSemConcluir();
  `);
  w.eval(`
    state.lotes['LT0009'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0009'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0009');
    openLoteDetail('LT0009');
  `);
  const textoLT0009Concluido = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(/Data Conclusão/.test(textoLT0009Concluido), 'Um lote concluído já mostra a "Data Conclusão"');

  // ---------- 12) (25/09/2026: secção removida — "Importar Prioridades"/"Colar lista recebida por
  // email" deixou de existir, ver secção mais abaixo sobre abrirLoteExistente criar o lote na hora) ----------

  // ---------- 13) lotesAguardaP3() conta aguarda_p3 + confronto ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTA'] = criarLoteVazio('LTA'); state.lotes['LTA'].diaPrevisto = ontemStr();
    state.lotes['LTA'].provador1='P1'; state.lotes['LTA'].provador2='P2';
    state.lotes['LTA'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTA'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    // frasco discordante (só P1 assinalou) e Forte -> aguarda_p3, direto (já não passa por Revisão Conjunta)
  `);
  w.eval(`renderAll();`);
  const contagemP3 = w.eval(`lotesAguardaP3().length`);
  ok(contagemP3 === 1, 'lotesAguardaP3() conta corretamente os lotes à espera do 3º provador (aguarda_p3)');

  // ---------- 13a2) Ficha do lote "Aguarda Provador 3": mantém título e contagens, sem o texto explicativo ----------
  w.eval(`openLoteDetail('LTA');`);
  const textoFichaP3 = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(/É preciso o 3º Provador/.test(textoFichaP3), 'A ficha do lote mantém o título "É preciso o 3º Provador"');
  ok(/TCA Forte/.test(textoFichaP3), 'A ficha do lote mantém as contagens (ex: TCA Forte)');
  ok(!/continuam a divergir|vai direto para o 3º provador desempatar|LAB não participa/.test(textoFichaP3), 'A ficha do lote já não mostra o texto explicativo "É preciso o 3º Provador..."');
  w.eval(`closeModal('overlayLote');`);

  // ---------- 13b) Botão dinâmico "Provador 3" (reaproveita o botão "Gerar lote de teste (DEV)") ----------
  const btnP3Visivel = w.eval(`!document.getElementById('btnAlertaP3').classList.contains('hidden')`);
  const btnP3Contagem = w.eval(`document.getElementById('contagemAlertaP3').textContent`);
  ok(btnP3Visivel === true && btnP3Contagem === '1', 'Botão dinâmico "Provador 3" aparece no ecrã Lotes com a contagem certa');

  // 22/09/2026: corrigido — com só 1 lote pendente, o botão já NÃO abre a ficha do lote diretamente
  // (isso escondia "Concluir Todos"/"Concluir Selecionados", que ficavam impossíveis de usar sempre
  // que só houvesse 1 lote à espera — foi o que a Joana reportou ter acontecido).
  w.eval(`abrirAlertaProvador3();`);
  ok(w.eval(`!!document.getElementById('overlayAlertaP3')`), 'Mesmo com só 1 lote pendente, o mini-modal abre na mesma (já não vai logo para a ficha do lote)');
  ok(!w.eval(`!!document.getElementById('overlayLote')`), 'A ficha do lote não abre sozinha quando há só 1 pendente');
  const txtBtnConcluirTodos1 = w.eval(`document.querySelector('#overlayAlertaP3 .actions-row button.btn-primary').textContent`);
  ok(/Concluir Todos \(1\)/.test(txtBtnConcluirTodos1||''), 'Com 1 lote pendente, o botão "Concluir Todos" já mostra a contagem certa (' + txtBtnConcluirTodos1 + ')');
  ok(w.eval(`document.querySelectorAll('#overlayAlertaP3 .p3-lote-check').length`) === 1, 'Com 1 lote pendente, existe 1 caixa de seleção');
  w.eval(`closeModal('overlayAlertaP3');`);

  w.eval(`
    state.lotes['LTA2'] = criarLoteVazio('LTA2'); state.lotes['LTA2'].diaPrevisto = ontemStr();
    state.lotes['LTA2'].provador1='P1'; state.lotes['LTA2'].provador2='P2';
    state.lotes['LTA2'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTA2'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    renderAll();
    abrirAlertaProvador3();
  `);
  const txtBtnConcluirTodos2 = w.eval(`document.querySelector('#overlayAlertaP3 .actions-row button.btn-primary').textContent`);
  ok(/Concluir Todos \(2\)/.test(txtBtnConcluirTodos2||''), 'Com vários lotes pendentes, o mini-modal mostra o botão "Concluir Todos" com a contagem certa (' + txtBtnConcluirTodos2 + ')');
  ok(/Concluir Selecionados/.test(w.eval(`document.querySelector('#overlayAlertaP3').textContent`)), 'O mini-modal também mostra o botão "Concluir Selecionados"');
  const checkboxesP3 = w.eval(`document.querySelectorAll('#overlayAlertaP3 .p3-lote-check').length`);
  ok(checkboxesP3 === 2, 'Com vários lotes pendentes, existe 1 caixa de seleção por lote (' + checkboxesP3 + ')');
  const botoesLoteP3 = w.eval(`document.querySelectorAll('#overlayAlertaP3 .lab-lote-row button').length`);
  ok(botoesLoteP3 === 2, 'Continua a existir 1 botão por lote para abrir e fazer o registo completo (' + botoesLoteP3 + ')');
  w.eval(`closeModal('overlayAlertaP3');`);

  // ---------- 13c) Alerta por email dispara uma vez por lote, nunca duplica ----------
  // (LTA e LTA2 já tinham sido notificados automaticamente pelo renderAll() dos passos anteriores —
  // repõe-se aqui o "por notificar" só para isolar e testar este mecanismo especificamente.)
  w.eval(`
    state.lotes['LTA'].alertaP3Enviado = false;
    state.lotes['LTA2'].alertaP3Enviado = false;
    window.__chamadasNotify = [];
    window.__fetchOriginal = window.fetch;
    window.fetch = (url, opts) => {
      window.__chamadasNotify.push({url, body: opts && opts.body});
      return Promise.resolve({ ok:true, json: () => Promise.resolve({ok:true, enviado:true}) });
    };
    renderAll(); // chama notificarNovosPendentesP3() internamente, como acontece a sério na app
  `);
  const chamadas1 = w.eval(`window.__chamadasNotify.length`);
  const urlChamada = w.eval(`window.__chamadasNotify[0] && window.__chamadasNotify[0].url`);
  const flagLTA = w.eval(`state.lotes['LTA'].alertaP3Enviado`);
  ok(chamadas1 === 2 && urlChamada === '/api/notify-provador3' && flagLTA === true,
     'renderAll() avisa o servidor uma vez por cada lote novo a precisar do 3º provador (' + chamadas1 + ' chamada(s))');

  w.eval(`renderAll();`); // corre outra vez — não deve repetir para os mesmos lotes
  const chamadas2 = w.eval(`window.__chamadasNotify.length`);
  ok(chamadas2 === chamadas1, 'Não volta a notificar os mesmos lotes — alertaP3Enviado evita duplicar o email');
  w.eval(`window.fetch = window.__fetchOriginal;`);

  // ---------- 13d) reenviarAlertaP3() força nova tentativa nos lotes ainda pendentes ----------
  w.eval(`
    state.lotes['LTA'].alertaP3Enviado = true; // simula ter ficado "preso" (ex.: por um 404 antes do fix)
    window.__chamadasReenvio = [];
    window.__fetchOriginal2 = window.fetch;
    window.fetch = (url) => { window.__chamadasReenvio.push(url); return new Promise(()=>{}); }; // nunca resolve — só interessa ver se chamou
    reenviarAlertaP3();
  `);
  const tentouReenviar = w.eval(`window.__chamadasReenvio.length`);
  ok(tentouReenviar >= 1, 'reenviarAlertaP3() força uma nova tentativa de notificação para os lotes ainda pendentes');
  w.eval(`window.fetch = window.__fetchOriginal2;`);

  // ---------- 14) "Fechar sem concluir" guarda o que já foi preenchido, não é um reset ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTB'] = criarLoteVazio('LTB'); state.lotes['LTB'].diaPrevisto = ontemStr();
    state.lotes['LTB'].provador1 = 'Maria';
    ctxLote='LTB'; ctxProvador='p1';
    openRegistoModal('LTB','p1');
  `);
  w.eval(`
    abrirSeletorGrid(3);
    marcarChipGrid('tcaF');
    document.getElementById('fObsRegisto').value = 'Cheiro leve, a confirmar mais tarde.';
  `);
  w.eval(`fecharRegistoSemConcluir();`);
  const regLTB = w.eval(`state.lotes['LTB'].registos.p1`);
  ok(regLTB.concluido === false, '"Fechar sem concluir" não assina nem bloqueia o registo');
  ok(regLTB.observacoes === 'Cheiro leve, a confirmar mais tarde.', '"Fechar sem concluir" guarda as observações escritas (não faz reset)');
  ok(Array.isArray(regLTB.itens) && regLTB.itens.length === 1 && regLTB.itens[0].frasco === 3, '"Fechar sem concluir" mantém os frascos já adicionados');
  w.eval(`openRegistoModal('LTB','p1');`);
  const obsAoReabrir = w.eval(`document.getElementById('fObsRegisto').value`);
  ok(obsAoReabrir === 'Cheiro leve, a confirmar mais tarde.', 'Ao reabrir o registo depois de "Fechar sem concluir", as observações continuam lá');

  // ---------- 14b) Retomar prova em curso não obriga a escolher o nome outra vez ----------
  w.eval(`closeModal('overlayRegisto');`);
  w.eval(`openLoteDetail('LTB');`);
  const textoBotaoEntrada = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(/Continuar Prova — Maria/.test(textoBotaoEntrada), 'O botão passa a dizer "Continuar Prova — Maria" quando já há uma prova em curso para esse lugar');
  w.eval(`closeModal('overlayLote');`);
  w.eval(`abrirEntradaProvador('LTB');`);
  ok(w.eval(`!document.getElementById('overlayEntrada')`), 'Ao retomar, não aparece o ecrã "Quem vai fazer esta prova?" outra vez');
  ok(w.eval(`!!document.getElementById('overlayRegisto')`), 'Ao retomar, vai direto para o ecrã de registo do provador');
  const itensAoRetomar = w.eval(`state.lotes['LTB'].registos.p1.itens.length`);
  ok(itensAoRetomar === 1, 'Os dados já preenchidos (frascos) continuam lá ao retomar');

  // ---------- 14c) Com uma prova em curso só aparece "Prova nova" (sem "Limpar campos") ----------
  w.eval(`closeModal('overlayRegisto'); openLoteDetail('LTB');`);
  const textoLoteLTB = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(textoLoteLTB.includes('Prova nova'), 'Com uma prova em curso, aparece a opção "Prova nova"');
  ok(!textoLoteLTB.includes('Limpar campos'), 'A opção "Limpar campos" foi removida (redundante com "Prova nova")');

  // ---------- 14d) "Prova nova": reinicia por completo, incluindo o nome do provador ----------
  w.eval(`provaNovaProvador('LTB','p1');`);
  ok(w.eval(`state.lotes['LTB'].provador1`) === '', '"Prova nova" limpa o nome do provador (permite escolher outra pessoa, ex: Joana → Ana Catarina)');
  ok(w.eval(`state.lotes['LTB'].registos.p1.itens.length`) === 0, '"Prova nova" apaga os dados já registados (frascos)');
  ok(w.eval(`!!document.getElementById('overlayEntrada')`), '"Prova nova" volta a mostrar o ecrã "Quem vai fazer esta prova?"');

  // ---------- 15) Grelha de toque direto (<=50 frascos): tocar em qualquer ordem, sem navegação forçada ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTC'] = criarLoteVazio('LTC'); state.lotes['LTC'].diaPrevisto = ontemStr(); state.lotes['LTC'].numeroFrascos = 50;
    ctxLote='LTC'; ctxProvador='p1';
    openRegistoModal('LTC','p1');
  `);
  ok(w.eval(`document.querySelectorAll('.frasco-tile').length`) === 50, 'Mostra uma grelha com uma peça por cada frasco (1 a 50)');
  // 25/09/2026: já não há peça em branco no início — a grelha é 10 por fila (1-10, 11-20...), a
  // corresponder exatamente à disposição física dos frascos no tabuleiro.
  ok(w.eval(`document.querySelectorAll('.frasco-tile.frasco-vazio').length`) === 0, 'Já não existe nenhuma peça em branco no início da grelha');
  ok(w.eval(`document.querySelector('.frasco-tile .ft-num').textContent`) === '1', 'O frasco 1 é mesmo a 1ª peça da grelha (não a 2ª)');
  ok(/\.frasco-grid\{[^}]*repeat\(10,1fr\)/.test(html), 'A grelha de frascos usa 10 colunas por fila (repeat(10,1fr)), para bater certo com o tabuleiro físico');
  ok(w.eval(`!document.querySelector('#fNumFrasco')`), 'Em modo grelha não existe campo para escrever o número do frasco');
  ok(w.eval(`frascoAtivoGrid`) === null, 'Começa na vista de grelha (nenhum frasco selecionado)');

  // toca directamente no frasco 40 (fora de ordem) e marca Mofo Forte
  w.eval(`abrirSeletorGrid(40); marcarChipGrid('mofoF');`);
  ok(w.eval(`frascoAtivoGrid`) === null, 'Depois de escolher o aroma, volta sozinho à grelha');
  const itemF40 = w.eval(`state.lotes['LTC'].registos.p1.itens.find(it=>it.frasco===40)`);
  ok(itemF40 && itemF40.mofoF === true, 'Tocar num frasco fora de ordem grava o aroma no frasco certo (40), sem obrigar a passar pelos anteriores');

  // toca no frasco 2, em seguida — confirma que a ordem é livre
  w.eval(`abrirSeletorGrid(2); marcarChipGrid('mofoP');`);
  const itemF2 = w.eval(`state.lotes['LTC'].registos.p1.itens.find(it=>it.frasco===2)`);
  ok(itemF2 && itemF2.mofoP === true, 'Pode tocar em qualquer frasco a seguir, sem seguir a sequência 1,2,3…');

  const tile2Marcado = w.eval(`document.querySelector('.frasco-tile.marcado')`) !== null;
  ok(tile2Marcado, 'Frascos já marcados ficam visualmente destacados na grelha');

  // reabre o seletor de um frasco já marcado — o aroma certo aparece pré-selecionado
  w.eval(`abrirSeletorGrid(2);`);
  const chipOnAoReabrir = w.eval(`document.querySelector('.aroma-picker button[data-k="mofoP"]').classList.contains('on')`);
  ok(chipOnAoReabrir === true, 'Ao reabrir um frasco já marcado, o aroma certo aparece destacado');
  const botoesGrandes = w.eval(`document.querySelectorAll('.aroma-picker button').length`) === 5;
  ok(botoesGrandes, 'O seletor de aroma mostra os 5 botões grandes de seleção');
  const semAromaDiscreto = w.eval(`!!document.querySelector('.aroma-limpo')`) && w.eval(`!document.querySelector('.seq-limpo')`);
  ok(semAromaDiscreto, '"Sem Aroma" aparece como opção discreta, não como botão grande em destaque');

  // "Sem Aroma" no seletor limpa o registo desse frasco
  w.eval(`marcarSemAromaGrid();`);
  const itemF2Limpo = w.eval(`state.lotes['LTC'].registos.p1.itens.find(it=>it.frasco===2)`);
  ok(itemF2Limpo === undefined, '"Sem Aroma" no seletor remove o registo desse frasco (fica limpo)');

  // ---------- 15a) Provador pode acrescentar mais 50 frascos à prova (25/09/2026) ----------
  // A amostra costuma ter 50 frascos, mas às vezes tem 100 — o provador deteta isso a meio da prova e
  // acrescenta mais 50 ele próprio, sem precisar de corrigir o Excel nem pedir ao admin.
  const btnAdicionar = w.eval(`document.querySelector('#overlayRegisto button[onclick="adicionarMaisFrascos()"]')`);
  ok(!!btnAdicionar, 'Existe um botão "+ Adicionar 50 Frascos" no ecrã de registo do provador');
  ok(w.eval(`document.querySelector('#overlayRegisto button[onclick="adicionarMaisFrascos()"]').textContent.trim()`) === '+ Adicionar 50 Frascos', 'O botão tem o texto "+ Adicionar 50 Frascos"');

  // confirma o texto exato do pokeyoke
  let confirmMsgCapturado = null;
  w.confirm = (msg) => { confirmMsgCapturado = msg; return true; };
  w.eval(`adicionarMaisFrascos();`);
  ok(confirmMsgCapturado === 'Tem a certeza que quer adicionar mais 50 frascos à prova?', 'O pokeyoke mostra o texto exato pedido: "Tem a certeza que quer adicionar mais 50 frascos à prova?" (' + confirmMsgCapturado + ')');
  // desfaz para o resto dos testes seguintes partir de 50, e volta a desenhar a grelha (1ª onda) para o DOM ficar consistente
  w.eval(`state.lotes['LTC'].numeroFrascos = 50; ondaGridAtiva = 0; renderRegistoFrascos();`);

  // recusar o pokeyoke não altera nada
  w.eval(`window.confirm = () => false;`);
  w.eval(`adicionarMaisFrascos();`);
  ok(w.eval(`state.lotes['LTC'].numeroFrascos`) === 50, 'Recusando o aviso de confirmação, o nº de frascos não muda');
  ok(w.eval(`document.querySelectorAll('.frasco-tile').length`) === 50, 'E a grelha continua com os mesmos 50 frascos');

  // confirmar o pokeyoke acrescenta 50 frascos (a este LOTE, não só a este registo) e salta logo para a onda nova
  w.eval(`window.confirm = () => true;`);
  w.eval(`adicionarMaisFrascos();`);
  ok(w.eval(`state.lotes['LTC'].numeroFrascos`) === 100, 'Confirmando o pokeyoke, o nº de frascos do LOTE passa de 50 para 100');
  ok(w.eval(`document.querySelector('.onda-contador').textContent.trim()`) === 'Frascos 51–100', 'Depois de acrescentar, salta logo para a onda nova (51–100), para continuar a marcar sem ter de navegar');
  ok(w.eval(`document.querySelectorAll('.frasco-tile').length`) === 50, 'A onda nova mostra os 50 frascos novos (51 a 100)');
  ok(w.eval(`document.querySelector('.frasco-tile .ft-num').textContent`) === '51', 'O primeiro frasco da onda nova é o 51 (numeração contínua, não reinicia)');

  // marca um frasco na nova onda (65) e confirma que fica gravado — prova que a onda nova é mesmo utilizável
  w.eval(`abrirSeletorGrid(65); marcarChipGrid('tcaP');`);
  ok(w.eval(`state.lotes['LTC'].registos.p1.itens.find(it=>it.frasco===65)`).tcaP === true, 'Um frasco marcado na onda acrescentada grava normalmente no registo');

  // acrescentar outra vez soma mais 50 (150 no total) — pode ser usado mais que uma vez
  w.eval(`adicionarMaisFrascos();`);
  ok(w.eval(`state.lotes['LTC'].numeroFrascos`) === 150, 'Pode acrescentar mais do que uma vez (ex: 50 -> 100 -> 150)');

  // ---------- 15b) Lotes com mais de 50 frascos: grelha de toque em "ondas" de 50 (17/09/2026) ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTD'] = criarLoteVazio('LTD'); state.lotes['LTD'].diaPrevisto = ontemStr(); state.lotes['LTD'].numeroFrascos = 120;
    ctxLote='LTD'; ctxProvador='p1';
    openRegistoModal('LTD','p1');
  `);
  ok(w.eval(`!document.querySelector('#fNumFrasco')`), 'Já não existe nenhum campo de entrada manual do nº do frasco, nem para lotes grandes');
  ok(w.eval(`!!document.querySelector('.frasco-grid')`), 'Com mais de 50 frascos, continua a mostrar-se a grelha de toque (não cai para entrada manual)');
  ok(w.eval(`document.querySelectorAll('.frasco-tile').length`) === 50, '1ª onda mostra 50 frascos de cada vez, mesmo havendo 120 no total');
  ok(w.eval(`document.querySelector('.onda-contador').textContent.trim()`) === 'Frascos 1–50', 'O contador mostra só o intervalo de frascos da onda ("Frascos 1–50"), sem a palavra "onda"');
  ok(!w.eval(`document.querySelector('.onda-nav').textContent`).toLowerCase().includes('onda anterior') && !w.eval(`document.querySelector('.onda-nav').textContent`).toLowerCase().includes('onda seguinte'),
    'Os botões de navegação mostram só as setas ◀ ▶, sem a palavra "Onda"');

  // marca o frasco 40 (dentro da 1ª onda) e avança para a 2ª onda
  w.eval(`abrirSeletorGrid(40); marcarChipGrid('tcaF');`);
  w.eval(`mudarOndaGrid(1);`);
  const primeiroDaOnda2 = w.eval(`document.querySelector('.frasco-tile .ft-num').textContent`);
  ok(primeiroDaOnda2 === '51', 'A 2ª onda começa no frasco 51 — numeração sempre contínua (não reinicia em 1)');
  ok(w.eval(`document.querySelectorAll('.frasco-tile.frasco-vazio').length`) === 0, 'A 2ª onda também não tem nenhuma peça em branco (já não existe em onda nenhuma)');

  // marca o frasco 65 (2ª onda) e confirma que fica gravado corretamente
  w.eval(`abrirSeletorGrid(65); marcarChipGrid('tcaP');`);
  const itemF65 = w.eval(`state.lotes['LTD'].registos.p1.itens.find(it=>it.frasco===65)`);
  ok(itemF65 && itemF65.tcaP === true, 'Um frasco marcado na 2ª onda (65) grava normalmente no registo do lote');

  // volta à 1ª onda e confirma que o frasco 40 continua marcado (as ondas não perdem dados uma da outra)
  w.eval(`mudarOndaGrid(-1);`);
  const itemF40Persistiu = w.eval(`state.lotes['LTD'].registos.p1.itens.find(it=>it.frasco===40)`);
  ok(itemF40Persistiu && itemF40Persistiu.tcaF === true, 'Ao voltar à onda anterior, os frascos já marcados nessa onda continuam lá');
  ok(w.eval(`document.querySelector('.onda-nav button[disabled]')`) !== null, 'Na 1ª onda, o botão "Onda anterior" fica desativado (não há onda antes da 1ª)');

  // ---------- 16) Ecrã "LAB" (Planeados / WIP / Concluídos) substitui o Histórico ----------
  ok(w.eval(`!!document.getElementById('navLab')`), 'A navegação passou a ter um botão "LAB"');
  ok(w.eval(`document.getElementById('navLab').textContent.trim()`) === 'LAB', 'O botão de navegação mostra o texto "LAB"');
  ok(w.eval(`!document.getElementById('navHistorico')`), 'Já não existe o antigo botão "Histórico"');
  ok(w.eval(`!!document.getElementById('view-lab')`), 'Existe a secção view-lab');
  ok(w.eval(`!document.getElementById('view-historico')`), 'Já não existe a antiga secção view-historico');

  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTP'] = criarLoteVazio('LTP'); state.lotes['LTP'].diaPrevisto = ontemStr();
    state.lotes['LTW'] = criarLoteVazio('LTW'); state.lotes['LTW'].diaPrevisto = ontemStr();
    state.lotes['LTW'].provador1 = 'Rita';
    state.lotes['LTK'] = criarLoteVazio('LTK'); state.lotes['LTK'].diaPrevisto = hojeStr();
    state.lotes['LTK'].provador1 = 'Rita'; state.lotes['LTK'].provador2 = 'Nuno';
    state.lotes['LTK'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTK'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTK'].decisao.final = 'concluido';
    state.lotes['LTK'].decisao.data = hojeStr();
    state.lotes['LTK2'] = criarLoteVazio('LTK2'); state.lotes['LTK2'].diaPrevisto = ontemStr();
    state.lotes['LTK2'].provador1 = 'Rita'; state.lotes['LTK2'].provador2 = 'Nuno';
    state.lotes['LTK2'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTK2'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTK2'].decisao.final = 'concluido';
    state.lotes['LTK2'].decisao.data = hojeStr(); // 29/09/2026: previsto para ontem, mas só fechado (decisao.data) hoje
    state.lotes['LTH'] = criarLoteVazio('LTH'); state.lotes['LTH'].diaPrevisto = ontemStr();
    state.lotes['LTH'].prioridade = 'vermelho';
    state.lotes['LTH'].provador1 = 'Rita'; state.lotes['LTH'].provador2 = 'Nuno';
    state.lotes['LTH'].registos.p1 = {itens:[{frasco:5,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTH'].registos.p2 = {itens:[{frasco:5,mofoF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTH'].decisao.final = 'concluido';
    state.lotes['LTH'].decisao.data = '2020-01-01'; // 29/09/2026: quem decide Concluídos/Histórico é decisao.data (o dia em que foi de facto fechado) — aqui foi fechado há muito tempo -> Histórico
    switchView('lab');
  `);
  ok(w.eval(`grupoLoteLAB(state.lotes['LTP'])`) === 'planeados', 'Lote sem nenhum provador a começar entra em "Planeados"');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTW'])`) === 'wip', 'Lote já começado mas não concluído entra em "WIP"');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTK'])`) === 'concluidos', 'Lote fechado hoje (decisao.data = hoje) entra em "Concluídos"');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTK2'])`) === 'concluidos', 'Um lote com diaPrevisto de ontem mas fechado hoje (decisao.data = hoje) entra em "Concluídos" — o que importa é quando foi FECHADO, não o dia para que estava previsto (29/09/2026, a pedido da Joana)');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTH'])`) === 'historico', 'Um lote fechado num dia anterior (decisao.data antiga) migra para "Histórico", mesmo tendo diaPrevisto de ontem');

  // 3 colunas visíveis de imediato (Planeados/WIP/Concluídos) — sem tabs para trocar de vista
  const textoPlaneados = w.eval(`document.getElementById('labColPlaneados').textContent`);
  ok(/LTP/.test(textoPlaneados) && !/LTW/.test(textoPlaneados) && !/LTK/.test(textoPlaneados), 'A coluna "Planeados" mostra só os lotes por começar');
  const textoWip = w.eval(`document.getElementById('labColWip').textContent`);
  ok(/LTW/.test(textoWip) && !/LTP/.test(textoWip) && !/LTK/.test(textoWip), 'A coluna "WIP" mostra só os lotes em curso');
  const textoConcluidos = w.eval(`document.getElementById('labColConcluidos').textContent`);
  ok(/LTK/.test(textoConcluidos) && /LTK2/.test(textoConcluidos) && !/LTH/.test(textoConcluidos), 'A coluna "Concluídos" mostra só os lotes fechados hoje (o LTH, fechado noutro dia, não aparece)');
  ok(w.eval(`document.getElementById('labContPlaneados').textContent`) === '1', 'A coluna Planeados mostra a contagem correta');
  ok(w.eval(`document.getElementById('labContWip').textContent`) === '1', 'A coluna WIP mostra a contagem correta');
  ok(w.eval(`document.getElementById('labContConcluidos').textContent`) === '2', 'A coluna Concluídos mostra a contagem correta');

  // não há colunas de Data/Prioridade por extenso/Provadores à vista — só o nº do lote (+ letra U/P)
  ok(w.eval(`!document.getElementById('view-lab').textContent.includes('Provador 1')`), 'A vista principal do LAB já não mostra os nomes dos provadores à vista');
  ok(w.eval(`!!document.querySelector('#labColConcluidos .lab-lote-btn[onclick]')`), 'Cada lote na coluna é um botão clicável (abre a ficha do lote)');
  const onclickLTK = w.eval(`document.querySelector('#labColConcluidos .lab-lote-btn').getAttribute('onclick')`);
  ok(/openLoteDetail/.test(onclickLTK), 'Clicar no lote abre a ficha do lote (openLoteDetail)');

  // letra U/P junto ao nº do lote quando já tinha sido identificado como Urgente/Prioritário
  ok(w.eval(`prioLetraLAB('vermelho')`) === 'U', 'Prioridade Urgente aparece como "U"');
  ok(w.eval(`prioLetraLAB('amarelo')`) === 'P', 'Prioridade Prioritário aparece como "P"');

  // Histórico fica escondido por omissão, só aparece ao pedir
  ok(w.eval(`document.getElementById('blocoHistoricoLAB').classList.contains('hidden')`), 'O bloco de Histórico começa escondido');
  w.eval(`toggleHistoricoLAB();`);
  ok(w.eval(`!document.getElementById('blocoHistoricoLAB').classList.contains('hidden')`), 'Ao clicar em "Ver Histórico de Conclusões", o bloco aparece');
  const textoHistorico = w.eval(`document.getElementById('tabelaLAB').textContent`);
  ok(/LTH/.test(textoHistorico) && !/LTK/.test(textoHistorico), 'O Histórico mostra os lotes concluídos em dias anteriores (não os de hoje)');
  ok(/Prova Concluída/.test(textoHistorico) && !/Rejeitado/.test(textoHistorico), 'O Histórico também mostra só "Prova Concluída" — já não existe aprovado/rejeitado na app');
  ok(w.eval(`document.querySelectorAll('#tabelaLAB > table').length`) === 0, 'O Histórico já não é, ele próprio, uma tabela larga com scroll horizontal (a lista é feita de linhas expansíveis)');
  ok(w.eval(`document.querySelectorAll('#tabelaLAB details.hist-row').length`) === 1, 'Cada lote do Histórico é uma linha compacta e expansível (details/summary)');
  const linhaHist = w.eval(`document.querySelector('#tabelaLAB details.hist-row')`);
  ok(w.eval(`!document.querySelector('#tabelaLAB details.hist-row').open`), 'A linha do Histórico começa fechada (recolhida) por omissão');
  const resumoLinha = w.eval(`document.querySelector('#tabelaLAB details.hist-row summary').textContent`);
  ok(/2020-01-01/.test(resumoLinha) && /LTH/.test(resumoLinha), 'O resumo (fechado) já mostra Data e Nº Lote sem precisar de abrir');
  ok(/\bU\b/.test(resumoLinha), 'O resumo mostra a letra "U" para o lote urgente, sem precisar de abrir');
  const detalheLinha = w.eval(`document.querySelector('#tabelaLAB details.hist-row .hist-row-detalhe').textContent`);
  ok(/Provador 1/.test(detalheLinha) && /Rita/.test(detalheLinha), 'Só dentro do detalhe (ao expandir) é que aparecem os provadores');
  ok(/TCA-P/.test(detalheLinha) && /MOF-F/.test(detalheLinha), 'O detalhe do Histórico mostra também a tabela de frascos com o aroma que cada provador encontrou');

  // ---------- 16c) Tabela "Frascos com Aroma": mostra o que cada provador encontrou, por frasco ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTF'] = criarLoteVazio('LTF'); state.lotes['LTF'].diaPrevisto = ontemStr();
    state.lotes['LTF'].provador1 = 'Rita'; state.lotes['LTF'].provador2 = 'Nuno';
    state.lotes['LTF'].registos.p1 = {itens:[{frasco:3,tcaF:true},{frasco:9,outro:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTF'].registos.p2 = {itens:[{frasco:3,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
  `);
  const framesLTF = w.eval(`framesUniaoLote(state.lotes['LTF'])`);
  ok(Array.isArray(framesLTF) && framesLTF.length===2 && framesLTF[0]===3 && framesLTF[1]===9, 'framesUniaoLote junta os frascos assinalados por qualquer provador (3 e 9)');
  const csvFrascosLTF = w.eval(`textoFrascosLoteCsv(state.lotes['LTF'])`);
  ok(/F3:TCA-F\/TCA-F/.test(csvFrascosLTF) && /F9:OUTRO\/-/.test(csvFrascosLTF), 'O texto para CSV mostra o aroma de cada provador por frasco (ex: F3:TCA-F/TCA-F)');
  w.eval(`openLoteDetail('LTF');`);
  const textoFichaLTF = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(/Frascos com Aroma/.test(textoFichaLTF), 'A ficha do lote (P1+P2 já concluídos) mostra a fieldset "Frascos com Aroma"');
  ok(/TCA-F/.test(textoFichaLTF) && /OUTRO/.test(textoFichaLTF), 'A ficha do lote mostra o aroma encontrado em cada frasco');

  // enquanto P1 concluiu mas P2 ainda não (prova cega), a tabela de frascos não pode aparecer
  w.eval(`
    state.lotes['LTF2'] = criarLoteVazio('LTF2'); state.lotes['LTF2'].diaPrevisto = ontemStr();
    state.lotes['LTF2'].provador1 = 'Rita';
    state.lotes['LTF2'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    openLoteDetail('LTF2');
  `);
  const textoFichaLTF2 = w.eval(`document.getElementById('overlayLote').textContent`);
  ok(!/Frascos com Aroma/.test(textoFichaLTF2), 'Enquanto o Provador 2 não conclui, a tabela de frascos fica escondida (mantém a prova cega)');
  ok(/mantém a prova cega/.test(textoFichaLTF2), 'A ficha explica que o registo do Provador 1 está escondido para manter a prova cega');

  // ---------- 16d) Supervisora pode quebrar a prova cega e ver já o Provador 1, com o código de
  // administração (8126) (29/09/2026, a pedido da Joana) ----------
  const btnVerP1Sup = w.eval(`document.querySelector('#overlayLote button[onclick*="openRegistoReadOnly"][onclick*="p1"]')`);
  ok(!!btnVerP1Sup, 'Enquanto o Provador 2 não conclui, aparece o botão "Ver Provador 1 (Supervisora)"');
  ok(w.eval(`document.querySelector('#overlayLote button[onclick*="openRegistoReadOnly"][onclick*="p1"]').textContent.trim()`) === 'Ver Provador 1 (Supervisora)', 'O botão tem o texto certo');

  // código errado não abre nada
  w.eval(`
    window.__promptOriginal = window.prompt; window.__alertOriginal = window.alert;
    window.prompt = () => 'errado'; window.alert = () => {};
    document.querySelector('#overlayLote button[onclick*="openRegistoReadOnly"][onclick*="p1"]').click();
  `);
  ok(w.eval(`!document.getElementById('overlayRegistoRO')`), 'Com o código errado, a prova cega mantém-se — não abre o registo do Provador 1');

  // código certo (8126) mostra o registo do Provador 1, mesmo o Provador 2 não tendo concluído
  w.eval(`
    window.prompt = () => '8126';
    document.querySelector('#overlayLote button[onclick*="openRegistoReadOnly"][onclick*="p1"]').click();
  `);
  ok(!!w.eval(`document.getElementById('overlayRegistoRO')`), 'Com o código 8126, abre o registo do Provador 1 mesmo com o Provador 2 ainda por concluir');
  ok(/TCA-F/.test(w.eval(`document.getElementById('overlayRegistoRO').textContent`)), 'E mostra mesmo os dados registados pelo Provador 1 (frasco com TCA Forte)');
  w.eval(`closeModal('overlayRegistoRO'); window.prompt = window.__promptOriginal; window.alert = window.__alertOriginal;`);

  // depois de o Provador 2 concluir, o botão de supervisora deixa de aparecer — já não é preciso, o
  // "Ver Provador 1" normal já está disponível
  w.eval(`
    state.lotes['LTF2'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    openLoteDetail('LTF2');
  `);
  ok(w.eval(`!document.querySelector('#overlayLote button[onclick*="openRegistoReadOnly"][onclick*="p1"]')`), 'Depois do Provador 2 concluir, o botão "Ver Provador 1 (Supervisora)" já não aparece (deixou de ser preciso)');
  ok(!!w.eval(`document.querySelector('#overlayLote button[onclick="openRegistoModal(\\'LTF2\\',\\'p1\\')"]')`), 'Passa a aparecer o "Ver Provador 1" normal, como sempre depois de P1+P2 concluídos');
  w.eval(`closeModal('overlayLote');`);

  // ---------- 17) Estado escrito no quadrado: Planeado / WIP (uma só cor, 18/09/2026) ----------
  w.eval(`state.lotes = {}; switchView('inicio');`);
  w.eval(`
    state.lotes['LTG1'] = criarLoteVazio('LTG1'); state.lotes['LTG1'].diaPrevisto = ontemStr();
    state.lotes['LTG2'] = criarLoteVazio('LTG2'); state.lotes['LTG2'].diaPrevisto = ontemStr();
    state.lotes['LTG2'].provador1 = 'Marta Santos';
    state.lotes['LTG3'] = criarLoteVazio('LTG3'); state.lotes['LTG3'].diaPrevisto = ontemStr();
    state.lotes['LTG3'].provador1 = 'Marta Santos'; state.lotes['LTG3'].provador2 = 'Francisca Braga';
    state.lotes['LTG3'].registos.p1.concluido = true; state.lotes['LTG3'].registos.p2.concluido = true;
    renderGradeLotes();
  `);
  const planeadosPresentes = w.eval(`document.querySelectorAll('.quad-estado-txt.e-planeado').length`);
  ok(planeadosPresentes === 1, 'Só o lote que ainda não começou mostra o texto "Planeado" no quadrado');
  const wipPresentes = w.eval(`document.querySelectorAll('.quad-estado-txt.e-wip').length`);
  ok(wipPresentes === 2, 'Os dois lotes com provador1 preenchido mostram a barra "WIP" (1 de 2 ou 2 de 2 — sem distinção de cor)');
  ok(w.eval(`!document.querySelector('.quad-estado-txt.e-wip1')`) && w.eval(`!document.querySelector('.quad-estado-txt.e-wip2')`),
    'Já não existem classes separadas e-wip1/e-wip2 — o WIP voltou a ser uma cor única (removido a pedido)');
  const txtPlaneado = w.eval(`document.querySelector('.quad-estado-txt.e-planeado').textContent.trim()`);
  ok(txtPlaneado === 'Planeado', 'A palavra escrita no quadrado do lote sem provadores é literalmente "Planeado"');
  const txtWip = w.eval(`document.querySelector('.quad-estado-txt.e-wip').textContent.trim()`);
  ok(txtWip === 'WIP', 'A palavra escrita no quadrado é "WIP"');
  const legendaTxt = w.eval(`document.body.textContent`);
  ok(!/Estado escrito no quadrado/.test(legendaTxt), 'Já não existe o texto explicativo da legenda sobre Planeado/WIP (removido a pedido)');

  // ---------- 18) Botão "⋯ Mais opções" no cabeçalho, com "Exportar Histórico (CSV)" lá dentro
  // (01/10/2026: agrupadas as ações secundárias num único menu, a pedido da Joana, para não encher
  // o cabeçalho de botões — antes "Exportar Histórico (CSV)" estava solto no cabeçalho). ----------
  ok(w.eval(`!!document.querySelector('header.topbar .btn-hist-csv')`), 'Existe um botão "⋯ Mais opções" no cabeçalho, junto à barra de pesquisa do lote');
  ok(w.eval(`document.querySelector('header.topbar .btn-hist-csv').textContent.trim()`) === '⋯ Mais opções', 'O botão do cabeçalho tem o texto "⋯ Mais opções"');
  ok(w.eval(`document.querySelector('header.topbar .btn-hist-csv').getAttribute('onclick')`) === 'abrirMaisOpcoes()', 'O botão do cabeçalho abre o menu "Mais opções"');
  w.eval(`abrirMaisOpcoes()`);
  ok(w.eval(`!!document.getElementById('overlayMaisOpcoes')`), 'abrirMaisOpcoes() mostra o menu com as ações secundárias');
  const btnExportarMenu = w.eval(`Array.from(document.querySelectorAll('#overlayMaisOpcoes button')).find(b=>b.textContent.trim()==='Exportar Histórico (CSV)')`);
  ok(!!btnExportarMenu, 'O menu "Mais opções" tem um botão "Exportar Histórico (CSV)"');
  w.eval(`closeModal('overlayMaisOpcoes')`);
  ok(w.eval(`!document.querySelector('#blocoHistoricoLAB button')`), 'O botão deixou de estar duplicado dentro do bloco de Histórico do LAB');
  // continua a funcionar a partir de qualquer ecrã (ex.: estando no Início, não em LAB)
  w.eval(`
    switchView('inicio');
    state.lotes['LTCSV'] = criarLoteVazio('LTCSV'); state.lotes['LTCSV'].diaPrevisto = ontemStr();
    state.lotes['LTCSV'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTCSV'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTCSV'].decisao = {final:'concluido', temFrascosParaLevantar:false, data: new Date().toISOString()};
  `);
  // jsdom não implementa URL.createObjectURL/a.click() de download — simula-se só isso (é limitação
  // do ambiente de teste, não do browser real) para poder confirmar que a função corre sem erro.
  w.URL.createObjectURL = () => 'blob:teste';
  w.URL.revokeObjectURL = () => {};
  let exportouSemErro = true;
  try{ w.eval(`exportarTabelaLABCsv()`); } catch(e){ exportouSemErro = false; }
  ok(exportouSemErro, 'exportarTabelaLABCsv() corre sem erro estando na vista Início (não depende de estar em LAB nem do histórico aberto)');

  // ---------- 19) Logística: Prioridades + Levantamento fundidos no mesmo ecrã ----------
  ok(w.eval(`!document.getElementById('navPrioridades')`), 'Já não existe um botão de navegação separado para "Prioridades"');
  ok(w.eval(`document.getElementById('navLevantamento').textContent`).includes('Logística'), 'O botão de navegação que restou chama-se "Logística"');
  ok(w.eval(`!document.getElementById('navLevantamento').querySelector('#badgeP3')`), 'O botão "Logística" já não tem o badge solto do 3º provador (só mostrava um número sem contexto) — o aviso vive agora só no botão dinâmico do ecrã Lotes');

  w.eval(`
    state.lotes = {};
    switchView('levantamento');
    state.lotes['LTAB'] = criarLoteVazio('LTAB'); state.lotes['LTAB'].diaPrevisto = ontemStr();
    state.lotes['LT00000001'] = criarLoteVazio('LT00000001'); state.lotes['LT00000001'].diaPrevisto = ontemStr();
    state.lotes['LT00000001'].prioridade = 'vermelho';
    state.lotes['LT00000001'].provador1 = 'Marta Santos'; state.lotes['LT00000001'].provador2 = 'Teresa Pinto';
    state.lotes['LT00000001'].registos.p1 = {itens:[{frasco:6,tcaF:true},{frasco:15,mofoP:true}],apreciacao:'limpo',observacoes:'Cheiro intenso no frasco 6.',concluido:true};
    state.lotes['LT00000001'].registos.p2 = {itens:[{frasco:6,tcaF:true},{frasco:15,mofoP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT00000001'].decisao.final = 'concluido';
    state.lotes['LT00000001'].decisao.temFrascosParaLevantar = true;
    state.lotes['LT00000001'].decisao.data = new Date().toISOString();
    state.lotes['LTREJ0'] = criarLoteVazio('LTREJ0'); state.lotes['LTREJ0'].diaPrevisto = ontemStr();
    state.lotes['LTREJ0'].provador1 = 'Marta Santos'; state.lotes['LTREJ0'].provador2 = 'Teresa Pinto';
    state.lotes['LTREJ0'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJ0'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJ0'].decisao.final = 'concluido';
    state.lotes['LTREJ0'].decisao.temFrascosParaLevantar = true;
    state.lotes['LTREJ0'].decisao.data = new Date().toISOString();
    state.lotes['LTREJ0'].decisao.comentarios = '2 frasco(s) com TCA/Mofo (união dos provadores) — segue para o Levantamento.';
    state.lotes['LTREJONTEM'] = criarLoteVazio('LTREJONTEM'); state.lotes['LTREJONTEM'].diaPrevisto = ontemStr();
    state.lotes['LTREJONTEM'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJONTEM'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJONTEM'].decisao.final = 'concluido';
    state.lotes['LTREJONTEM'].decisao.temFrascosParaLevantar = true;
    state.lotes['LTREJONTEM'].decisao.data = '2020-01-01T10:00:00.000Z';
    // 23/09/2026: lote concluído mas ABAIXO do limiar (temFrascosParaLevantar=false) — a pedido da
    // Joana, o Histórico tem de mostrar este lote na mesma (com "0" frascos), não escondê-lo.
    state.lotes['LTHISTZERO'] = criarLoteVazio('LTHISTZERO'); state.lotes['LTHISTZERO'].diaPrevisto = ontemStr();
    state.lotes['LTHISTZERO'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTHISTZERO'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTHISTZERO'].decisao.final = 'concluido';
    state.lotes['LTHISTZERO'].decisao.temFrascosParaLevantar = false;
    state.lotes['LTHISTZERO'].decisao.data = new Date().toISOString();
    renderAll();
  `);
  ok(!w.eval(`document.getElementById('listaPrioridades')`), 'A lista "Lotes em aberto" já não existe no ecrã Logística');
  ok(w.eval(`!document.body.textContent.includes('Lotes em aberto')`), 'O título "Lotes em aberto" foi removido');
  ok(w.eval(`!document.getElementById('toolbarSelecao')`), 'A seleção múltipla/apagar em massa foi removida (não há lista para selecionar)');
  ok(!w.eval(`document.body.textContent`).includes('Imprimir'), 'O botão "Imprimir" dos Lotes em aberto foi removido');
  ok(!w.eval(`document.body.textContent`).includes('Exportar CSV') && !w.eval(`document.body.textContent`).includes('Exportar XLS'), 'Os botões "Exportar CSV"/"Exportar XLS" dos Lotes em aberto foram removidos');
  // 21/09/2026: "Importar lista do planeamento" (colar prioridades) foi removido do ecrã Logística —
  // já só existe no ecrã Lotes (era o mesmo atalho duplicado em 2 sítios, ver secção 19c mais abaixo).
  ok(!w.eval(`document.body.textContent.includes('Importar lista do planeamento')`), 'O título "Importar lista do planeamento" foi removido do ecrã Logística');
  ok(!w.eval(`!!document.querySelector('#view-levantamento button[onclick="toggleImportBox()"]')`), 'O botão "Colar lista recebida por email" foi removido do ecrã Logística (já só existe no ecrã Lotes)');

  // 21/09/2026: "Por levantar (hoje)" deixou de listar os cartões automaticamente — só mostra um aviso
  // a indicar para ler o código de barras. A listagem completa dos cartões passou a viver só no
  // separador "Histórico" (testada a seguir).
  const txtLevantamentoHoje = w.eval(`document.getElementById('listaLevantamento').textContent`);
  ok(!txtLevantamentoHoje.includes('LT00000001') && !txtLevantamentoHoje.includes('LTREJ0') && !txtLevantamentoHoje.includes('LTREJONTEM'), '"Por levantar (hoje)" já não lista nenhum cartão de lote automaticamente');
  ok(/Ler código de barras da etiqueta/.test(txtLevantamentoHoje), '"Por levantar (hoje)" mostra um aviso a indicar para ler o código de barras da etiqueta');
  ok(!w.eval(`document.querySelector('#listaLevantamento .quad-lote.lev-tile')`), '"Por levantar (hoje)" não tem nenhum bloco colorido de lote (a lista está mesmo vazia, só o aviso)');

  w.eval(`filtrarLevantamento('todos')`);
  const txtLevantamentoTodos = w.eval(`document.getElementById('listaLevantamento').textContent`);
  ok(txtLevantamentoTodos.includes('LT00000001') && txtLevantamentoTodos.includes('LTREJ0') && txtLevantamentoTodos.includes('LTREJONTEM'), '"Histórico" mostra todos os lotes com frascos para levantar, de hoje e de dias anteriores (a lista completa mudou-se para aqui)');
  ok(txtLevantamentoTodos.includes('LTHISTZERO'), '23/09/2026: "Histórico" também mostra um lote concluído ABAIXO do limiar (temFrascosParaLevantar=false) — o limiar só decide a prova, não filtra o que a Logística vê');
  ok(w.eval(`document.querySelector('[data-lf="todos"]').textContent.trim()`) === 'Histórico', 'O separador passou a chamar-se "Histórico" (em vez de "Todos os rejeitados")');
  const numFrascosLT00000001 = w.eval(`document.querySelector('#listaLevantamento .quad-lote.q-prio-urgente').closest('.lote-card').querySelector('.fl-num').textContent.trim()`);
  ok(numFrascosLT00000001 === '6, 15', 'Mostra o nº efetivo dos frascos a levantar (ex: 6, 15) em vez de só uma contagem, num destaque maior (fl-num)');
  const cartoesLevantamento = w.eval(`[...document.querySelectorAll('#listaLevantamento .fl-num')].map(e=>e.textContent.trim())`);
  ok(cartoesLevantamento.includes('0'), 'Quando não há frasco assinalado individualmente, mostra "0"');
  ok(txtLevantamentoTodos.includes('Cheiro intenso no frasco 6'), 'As Observações do provador continuam visíveis');
  ok(!/Apreciação Geral/.test(txtLevantamentoTodos), 'A "Apreciação Geral" foi removida do Levantamento');
  ok(!/TCA|Mofo/.test(txtLevantamentoTodos), 'A informação de tipo de defeito (TCA/Mofo) foi removida do Levantamento');
  ok(!/Material levantado/.test(txtLevantamentoTodos), 'Já não existe a validação/checkbox "Material levantado"');
  ok(!/segue para o Levantamento/.test(txtLevantamentoTodos) && !/Comentários:/.test(txtLevantamentoTodos), 'O comentário da decisão automática já não aparece no Levantamento');
  ok(txtLevantamentoTodos.includes('Sem observações registadas'), 'Sem observações reais dos provadores, mostra "Sem observações registadas" em vez do comentário automático');

  ok(w.eval(`!!document.querySelector('#listaLevantamento .quad-lote.lev-tile.q-prio-urgente')`), 'O nº do lote no Levantamento aparece num bloco colorido igual ao da grelha de Lotes (mesma cor de prioridade)');
  ok(w.eval(`document.querySelector('#listaLevantamento .quad-lote.lev-tile.q-prio-urgente').textContent.trim()`) === 'LT00000001', 'O bloco colorido mostra o nº do lote (LT00000001, prioridade urgente/vermelho)');
  ok(w.eval(`document.querySelector('#listaLevantamento .quad-lote.lev-tile.q-prio-urgente').tagName`) === 'BUTTON', 'O bloco colorido é um botão (tipo botões, clicável para abrir a ficha do lote)');

  w.eval(`filtrarLevantamento('pendentes')`);

  // ---------- 19b) Logística: "Ler código barras da etiqueta" é de disparo contínuo — cada etiqueta
  // nova atualiza o cartão sozinha, sem fechar a câmara nem precisar de mais nenhum clique ----------
  const btnScanLevantamento = w.eval(`document.querySelector('#view-levantamento button[onclick="abrirScannerLevantamento()"]')`);
  ok(!!btnScanLevantamento, 'Existe um botão no ecrã Logística que chama abrirScannerLevantamento()');
  ok(w.eval(`document.querySelector('#view-levantamento button[onclick="abrirScannerLevantamento()"]').textContent.trim()`) === 'Ler código barras da etiqueta', 'O botão tem o texto "Ler código barras da etiqueta"');

  // simula o leitor já aberto em modo levantamento (a biblioteca da câmara não está disponível no teste)
  w.eval(`
    document.getElementById('modalRoot').innerHTML = '<div id="overlayScanner"><div id="resultadoLevantamentoLive"></div></div>';
    scannerModo = 'levantamento'; scannerUltimoCodigo = null; scannerUltimoTempo = 0;
    onCodigoBarrasLido('LT00000001');
  `);
  const textoLive1 = w.eval(`document.getElementById('resultadoLevantamentoLive').textContent`);
  ok(/LT00000001/.test(textoLive1) && /6, 15/.test(textoLive1), 'Ao ler um lote com frascos para levantar, o cartão (com os frascos a levantar) aparece dentro do próprio leitor');
  ok(w.eval(`!!document.getElementById('overlayScanner')`), 'O leitor continua aberto depois de mostrar o cartão — não fecha sozinho, para poder ler a próxima etiqueta');

  // lê logo a seguir outra etiqueta (lote concluído sem nada a levantar) — 23/09/2026, a pedido da
  // Joana: já não mostra uma mensagem à parte, mostra logo o mesmo cartão de sempre, só que com "0"
  // frascos a levantar — basta estar concluído para o scanner interpretar e mostrar o cartão.
  w.eval(`
    state.lotes['LT00000002'] = criarLoteVazio('LT00000002'); state.lotes['LT00000002'].diaPrevisto = ontemStr();
    state.lotes['LT00000002'].decisao.final = 'concluido';
    state.lotes['LT00000002'].decisao.temFrascosParaLevantar = false;
    onCodigoBarrasLido('LT00000002');
  `);
  const textoLive2 = w.eval(`document.getElementById('resultadoLevantamentoLive').textContent`);
  ok(/LT00000002/.test(textoLive2) && !/não tem frascos para levantar/.test(textoLive2), 'Ao ler logo a seguir um lote concluído sem nada a levantar, mostra logo o cartão (não uma mensagem à parte)');
  const flNumLT00000002 = w.eval(`document.querySelector('#resultadoLevantamentoLive .fl-num').textContent.trim()`);
  ok(flNumLT00000002 === '0', 'O cartão desse lote mostra "0" frascos a levantar');

  // código que não corresponde a nenhum lote conhecido
  w.eval(`onCodigoBarrasLido('LT99999999');`);
  const textoLive3 = w.eval(`document.getElementById('resultadoLevantamentoLive').textContent`);
  ok(/Não encontrei nenhum lote/.test(textoLive3), 'Um código sem lote correspondente também atualiza o cartão a dizer que não encontrou');

  // ler o MESMO código outra vez de imediato (etiqueta ainda à frente da câmara) não deve voltar a
  // redesenhar o cartão dentro de 2,5s — evita ficar a piscar sem parar
  w.eval(`document.getElementById('resultadoLevantamentoLive').innerHTML = '<span id="marcadorTeste">ainda aqui</span>'; onCodigoBarrasLido('LT99999999');`);
  ok(w.eval(`!!document.getElementById('marcadorTeste')`), 'Ler o MESMO código repetidamente em menos de 2,5s não volta a redesenhar o cartão');

  // lote que existe mas ainda não tem decisão nenhuma — continua a avisar que ainda não foi decidido
  w.eval(`
    state.lotes['LT00000003'] = criarLoteVazio('LT00000003'); state.lotes['LT00000003'].diaPrevisto = ontemStr();
    onCodigoBarrasLido('LT00000003');
  `);
  const textoLive3b = w.eval(`document.getElementById('resultadoLevantamentoLive').textContent`);
  ok(/LT00000003/.test(textoLive3b) && /ainda não foi decidido/.test(textoLive3b), 'Um lote que ainda não tem decisão continua a avisar "ainda não foi decidido" (não mostra o cartão)');

  // fora do modo levantamento, continua a fechar a câmara e a abrir a ficha completa como sempre
  w.eval(`
    document.getElementById('modalRoot').innerHTML = '<div id="overlayScanner"></div>';
    scannerModo = 'detalhe';
    onCodigoBarrasLido('LT00000001');
  `);
  ok(w.eval(`!!document.getElementById('overlayLote')`), 'Fora do modo levantamento (scanner normal), ler um lote continua a abrir a ficha completa');
  ok(w.eval(`!document.getElementById('overlayScanner')`), 'E fecha o leitor, como sempre');
  w.eval(`closeModal('overlayLote');`);

  // ---------- 19c) Só aceita códigos no formato exato "LT" + 8 dígitos (28/09/2026, a pedido da
  // Joana) — a etiqueta tem vários códigos de barras (Lote Controlo, PO, etc.), e mesmo um "LT" solto
  // sem os 8 dígitos a seguir é ignorado; nada disto cria lotes falsos nem fecha/interrompe a câmara. ----------
  w.eval(`
    state.lotes = {};
    document.getElementById('modalRoot').innerHTML = '<div id="overlayScanner"></div>';
    scannerModo = 'detalhe';
    onCodigoBarrasLido('040000818265'); // "Lote Controlo" da etiqueta — não é o nº de lote
  `);
  ok(w.eval(`!document.getElementById('overlayLote')`), 'Um código que não começa por "LT" (ex.: o "Lote Controlo") não abre nenhuma ficha');
  ok(w.eval(`!!document.getElementById('overlayScanner')`), 'A câmara continua aberta a tentar ler o código certo, em vez de fechar');
  ok(w.eval(`Object.keys(state.lotes).length`) === 0, 'E não chega a criar nenhum lote falso com esse código');

  w.eval(`onCodigoBarrasLido('222002-N-MST-L01-45X240-0303-SDE-SDS');`); // outro código da folha de rosto
  ok(w.eval(`Object.keys(state.lotes).length`) === 0, 'Outro código da etiqueta que também não começa por "LT" continua a ser ignorado');

  w.eval(`onCodigoBarrasLido('LT0237269');`); // "LT" + só 7 dígitos (um a menos) — ainda não é o formato certo
  ok(w.eval(`Object.keys(state.lotes).length`) === 0, '"LT" seguido de menos de 8 dígitos continua a ser ignorado (formato incompleto)');

  w.eval(`onCodigoBarrasLido('LT023726901');`); // "LT" + 9 dígitos (um a mais) — também não bate certo
  ok(w.eval(`Object.keys(state.lotes).length`) === 0, '"LT" seguido de mais de 8 dígitos também é ignorado (não é o formato exato)');

  w.eval(`onCodigoBarrasLido('LT02372690');`); // o código certo (LT + exatamente 8 dígitos), lido a seguir
  ok(w.eval(`!!document.getElementById('overlayLote')`), 'Assim que lê o código certo ("LT" + 8 dígitos), abre a ficha normalmente');
  ok(w.eval(`!!state.lotes['LT02372690']`), 'E cria/abre esse lote');
  w.eval(`closeModal('overlayLote');`);

  // o mesmo filtro aplica-se ao modo levantamento (Logística)
  w.eval(`
    document.getElementById('modalRoot').innerHTML = '<div id="overlayScanner"><div id="resultadoLevantamentoLive"></div></div>';
    scannerModo = 'levantamento'; scannerUltimoCodigo = null; scannerUltimoTempo = 0;
    onCodigoBarrasLido('040000818265');
  `);
  ok(w.eval(`document.getElementById('resultadoLevantamentoLive').textContent`) === '', 'No modo levantamento, um código que não começa por "LT" também é ignorado — não atualiza o cartão');

  // ---------- 20) LAB: botão "Copiar" — só na coluna Concluídos (22/09/2026: removido de Planeados/WIP
  // a pedido da Joana, porque esses lotes ainda não têm nada para "enviar ao LAB") ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LTP1'] = criarLoteVazio('LTP1'); state.lotes['LTP1'].diaPrevisto = ontemStr();
    state.lotes['LTP2'] = criarLoteVazio('LTP2'); state.lotes['LTP2'].diaPrevisto = ontemStr();
    state.lotes['LTW1'] = criarLoteVazio('LTW1'); state.lotes['LTW1'].diaPrevisto = ontemStr(); state.lotes['LTW1'].provador1 = 'Marta Santos';
    state.lotes['LTCA'] = criarLoteVazio('LTCA'); state.lotes['LTCA'].diaPrevisto = hojeStr(); state.lotes['LTCA'].decisao.final = 'concluido'; state.lotes['LTCA'].decisao.data = hojeStr();
    state.lotes['LTCB'] = criarLoteVazio('LTCB'); state.lotes['LTCB'].diaPrevisto = hojeStr(); state.lotes['LTCB'].decisao.final = 'concluido'; state.lotes['LTCB'].decisao.data = hojeStr();
    switchView('lab');
  `);
  ok(!w.eval(`document.getElementById('labColPlaneados').parentElement.querySelector('.lab-col-copy')`), 'A coluna Planeados já não tem botão "Copiar"');
  ok(!w.eval(`document.getElementById('labColWip').parentElement.querySelector('.lab-col-copy')`), 'A coluna WIP já não tem botão "Copiar"');
  ok(!!w.eval(`document.getElementById('labColConcluidos').parentElement.querySelector('.lab-col-copy')`), 'A coluna Concluídos continua a ter o botão "Copiar"');
  let textoCopiado = null;
  w.navigator.clipboard = { writeText: (t)=>{ textoCopiado = t; return Promise.resolve(); } };
  const alertsAntes = alerts.length;
  w.eval(`copiarColunaLAB('concluidos')`);
  ok(textoCopiado === 'LTCA\nLTCB', 'O "Copiar" da coluna Concluídos junta só os nºs de lote com quebra de linha (um por linha), sem TCA/MOFO/OUTROS nem a letra U/P');
  ok(alerts.length === alertsAntes, 'Copiar já não abre um popup a pedir para clicar OK — copia direto, sem pokeyoke');
  ok(w.eval(`!state.lotes['LTCA'].copiadoLAB && !state.lotes['LTCB'].copiadoLAB`), 'Copiar a coluna toda (sem nada marcado) não assinala nenhum lote como "já copiado" — não muda cor');

  // ---------- 20b) LAB: mini-tabela TCA/MOFO/OUTROS, caixa de seleção e "Copiar" seletivo (roxo) —
  // tudo isto só existe na coluna Concluídos; Planeados/WIP ficam sem nenhum destes elementos ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LTX1'] = criarLoteVazio('LTX1'); state.lotes['LTX1'].diaPrevisto = ontemStr();
    state.lotes['LTX1'].provador1 = 'Rita'; state.lotes['LTX1'].provador2 = 'Nuno';
    state.lotes['LTX1'].registos.p1 = {itens:[{frasco:1,tcaF:true},{frasco:2,mofoP:true}],apreciacao:'',observacoes:'Cheira mal',concluido:true};
    state.lotes['LTX1'].registos.p2 = {itens:[{frasco:1,tcaF:true},{frasco:3,outro:true}],apreciacao:'',observacoes:'Confirmo',concluido:true};
    state.lotes['LTX2'] = criarLoteVazio('LTX2'); state.lotes['LTX2'].diaPrevisto = ontemStr();
    state.lotes['LTX2'].provador1 = 'Rita';
    state.lotes['LTX2'].registos.p1 = {itens:[],apreciacao:'',observacoes:'Só eu escrevi',concluido:false};
    state.lotes['LTC1'] = criarLoteVazio('LTC1'); state.lotes['LTC1'].diaPrevisto = hojeStr();
    state.lotes['LTC1'].provador1 = 'Rita'; state.lotes['LTC1'].provador2 = 'Nuno';
    state.lotes['LTC1'].registos.p1 = {itens:[{frasco:1,tcaF:true},{frasco:2,mofoP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTC1'].registos.p2 = {itens:[{frasco:1,tcaF:true},{frasco:3,outro:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTC1'].decisao.final = 'concluido';
    state.lotes['LTC1'].decisao.temFrascosParaLevantar = true;
    state.lotes['LTC1'].decisao.data = hojeStr();
    state.lotes['LTC2'] = criarLoteVazio('LTC2'); state.lotes['LTC2'].diaPrevisto = hojeStr();
    state.lotes['LTC2'].decisao.final = 'concluido'; state.lotes['LTC2'].decisao.data = hojeStr();
    switchView('lab');
  `);
  // mini-tabela: só aparece na coluna Concluídos (a pedido) — Planeados/WIP ficam sem ela
  // 25/09/2026: a pedido da Joana, a mini-tabela passou a contar só os frascos COINCIDENTES entre os
  // 2 provadores (mesma regra da decisão automática), não a união de tudo. Em LTC1: frasco 1 (TCA
  // Forte nos dois) é coincidente -> conta; frasco 2 (Mofo, só P1) e frasco 3 (Outro, só P2) são
  // discordantes -> descartados deste resumo (['1','0','0'], já não ['1','1','1']).
  const celulasLTC1 = w.eval(`[...document.querySelectorAll('[data-lote="LTC1"] .lab-mini-tabela td')].map(td=>td.textContent)`);
  ok(JSON.stringify(celulasLTC1) === JSON.stringify(['1','0','0']), 'Em Concluídos, a mini-tabela mostra só os frascos coincidentes entre os provadores (discordantes são descartados)');
  ok(w.eval(`!document.querySelector('[data-lote="LTX1"] .lab-mini-tabela')`), 'Em WIP, o lote já não mostra a mini-tabela TCA/MOFO/OUTROS (só pedida para Concluídos)');
  ok(w.eval(`!document.querySelector('[data-lote="LTX2"] .lab-mini-tabela')`), 'Em Planeados/WIP, nenhum lote mostra a mini-tabela');

  // asterisco só quando AMBOS os provadores preenchem Observações
  ok(w.eval(`!!document.querySelector('[data-lote="LTX1"] .lab-obs-flag')`), 'LTX1 (P1 e P2 com Observações) mostra o símbolo de evidência');
  ok(w.eval(`!document.querySelector('[data-lote="LTX2"] .lab-obs-flag')`), 'LTX2 (só P1 escreveu Observações) não mostra o símbolo — falta o P2');

  // checkbox de seleção por lote — 22/09/2026: removido de Planeados/WIP, continua só em Concluídos
  ok(!w.eval(`document.querySelector('[data-lote="LTX1"] .lab-lote-check')`), 'Em WIP, o lote já não tem caixa de seleção');
  ok(!w.eval(`document.querySelector('[data-lote="LTX2"] .lab-lote-check')`), 'Em Planeados/WIP, nenhum lote tem caixa de seleção');
  ok(w.eval(`!!document.querySelector('[data-lote="LTC1"] .lab-lote-check')`), 'Em Concluídos, o lote continua a ter caixa de seleção');
  w.eval(`document.querySelector('[data-lote="LTC1"] .lab-lote-check').checked = true; toggleSelecaoLAB('LTC1', document.querySelector('[data-lote="LTC1"] .lab-lote-check'));`);
  ok(w.eval(`labSelecionados.has('LTC1')`), 'Marcar a caixa acrescenta o lote à seleção');

  // "Copiar" com seleção: copia só o(s) marcado(s), fica roxo (copiadoLAB) e a seleção é limpa
  textoCopiado = null;
  w.eval(`copiarColunaLAB('concluidos')`);
  ok(textoCopiado === 'LTC1', 'Com LTC1 marcado, "Copiar" copia só o nº desse lote (mesmo havendo outro lote em Concluídos) — sem TCA/MOFO/OUTROS no texto');
  ok(w.eval(`state.lotes['LTC1'].copiadoLAB === true`), 'Depois de copiar o lote selecionado, fica assinalado como já copiado/enviado ao LAB');
  ok(w.eval(`!labSelecionados.has('LTC1')`), 'Depois de copiar, a seleção desse lote é limpa (a caixa desmarca)');
  ok(w.eval(`document.querySelector('[data-lote="LTC1"] .lab-lote-btn').classList.contains('copiado')`), 'O quadrado do lote copiado fica com a classe visual roxa');
  ok(w.eval(`!state.lotes['LTC2'].copiadoLAB`), 'O lote LTC2, que não estava marcado, não fica assinalado nem muda de cor');

  // ---------- 20c) Caso real trazido pela Joana (LT02379398, 25/09/2026): frascos 13/20/38/48
  // marcados pelos 2 provadores (coincidentes -> contam), frascos 6/7 (só P2, "Outro") e 32 (só P1,
  // TCA) são discordantes -> descartados. Resultado esperado no quadro do LAB: 4 TCA, 0 Mofo, 0 Outros
  // (não "5 TCA, 0 Mofo, 2 Outros", que seria a união de tudo). ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LT02379398'] = criarLoteVazio('LT02379398'); state.lotes['LT02379398'].diaPrevisto = hojeStr();
    state.lotes['LT02379398'].provador1 = 'Rita'; state.lotes['LT02379398'].provador2 = 'Nuno';
    state.lotes['LT02379398'].registos.p1 = {itens:[
      {frasco:13,tcaP:true},{frasco:20,tcaP:true},{frasco:32,tcaP:true},{frasco:38,tcaP:true},{frasco:48,tcaP:true}
    ],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT02379398'].registos.p2 = {itens:[
      {frasco:6,outro:true},{frasco:7,outro:true},{frasco:13,tcaP:true},{frasco:20,tcaF:true},{frasco:38,tcaP:true},{frasco:48,tcaP:true}
    ],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT02379398'].decisao.final = 'concluido';
    state.lotes['LT02379398'].decisao.temFrascosParaLevantar = true;
    state.lotes['LT02379398'].decisao.data = hojeStr();
    switchView('lab');
  `);
  const celulasLT398 = w.eval(`[...document.querySelectorAll('[data-lote="LT02379398"] .lab-mini-tabela td')].map(td=>td.textContent)`);
  ok(JSON.stringify(celulasLT398) === JSON.stringify(['4','0','0']), 'LT02379398: o quadro do LAB mostra 4 TCA, 0 Mofo, 0 Outros — só os coincidentes (13, 20, 38, 48), descartando os discordantes (6, 7, 32)');

  // ---------- 20d) Segundo caso real trazido pela Joana (28/09/2026): frascos 10 (só P2, Outro), 16
  // (só P2, TCA) e 45 (só P1, Outro) são discordantes -> descartados. Frasco 22 (TCA-F / TCA-P) é
  // coincidente na mesma categoria -> 1 TCA. Frasco 17 (Mofo-P / Outro) é coincidente com categorias
  // diferentes -> hierarquia decide: Mofo > Outro -> conta como 1 Mofo. Resultado esperado no quadro
  // do LAB: 1 TCA, 1 Mofo, 0 Outros. ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LT02379999'] = criarLoteVazio('LT02379999'); state.lotes['LT02379999'].diaPrevisto = hojeStr();
    state.lotes['LT02379999'].provador1 = 'Ana Catarina Silva'; state.lotes['LT02379999'].provador2 = 'Francisca Braga';
    state.lotes['LT02379999'].registos.p1 = {itens:[
      {frasco:17,mofoP:true},{frasco:22,tcaF:true},{frasco:45,outro:true}
    ],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT02379999'].registos.p2 = {itens:[
      {frasco:10,outro:true},{frasco:16,tcaP:true},{frasco:17,outro:true},{frasco:22,tcaP:true}
    ],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT02379999'].decisao.final = 'concluido';
    state.lotes['LT02379999'].decisao.temFrascosParaLevantar = true;
    state.lotes['LT02379999'].decisao.data = hojeStr();
    switchView('lab');
  `);
  const celulasLT999 = w.eval(`[...document.querySelectorAll('[data-lote="LT02379999"] .lab-mini-tabela td')].map(td=>td.textContent)`);
  ok(JSON.stringify(celulasLT999) === JSON.stringify(['1','1','0']), 'LT02379999: o quadro do LAB mostra 1 TCA (frasco 22), 1 Mofo (frasco 17, hierarquia vence sobre Outro), 0 Outros — frascos 10/16/45 discordantes ficam de fora');

  // ---------- 21) Nav: "Início" passa a "Lotes" e o botão "+" fica centrado ----------
  ok(w.eval(`document.getElementById('navInicio').textContent.trim()`) === 'Lotes', 'O botão de navegação "Início" passou a chamar-se "Lotes"');
  const navFabEntrePares = w.eval(`
    (() => {
      const nav = document.querySelector('.bottomnav');
      const kids = [...nav.children];
      const fabIdx = kids.findIndex(k=>k.classList.contains('nav-fab'));
      const antes = kids[fabIdx-1], depois = kids[fabIdx+1];
      return !!antes && !!depois && antes.classList.contains('nav-side') && depois.classList.contains('nav-side');
    })()
  `);
  ok(navFabEntrePares, 'O botão "+" está entre dois grupos (.nav-side) de largura igual — fica sempre centrado, independentemente de quantos botões há de cada lado');
  ok(w.eval(`document.querySelectorAll('.nav-side')[0].contains(document.getElementById('navInicio'))`) && w.eval(`document.querySelectorAll('.nav-side')[0].contains(document.getElementById('navLab'))`), 'Lotes e LAB ficam no grupo da esquerda');
  ok(w.eval(`document.querySelectorAll('.nav-side')[1].contains(document.getElementById('navLevantamento'))`), 'Logística fica no grupo da direita');

  // ---------- 21b) Botão "+" abre o Resumo do Estado (Total/Por Abrir/Aberto/Fechado) ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LTR1'] = criarLoteVazio('LTR1'); state.lotes['LTR1'].diaPrevisto = ontemStr(); // por abrir
    state.lotes['LTR2'] = criarLoteVazio('LTR2'); state.lotes['LTR2'].diaPrevisto = ontemStr();
    state.lotes['LTR2'].provador1 = 'Marta Santos'; // aberto (WIP)
    state.lotes['LTR3'] = criarLoteVazio('LTR3'); state.lotes['LTR3'].diaPrevisto = hojeStr();
    state.lotes['LTR3'].decisao.final = 'concluido'; state.lotes['LTR3'].decisao.data = hojeStr(); // fechado hoje
    state.lotes['LTR4'] = criarLoteVazio('LTR4'); state.lotes['LTR4'].diaPrevisto = ontemStr();
    state.lotes['LTR4'].decisao.final = 'concluido'; state.lotes['LTR4'].decisao.data = ontemStr(); // fechado ontem -> histórico, não conta
  `);
  const contagem = w.eval(`JSON.stringify(contarEstadoLotes())`);
  ok(contagem === JSON.stringify({total:3, porAbrir:1, aberto:1, fechado:1}),
    'contarEstadoLotes() conta Total/Por Abrir/Aberto/Fechado certos, ignorando lotes fechados em dias anteriores (' + contagem + ')');

  const navFabChamaResumo = w.eval(`document.querySelector('.nav-fab').getAttribute('onclick')`);
  ok(navFabChamaResumo === 'abrirResumoEstado()', 'O botão "+" já chama abrirResumoEstado() em vez de ficar sem ação');

  w.eval(`abrirResumoEstado();`);
  const textoResumo = w.eval(`document.getElementById('overlayResumoEstado').textContent`);
  ok(/Total de Lotes/.test(textoResumo) && /Por Abrir/.test(textoResumo) && /Aberto/.test(textoResumo) && /Fechado/.test(textoResumo),
    'O ecrã do botão "+" mostra os 4 quadrados: Total de Lotes, Por Abrir, Aberto e Fechado');
  const numsResumo = w.eval(`[...document.querySelectorAll('.resumo-estado-tile .re-num')].map(e=>e.textContent.trim())`);
  ok(JSON.stringify(numsResumo) === JSON.stringify(['3','1/3','1/3','1/3']),
    'Os números mostrados batem certo com a contagem (Total 3, Por Abrir 1/3, Aberto 1/3, Fechado 1/3)');
  w.eval(`closeModal('overlayResumoEstado');`);

  // ---------- 22) Pronto para publicar no Railway: 30 min repostos, DEV escondido, cache de teste limpa ----------
  ok(w.eval(`MINUTOS_ESPERA_ENTRE_PROVADORES`) === 30, 'O tempo mínimo entre provadores voltou a ser 30 minutos (estava a 0 só para testes)');
  ok(w.eval(`document.getElementById('btnGerarLoteTeste').classList.contains('hidden')`), 'O botão "Gerar lote de teste (DEV)" está escondido — basta mudar DEV_MOSTRAR_GERAR_LOTE_TESTE para true se precisares de o testar outra vez');
  w.eval(`
    state.lotes['LT09990007'] = criarLoteVazio('LT09990007');
    state.lotes['LT02364212'] = criarLoteVazio('LT02364212');
  `);
  const apagouTeste = w.eval(`limparLotesDeTeste()`);
  ok(apagouTeste === true, 'limparLotesDeTeste() assinala que havia lotes de teste para limpar');
  ok(w.eval(`!state.lotes['LT09990007']`), 'limparLotesDeTeste() apaga os lotes de teste (prefixo LT0999...) da cache');
  ok(w.eval(`!!state.lotes['LT02364212']`), 'limparLotesDeTeste() nunca apaga lotes reais (outro prefixo, vindos do Excel)');

  // ---------- 23) limparTudoExceto(): ação de manutenção pontual — mantém só a lista dada ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LT0A'] = criarLoteVazio('LT0A');
    state.lotes['LT0B'] = criarLoteVazio('LT0B');
    state.lotes['LT0C'] = criarLoteVazio('LT0C');
    window.__chamadasDelete = [];
    window.__fetchOriginal = window.fetch;
    window.fetch = (url, opts) => {
      if(opts && opts.method === 'DELETE') window.__chamadasDelete.push(url);
      return Promise.resolve({ ok:true, json: () => Promise.resolve({ok:true}) });
    };
    limparTudoExceto(['LT0A']); // confirm() está mockado para true (ver topo do ficheiro)
  `);
  const ficaramApenasA = w.eval(`Object.keys(state.lotes).join(',')`);
  const apagouBeC = w.eval(`window.__chamadasDelete.length`);
  ok(ficaramApenasA === 'LT0A' && apagouBeC === 2, 'limparTudoExceto() mantém só os lotes da lista dada e apaga os restantes (ficou: ' + ficaramApenasA + ')');

  w.eval(`window.__chamadasDelete = []; limparTudoExceto(['LT0A']);`);
  const semNadaAApagar = w.eval(`window.__chamadasDelete.length`);
  ok(semNadaAApagar === 0, 'limparTudoExceto() não faz nada (nem pede confirmação) se já só existirem lotes da lista a manter');

  w.eval(`state.lotes['LT0D'] = criarLoteVazio('LT0D'); window.confirm = () => false;`);
  w.eval(`limparTudoExceto(['LT0A']);`);
  const manteveComCancelamento = w.eval(`Object.keys(state.lotes).length`);
  ok(manteveComCancelamento === 2, 'limparTudoExceto() não apaga nada se o utilizador cancelar a confirmação');
  w.eval(`window.confirm = () => true; window.fetch = window.__fetchOriginal;`);

  // ---------- 25) Tombstones (removidos): um lote apagado nunca deve "ressuscitar" a partir de
  // uma sincronização com o servidor, mesmo que a cache local ainda o tenha. Se o servidor devolver
  // um tombstone mais recente do que a última atualização de um lote, esse lote é removido. ----------
  w.eval(`
    state.lotes = {};
    state.removidos = {};
    state.lotes['LTZ1'] = criarLoteVazio('LTZ1');
    state.lotes['LTZ1'].atualizadoEm = '2026-09-16T10:00:00.000Z'; // cópia antiga, anterior ao apagamento
  `);
  const removidoAplicado = w.eval(`
    aplicarRemovidos(state.lotes, { LTZ1: '2026-09-17T08:00:00.000Z' });
    !state.lotes['LTZ1'];
  `);
  ok(removidoAplicado === true, 'aplicarRemovidos() remove da cache local um lote cuja última atualização é anterior ao tombstone');

  const mantidoQuandoMaisRecente = w.eval(`
    state.lotes = {};
    state.lotes['LTZ2'] = criarLoteVazio('LTZ2');
    state.lotes['LTZ2'].atualizadoEm = '2026-09-18T10:00:00.000Z'; // atualização genuína DEPOIS do tombstone
    aplicarRemovidos(state.lotes, { LTZ2: '2026-09-17T08:00:00.000Z' });
    !!state.lotes['LTZ2'];
  `);
  ok(mantidoQuandoMaisRecente === true, 'aplicarRemovidos() mantém um lote se foi genuinamente recriado/atualizado depois do tombstone');

  const mergeRemovidosMantemMaisRecente = w.eval(`
    JSON.stringify(mergeRemovidos({ X:'2026-09-10T00:00:00.000Z' }, { X:'2026-09-17T00:00:00.000Z', Y:'2026-09-01T00:00:00.000Z' }));
  `);
  ok(mergeRemovidosMantemMaisRecente === JSON.stringify({ X:'2026-09-17T00:00:00.000Z', Y:'2026-09-01T00:00:00.000Z' }),
    'mergeRemovidos() junta tombstones de duas fontes, mantendo sempre a data mais recente por lote');

  // Simula uma sincronização completa (fetch de /api/lotes) onde o servidor já tem o tombstone
  // mas a cache local (localStorage, de outro dispositivo) ainda tinha o lote apagado.
  w.eval(`
    state.lotes = { 'LTZ3': criarLoteVazio('LTZ3') };
    state.lotes['LTZ3'].atualizadoEm = '2026-09-16T09:00:00.000Z';
    state.removidos = {};
    window.__fetchOriginal4 = window.fetch;
    window.fetch = () => Promise.resolve({ ok:true, json: () => Promise.resolve({
      lotes: {},
      removidos: { LTZ3: '2026-09-17T09:00:00.000Z' }
    })});
  `);
  w.eval(`enviarAoServidor()`); // assíncrono — a verificação (teste 26) fica no bloco setTimeout final

  // ---------- 27) Painel de administração: palavra-passe protege o acesso a campos normalmente
  // fixos (nº frascos, nº rolhas, prioridade), eliminar o lote, e a lista geral de provadores ----------
  w.eval(`
    window.__promptOriginal = window.prompt;
    window.__alertOriginal = window.alert;
    window.__alertas = [];
    window.alert = (m)=> window.__alertas.push(m);
    state.lotes = {};
    state.lotes['LTF'] = criarLoteVazio('LTF'); state.lotes['LTF'].diaPrevisto = ontemStr();
  `);
  const bloqueadoComPassErrada = w.eval(`
    window.__executou = false;
    window.prompt = () => 'palavra-errada';
    pedirAcessoAdmin(()=>{ window.__executou = true; });
    window.__executou;
  `);
  ok(bloqueadoComPassErrada === false, 'pedirAcessoAdmin() não executa a ação com a palavra-passe errada');
  const alertaPassErrada = w.eval(`window.__alertas[window.__alertas.length-1]`);
  ok(alertaPassErrada === 'Palavra-passe incorreta.', 'Mostra um aviso quando a palavra-passe está errada');

  const cancelarNaoExecuta = w.eval(`
    window.__executou = false;
    window.prompt = () => null; // utilizador cancelou
    pedirAcessoAdmin(()=>{ window.__executou = true; });
    window.__executou;
  `);
  ok(cancelarNaoExecuta === false, 'pedirAcessoAdmin() não executa nada nem mostra aviso se o utilizador cancelar o prompt');

  const passouComPassCerta = w.eval(`
    window.__executou = false;
    window.prompt = () => '8126';
    pedirAcessoAdmin(()=>{ window.__executou = true; });
    window.__executou;
  `);
  ok(passouComPassCerta === true, 'pedirAcessoAdmin() executa a ação quando a palavra-passe está certa');

  const passouComEspacos = w.eval(`
    window.__executou = false;
    window.prompt = () => ' 8126 '; // espaço a mais no telemóvel não deve bloquear
    pedirAcessoAdmin(()=>{ window.__executou = true; });
    window.__executou;
  `);
  ok(passouComEspacos === true, 'pedirAcessoAdmin() aceita a palavra-passe mesmo com espaços a mais no início/fim');

  // Abre o painel de edição e altera nº de frascos, nº de rolhas, prioridade e bartops
  w.eval(`
    window.prompt = () => '8126';
    pedirAcessoAdmin(()=>abrirEdicaoLote('LTF'));
  `);
  ok(w.eval(`!!document.getElementById('overlayEdicaoLote')`), 'A palavra-passe certa abre o painel "Editar informações"');
  w.eval(`
    document.getElementById('fEdPrioridade').value = 'vermelho';
    document.getElementById('fEdFrascos').value = '150';
    document.getElementById('fEdRolhas').value = '4';
    document.getElementById('fEdBartops').checked = true;
    guardarEdicaoLote('LTF');
  `);
  const loteEditado = w.eval(`({p: state.lotes['LTF'].prioridade, f: state.lotes['LTF'].numeroFrascos, r: state.lotes['LTF'].numeroRolhasPorFrasco, b: state.lotes['LTF'].bartops})`);
  ok(loteEditado.p === 'vermelho' && loteEditado.f === 150 && loteEditado.r === 4 && loteEditado.b === true,
    'guardarEdicaoLote() grava prioridade, nº frascos, nº rolhas e bartops no lote');

  // Validação: não aceita nº de frascos/rolhas inválidos (reabre o painel, que "guardarEdicaoLote"
  // anterior tinha fechado ao voltar à ficha do lote)
  w.eval(`
    window.__alertas = [];
    abrirEdicaoLote('LTF');
    document.getElementById('fEdFrascos').value = '0';
    guardarEdicaoLote('LTF');
  `);
  ok(w.eval(`state.lotes['LTF'].numeroFrascos`) === 150, 'guardarEdicaoLote() recusa um nº de frascos inválido (0) e mantém o valor anterior');

  // Eliminar lote a partir do painel de edição
  w.eval(`window.confirm = () => true;`);
  w.eval(`
    window.prompt = () => '8126';
    pedirAcessoAdmin(()=>abrirEdicaoLote('LTF'));
    apagarLote('LTF');
  `);
  ok(w.eval(`!state.lotes['LTF']`) === true, '"Eliminar lote definitivamente" no painel de administração apaga o lote');
  ok(w.eval(`!!state.removidos['LTF']`) === true, 'A eliminação a partir do painel de administração também regista o tombstone');
  w.eval(`window.prompt = window.__promptOriginal; window.alert = window.__alertOriginal;`);

  // ---------- 28) Lista Geral de Provadores: editável e usada em opcoesProvadores() ----------
  const listaPorDefeitoUsada = w.eval(`
    state.provadoresLista = null;
    opcoesProvadores('').includes('Joana Amorim');
  `);
  ok(listaPorDefeitoUsada === true, 'Sem configuração do servidor, opcoesProvadores() usa a lista por defeito (DEFAULT_PROVADORES)');

  const listaPersonalizadaUsada = w.eval(`
    state.provadoresLista = ['Nome Novo', 'Outra Pessoa'];
    const html = opcoesProvadores('');
    html.includes('Nome Novo') && !html.includes('Joana Amorim');
  `);
  ok(listaPersonalizadaUsada === true, 'Com uma lista personalizada em state.provadoresLista, opcoesProvadores() deixa de usar a lista por defeito');

  const configAplicada = w.eval(`
    state.provadoresLista = null;
    aplicarConfig({ provadores: ['Zé', 'Rita'], atualizadoEm: '2026-09-17T12:00:00.000Z' });
    JSON.stringify(state.provadoresLista);
  `);
  ok(configAplicada === JSON.stringify(['Zé','Rita']), 'aplicarConfig() aplica a lista de provadores recebida do servidor');

  const configVaziaIgnorada = w.eval(`
    aplicarConfig({ provadores: [], atualizadoEm: '2026-09-18T00:00:00.000Z' });
    JSON.stringify(state.provadoresLista);
  `);
  ok(configVaziaIgnorada === JSON.stringify(['Zé','Rita']), 'aplicarConfig() ignora uma lista vazia recebida do servidor (mantém a lista que já tinha)');

  // adicionarProvadorAdmin / removerProvadorAdmin (assíncronos — usam fetch para /api/config)
  w.eval(`
    state.provadoresLista = ['Ana', 'Bruno'];
    window.__fetchOriginal5 = window.fetch;
    window.fetch = (url, opts) => Promise.resolve({ ok:true, json: () => Promise.resolve({
      config: { provadores: JSON.parse(opts.body).provadores, atualizadoEm: JSON.parse(opts.body).atualizadoEm }
    })});
    window.confirm = () => true;
    document.getElementById('modalRoot').innerHTML = '<div><input id="fNovoProvador"></div>';
    document.getElementById('fNovoProvador').value = 'Carla Nova';
    adicionarProvadorAdmin(null);
  `);

  // ---------- 24) Resposta de erro do servidor (ex.: 404, endpoint ainda não publicado) tem de
  // repor alertaP3Enviado=false, para tentar de novo mais tarde (precisa de um tick a mais, porque
  // só se resolve depois de o fetch simulado responder) ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LTE'] = criarLoteVazio('LTE'); state.lotes['LTE'].diaPrevisto = ontemStr();
    state.lotes['LTE'].provador1='P1'; state.lotes['LTE'].provador2='P2';
    state.lotes['LTE'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTE'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTE'].revisaoConjunta.feita = true; // -> aguarda_p3
    window.__fetchOriginal3 = window.fetch;
    window.fetch = () => Promise.resolve({ ok:false, status:404 });
    renderAll();
  `);
  setTimeout(() => {
    const flagDepoisDe404 = w.eval(`state.lotes['LTE'].alertaP3Enviado`);
    ok(flagDepoisDe404 === false, 'Resposta de erro do servidor (ex.: 404) repõe alertaP3Enviado=false, para tentar de novo mais tarde');
    w.eval(`window.fetch = window.__fetchOriginal3;`);

    // ---------- 26) enviarAoServidor() aplica o tombstone recebido do servidor e remove da
    // cache local (state.lotes) um lote que outro dispositivo tinha apagado entretanto ----------
    const ltz3Sobreviveu = w.eval(`!!state.lotes['LTZ3']`);
    ok(ltz3Sobreviveu === false, 'enviarAoServidor() aplica o tombstone recebido e remove o lote apagado da cache local');
    const removidoZ3Guardado = w.eval(`state.removidos['LTZ3']`);
    ok(removidoZ3Guardado === '2026-09-17T09:00:00.000Z', 'O tombstone recebido do servidor fica guardado em state.removidos');
    w.eval(`window.fetch = window.__fetchOriginal4;`);

    // ---------- 29) adicionarProvadorAdmin() grava no servidor (via /api/config) e atualiza a
    // lista local — precisa de um tick extra porque guardarProvadoresNoServidor() é assíncrono ----------
    setTimeout(() => {
      const listaComNovoProvador = w.eval(`JSON.stringify(state.provadoresLista)`);
      ok(listaComNovoProvador === JSON.stringify(['Ana','Bruno','Carla Nova']),
        'adicionarProvadorAdmin() acrescenta o novo nome à lista e guarda-o (via /api/config)');

      // repõe o mock de /api/config (outros testes, entretanto, restauraram o fetch por defeito)
      w.eval(`
        window.fetch = (url, opts) => Promise.resolve({ ok:true, json: () => Promise.resolve({
          config: { provadores: JSON.parse(opts.body).provadores, atualizadoEm: JSON.parse(opts.body).atualizadoEm }
        })});
        removerProvadorAdmin(0, null);
      `); // remove "Ana" (confirm mockado para true)
      setTimeout(() => {
        const listaSemAna = w.eval(`JSON.stringify(state.provadoresLista)`);
        ok(listaSemAna === JSON.stringify(['Bruno','Carla Nova']),
          'removerProvadorAdmin() remove o nome escolhido da lista e guarda a alteração');
        w.eval(`window.fetch = window.__fetchOriginal5; window.confirm = () => true;`);

        // ---------- 30) concluirTodosP3(): atalho para o 3º provador concluir vários lotes
        // aguarda_p3 de uma vez, sem pedir nome e sem registar aromas novos — a prova fecha sempre
        // como "concluída"; se fica ou não com frascos para levantar continua a ser sempre calculado
        // pelo motor de decisão normal. ----------
        w.eval(`
          state.lotes = {};
          state.lotes['LTP3A'] = criarLoteVazio('LTP3A'); state.lotes['LTP3A'].diaPrevisto = ontemStr();
          state.lotes['LTP3A'].provador1='Ana'; state.lotes['LTP3A'].provador2='Bruno';
          state.lotes['LTP3A'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3A'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3B'] = criarLoteVazio('LTP3B'); state.lotes['LTP3B'].diaPrevisto = ontemStr();
          state.lotes['LTP3B'].provador1='Ana'; state.lotes['LTP3B'].provador2='Bruno';
          state.lotes['LTP3B'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3B'].registos.p2 = {itens:[{frasco:7,mofoF:true}],apreciacao:'',observacoes:'',concluido:true};
          renderAll();
        `);
        const contagemAntesP3 = w.eval(`lotesAguardaP3().length`);
        ok(contagemAntesP3 === 2, 'concluirTodosP3(): fixture inicial tem 2 lotes genuinamente aguarda_p3');

        w.eval(`abrirAlertaProvador3();`);
        const txtBtnConcluirTodos = w.eval(`(document.querySelector('#overlayAlertaP3 .actions-row button.btn-primary') || {}).textContent`);
        ok(/Concluir Todos \(2\)/.test(txtBtnConcluirTodos||''), 'O mini-modal mostra o botão "Concluir Todos" com a contagem certa (' + txtBtnConcluirTodos + ')');

        w.eval(`concluirTodosP3();`);
        const modalFechouP3 = w.eval(`!document.getElementById('overlayAlertaP3')`);
        ok(modalFechouP3 === true, 'concluirTodosP3() fecha o mini-modal depois de concluir');

        const finalA = w.eval(`state.lotes['LTP3A'].decisao.final`);
        const finalB = w.eval(`state.lotes['LTP3B'].decisao.final`);
        const temLevantarA = w.eval(`state.lotes['LTP3A'].decisao.temFrascosParaLevantar`);
        const temLevantarB = w.eval(`state.lotes['LTP3B'].decisao.temFrascosParaLevantar`);
        const provador3A = w.eval(`state.lotes['LTP3A'].provador3`);
        const provador3B = w.eval(`state.lotes['LTP3B'].provador3`);
        const p3ConcluidoA = w.eval(`state.lotes['LTP3A'].registos.p3.concluido`);
        const p3ItensA = w.eval(`state.lotes['LTP3A'].registos.p3.itens.length`);
        const decididoPorA = w.eval(`state.lotes['LTP3A'].decisao.decididoPor`);
        ok(finalA === 'concluido' && finalB === 'concluido', 'concluirTodosP3() conclui os 2 lotes (não há aprovado/rejeitado, só "concluído")');
        ok(temLevantarA === true && temLevantarB === true, 'O motor de decisão calcula sozinho que há frascos para levantar, por causa do frasco Forte já registado por P1/P2');
        ok(provador3A === '' && provador3B === '', 'concluirTodosP3() não pede nem preenche o nome do 3º provador (fica em branco)');
        ok(p3ConcluidoA === true && p3ItensA === 0, 'concluirTodosP3() marca o registo do Provador 3 como concluído, sem qualquer frasco novo assinalado');
        ok(decididoPorA === 'Provador 3', 'Sem nome preenchido, a decisão fica atribuída ao rótulo genérico "Provador 3"');

        const contagemDepoisP3 = w.eval(`lotesAguardaP3().length`);
        ok(contagemDepoisP3 === 0, 'Depois de concluirTodosP3(), já não há lotes pendentes do 3º provador');

        const badgeEscondidoP3 = w.eval(`document.getElementById('btnAlertaP3').classList.contains('hidden')`);
        ok(badgeEscondidoP3 === true, 'O badge "Provador 3" fica escondido depois de concluirTodosP3() resolver todos os pendentes');

        // 29/09/2026: LTP3A tem diaPrevisto=ontem (ficou parado à espera do 3º provador), mas foi
        // fechado (decisao.data) HOJE via concluirTodosP3() — como quem decide Concluídos/Histórico é
        // decisao.data (dia em que foi de facto fechado), fica em "Concluídos", não em "Histórico".
        const grupoLabA = w.eval(`grupoLoteLAB(state.lotes['LTP3A'])`);
        ok(grupoLabA === 'concluidos', 'Um lote concluído via concluirTodosP3() aparece em "Concluídos" hoje, mesmo tendo ficado dias parado à espera do 3º provador — o que importa é o dia em que foi fechado (decisao.data)');

        // ---------- 30b) concluirTodosP3() ignora a espera de 30 min entre provadores ----------
        w.eval(`
          state.lotes['LTP3C'] = criarLoteVazio('LTP3C'); state.lotes['LTP3C'].diaPrevisto = ontemStr();
          state.lotes['LTP3C'].provador1='Ana'; state.lotes['LTP3C'].provador2='Bruno';
          state.lotes['LTP3C'].registos.p1 = {itens:[{frasco:2,mofoF:true}],apreciacao:'',observacoes:'',concluido:true, assinadoEm: new Date().toISOString()};
          state.lotes['LTP3C'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true, assinadoEm: new Date().toISOString()};
          renderAll();
        `);
        const esperaAindaAtiva = w.eval(`tempoEsperaProvador(state.lotes['LTP3C'], 'p3') > 0`);
        ok(esperaAindaAtiva === true, 'Fixture LTP3C ainda está dentro da janela de espera de 30 min (para provar que o atalho a ignora)');
        w.eval(`concluirTodosP3();`);
        const finalC = w.eval(`state.lotes['LTP3C'].decisao.final`);
        const temLevantarC = w.eval(`state.lotes['LTP3C'].decisao.temFrascosParaLevantar`);
        ok(finalC === 'concluido' && temLevantarC === true, 'concluirTodosP3() conclui mesmo lotes ainda dentro da janela de espera de 30 min entre provadores');

        // ---------- 30c) concluirTodosP3() deixa de fora lotes ainda bloqueados até amanhã ----------
        w.eval(`
          state.lotes['LTP3D'] = criarLoteVazio('LTP3D'); state.lotes['LTP3D'].diaPrevisto = amanhaStr();
          state.lotes['LTP3D'].provador1='Ana'; state.lotes['LTP3D'].provador2='Bruno';
          state.lotes['LTP3D'].registos.p1 = {itens:[{frasco:3,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3D'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
        `);
        const bloqueadoP3D = w.eval(`loteBloqueadoAteAmanha(state.lotes['LTP3D'])`);
        ok(bloqueadoP3D === true, 'Fixture LTP3D está marcada como só podendo ser cheirada amanhã');
        w.eval(`concluirTodosP3();`);
        const finalD = w.eval(`state.lotes['LTP3D'].decisao.final`);
        ok(finalD == null, 'concluirTodosP3() não conclui lotes ainda bloqueados até amanhã (diaPrevisto futuro) — ficam de fora do atalho');
        const p3ConcluidoD = w.eval(`state.lotes['LTP3D'].registos.p3.concluido`);
        ok(p3ConcluidoD === false, 'O registo do Provador 3 de um lote bloqueado até amanhã continua por concluir');

        // ---------- 30d) concluirSelecionadosP3(): conclui só os lotes marcados com a caixa, deixando
        // os outros pendentes para serem abertos e provados a sério (22/09/2026, a pedido da Joana) ----------
        w.eval(`
          state.lotes['LTP3E'] = criarLoteVazio('LTP3E'); state.lotes['LTP3E'].diaPrevisto = ontemStr();
          state.lotes['LTP3E'].provador1='Ana'; state.lotes['LTP3E'].provador2='Bruno';
          state.lotes['LTP3E'].registos.p1 = {itens:[{frasco:4,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3E'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3F'] = criarLoteVazio('LTP3F'); state.lotes['LTP3F'].diaPrevisto = ontemStr();
          state.lotes['LTP3F'].provador1='Ana'; state.lotes['LTP3F'].provador2='Bruno';
          state.lotes['LTP3F'].registos.p1 = {itens:[{frasco:5,mofoF:true}],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTP3F'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          renderAll();
          abrirAlertaProvador3();
        `);

        w.eval(`concluirSelecionadosP3();`);
        ok(/Marca pelo menos um lote/.test(lastAlert()), 'concluirSelecionadosP3() sem nada marcado mostra um aviso a pedir para marcar pelo menos um lote');
        ok(w.eval(`state.lotes['LTP3E'].decisao.final`) == null && w.eval(`state.lotes['LTP3F'].decisao.final`) == null, 'Sem nada marcado, nenhum lote é concluído');

        w.eval(`document.querySelector('#overlayAlertaP3 .p3-lote-check[data-lote="LTP3E"]').checked = true;`);
        w.eval(`concluirSelecionadosP3();`);
        const finalE = w.eval(`state.lotes['LTP3E'].decisao.final`);
        const finalF = w.eval(`state.lotes['LTP3F'].decisao.final`);
        ok(finalE === 'concluido', 'concluirSelecionadosP3() conclui o lote marcado (LTP3E)');
        ok(finalF == null, 'concluirSelecionadosP3() deixa por concluir o lote que NÃO estava marcado (LTP3F)');
        ok(w.eval(`!document.getElementById('overlayAlertaP3')`), 'concluirSelecionadosP3() fecha o mini-modal depois de concluir');
        const pendentesDepoisSelecionados = w.eval(`lotesAguardaP3().map(l=>l.numeroLote)`);
        ok(pendentesDepoisSelecionados.includes('LTP3F') && !pendentesDepoisSelecionados.includes('LTP3E'), 'LTP3F continua na lista de pendentes do 3º provador, pronto para ser aberto e provado a sério (LTP3E já não está lá)');

        // ---------- 31) (25/09/2026: secção removida — "Colar lista recebida por email" e
        // "Importar Ordens (Excel)" deixaram de existir no ecrã Lotes; ver secção 36 mais abaixo
        // sobre abrirLoteExistente criar o lote na hora ao ler o código de barras) ----------

        // ---------- 32) Migração de decisões antigas ("aprovado"/"rejeitado") para "concluido" (22/09/2026) ----------
        // Lotes decididos ANTES da unificação de 21/09 ainda podem ter essas palavras gravadas em
        // decisao.final (vêm do servidor/localStorage antigo). garantirCamposNovos() tem de as
        // converter, senão a app volta a tratá-los como "ainda não decidido" — foi o que a Joana
        // apanhou no leitor de código de barras da Logística com um lote já concluído há muito tempo.
        w.eval(`
          state.lotes['LTOLDREJ'] = criarLoteVazio('LTOLDREJ');
          state.lotes['LTOLDREJ'].decisao = {final:'rejeitado', comentarios:'antigo', decididoPor:'Automático', data:'2026-08-01'};
          garantirCamposNovos(state.lotes['LTOLDREJ']);
          state.lotes['LTOLDAPR'] = criarLoteVazio('LTOLDAPR');
          state.lotes['LTOLDAPR'].decisao = {final:'aprovado', comentarios:'antigo', decididoPor:'Automático', data:'2026-08-01'};
          garantirCamposNovos(state.lotes['LTOLDAPR']);
        `);
        ok(w.eval(`state.lotes['LTOLDREJ'].decisao.final`) === 'concluido', 'Lote antigo "rejeitado" é migrado para decisao.final="concluido"');
        ok(w.eval(`state.lotes['LTOLDREJ'].decisao.temFrascosParaLevantar`) === true, 'Lote antigo "rejeitado" fica com temFrascosParaLevantar=true (tinha algo a levantar)');
        ok(w.eval(`state.lotes['LTOLDAPR'].decisao.final`) === 'concluido', 'Lote antigo "aprovado" é migrado para decisao.final="concluido"');
        ok(w.eval(`state.lotes['LTOLDAPR'].decisao.temFrascosParaLevantar`) === false, 'Lote antigo "aprovado" fica com temFrascosParaLevantar=false (nada a levantar)');
        ok(!/ainda não foi decidido/.test(w.eval(`htmlResultadoLevantamento('LTOLDREJ')`)), 'O leitor de código de barras já não diz "ainda não foi decidido" para o lote antigo "rejeitado"');
        ok(!/ainda não foi decidido/.test(w.eval(`htmlResultadoLevantamento('LTOLDAPR')`)), 'O leitor de código de barras já não diz "ainda não foi decidido" para o lote antigo "aprovado"');

        // ---------- 33) computeStatus() blinda mesmo sem passar pela migração (22/09/2026) ----------
        // Mesmo que um lote chegue com um decisao.final antigo por qualquer via que não passe por
        // garantirCamposNovos, o "Estado atual" nunca deve mostrar a palavra "rejeitado"/"aprovado".
        w.eval(`
          state.lotes['LTRAW1'] = criarLoteVazio('LTRAW1');
          state.lotes['LTRAW1'].decisao.final = 'rejeitado';
        `);
        ok(w.eval(`computeStatus(state.lotes['LTRAW1'])`) === 'concluido', 'computeStatus() converte um decisao.final="rejeitado" cru para "concluido"');
        ok(w.eval(`STATUS_META[computeStatus(state.lotes['LTRAW1'])].label`) === 'Prova Concluída', 'O rótulo mostrado passa a ser "Prova Concluída", nunca a palavra antiga');

        // ---------- 34) Arquivo do LAB segue o dia em que a decisão foi de facto registada no sistema
        // (decisao.data) — 29/09/2026, a pedido da Joana. ----------
        // Exemplo real: um lote fechado dia 17 não pode continuar a aparecer em "Concluídos" vários
        // dias depois só porque foi carregado/trabalhado nessa data — tem de estar em "Histórico" assim
        // que o dia em que foi fechado deixa de ser hoje.
        w.eval(`
          state.lotes['LTARQ1'] = criarLoteVazio('LTARQ1');
          state.lotes['LTARQ1'].diaPrevisto = '2026-09-17';
          state.lotes['LTARQ1'].decisao.final = 'concluido';
          state.lotes['LTARQ1'].decisao.data = '2026-09-17';
        `);
        ok(w.eval(`grupoLoteLAB(state.lotes['LTARQ1'])`) === 'historico', 'Lote fechado há vários dias (decisao.data=17/09) fica em "Histórico" hoje, mesmo tendo diaPrevisto igual');

        // Exceção que a Joana pediu explicitamente: um lote AINDA à espera do 3º provador (sem decisão
        // nenhuma) nunca pode ser "empurrado" para Concluídos/Histórico só por o diaPrevisto ter passado
        // — tem de continuar em WIP na página inicial até haver mesmo uma decisão.
        w.eval(`
          state.lotes['LTARQ2'] = criarLoteVazio('LTARQ2');
          state.lotes['LTARQ2'].diaPrevisto = '2026-09-17'; // dia de trabalho já passou há dias
          state.lotes['LTARQ2'].provador1 = 'Ana'; state.lotes['LTARQ2'].provador2 = 'Bruno';
          state.lotes['LTARQ2'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LTARQ2'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          // discordância Forte -> precisa do 3º provador -> decisao.final continua null
        `);
        ok(w.eval(`state.lotes['LTARQ2'].decisao.final`) == null, 'LTARQ2 continua sem decisão (à espera do 3º provador)');
        ok(w.eval(`grupoLoteLAB(state.lotes['LTARQ2'])`) === 'wip', 'Um lote ainda à espera do 3º provador fica sempre em "WIP", mesmo com o diaPrevisto já muito atrasado — nunca "salta" para Concluídos/Histórico sem decisão');
        ok(w.eval(`computeStatus(state.lotes['LTARQ2'])`) === 'aguarda_p3', 'O estado desse lote continua "Aguarda Provador 3", não "concluído"');

        // ---------- 35) Aviso de "2 amostras distintas com o mesmo Lote" (22/09/2026) ----------
        // 25/09/2026: o mecanismo que ACIONAVA este aviso (extrairLotesDaFolha/aplicarImportacaoOrdens,
        // ligados à importação de Excel) foi removido a pedido da Joana junto com o próprio import —
        // deixou de haver validação prévia por Excel/lista. O campo avisoDuplicado e a sua apresentação
        // visual (ícone na grelha, aviso na ficha do lote) ficaram no código, sem incómodo, e continuam
        // testados aqui a definir o campo diretamente — caso volte a fazer sentido acioná-lo de outra forma.

        // sinal visual na grelha (Lotes) e na ficha do lote
        w.eval(`
          state.lotes = {};
          state.lotes['LTDUP'] = criarLoteVazio('LTDUP'); state.lotes['LTDUP'].diaPrevisto = ontemStr(); state.lotes['LTDUP'].avisoDuplicado = true;
          state.lotes['LTOK'] = criarLoteVazio('LTOK'); state.lotes['LTOK'].diaPrevisto = ontemStr();
          switchView('inicio');
          renderGradeLotes();
        `);
        ok(w.eval(`!!document.querySelector('[onclick="openLoteDetail(\\'LTDUP\\')"] .quad-aviso-dup')`), 'Na grelha de Lotes, o lote com avisoDuplicado mostra o ícone de aviso');
        ok(!w.eval(`document.querySelector('[onclick="openLoteDetail(\\'LTOK\\')"] .quad-aviso-dup')`), 'Um lote normal (sem avisoDuplicado) não mostra o ícone de aviso');

        w.eval(`openLoteDetail('LTDUP');`);
        ok(/2 amostras distintas na importação de hoje/.test(w.eval(`document.getElementById('overlayLote').textContent`)), 'A ficha do lote duplicado mostra o aviso a pedir para confirmar com a Produção');
        w.eval(`closeModal('overlayLote');`);
        w.eval(`openLoteDetail('LTOK');`);
        ok(!/2 amostras distintas/.test(w.eval(`document.getElementById('overlayLote').textContent`)), 'A ficha de um lote normal não mostra esse aviso');
        w.eval(`closeModal('overlayLote');`);

        // ---------- 36) abrirLoteExistente() cria o lote na hora (25/09/2026) ----------
        // Deixou de haver validação prévia por Excel/lista — o provador lê o código de barras (ou usa
        // a pesquisa / "Identificar Lote") mesmo à mesa, ainda sem o lote existir no sistema, e o
        // próprio ato de abrir cria o registo, disponível já hoje (não D+1) e gravado (saveState()).
        w.eval(`state.lotes = {};`);
        ok(w.eval(`!state.lotes['LTNOVO']`), 'LTNOVO não existe antes de ser aberto/lido');
        w.eval(`abrirLoteExistente('LTNOVO');`);
        ok(w.eval(`!!state.lotes['LTNOVO']`), 'abrirLoteExistente() cria o lote na hora quando ele não existia');
        ok(w.eval(`state.lotes['LTNOVO'].diaPrevisto`) === w.eval(`hojeStr()`), 'O lote criado na hora fica com diaPrevisto = hoje (disponível já, não D+1)');
        ok(w.eval(`state.lotes['LTNOVO'].previstoHoje`) === true, 'O lote criado na hora fica marcado previstoHoje=true');
        ok(w.eval(`!loteBloqueadoAteAmanha(state.lotes['LTNOVO'])`), 'O lote criado na hora não fica bloqueado até amanhã');
        ok(w.eval(`!!document.getElementById('overlayLote')`), 'abrirLoteExistente() abre logo a ficha do lote recém-criado');
        w.eval(`closeModal('overlayLote');`);

        // Se o lote já existir, abrirLoteExistente() só abre a ficha — não o recria nem apaga dados já lá postos.
        w.eval(`
          state.lotes['LTJAEXISTE'] = criarLoteVazio('LTJAEXISTE');
          state.lotes['LTJAEXISTE'].diaPrevisto = ontemStr();
          state.lotes['LTJAEXISTE'].prioridade = 'vermelho';
          abrirLoteExistente('LTJAEXISTE');
        `);
        ok(w.eval(`state.lotes['LTJAEXISTE'].diaPrevisto`) === w.eval(`ontemStr()`), 'Um lote já existente mantém os seus dados (diaPrevisto) — abrirLoteExistente() não o recria por cima');
        ok(w.eval(`state.lotes['LTJAEXISTE'].prioridade`) === 'vermelho', 'Um lote já existente mantém a prioridade já definida');
        w.eval(`closeModal('overlayLote');`);

        // ---------- 37) Supervisora pode editar um registo de P1/P2 já assinado, com o código de
        // administração (8126) (25/09/2026) ----------
        w.eval(`
          state.lotes = {};
          state.lotes['LTSUP1'] = criarLoteVazio('LTSUP1'); state.lotes['LTSUP1'].diaPrevisto = hojeStr();
          state.lotes['LTSUP1'].registos.p1.itens = [{frasco:13,tcaF:false,tcaP:true,mofoF:false,mofoP:false,outro:false}];
          state.lotes['LTSUP1'].registos.p1.apreciacao = 'pouco_limpo';
          state.lotes['LTSUP1'].registos.p1.concluido = true;
          state.lotes['LTSUP1'].registos.p1.assinadoEm = new Date().toISOString();
          state.lotes['LTSUP1'].registos.p2.concluido = true; // prova cega: P1 só se pode reler depois de P2 concluir
          openRegistoModal('LTSUP1','p1');
        `);
        ok(w.eval(`!!document.getElementById('overlayRegistoRO')`), 'Um registo de P1 já assinado continua a abrir em modo só-leitura por omissão');
        ok(w.eval(`!!document.querySelector('#overlayRegistoRO button[onclick*="abrirEdicaoSupervisora"]')`), 'A vista só-leitura mostra o botão "Editar (Supervisora)"');

        // código errado não abre a edição
        w.eval(`
          window.__promptOriginal = window.prompt; window.__alertOriginal = window.alert;
          window.prompt = () => 'errado'; window.alert = () => {};
          document.querySelector('#overlayRegistoRO button[onclick*="abrirEdicaoSupervisora"]').click();
        `);
        ok(w.eval(`!!document.getElementById('overlayRegistoRO')`), 'Com o código errado, a vista continua só-leitura (não abre a edição)');
        ok(w.eval(`!document.getElementById('overlayRegisto')`), 'Com o código errado, o modal de edição não chega a abrir');

        // código certo (8126) abre a grelha de edição, pré-preenchida com o que já lá estava
        w.eval(`
          window.prompt = () => '8126';
          document.querySelector('#overlayRegistoRO button[onclick*="abrirEdicaoSupervisora"]').click();
        `);
        ok(w.eval(`!!document.getElementById('overlayRegisto')`), 'Com o código 8126, abre o modal de edição da supervisora');
        ok(/Edição da Supervisora/.test(w.eval(`document.getElementById('overlayRegisto').textContent`)), 'O modal identifica-se claramente como "Edição da Supervisora"');
        ok(w.eval(`document.querySelector('.frasco-tile.marcado').textContent`).includes('13'), 'A grelha de edição já vem com o frasco 13 marcado (dados do registo assinado)');
        ok(w.eval(`document.querySelector('input[name="apreciacao"][value="pouco_limpo"]').checked`) === true, 'A apreciação já preenchida ("Pouco Limpo") vem pré-selecionada');

        // editar um frasco na grelha grava logo, tal como no registo normal
        w.eval(`abrirSeletorGrid(20); marcarChipGrid('tcaF');`);
        ok(w.eval(`itemFrasco(20).tcaF`) === true, 'Marcar um novo frasco na edição da supervisora grava logo no registo (frasco 20 = TCA Forte)');
        ok(w.eval(`state.lotes['LTSUP1'].registos.p1.concluido`) === true, 'O registo continua "concluído" durante a edição da supervisora — não é reaberto ao provador');

        // "Guardar Alterações" grava a apreciação/observações e volta para a ficha do lote
        w.eval(`
          document.querySelector('input[name="apreciacao"][value="limpo"]').checked = true;
          document.getElementById('fObsRegisto').value = 'Corrigido pela supervisora';
          guardarEdicaoSupervisora();
        `);
        ok(w.eval(`state.lotes['LTSUP1'].registos.p1.apreciacao`) === 'limpo', 'guardarEdicaoSupervisora() atualiza a Apreciação Geral corrigida');
        ok(w.eval(`state.lotes['LTSUP1'].registos.p1.observacoes`) === 'Corrigido pela supervisora', 'guardarEdicaoSupervisora() atualiza as Observações corrigidas');
        ok(w.eval(`state.lotes['LTSUP1'].registos.p1.concluido`) === true, 'O registo continua assinado/concluído depois de guardar a correção');
        ok(w.eval(`!document.getElementById('overlayRegisto')`), 'guardarEdicaoSupervisora() fecha o modal de edição');
        ok(w.eval(`!!document.getElementById('overlayLote')`), 'Depois de guardar, volta a mostrar a ficha do lote');
        w.eval(`closeModal('overlayLote'); window.prompt = window.__promptOriginal; window.alert = window.__alertOriginal;`);

        // ---------- 38) hojeStr()/ontemStr()/amanhaStr() usam a data LOCAL do aparelho, nunca UTC
        // (28/09/2026 — bug encontrado a pedido da Joana: "colega não conseguiu ler etiquetas antes
        // das 7h"). Antes usavam toISOString() (sempre UTC), o que podia desfasar "hoje" em relação
        // ao calendário do telemóvel — nomeadamente logo a seguir à meia-noite local, ou em qualquer
        // aparelho com o fuso horário mal configurado — fazendo um lote lido nessa altura ficar com
        // diaPrevisto no dia errado (podendo parecer bloqueado até amanhã sem ser). ----------
        const dLocal = new Date();
        const esperadoHoje = `${dLocal.getFullYear()}-${String(dLocal.getMonth()+1).padStart(2,'0')}-${String(dLocal.getDate()).padStart(2,'0')}`;
        ok(w.eval(`hojeStr()`) === esperadoHoje, 'hojeStr() bate certo com a data local do aparelho (getFullYear/getMonth/getDate), não com toISOString() em UTC');
        const dOntem = new Date(dLocal); dOntem.setDate(dOntem.getDate()-1);
        const esperadoOntem = `${dOntem.getFullYear()}-${String(dOntem.getMonth()+1).padStart(2,'0')}-${String(dOntem.getDate()).padStart(2,'0')}`;
        ok(w.eval(`ontemStr()`) === esperadoOntem, 'ontemStr() também usa a data local (dia anterior ao de hoje, no calendário do aparelho)');
        const dAmanha = new Date(dLocal); dAmanha.setDate(dAmanha.getDate()+1);
        const esperadoAmanha = `${dAmanha.getFullYear()}-${String(dAmanha.getMonth()+1).padStart(2,'0')}-${String(dAmanha.getDate()).padStart(2,'0')}`;
        ok(w.eval(`amanhaStr()`) === esperadoAmanha, 'amanhaStr() também usa a data local (dia seguinte ao de hoje, no calendário do aparelho)');

        // ---------- 38b) Limpeza automática dos lotes atrasados à meia-noite (29/09/2026, a pedido
        // da Joana: "não colocar a responsabilidade da equipa limpar" — o ecrã "Lotes" tem de ficar
        // limpo sozinho, independentemente de os lotes terem sido trabalhados ou não). ----------
        // 30/09/2026: primeiro confirma a CORREÇÃO DO BUG GRAVE — sem dadosSincronizadosComServidor
        // (ainda não houve uma leitura ao servidor nesta sessão), a limpeza não pode apagar nada, para
        // nunca decidir "isto está atrasado" só com base numa cópia local que pode estar desatualizada
        // há dias (foi isto, muito provavelmente, que causou a perda de dados real de 30/09/2026).
        w.eval(`
          state.lotes = {};
          state.lotes['LTVELHO1'] = criarLoteVazio('LTVELHO1'); state.lotes['LTVELHO1'].diaPrevisto = ontemStr();
          state.lotes['LTVELHO2'] = criarLoteVazio('LTVELHO2'); state.lotes['LTVELHO2'].diaPrevisto = '2020-01-01';
          state.lotes['LTHOJE1'] = criarLoteVazio('LTHOJE1'); state.lotes['LTHOJE1'].diaPrevisto = hojeStr();
          state.lotes['LTFUTURO1'] = criarLoteVazio('LTFUTURO1'); state.lotes['LTFUTURO1'].diaPrevisto = amanhaStr();
          state.lotes['LTDECIDIDO'] = criarLoteVazio('LTDECIDIDO'); state.lotes['LTDECIDIDO'].diaPrevisto = ontemStr();
          state.lotes['LTDECIDIDO'].decisao.final = 'concluido'; state.lotes['LTDECIDIDO'].decisao.data = ontemStr();
          state.removidos = {};
          delete state.ultimaLimpezaLotes; // simula um dia novo, em que a limpeza ainda não correu
          window.__fetchOriginalLimpeza = window.fetch;
          window.fetch = () => Promise.resolve({ ok:true });
          const avisoPrevio = document.getElementById('avisoLimpezaAutomatica'); if(avisoPrevio) avisoPrevio.remove();
          switchView('inicio');
          dadosSincronizadosComServidor = false; // ainda não sincronizou nesta sessão (ex.: telemóvel acabado de abrir)
          renderGradeLotes();
        `);
        ok(w.eval(`!!state.lotes['LTVELHO1'] && !!state.lotes['LTVELHO2']`), 'CORREÇÃO CRÍTICA: sem ter sincronizado ainda com o servidor nesta sessão, a limpeza automática NÃO apaga nenhum lote, mesmo que pareçam atrasados na cópia local');
        ok(w.eval(`!state.ultimaLimpezaLotes`), 'Sem sincronizar, nem sequer marca a limpeza como feita — fica pronta para correr a sério assim que sincronizar');

        w.eval(`
          dadosSincronizadosComServidor = true; // simula a 1ª leitura ao servidor já ter acontecido com sucesso
          renderGradeLotes();
        `);
        ok(w.eval(`JSON.stringify(lotesAtrasados())`) === '[]', 'lotesAtrasados() fica vazio depois da limpeza — já não há nenhum lote por decidir com diaPrevisto antes de hoje');
        ok(w.eval(`!state.lotes['LTVELHO1'] && !state.lotes['LTVELHO2']`), 'Ao renderizar o ecrã Lotes num dia novo, os atrasados (ainda por decidir, diaPrevisto antes de hoje) são eliminados automaticamente — sem código nem confirmação de ninguém');
        ok(w.eval(`!!state.lotes['LTHOJE1'] && !!state.lotes['LTFUTURO1'] && !!state.lotes['LTDECIDIDO']`), 'Não mexe nos lotes de hoje, futuros ou já decididos');
        ok(w.eval(`!!state.removidos['LTVELHO1'] && !!state.removidos['LTVELHO2']`), 'Fica um tombstone (state.removidos) para cada lote atrasado eliminado, tal como uma eliminação normal');
        ok(w.eval(`state.ultimaLimpezaLotes === hojeStr()`), 'Fica registada a data da última limpeza, para não repetir várias vezes no mesmo dia');
        ok(w.eval(`document.getElementById('gradeLotes').textContent.includes('LTHOJE1') && !document.getElementById('gradeLotes').textContent.includes('LTVELHO1')`), 'A grelha "Lotes" já não mostra o lote atrasado depois da limpeza automática — o ecrã fica limpo sozinho');
        const textoAvisoLimpeza = w.eval(`document.getElementById('avisoLimpezaAutomatica') ? document.getElementById('avisoLimpezaAutomatica').textContent : ''`);
        ok(/2/.test(textoAvisoLimpeza), 'Mostra um aviso transitório a informar quantos lotes foram limpos automaticamente, para a equipa não ficar sem perceber porque desapareceram');

        // no mesmo dia em que a limpeza já correu, não volta a repetir (guarda por state.ultimaLimpezaLotes)
        w.eval(`
          state.lotes['LTVELHO3'] = criarLoteVazio('LTVELHO3'); state.lotes['LTVELHO3'].diaPrevisto = ontemStr();
          renderGradeLotes();
        `);
        ok(w.eval(`!!state.lotes['LTVELHO3']`), 'No mesmo dia em que a limpeza já correu, não volta a apagar automaticamente — só corre de novo no dia seguinte');

        // sem nenhum lote atrasado (dia novo) -> nada é eliminado e não aparece aviso
        w.eval(`
          delete state.lotes['LTVELHO3'];
          delete state.ultimaLimpezaLotes;
          state.lotes = { LTHOJE2: criarLoteVazio('LTHOJE2') };
          state.lotes['LTHOJE2'].diaPrevisto = hojeStr();
          const antigo2 = document.getElementById('avisoLimpezaAutomatica'); if(antigo2) antigo2.remove();
          renderGradeLotes();
        `);
        ok(w.eval(`!!state.lotes['LTHOJE2']`), 'Sem lotes atrasados, a limpeza automática não apaga nada');
        ok(w.eval(`!document.getElementById('avisoLimpezaAutomatica')`), 'Sem lotes atrasados, não aparece nenhum aviso de limpeza automática');
        w.eval(`window.fetch = window.__fetchOriginalLimpeza;`);

        // ---------- 38d) CORREÇÃO IMPORTANTE a pedido da Joana (01/10/2026): um lote já em WIP (com
        // Provador 1 atribuído, prova em curso) NUNCA pode ser apagado pela limpeza automática, mesmo
        // que o seu diaPrevisto seja anterior a hoje. Caso real: lotes lidos de manhã (7h-8h) e já em
        // WIP desapareceram do ecrã LAB por volta das 9h33 — a equipa estava a meio da prova. Só um
        // lote totalmente por começar (sem Provador 1, "Planeado") pode continuar a ser varrido. ----------
        w.eval(`
          state.lotes = {};
          state.lotes['LTWIPVELHO'] = criarLoteVazio('LTWIPVELHO'); state.lotes['LTWIPVELHO'].diaPrevisto = ontemStr();
          state.lotes['LTWIPVELHO'].provador1 = 'Tânia Lino'; // já em WIP — prova em curso
          state.lotes['LTPLANVELHO'] = criarLoteVazio('LTPLANVELHO'); state.lotes['LTPLANVELHO'].diaPrevisto = ontemStr();
          // sem provador1 — continua "Planeado", por começar
          state.removidos = {};
          delete state.ultimaLimpezaLotes;
          window.__fetchOriginalLimpeza2 = window.fetch;
          window.fetch = () => Promise.resolve({ ok:true });
          const avisoPrevio2 = document.getElementById('avisoLimpezaAutomatica'); if(avisoPrevio2) avisoPrevio2.remove();
          switchView('inicio');
          dadosSincronizadosComServidor = true;
          renderGradeLotes();
        `);
        ok(w.eval(`!!state.lotes['LTWIPVELHO']`), 'CORREÇÃO 01/10/2026: um lote já em WIP (com Provador 1) nunca é apagado pela limpeza automática, mesmo com diaPrevisto atrasado — a prova pode estar a meio');
        ok(w.eval(`!state.lotes['LTPLANVELHO']`), 'Um lote "Planeado" (sem Provador 1 ainda) com diaPrevisto atrasado continua a ser varrido normalmente pela limpeza automática');
        ok(w.eval(`!!state.removidos['LTPLANVELHO'] && !state.removidos['LTWIPVELHO']`), 'Só fica tombstone para o lote Planeado eliminado — o lote WIP não é sequer tocado');
        w.eval(`window.fetch = window.__fetchOriginalLimpeza2;`);

        // ---------- 38c) Caso real trazido pela Joana (29/09/2026): um lote com diaPrevisto de um dia
        // anterior mas fechado (decisao.data) HOJE tem de aparecer no dropdown "Concluídos" do LAB, não
        // no "Histórico de Conclusões" — mesmo com o Histórico aberto ao mesmo tempo. ----------
        w.eval(`
          state.lotes = {};
          state.lotes['LT02380788'] = criarLoteVazio('LT02380788'); state.lotes['LT02380788'].diaPrevisto = ontemStr();
          state.lotes['LT02380788'].provador1 = 'Tânia Lino'; state.lotes['LT02380788'].provador2 = 'Raquel Santos';
          state.lotes['LT02380788'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LT02380788'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
          state.lotes['LT02380788'].decisao.final = 'concluido';
          state.lotes['LT02380788'].decisao.data = hojeStr();
          switchView('lab');
          toggleHistoricoLAB(); // abre o Histórico ao mesmo tempo, como no print da Joana
        `);
        ok(w.eval(`document.getElementById('labColConcluidos').textContent.includes('LT02380788')`), 'Um lote com diaPrevisto de ontem mas fechado hoje aparece no dropdown "Concluídos" do LAB');
        ok(w.eval(`!document.getElementById('tabelaLAB').textContent.includes('LT02380788')`), 'Esse mesmo lote NÃO aparece na lista de "Histórico de Conclusões", mesmo com o Histórico aberto (só lá entra quando o dia em que foi fechado deixar de ser hoje)');
        w.eval(`toggleHistoricoLAB();`); // fecha outra vez, para não interferir com as secções seguintes

        // ---------- 40) Cópia de segurança local dos dados de hoje (30/09/2026, a pedido da Joana,
        // depois de um incidente em que erros 404 no Railway coincidiram com a perda de tudo o que
        // tinha sido feito no dia). Além da cópia principal (STORAGE_KEY), guarda-se uma 2ª cópia só
        // com os lotes ainda por decidir + os fechados hoje — os restantes já estão arquivados/no
        // servidor. Ao arrancar, se a cópia principal estiver a faltar algum desses lotes, repõe-se a
        // partir desta cópia de segurança, sem nunca apagar nada. ----------
        w.eval(`
          state.lotes = {};
          state.lotes['LTBK1'] = criarLoteVazio('LTBK1'); state.lotes['LTBK1'].diaPrevisto = hojeStr(); // ainda por decidir
          state.lotes['LTBK2'] = criarLoteVazio('LTBK2'); state.lotes['LTBK2'].diaPrevisto = ontemStr();
          state.lotes['LTBK2'].decisao.final = 'concluido'; state.lotes['LTBK2'].decisao.data = hojeStr(); // fechado hoje
          state.lotes['LTBK3'] = criarLoteVazio('LTBK3'); state.lotes['LTBK3'].diaPrevisto = '2020-01-01';
          state.lotes['LTBK3'].decisao.final = 'concluido'; state.lotes['LTBK3'].decisao.data = '2020-01-01'; // fechado há muito tempo -> não entra no backup
        `);
        const backupGuardado = w.eval(`JSON.stringify(Object.keys(lotesParaBackupHoje()).sort())`);
        ok(backupGuardado === JSON.stringify(['LTBK1','LTBK2']), 'lotesParaBackupHoje() só inclui os ainda por decidir e os fechados hoje — não um lote fechado há muito tempo');

        w.eval(`guardarBackupHoje();`);
        const backupNoLocalStorage = w.eval(`JSON.parse(localStorage.getItem(BACKUP_KEY))`);
        ok(!!backupNoLocalStorage && backupNoLocalStorage.dia === w.eval(`hojeStr()`), 'guardarBackupHoje() grava no localStorage, com a data de hoje');
        ok(Object.keys(backupNoLocalStorage.lotes).sort().join(',') === 'LTBK1,LTBK2', 'A cópia de segurança gravada tem os lotes certos (LTBK1 e LTBK2)');

        // simula uma cópia principal que perdeu o LTBK2 (ex.: servidor devolveu vazio depois de um
        // incidente) — a recuperação tem de o repor, sem mexer no que já lá está nem apagar nada.
        w.eval(`delete state.lotes['LTBK2'];`);
        const contagemAntesRecuperar = w.eval(`Object.keys(state.lotes).length`);
        ok(contagemAntesRecuperar === 2, 'Fixture: a cópia principal ficou só com 2 lotes (LTBK2 "perdido")');
        const nRecuperados = w.eval(`recuperarBackupHojeSeNecessario()`);
        ok(nRecuperados === 1, 'recuperarBackupHojeSeNecessario() devolve quantos lotes foram repostos (1)');
        ok(w.eval(`!!state.lotes['LTBK2']`), 'O lote "perdido" (LTBK2) volta a existir depois de recuperarBackupHojeSeNecessario()');
        ok(w.eval(`!!state.lotes['LTBK1'] && !!state.lotes['LTBK3']`), 'Os lotes que já lá estavam continuam intactos — a recuperação só acrescenta, nunca substitui nem apaga');

        // se não faltar nada, não "recupera" (nem reporta) nenhum lote
        const nRecuperados2 = w.eval(`recuperarBackupHojeSeNecessario()`);
        ok(nRecuperados2 === 0, 'Com a cópia principal já completa, recuperarBackupHojeSeNecessario() não acrescenta nada (devolve 0)');

        // ---------- 39) Verificação automática de versão nova (29/09/2026, a pedido da Joana: deixar
        // de depender de cada pessoa saber que tem de dar refresh manual). verificarNovaVersao() busca
        // o próprio index.html publicado e compara o APP_BUILD embutido nele com o desta sessão; se
        // forem diferentes, mostra um aviso fixo com contagem decrescente e atualiza sozinha. ----------
        w.eval(`
          window.__fetchOriginalVersao = window.fetch;
          window.fetch = () => Promise.resolve({ ok:true, text: () => Promise.resolve("const APP_BUILD = 'outra-versao-qualquer';") });
          verificarNovaVersao();
        `);
        setTimeout(() => {
          ok(w.eval(`!!document.getElementById('avisoVersaoNova')`), 'verificarNovaVersao() mostra o aviso quando a versão publicada no servidor é diferente da carregada nesta sessão');
          ok(/Atualizar agora/.test(w.eval(`document.getElementById('avisoVersaoNova').textContent`)), 'O aviso tem um botão "Atualizar agora", além da contagem automática');
          ok(/avisoVersaoJaMostrado = true/.test(w.eval(`mostrarAvisoVersaoNova.toString()`)) , 'mostrarAvisoVersaoNova() marca que já mostrou, para nunca duplicar o aviso');
          w.eval(`document.getElementById('avisoVersaoNova').remove(); avisoVersaoJaMostrado = false; window.fetch = window.__fetchOriginalVersao;`);

          // versão igual à publicada -> não mostra aviso nenhum
          w.eval(`
            window.__fetchOriginalVersao2 = window.fetch;
            window.fetch = () => Promise.resolve({ ok:true, text: () => Promise.resolve("const APP_BUILD = '" + APP_BUILD + "';") });
            verificarNovaVersao();
          `);
          setTimeout(() => {
            ok(w.eval(`!document.getElementById('avisoVersaoNova')`), 'Quando a versão publicada é igual à carregada, não mostra nenhum aviso');
            w.eval(`window.fetch = window.__fetchOriginalVersao2;`);

            // ---------- 42) "Mais opções" -> "Backups diários" -> Restaurar (01/10/2026, a pedido da
            // Joana, depois do bug de 01/10/2026 que apagou lotes em WIP). restaurarDeBackup() nunca
            // pode sobrepor-se a um lote que já exista na app (preserva trabalho atual) — só repõe o
            // que está em falta, mesmo que tenha tombstone (lote apagado por engano/bug). ----------
            w.eval(`
              state.lotes = {};
              state.removidos = {};
              state.lotes['LTREST1'] = criarLoteVazio('LTREST1'); state.lotes['LTREST1'].provador1 = 'Atual';
              state.removidos['LTREST2'] = '2026-09-30T20:00:00.000Z'; // tombstone antigo — simula um lote apagado por engano/bug
              window.__backupFake = {
                dia: '2026-09-30',
                lotes: {
                  LTREST1: (()=>{ const l = criarLoteVazio('LTREST1'); l.provador1 = 'Velho (não deve aparecer)'; return l; })(),
                  LTREST2: (()=>{ const l = criarLoteVazio('LTREST2'); l.provador1 = 'Recuperado'; l.atualizadoEm = '2026-09-30T19:00:00.000Z'; return l; })(),
                  LTREST3: (()=>{ const l = criarLoteVazio('LTREST3'); l.provador1 = 'Novo'; return l; })()
                }
              };
              window.__chamadasAuditoria = [];
              window.__fetchOriginalRestauro = window.fetch;
              window.fetch = (url, opts) => {
                if(String(url).includes('/api/backup-diario/listar')) return Promise.resolve({ ok:true, json: () => Promise.resolve({ backups: [{dia:'2026-09-30', csv:true, json:true}] }) });
                if(String(url).includes('/api/backup-diario/2026-09-30/download')) return Promise.resolve({ ok:true, json: () => Promise.resolve(window.__backupFake) });
                if(String(url).includes('/api/auditoria')){ window.__chamadasAuditoria.push(JSON.parse((opts&&opts.body)||'{}')); return Promise.resolve({ ok:true, json: () => Promise.resolve({ok:true}) }); }
                return Promise.reject(new Error('url inesperado no teste: ' + url));
              };
              restaurarDeBackup('2026-09-30');
            `);
            // ---------- 43) Login nomeado (ADMIN_USERS) exigido antes de restaurar (01/10/2026, a
            // pedido da Joana: "ter esta ação sem dependências [do código 8126] mas que fique o
            // registo de quem as fez"). ----------
            ok(w.eval(`!!document.getElementById('overlayAcessoNomeado')`), 'restaurarDeBackup() pede sempre identificação nomeada antes de fazer seja o que for');
            ok(w.eval(`document.querySelector('#overlayAcessoNomeado .sub').textContent`).includes('Restaurar backup de 2026-09-30'), 'O pedido de identificação diz qual é a ação em causa');
            ok(w.eval(`!!state.lotes['LTREST2']`) === false, 'Enquanto não se confirma a identidade, nada é restaurado ainda');
            // password errada -> bloqueado, nada acontece
            w.eval(`document.getElementById('fAcessoNome').value = 'Tânia Martins'; document.getElementById('fAcessoPassword').value = 'errada123'; confirmarAcessoNomeado();`);
            ok(w.eval(`!!document.getElementById('overlayAcessoNomeado')`), 'Com a password errada, o pedido de identificação continua aberto — não deixa passar');
            ok(w.eval(`!!state.lotes['LTREST2']`) === false, 'Com a password errada, nada é restaurado');
            // password certa -> prossegue para o restauro (que ainda pede confirm(), já OK por omissão no teste)
            w.eval(`document.getElementById('fAcessoPassword').value = 'PP95K8Hy3c'; confirmarAcessoNomeado();`);
            setTimeout(() => {
              ok(w.eval(`!document.getElementById('overlayAcessoNomeado')`), 'Com a password certa, o pedido de identificação fecha e a ação prossegue');
              ok(w.eval(`state.lotes['LTREST1'].provador1`) === 'Atual', 'restaurarDeBackup() nunca sobrepõe um lote que já exista na app agora — preserva o trabalho atual');
              ok(w.eval(`!!state.lotes['LTREST2']`), 'restaurarDeBackup() repõe um lote que tinha sido apagado (tombstone) e está em falta');
              ok(w.eval(`state.lotes['LTREST2'].provador1`) === 'Recuperado', 'O lote reposto vem com os dados corretos do backup');
              ok(w.eval(`!state.removidos['LTREST2']`), 'restaurarDeBackup() remove o tombstone do lote reposto, para o servidor aceitar de volta (ver app.put /api/lotes)');
              ok(w.eval(`!!state.lotes['LTREST3']`), 'restaurarDeBackup() também repõe um lote simplesmente em falta (nunca teve tombstone)');
              ok(w.eval(`state.lotes['LTREST2'].atualizadoEm > '2026-09-30T19:00:00.000Z'`), 'O lote reposto fica com atualizadoEm novo (mais recente que o tombstone antigo), para passar a validação do servidor');
              ok(w.eval(`window.__chamadasAuditoria.length`) === 1, 'Fica registada exatamente uma entrada no registo de atividade para esta ação');
              ok(w.eval(`window.__chamadasAuditoria[0].nome`) === 'Tânia Martins', 'O registo de atividade identifica corretamente quem fez a ação');
              ok(/Restaurou backup de 2026-09-30/.test(w.eval(`window.__chamadasAuditoria[0].acao`)), 'O registo de atividade descreve a ação feita');

              // restaurarVersaoAnterior() usa sempre o backup mais recente da lista, sem precisar de escolher o dia
              w.eval(`
                state.lotes = {};
                state.removidos = {};
                restaurarVersaoAnterior();
              `);
              ok(w.eval(`document.querySelector('#overlayAcessoNomeado .sub').textContent`).includes('Restaurar versão anterior'), 'restaurarVersaoAnterior() também pede identificação nomeada primeiro');
              w.eval(`document.getElementById('fAcessoNome').value = 'Ana Catarina Silva'; document.getElementById('fAcessoPassword').value = 'pUpU4pFpiQ'; confirmarAcessoNomeado();`);
              setTimeout(() => {
                ok(w.eval(`!!state.lotes['LTREST2'] && !!state.lotes['LTREST3']`), 'restaurarVersaoAnterior() usa o backup mais recente disponível, sem ser preciso escolher o dia');
                ok(w.eval(`window.__chamadasAuditoria.length`) === 2, 'Fica também registada a segunda ação, com a pessoa certa');
                ok(w.eval(`window.__chamadasAuditoria[1].nome`) === 'Ana Catarina Silva', 'A segunda entrada identifica a pessoa certa (diferente da primeira)');
                w.eval(`window.fetch = window.__fetchOriginalRestauro;`);

                console.log(`\n${pass} passaram, ${fail} falharam.`);
                process.exit(fail > 0 ? 1 : 0);
              }, 80);
            }, 80);
          }, 50);
        }, 50);
      }, 50);
    }, 50);
  }, 50);
}

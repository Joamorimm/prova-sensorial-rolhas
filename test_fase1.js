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

  // ---------- 4) Regra automática do LAB: 0 defeitos -> aprovado automático ----------
  w.eval(`state.lotes = {}; saveState();`);
  w.eval(`
    state.lotes['LT0003'] = criarLoteVazio('LT0003'); state.lotes['LT0003'].diaPrevisto = ontemStr();
    state.lotes['LT0003'].provador1='P1'; state.lotes['LT0003'].provador2='P2';
    state.lotes['LT0003'].registos.p1 = {itens:[],apreciacao:'limpo',observacoes:'',concluido:true};
    state.lotes['LT0003'].registos.p2 = {itens:[],apreciacao:'limpo',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0003');
  `);
  ok(w.eval(`state.lotes['LT0003'].decisao.final`) === 'aprovado', 'Zero frascos com TCA/Mofo -> aprovado automático, sem clicar em nada');

  // ---------- 5) 1-3 defeitos (sem Mofo Forte) -> rejeitado automático ----------
  w.eval(`
    state.lotes['LT0004'] = criarLoteVazio('LT0004'); state.lotes['LT0004'].diaPrevisto = ontemStr();
    state.lotes['LT0004'].provador1='P1'; state.lotes['LT0004'].provador2='P2';
    const itens = [{frasco:1,tcaF:true},{frasco:2,mofoP:true}];
    state.lotes['LT0004'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0004'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0004');
  `);
  ok(w.eval(`state.lotes['LT0004'].decisao.final`) === 'rejeitado', '2 frascos com TCA/Mofo (< 3) -> rejeitado automático');
  ok(w.eval(`state.lotes['LT0004'].decisao.classificacao`) === null, 'Com 2 frascos ainda não leva a classificação "TCA Forte" (só a partir de 3)');
  const comentarioLT0004 = w.eval(`state.lotes['LT0004'].decisao.comentarios`);
  ok(!/rejeição|aprovação/i.test(comentarioLT0004), 'O comentário da decisão automática não usa as palavras "rejeição"/"aprovação" — só descreve e conclui a prova');

  // ---------- 6) Exatamente 3 defeitos -> rejeitado automático + classificação "TCA Forte" ----------
  w.eval(`
    state.lotes['LT0005'] = criarLoteVazio('LT0005'); state.lotes['LT0005'].diaPrevisto = ontemStr();
    state.lotes['LT0005'].provador1='P1'; state.lotes['LT0005'].provador2='P2';
    const itens = [{frasco:1,tcaF:true},{frasco:2,mofoP:true},{frasco:3,tcaP:true}];
    state.lotes['LT0005'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0005'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0005');
  `);
  ok(w.eval(`state.lotes['LT0005'].decisao.final`) === 'rejeitado', '3 frascos com TCA/Mofo -> rejeitado automático');
  ok(w.eval(`state.lotes['LT0005'].decisao.classificacao`) === 'TCA Forte', 'Exatamente 3 frascos -> fica classificado como "TCA Forte"');

  // ---------- 7) "Outro Aroma" não conta para nenhuma regra automática ----------
  w.eval(`
    state.lotes['LT0006'] = criarLoteVazio('LT0006'); state.lotes['LT0006'].diaPrevisto = ontemStr();
    state.lotes['LT0006'].provador1='P1'; state.lotes['LT0006'].provador2='P2';
    const itens = [{frasco:1,outro:true},{frasco:2,outro:true},{frasco:3,outro:true},{frasco:4,outro:true}];
    state.lotes['LT0006'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0006'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    tentarAutoFinalizar('LT0006');
  `);
  ok(w.eval(`state.lotes['LT0006'].decisao.final`) === 'aprovado', '4 frascos só com "Outro Aroma" (nenhum TCA/Mofo) -> continua aprovado automático');

  // ---------- 8) 4+ defeitos -> precisa do 3º provador (não decide sozinha só com P1+P2) ----------
  w.eval(`
    state.lotes['LT0007'] = criarLoteVazio('LT0007'); state.lotes['LT0007'].diaPrevisto = ontemStr();
    state.lotes['LT0007'].provador1='P1'; state.lotes['LT0007'].provador2='P2';
    const itens = [{frasco:1,tcaF:true},{frasco:2,tcaP:true},{frasco:3,mofoP:true},{frasco:4,tcaP:true}];
    state.lotes['LT0007'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0007'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
  `);
  const r8 = w.eval(`({decidiu: tentarAutoFinalizar('LT0007'), status: computeStatus(state.lotes['LT0007']), final: state.lotes['LT0007'].decisao.final, slot: proximoSlotProva(state.lotes['LT0007'])})`);
  ok(r8.status === 'aguarda_p3' && !r8.final && r8.slot === 'p3', '4 frascos com defeito -> não decide sozinha, fica "Aguarda Provador 3" (Iniciar Prova aponta para p3)');

  // ---------- 9) Qualquer Mofo Forte -> precisa do 3º provador mesmo com poucos defeitos ----------
  w.eval(`
    state.lotes['LT0008'] = criarLoteVazio('LT0008'); state.lotes['LT0008'].diaPrevisto = ontemStr();
    state.lotes['LT0008'].provador1='P1'; state.lotes['LT0008'].provador2='P2';
    const itens = [{frasco:1,mofoF:true}];
    state.lotes['LT0008'].registos.p1 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LT0008'].registos.p2 = {itens: itens.map(x=>({...x})),apreciacao:'',observacoes:'',concluido:true};
  `);
  const r9 = w.eval(`({decidiu: tentarAutoFinalizar('LT0008'), status: computeStatus(state.lotes['LT0008'])})`);
  ok(r9.status === 'aguarda_p3' && r9.decidiu === false, '1 frasco com Mofo Forte -> precisa sempre do 3º provador, mesmo sendo só 1 defeito');

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
  ok(l8.final === 'rejeitado' && l8.decididoPor === 'Teresa Pinto', 'Ao assinar, o lote fica decidido sozinho (direto) — sem clicar em Aprovar/Rejeitar — e pronto para o Levantamento');

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
  // conclui o lote (0 defeitos -> aprovado automático) e confirma que a Data Conclusão aparece
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

  // ---------- 12) Importar Prioridades (colar texto) já não cria lotes novos ----------
  w.eval(`state.lotes = {}; saveState();`);
  w.eval(`document.getElementById('taPrioridadesInput').value = 'LT09991111\\tU';`);
  w.eval(`importarPrioridades();`);
  const criouLote = w.eval(`!!state.lotes['LT09991111']`);
  ok(criouLote === false, 'Colar uma lista de prioridades já NÃO cria lotes novos (só o "Importar Ordens (Excel)" cria)');
  ok(/ainda não existem na app/.test(lastAlert()), 'Mostra aviso claro de que o lote não existe e não foi criado — alerta: "' + lastAlert().slice(0,70) + '..."');

  // ---------- 13) lotesAguardaP3() conta aguarda_p3 + confronto ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTA'] = criarLoteVazio('LTA'); state.lotes['LTA'].diaPrevisto = ontemStr();
    state.lotes['LTA'].provador1='P1'; state.lotes['LTA'].provador2='P2';
    state.lotes['LTA'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTA'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTA'].revisaoConjunta.feita = true; // divergência mantida -> aguarda_p3
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

  w.eval(`abrirAlertaProvador3();`); // só 1 lote pendente -> abre logo a ficha do lote
  const abriuLoteDireto = w.eval(`!!document.getElementById('overlayLote')`);
  ok(abriuLoteDireto === true, 'Com um único lote pendente, o botão dinâmico abre logo a ficha do lote (sem escolher)');
  w.eval(`closeModal('overlayLote');`);

  w.eval(`
    state.lotes['LTA2'] = criarLoteVazio('LTA2'); state.lotes['LTA2'].diaPrevisto = ontemStr();
    state.lotes['LTA2'].provador1='P1'; state.lotes['LTA2'].provador2='P2';
    state.lotes['LTA2'].registos.p1 = {itens:[{frasco:1,tcaF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTA2'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTA2'].revisaoConjunta.feita = true;
    renderAll();
    abrirAlertaProvador3();
  `);
  const opcoesEscolha = w.eval(`document.querySelectorAll('#overlayAlertaP3 .actions-row button').length`);
  ok(opcoesEscolha === 2, 'Com vários lotes pendentes, o botão dinâmico mostra um mini-modal a escolher qual abrir (' + opcoesEscolha + ' opções)');
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
  ok(w.eval(`document.querySelectorAll('.frasco-tile:not(.frasco-vazio)').length`) === 50, 'Mostra uma grelha com uma peça por cada frasco (1 a 50)');
  ok(w.eval(`document.querySelectorAll('.frasco-tile.frasco-vazio').length`) === 1, 'A 1ª posição da grelha fica em branco, avançando o frasco 1 para a 2ª posição');
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

  // ---------- 15b) Lotes com mais de 50 frascos: grelha de toque em "ondas" de 50 (17/09/2026) ----------
  w.eval(`state.lotes = {};`);
  w.eval(`
    state.lotes['LTD'] = criarLoteVazio('LTD'); state.lotes['LTD'].diaPrevisto = ontemStr(); state.lotes['LTD'].numeroFrascos = 120;
    ctxLote='LTD'; ctxProvador='p1';
    openRegistoModal('LTD','p1');
  `);
  ok(w.eval(`!document.querySelector('#fNumFrasco')`), 'Já não existe nenhum campo de entrada manual do nº do frasco, nem para lotes grandes');
  ok(w.eval(`!!document.querySelector('.frasco-grid')`), 'Com mais de 50 frascos, continua a mostrar-se a grelha de toque (não cai para entrada manual)');
  ok(w.eval(`document.querySelectorAll('.frasco-tile:not(.frasco-vazio)').length`) === 50, '1ª onda mostra 50 frascos de cada vez, mesmo havendo 120 no total');
  ok(w.eval(`document.querySelector('.onda-contador').textContent.trim()`) === 'Frascos 1–50', 'O contador mostra só o intervalo de frascos da onda ("Frascos 1–50"), sem a palavra "onda"');
  ok(!w.eval(`document.querySelector('.onda-nav').textContent`).toLowerCase().includes('onda anterior') && !w.eval(`document.querySelector('.onda-nav').textContent`).toLowerCase().includes('onda seguinte'),
    'Os botões de navegação mostram só as setas ◀ ▶, sem a palavra "Onda"');

  // marca o frasco 40 (dentro da 1ª onda) e avança para a 2ª onda
  w.eval(`abrirSeletorGrid(40); marcarChipGrid('tcaF');`);
  w.eval(`mudarOndaGrid(1);`);
  const primeiroDaOnda2 = w.eval(`document.querySelector('.frasco-tile .ft-num').textContent`);
  ok(primeiroDaOnda2 === '51', 'A 2ª onda começa no frasco 51 — numeração sempre contínua (não reinicia em 1)');
  ok(w.eval(`document.querySelectorAll('.frasco-tile.frasco-vazio').length`) === 0, 'A 2ª onda não tem a peça em branco inicial (essa só existe na 1ª onda)');

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
    state.lotes['LTK'] = criarLoteVazio('LTK'); state.lotes['LTK'].diaPrevisto = ontemStr();
    state.lotes['LTK'].provador1 = 'Rita'; state.lotes['LTK'].provador2 = 'Nuno';
    state.lotes['LTK'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTK'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTK'].decisao.final = 'rejeitado';
    state.lotes['LTK'].decisao.data = hojeStr();
    state.lotes['LTH'] = criarLoteVazio('LTH'); state.lotes['LTH'].diaPrevisto = ontemStr();
    state.lotes['LTH'].prioridade = 'vermelho';
    state.lotes['LTH'].provador1 = 'Rita'; state.lotes['LTH'].provador2 = 'Nuno';
    state.lotes['LTH'].registos.p1 = {itens:[{frasco:5,tcaP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTH'].registos.p2 = {itens:[{frasco:5,mofoF:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTH'].decisao.final = 'aprovado';
    state.lotes['LTH'].decisao.data = '2020-01-01';
    switchView('lab');
  `);
  ok(w.eval(`grupoLoteLAB(state.lotes['LTP'])`) === 'planeados', 'Lote sem nenhum provador a começar entra em "Planeados"');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTW'])`) === 'wip', 'Lote já começado mas não concluído entra em "WIP"');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTK'])`) === 'concluidos', 'Lote concluído hoje entra em "Concluídos"');
  ok(w.eval(`grupoLoteLAB(state.lotes['LTH'])`) === 'historico', 'Lote concluído num dia anterior migra para "Histórico"');

  // 3 colunas visíveis de imediato (Planeados/WIP/Concluídos) — sem tabs para trocar de vista
  const textoPlaneados = w.eval(`document.getElementById('labColPlaneados').textContent`);
  ok(/LTP/.test(textoPlaneados) && !/LTW/.test(textoPlaneados) && !/LTK/.test(textoPlaneados), 'A coluna "Planeados" mostra só os lotes por começar');
  const textoWip = w.eval(`document.getElementById('labColWip').textContent`);
  ok(/LTW/.test(textoWip) && !/LTP/.test(textoWip) && !/LTK/.test(textoWip), 'A coluna "WIP" mostra só os lotes em curso');
  const textoConcluidos = w.eval(`document.getElementById('labColConcluidos').textContent`);
  ok(/LTK/.test(textoConcluidos) && !/LTH/.test(textoConcluidos), 'A coluna "Concluídos" mostra só os lotes concluídos hoje (o LTH de outro dia não aparece)');
  ok(w.eval(`document.getElementById('labContPlaneados').textContent`) === '1', 'A coluna Planeados mostra a contagem correta');
  ok(w.eval(`document.getElementById('labContWip').textContent`) === '1', 'A coluna WIP mostra a contagem correta');
  ok(w.eval(`document.getElementById('labContConcluidos').textContent`) === '1', 'A coluna Concluídos mostra a contagem correta');

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
  ok(/Prova Concluída/.test(textoHistorico) && !/Rejeitado/.test(textoHistorico), 'O Histórico também mostra só "Prova Concluída", sem distinguir aprovado/rejeitado');
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

  // ---------- 18) Botão "Exportar Histórico (CSV)" encostado à barra de pesquisa (header) ----------
  ok(w.eval(`!!document.querySelector('header.topbar .btn-hist-csv')`), 'Existe um botão "Exportar Histórico (CSV)" no cabeçalho, junto à barra de pesquisa do lote');
  ok(w.eval(`document.querySelector('header.topbar .btn-hist-csv').textContent.trim()`) === 'Exportar Histórico (CSV)', 'O botão do cabeçalho tem o texto "Exportar Histórico (CSV)"');
  ok(w.eval(`document.querySelector('header.topbar .btn-hist-csv').getAttribute('onclick')`) === 'exportarTabelaLABCsv()', 'O botão do cabeçalho chama exportarTabelaLABCsv() diretamente — a informação sai logo, sem entrar em LAB');
  ok(w.eval(`!document.querySelector('#blocoHistoricoLAB button')`), 'O botão deixou de estar duplicado dentro do bloco de Histórico do LAB');
  // continua a funcionar a partir de qualquer ecrã (ex.: estando no Início, não em LAB)
  w.eval(`
    switchView('inicio');
    state.lotes['LTCSV'] = criarLoteVazio('LTCSV'); state.lotes['LTCSV'].diaPrevisto = ontemStr();
    state.lotes['LTCSV'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTCSV'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTCSV'].decisao = {final:'aprovado', data: new Date().toISOString()};
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
    state.lotes['LTREJ1'] = criarLoteVazio('LTREJ1'); state.lotes['LTREJ1'].diaPrevisto = ontemStr();
    state.lotes['LTREJ1'].prioridade = 'vermelho';
    state.lotes['LTREJ1'].provador1 = 'Marta Santos'; state.lotes['LTREJ1'].provador2 = 'Teresa Pinto';
    state.lotes['LTREJ1'].registos.p1 = {itens:[{frasco:6,tcaF:true},{frasco:15,mofoP:true}],apreciacao:'limpo',observacoes:'Cheiro intenso no frasco 6.',concluido:true};
    state.lotes['LTREJ1'].registos.p2 = {itens:[{frasco:6,tcaF:true},{frasco:15,mofoP:true}],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJ1'].decisao.final = 'rejeitado';
    state.lotes['LTREJ1'].decisao.data = new Date().toISOString();
    state.lotes['LTREJ0'] = criarLoteVazio('LTREJ0'); state.lotes['LTREJ0'].diaPrevisto = ontemStr();
    state.lotes['LTREJ0'].provador1 = 'Marta Santos'; state.lotes['LTREJ0'].provador2 = 'Teresa Pinto';
    state.lotes['LTREJ0'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJ0'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJ0'].decisao.final = 'rejeitado';
    state.lotes['LTREJ0'].decisao.data = new Date().toISOString();
    state.lotes['LTREJ0'].decisao.comentarios = '2 frasco(s) com TCA/Mofo (união dos provadores) — rejeição automática.';
    state.lotes['LTREJONTEM'] = criarLoteVazio('LTREJONTEM'); state.lotes['LTREJONTEM'].diaPrevisto = ontemStr();
    state.lotes['LTREJONTEM'].registos.p1 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJONTEM'].registos.p2 = {itens:[],apreciacao:'',observacoes:'',concluido:true};
    state.lotes['LTREJONTEM'].decisao.final = 'rejeitado';
    state.lotes['LTREJONTEM'].decisao.data = '2020-01-01T10:00:00.000Z';
    renderAll();
  `);
  ok(!w.eval(`document.getElementById('listaPrioridades')`), 'A lista "Lotes em aberto" já não existe no ecrã Logística');
  ok(w.eval(`!document.body.textContent.includes('Lotes em aberto')`), 'O título "Lotes em aberto" foi removido');
  ok(w.eval(`!document.getElementById('toolbarSelecao')`), 'A seleção múltipla/apagar em massa foi removida (não há lista para selecionar)');
  ok(!w.eval(`document.body.textContent`).includes('Imprimir'), 'O botão "Imprimir" dos Lotes em aberto foi removido');
  ok(!w.eval(`document.body.textContent`).includes('Exportar CSV') && !w.eval(`document.body.textContent`).includes('Exportar XLS'), 'Os botões "Exportar CSV"/"Exportar XLS" dos Lotes em aberto foram removidos');
  ok(w.eval(`!!document.getElementById('taPrioridadesInput')`), '"Importar lista do planeamento" (colar prioridades) continua no ecrã Logística');

  const txtLevantamentoHoje = w.eval(`document.getElementById('listaLevantamento').textContent`);
  ok(txtLevantamentoHoje.includes('LTREJ1') && txtLevantamentoHoje.includes('LTREJ0'), '"Por levantar (hoje)" mostra os lotes rejeitados hoje');
  ok(!txtLevantamentoHoje.includes('LTREJONTEM'), '"Por levantar (hoje)" já não mostra um lote rejeitado num dia anterior — a vista limpa-se sozinha todos os dias');
  const numFrascosLTREJ1 = w.eval(`document.querySelector('#listaLevantamento .quad-lote.q-prio-urgente').closest('.lote-card').querySelector('.fl-num').textContent.trim()`);
  ok(numFrascosLTREJ1 === '6, 15', 'Mostra o nº efetivo dos frascos a levantar (ex: 6, 15) em vez de só uma contagem, num destaque maior (fl-num)');
  const cartoesLevantamento = w.eval(`[...document.querySelectorAll('#listaLevantamento .fl-num')].map(e=>e.textContent.trim())`);
  ok(cartoesLevantamento.includes('0'), 'Quando não há frasco assinalado individualmente, mostra "0"');
  ok(txtLevantamentoHoje.includes('Cheiro intenso no frasco 6'), 'As Observações do provador continuam visíveis');
  ok(!/Apreciação Geral/.test(txtLevantamentoHoje), 'A "Apreciação Geral" foi removida do Levantamento');
  ok(!/TCA|Mofo/.test(txtLevantamentoHoje), 'A informação de tipo de defeito (TCA/Mofo) foi removida do Levantamento');
  ok(!/Material levantado/.test(txtLevantamentoHoje), 'Já não existe a validação/checkbox "Material levantado"');
  ok(!/rejeição automática/.test(txtLevantamentoHoje) && !/Comentários:/.test(txtLevantamentoHoje), 'O comentário da decisão automática ("rejeição automática") já não aparece no Levantamento');
  ok(txtLevantamentoHoje.includes('Sem observações registadas'), 'Sem observações reais dos provadores, mostra "Sem observações registadas" em vez do comentário automático');

  ok(w.eval(`!!document.querySelector('#listaLevantamento .quad-lote.lev-tile.q-prio-urgente')`), 'O nº do lote no Levantamento aparece num bloco colorido igual ao da grelha de Lotes (mesma cor de prioridade)');
  ok(w.eval(`document.querySelector('#listaLevantamento .quad-lote.lev-tile.q-prio-urgente').textContent.trim()`) === 'LTREJ1', 'O bloco colorido mostra o nº do lote (LTREJ1, prioridade urgente/vermelho)');
  ok(w.eval(`document.querySelector('#listaLevantamento .quad-lote.lev-tile.q-prio-urgente').tagName`) === 'BUTTON', 'O bloco colorido é um botão (tipo botões, clicável para abrir a ficha do lote)');

  w.eval(`filtrarLevantamento('todos')`);
  const txtLevantamentoTodos = w.eval(`document.getElementById('listaLevantamento').textContent`);
  ok(txtLevantamentoTodos.includes('LTREJONTEM'), '"Histórico" continua a mostrar lotes rejeitados em dias anteriores');
  ok(w.eval(`document.querySelector('[data-lf="todos"]').textContent.trim()`) === 'Histórico', 'O separador passou a chamar-se "Histórico" (em vez de "Todos os rejeitados")');

  // ---------- 20) LAB: botão "Copiar" por coluna — nºs de lote um por linha, para colar em coluna no Excel ----------
  w.eval(`
    state.lotes = {};
    state.lotes['LTP1'] = criarLoteVazio('LTP1'); state.lotes['LTP1'].diaPrevisto = ontemStr();
    state.lotes['LTP2'] = criarLoteVazio('LTP2'); state.lotes['LTP2'].diaPrevisto = ontemStr();
    state.lotes['LTW1'] = criarLoteVazio('LTW1'); state.lotes['LTW1'].diaPrevisto = ontemStr(); state.lotes['LTW1'].provador1 = 'Marta Santos';
    switchView('lab');
  `);
  ok(w.eval(`!!document.querySelector('.lab-col-copy')`), 'Existe um botão "Copiar" em cada coluna do LAB');
  let textoCopiado = null;
  w.navigator.clipboard = { writeText: (t)=>{ textoCopiado = t; return Promise.resolve(); } };
  const alertsAntes = alerts.length;
  w.eval(`copiarColunaLAB('planeados')`);
  ok(textoCopiado === 'LTP1\nLTP2', 'O "Copiar" da coluna Planeados junta os nºs de lote com quebra de linha (um por linha), sem a letra U/P nem o resto do botão');
  ok(alerts.length === alertsAntes, 'Copiar já não abre um popup a pedir para clicar OK — copia direto, sem pokeyoke');
  textoCopiado = null;
  w.eval(`copiarColunaLAB('wip')`);
  ok(textoCopiado === 'LTW1', 'O "Copiar" da coluna WIP copia só os lotes dessa coluna');

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
    state.lotes['LTR3'] = criarLoteVazio('LTR3'); state.lotes['LTR3'].diaPrevisto = ontemStr();
    state.lotes['LTR3'].decisao.final = 'aprovado'; state.lotes['LTR3'].decisao.data = hojeStr(); // fechado hoje
    state.lotes['LTR4'] = criarLoteVazio('LTR4'); state.lotes['LTR4'].diaPrevisto = ontemStr();
    state.lotes['LTR4'].decisao.final = 'rejeitado'; state.lotes['LTR4'].decisao.data = ontemStr(); // fechado ontem -> histórico, não conta
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

        console.log(`\n${pass} passaram, ${fail} falharam.`);
        process.exit(fail > 0 ? 1 : 0);
      }, 50);
    }, 50);
  }, 50);
}

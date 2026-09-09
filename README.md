# Prova Sensorial de Amostras de Rolhas — Cork Supply Portugal

App partilhada (todos os utilizadores veem os mesmos lotes, em tempo real) e instalável
como app no telemóvel (Android e iPhone), sem passar pelas lojas de aplicações.

## O que está aqui

- `server.js` — servidor Node/Express que guarda os lotes e sincroniza todos os
  utilizadores ligados em tempo real (Socket.IO).
- `public/` — a aplicação (a mesma que já conheces, agora a falar com o servidor
  em vez de guardar só no telemóvel).
- `public/manifest.json`, `public/sw.js`, `public/icons/` — tornam a app instalável
  ("Adicionar ao ecrã principal") em Android e iPhone.

## Publicar no Railway (a conta que já tens)

1. Cria um novo projeto no Railway → **Deploy from GitHub repo** (mais simples) ou
   **Empty Project** e depois usa o Railway CLI/arrastar ficheiros — o Railway deteta
   automaticamente que é uma app Node (por causa do `package.json`) e corre `npm install`
   seguido de `npm start`.
   - Se preferires GitHub: cria um repositório novo, copia estes ficheiros para lá
     (não precisas de copiar a pasta `node_modules`, o Railway instala-a sozinho),
     faz commit/push, e liga esse repositório ao Railway.
2. **Volume persistente (importante):** por defeito, o disco do Railway é apagado a
   cada novo deploy. Para os dados dos lotes não se perderem:
   - No projeto Railway, vai a **Settings → Volumes** e cria um volume, montado por
     exemplo em `/data`.
   - Define a variável de ambiente `DATA_DIR` = `/data`.
   - Sem isto, a app funciona na mesma, mas os lotes podem desaparecer no próximo deploy.
3. **Proteger o acesso (opcional mas recomendado):** já que o link fica público,
   define duas variáveis de ambiente para pedir utilizador/password antes de abrir:
   - `APP_USER` = (ex: `corksupply`)
   - `APP_PASS` = (uma password à tua escolha, partilhada só com a equipa)
   - Se não definires nada, a app fica acessível a quem tiver o link.
4. O Railway dá-te um URL público (tipo `prova-sensorial-production.up.railway.app`).
   É esse o link a partilhar com a equipa.

## Instalar no telemóvel (depois de publicado)

- **Android (Chrome):** abre o link → menu (⋮) → "Adicionar ao ecrã principal" /
  "Instalar aplicação".
- **iPhone (Safari):** abre o link → botão Partilhar (quadrado com seta) →
  "Adicionar ao Ecrã Principal".

Depois disto, a app abre com ícone próprio, em ecrã inteiro, como uma app normal —
mas continua a ser a mesma página web por trás, atualizada automaticamente sempre
que voltares a abrir.

## Testar localmente antes de publicar

```
npm install
npm start
```

Depois abre `http://localhost:3000` no browser. Para testares a sincronização entre
"utilizadores", abre o mesmo endereço em duas abas/dispositivos diferentes — uma
alteração numa aparece na outra em poucos segundos.

## Limitações a ter em conta

- Não há contas/login por pessoa — só a password partilhada opcional acima. Quem
  souber a password pode ver e alterar tudo.
- Duas pessoas a editar o mesmo lote ao mesmo tempo: fica sempre a versão mais
  recente (não há aviso de conflito) — para o volume de uso de um laboratório isto
  não costuma ser problema, mas é bom saber.
- As fotos das etiquetas vão dentro dos dados do lote (como imagem em texto);
  com muitas fotos de alta resolução, o ficheiro de dados cresce — se um dia isto
  pesar muito, o próximo passo seria guardar as fotos à parte (ex: num serviço de
  ficheiros), não é urgente para já.

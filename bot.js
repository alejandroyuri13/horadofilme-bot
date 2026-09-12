const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

// ============================================================
// LOG + SSE
// ============================================================
const logBuffer = [];
const sseClients = [];

function log(msg) {
  const linha = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
  console.log(linha);
  logBuffer.push(linha);
  if (logBuffer.length > 200) logBuffer.shift();
  sseClients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(linha)}\n\n`); } catch {}
  });
}

// ============================================================
// VALIDAÇÃO DE VARIÁVEIS
// ============================================================
const variaveis = ['TIGER_USER', 'TIGER_PASS', 'BREVO_API_KEY', 'BREVO_TEMPLATE_ID', 'BREVO_EMAIL_REMETENTE', 'TIGER_SERVER_ID', 'PLANOS', 'WEBHOOK_SECRET', 'DASHBOARD_USER', 'DASHBOARD_PASS'];
for (const v of variaveis) {
  if (!process.env[v]) {
    console.log(`❌ Variável obrigatória não definida: ${v}`);
    process.exit(1);
  }
}

// PLANOS JSON inválido mata o processo na inicialização
try { JSON.parse(process.env.PLANOS); } catch {
  console.log('❌ PLANOS não é um JSON válido. Verifique a variável de ambiente.');
  process.exit(1);
}

const TIGER_USER        = process.env.TIGER_USER;
const TIGER_PASS        = process.env.TIGER_PASS;
const BREVO_API_KEY     = process.env.BREVO_API_KEY;
const BREVO_TEMPLATE_ID = parseInt(process.env.BREVO_TEMPLATE_ID);
const BREVO_REMETENTE   = process.env.BREVO_EMAIL_REMETENTE;
const BREVO_ALERTA      = process.env.BREVO_EMAIL_ALERTA || process.env.BREVO_EMAIL_REMETENTE;
const SERVER_ID         = process.env.TIGER_SERVER_ID;
const DOWNLOADER        = process.env.CODIGO_DOWNLOADER || '';
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET;
const DASHBOARD_USER    = process.env.DASHBOARD_USER;
const DASHBOARD_PASS    = process.env.DASHBOARD_PASS;
const PORT              = process.env.PORT || 3000;
// Normaliza nomes de plano para lowercase sem espaços extras (evita falha por diferença de caixa)
const PLANOS_RAW        = JSON.parse(process.env.PLANOS);
const PLANOS            = Object.fromEntries(
  Object.entries(PLANOS_RAW).map(([k, v]) => [k.trim().toLowerCase(), v])
);

// Sempre criamos contas de 1 mês na Tiger (servidor OURO, pacote C/ADULTO) — economiza créditos
const PACKAGE_ID_MENSAL = 'RYAWRk1jlx';

// Quantidade de meses por nome de plano
const MESES_POR_PLANO = {
  'hora do filme [1 mês]':  1,
  'hora do filme [3 meses]': 3,
  'hora do filme [6 meses]': 6,
  'hora do filme [anual]':  12,
  'hora do filme [plus]':    1,
};

// ============================================================
// POOL DE CREDENCIAIS (2 clientes por conta, sempre 1 mês)
// ============================================================
const POOL_FILE = process.env.POOL_FILE || './pool.json';
let pool = [];

function carregarPool() {
  try {
    pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    const ativas = pool.filter(c => c.ativa).length;
    console.log(`[Pool] Carregada: ${ativas} contas ativas`);
  } catch { pool = []; }
}

function salvarPool() {
  try { fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2)); } catch {}
}

function contaComSlot() {
  return pool.find(c => c.ativa && c.clientes.length < 2);
}

function novaEntradaPool(usuario, senha, cliente) {
  const exp = new Date();
  exp.setDate(exp.getDate() + 30);
  const entrada = { id: Date.now(), usuario, senha, dataExpiracao: exp.toISOString(), ativa: true, clientes: [cliente] };
  pool.push(entrada);
  salvarPool();
  return entrada;
}

// ============================================================
// HISTÓRICO DE VENDAS (persistido em disco)
// ============================================================
const HISTORICO_FILE = process.env.HISTORICO_FILE || (process.env.POOL_FILE ? process.env.POOL_FILE.replace('pool.json','historico.json') : './historico.json');
let historico = [];

function carregarHistorico() {
  try {
    historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
    console.log(`[Histórico] Carregado: ${historico.length} registros`);
  } catch { historico = []; }
}

function salvarHistorico() {
  try { fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2)); } catch {}
}

function registrarVenda(dados) {
  historico.unshift(dados);
  if (historico.length > 1000) historico.pop();
  salvarHistorico();
}

// ============================================================
// ALERTA DE FALHA — email para o operador quando venda falha
// ============================================================
async function enviarAlertaFalha(venda, motivo) {
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: [{ email: BREVO_ALERTA, name: 'Operador Hora do Filme' }],
        sender: { name: 'Hora do Filme Bot', email: BREVO_REMETENTE },
        subject: '🚨 FALHA na entrega — ' + venda.nomeCliente,
        htmlContent: `<p><b>Cliente:</b> ${venda.nomeCliente} &lt;${venda.emailCliente}&gt;</p>
          <p><b>Plano:</b> ${venda.nomeProduto}</p>
          <p><b>Erro:</b> ${motivo}</p>
          <p><b>Horário:</b> ${new Date().toLocaleString('pt-BR')}</p>
          <p>Acesse o painel e use "Reenviar Email Manualmente" após resolver.</p>`
      })
    });
    log(`📧 Alerta de falha enviado para ${BREVO_ALERTA}`);
  } catch (e) {
    log(`⚠️  Não foi possível enviar alerta de falha: ${e.message}`);
  }
}

// ============================================================
// SESSÃO PERSISTENTE DA TIGER
// ============================================================
let sessao = null;
let iniciandoSessao = false;

// Renova a sessão automaticamente a cada 10 horas (tokens expiram)
const RENOVAR_SESSAO_MS = 10 * 60 * 60 * 1000;
setInterval(async () => {
  if (sessao && !processando) {
    log('🔄 Renovação periódica da sessão Tiger...');
    await invalidarSessao();
    try {
      await iniciarSessao();
    } catch (e) {
      log(`⚠️  Renovação automática falhou: ${e.message}. Será tentada na próxima venda.`);
    }
  }
}, RENOVAR_SESSAO_MS);

const TIGER_BASE = 'https://tigreagile.uk';
const TIGER_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function iniciarSessao() {
  if (iniciandoSessao) {
    await new Promise(r => setTimeout(r, 5000));
    return sessao;
  }
  iniciandoSessao = true;
  log('🔄 Iniciando sessão na Tiger...');

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1280,800']
    });
    const context = await browser.newContext({
      userAgent: TIGER_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR'
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    let token = null;

    // Captura token de qualquer resposta da API de auth
    page.on('response', async (response) => {
      if (response.url().includes('/api/auth') || response.url().includes('/api/login')) {
        try {
          const json = await response.json();
          const t = json?.token || json?.data?.token || json?.access_token;
          if (t && !token) token = 'Bearer ' + t;
        } catch {}
      }
    });

    // Navega e espera o JS terminar de renderizar
    log('🌐 Abrindo Tiger...');
    await page.goto(TIGER_BASE, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(3000); // pausa extra para SPA renderizar

    // Tira screenshot para debug (salva no log)
    const inputs = await page.locator('input:not([type="hidden"])').all();
    log(`🔍 Inputs encontrados na página: ${inputs.length}`);

    if (inputs.length >= 2) {
      log('🖱️ Preenchendo formulário de login...');
      await inputs[0].fill(TIGER_USER);
      await inputs[1].fill(TIGER_PASS);

      // Tenta clicar no botão de submit
      try {
        await page.locator('button[type="submit"]').first().click();
      } catch {
        // Alguns SPAs usam div ou outro elemento como botão
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(8000);
    } else {
      // Tenta encontrar inputs por outros seletores
      log('⚠️ Formulário padrão não encontrado, tentando seletores alternativos...');
      try {
        await page.waitForSelector('[placeholder*="usu"], [placeholder*="user"], [placeholder*="login"], [type="email"]', { timeout: 20000 });
        const altInputs = await page.locator('input').all();
        log(`🔍 Inputs alternativos: ${altInputs.length}`);
        if (altInputs.length >= 2) {
          await altInputs[0].fill(TIGER_USER);
          await altInputs[1].fill(TIGER_PASS);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(8000);
        }
      } catch (e) {
        log(`⚠️ Seletores alternativos falharam: ${e.message}`);
      }
    }

    if (!token) throw new Error('Não foi possível obter token da Tiger. Verifique usuário/senha (ou possível bloqueio anti-bot do Cloudflare).');

    sessao = { browser, page, token, iniciadaEm: new Date() };
    log('✅ Sessão Tiger iniciada!');
    return sessao;

  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    throw err;
  } finally {
    iniciandoSessao = false;
  }
}

async function getSessao() {
  if (!sessao) return await iniciarSessao();
  return sessao;
}

async function invalidarSessao() {
  if (sessao) {
    try { await sessao.browser.close(); } catch {}
    sessao = null;
    log('🔄 Sessão invalidada.');
  }
}

// ============================================================
// CRIAR CLIENTE NA TIGER (com retry)
// ============================================================
async function criarCliente(packageId, tentativa = 1) {
  const MAX = 3;

  try {
    const { page, token } = await getSessao();

    const resultado = await page.evaluate(async ({ packageId, token, serverId }) => {
      const usuario = Math.floor(1000000 + Math.random() * 9000000).toString();
      const senha   = Math.floor(1000000 + Math.random() * 9000000).toString();

      const res = await fetch('/api/customers', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': token
        },
        body: JSON.stringify({
          server_id: serverId,
          package_id: packageId,
          username: usuario,
          password: senha,
          connections: 2,
          bouquets: '',
          parent_can_edit_personal_data: 'YES'
        })
      });

      const data = await res.json();
      return { status: res.status, data, usuario, senha };
    }, { packageId, token, serverId: SERVER_ID });

    if (resultado.status === 401) {
      log('🔄 Token expirado, renovando sessão...');
      await invalidarSessao();
      if (tentativa < MAX) return criarCliente(packageId, tentativa + 1);
      throw new Error('Sessão inválida após renovação');
    }

    if (resultado.status !== 200 && resultado.status !== 201) {
      throw new Error(`Tiger retornou ${resultado.status}: ${JSON.stringify(resultado.data)}`);
    }

    const usuario = resultado.data?.data?.username || resultado.usuario;
    const senha   = resultado.data?.data?.password || resultado.senha;

    log(`✅ Credencial criada: ${usuario}`);
    return { usuario, senha };

  } catch (err) {
    if (tentativa < MAX) {
      const espera = 2000 * tentativa;
      log(`⚠️  Tentativa ${tentativa}/${MAX} falhou: ${err.message}. Aguardando ${espera/1000}s...`);
      await invalidarSessao();
      await new Promise(r => setTimeout(r, espera));
      return criarCliente(packageId, tentativa + 1);
    }
    throw err;
  }
}

// ============================================================
// ENVIAR EMAIL VIA BREVO
// ============================================================
async function enviarEmail(emailCliente, nomeCliente, nomeProduto, usuario, senha) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: [{ email: emailCliente, name: nomeCliente }],
      sender: { name: 'Hora do Filme', email: BREVO_REMETENTE },
      templateId: BREVO_TEMPLATE_ID,
      params: {
        NOME_CLIENTE: nomeCliente,
        USUARIO: usuario,
        SENHA: senha,
        PLANO: nomeProduto,
        DOWNLOADER: DOWNLOADER
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo erro: ${text}`);
  }

  log(`✅ Email enviado para ${emailCliente}`);
}

// ============================================================
// FILA DE PROCESSAMENTO
// ============================================================
const fila = [];
let processando = false;

async function adicionarNaFila(venda) {
  fila.push(venda);
  log(`📥 Venda na fila (posição ${fila.length}): ${venda.nomeCliente}`);
  processarFila();
}

async function processarFila() {
  if (processando || fila.length === 0) return;
  processando = true;

  while (fila.length > 0) {
    const venda = fila.shift();
    try {
      await processarVendaComPool(venda);
    } catch (err) {
      log(`❌ Falha definitiva para ${venda.emailCliente}: ${err.message}`);
      registrarVenda({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        nomeCliente: venda.nomeCliente,
        emailCliente: venda.emailCliente,
        nomeProduto: venda.nomeProduto,
        usuario: null,
        senha: null,
        status: 'erro',
        erro: err.message
      });
      await enviarAlertaFalha(venda, err.message);
    }
  }

  processando = false;
}

async function processarVendaComPool({ emailCliente, nomeCliente, nomeProduto }) {
  log(`\n▶ Processando: ${nomeCliente} <${emailCliente}> — ${nomeProduto}`);

  const meses = MESES_POR_PLANO[nomeProduto.trim().toLowerCase()] || 1;
  const clienteDados = { nome: nomeCliente, email: emailCliente, planoOriginal: nomeProduto, totalMeses: meses, mesesRestantes: meses - 1 };

  let usuario, senha;
  const slot = contaComSlot();

  if (slot) {
    usuario = slot.usuario;
    senha   = slot.senha;
    slot.clientes.push(clienteDados);
    salvarPool();
    log(`♻️ Reusando conta ${usuario} (${slot.clientes.length}/2 slots)`);
  } else {
    const creds = await criarCliente(PACKAGE_ID_MENSAL);
    usuario = creds.usuario;
    senha   = creds.senha;
    novaEntradaPool(usuario, senha, clienteDados);
    log(`✅ Nova conta criada: ${usuario}`);
  }

  await enviarEmail(emailCliente, nomeCliente, nomeProduto, usuario, senha);

  registrarVenda({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    nomeCliente,
    emailCliente,
    nomeProduto,
    usuario,
    senha,
    status: 'sucesso',
    erro: null
  });

  log(`✅ Concluído: ${nomeCliente}\n`);
}

// ============================================================
// RENOVAÇÃO AUTOMÁTICA (verifica a cada hora)
// ============================================================
async function verificarRenovacoes() {
  const limite = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const paraRenovar = pool.filter(c => c.ativa && new Date(c.dataExpiracao) <= limite);
  if (paraRenovar.length === 0) return;

  log(`\n🔄 ${paraRenovar.length} conta(s) vencendo — processando renovações...`);

  for (const conta of paraRenovar) {
    conta.ativa = false;

    const paraRenovarClientes = conta.clientes.filter(c => c.mesesRestantes > 0);
    const concluidos          = conta.clientes.filter(c => c.mesesRestantes <= 0);
    concluidos.forEach(c => log(`📋 Plano concluído: ${c.email} (${c.planoOriginal})`));

    if (paraRenovarClientes.length > 0) {
      try {
        const creds = await criarCliente(PACKAGE_ID_MENSAL);
        const exp = new Date();
        exp.setDate(exp.getDate() + 30);

        pool.push({
          id: Date.now(),
          usuario: creds.usuario,
          senha: creds.senha,
          dataExpiracao: exp.toISOString(),
          ativa: true,
          clientes: paraRenovarClientes.map(c => ({ ...c, mesesRestantes: c.mesesRestantes - 1 }))
        });

        for (const c of paraRenovarClientes) {
          try {
            await enviarEmail(c.email, c.nome, c.planoOriginal, creds.usuario, creds.senha);
            log(`✅ Renovação enviada: ${c.email}`);
          } catch (e) {
            log(`❌ Falha ao renovar ${c.email}: ${e.message}`);
          }
        }
      } catch (e) {
        log(`❌ Erro ao criar conta de renovação: ${e.message}`);
        conta.ativa = true; // restaura para tentar novamente
      }
    }

    salvarPool();
  }
}

setInterval(verificarRenovacoes, 60 * 60 * 1000); // a cada hora
// ============================================================
// DASHBOARD HTML
// ============================================================
const dashboard = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🎬 Hora do Filme — Painel</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0e1a;
    --card: #111827;
    --border: #1f2937;
    --accent: #6366f1;
    --accent2: #8b5cf6;
    --green: #10b981;
    --red: #ef4444;
    --yellow: #f59e0b;
    --text: #f1f5f9;
    --muted: #64748b;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }

  header {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
    border-bottom: 1px solid var(--border);
    padding: 16px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(12px);
  }
  .logo { display: flex; align-items: center; gap: 12px; }
  .logo-icon { font-size: 32px; }
  .logo-text h1 { font-size: 20px; font-weight: 700; background: linear-gradient(135deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .logo-text p { font-size: 12px; color: var(--muted); }
  .status-badge {
    display: flex; align-items: center; gap: 8px;
    background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3);
    color: var(--green); padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600;
  }
  .pulse { width: 8px; height: 8px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.3)} }

  main { padding: 24px 32px; max-width: 1400px; margin: 0 auto; }

  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media(max-width:1024px){ .grid-4{grid-template-columns:repeat(2,1fr)} }
  @media(max-width:640px){ .grid-4{grid-template-columns:1fr} .grid-2{grid-template-columns:1fr} }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    transition: border-color .2s;
  }
  .card:hover { border-color: #374151; }
  .card-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
  .card-value { font-size: 36px; font-weight: 700; line-height: 1; }
  .card-sub { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .card-icon { font-size: 28px; float: right; margin-top: -4px; }

  .stat-green .card-value { color: var(--green); }
  .stat-red   .card-value { color: var(--red); }
  .stat-yellow .card-value { color: var(--yellow); }
  .stat-purple .card-value { color: #a78bfa; }

  .section-title {
    font-size: 14px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .05em;
    margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }

  /* Tabela */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 14px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  td { padding: 12px 14px; border-bottom: 1px solid #1a2234; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }

  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
  }
  .badge-green { background: rgba(16,185,129,.15); color: var(--green); border: 1px solid rgba(16,185,129,.3); }
  .badge-red   { background: rgba(239,68,68,.15);  color: var(--red);   border: 1px solid rgba(239,68,68,.3); }
  .badge-yellow { background: rgba(245,158,11,.15); color: var(--yellow); border: 1px solid rgba(245,158,11,.3); }

  /* Log */
  .log-box {
    background: #060b14;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    height: 320px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.7;
  }
  .log-line { color: #94a3b8; }
  .log-line.ok  { color: var(--green); }
  .log-line.err { color: var(--red); }
  .log-line.warn { color: var(--yellow); }
  .log-line.info { color: #818cf8; }

  /* Ações */
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
  button {
    cursor: pointer; border: none; border-radius: 8px; padding: 10px 18px;
    font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px;
    transition: all .15s;
  }
  .btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; }
  .btn-primary:hover { opacity: .85; transform: translateY(-1px); }
  .btn-secondary { background: var(--card); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { border-color: #374151; background: #1a2234; }
  .btn-danger { background: rgba(239,68,68,.1); color: var(--red); border: 1px solid rgba(239,68,68,.3); }
  .btn-danger:hover { background: rgba(239,68,68,.2); }

  /* Modal reenvio */
  .modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.7); backdrop-filter: blur(4px);
    z-index: 999; align-items: center; justify-content: center;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 28px; width: 420px; max-width: 95vw;
  }
  .modal h2 { font-size: 16px; margin-bottom: 16px; }
  .modal input, .modal select {
    width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: 10px 14px;
    font-size: 13px; margin-bottom: 12px; outline: none;
  }
  .modal input:focus, .modal select:focus { border-color: var(--accent); }
  .modal label { font-size: 12px; color: var(--muted); margin-bottom: 4px; display: block; }
  .modal-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }

  /* Planos chart */
  .planos-list { display: flex; flex-direction: column; gap: 10px; }
  .plano-item { display: flex; flex-direction: column; gap: 4px; }
  .plano-header { display: flex; justify-content: space-between; font-size: 12px; }
  .plano-name { color: var(--text); }
  .plano-count { color: var(--muted); }
  .plano-bar { height: 6px; background: var(--border); border-radius: 999px; overflow: hidden; }
  .plano-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 999px; transition: width .6s ease; }

  .uptime { font-size: 11px; color: var(--muted); }
  .empty { color: var(--muted); font-size: 13px; text-align: center; padding: 24px; }

  /* Detalhe do cliente */
  .detalhe-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .detalhe-label { font-size: 12px; color: var(--muted); white-space: nowrap; padding-top: 2px; }
  .detalhe-val { font-size: 13px; text-align: right; word-break: break-all; }
  .cred-row { background: rgba(99,102,241,.07); border-radius: 8px; padding: 8px 12px; }
  tr[onclick]:hover td { background: rgba(99,102,241,.07) !important; }

  /* Toast */
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 18px; font-size: 13px;
    display: flex; align-items: center; gap: 8px;
    animation: slideIn .3s ease; z-index: 9999;
    max-width: 320px;
  }
  @keyframes slideIn { from{transform:translateX(100px);opacity:0} to{transform:translateX(0);opacity:1} }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">🎬</div>
    <div class="logo-text">
      <h1>Hora do Filme</h1>
      <p>Painel de Automação</p>
    </div>
  </div>
  <div class="status-badge">
    <div class="pulse"></div>
    <span id="statusText">Online</span>
  </div>
</header>

<main>
  <!-- Cards de métricas -->
  <div class="grid-4">
    <div class="card stat-green">
      <div class="card-icon">✅</div>
      <div class="card-label">Vendas com Sucesso</div>
      <div class="card-value" id="totalSucesso">0</div>
      <div class="card-sub">Total processado</div>
    </div>
    <div class="card stat-purple">
      <div class="card-icon">📅</div>
      <div class="card-label">Vendas Hoje</div>
      <div class="card-value" id="vendasHoje">0</div>
      <div class="card-sub" id="dataHoje">—</div>
    </div>
    <div class="card stat-yellow">
      <div class="card-icon">⏳</div>
      <div class="card-label">Na Fila</div>
      <div class="card-value" id="naFila">0</div>
      <div class="card-sub" id="filaStatus">Aguardando vendas</div>
    </div>
    <div class="card stat-red">
      <div class="card-icon">❌</div>
      <div class="card-label">Erros</div>
      <div class="card-value" id="totalErros">0</div>
      <div class="card-sub">Total de falhas</div>
    </div>
  </div>

  <!-- Ações rápidas -->
  <div class="actions">
    <button class="btn-primary" onclick="abrirModalReenvio()">
      📧 Reenviar Email Manualmente
    </button>
    <button class="btn-secondary" onclick="reconectar()">
      🔄 Reconectar Tiger
    </button>
    <button class="btn-secondary" onclick="limparLogs()">
      🗑️ Limpar Logs
    </button>
    <button class="btn-secondary" onclick="exportarHistorico()">
      📥 Exportar CSV
    </button>
  </div>

  <!-- Grid principal -->
  <div class="grid-2">
    <!-- Histórico de vendas -->
    <div class="card">
      <div class="section-title"><div class="dot"></div> Últimas Vendas</div>
      <div class="table-wrap" style="max-height:480px;overflow-y:auto;">
        <table>
          <thead style="position:sticky;top:0;background:var(--card);z-index:1;">
            <tr>
              <th>Cliente</th>
              <th>Plano</th>
              <th>Horário</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="tabelaVendas">
            <tr><td colspan="4" class="empty">Nenhuma venda processada ainda</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Coluna direita -->
    <div style="display:flex;flex-direction:column;gap:16px">
      <!-- Status do sistema -->
      <div class="card">
        <div class="section-title"><div class="dot"></div> Status do Sistema</div>
        <table>
          <tbody>
            <tr>
              <td style="color:var(--muted);font-size:13px">Tiger</td>
              <td><span class="badge" id="tigerBadge">—</span></td>
            </tr>
            <tr>
              <td style="color:var(--muted);font-size:13px">Brevo (Email)</td>
              <td><span class="badge badge-green">✓ Configurado</span></td>
            </tr>
            <tr>
              <td style="color:var(--muted);font-size:13px">Webhook</td>
              <td><span class="badge badge-green">✓ Ativo</span></td>
            </tr>
            <tr>
              <td style="color:var(--muted);font-size:13px">Processando</td>
              <td><span class="badge" id="processandoBadge">—</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Vendas por plano -->
      <div class="card">
        <div class="section-title"><div class="dot"></div> Vendas por Plano</div>
        <div class="planos-list" id="planosList">
          <div class="empty">Sem dados ainda</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Log em tempo real -->
  <div class="card">
    <div class="section-title" style="margin-bottom:12px">
      <div class="dot"></div> Log em Tempo Real
      <span style="margin-left:auto;font-size:11px;color:var(--muted)" id="logCount">0 linhas</span>
    </div>
    <div class="log-box" id="logBox"></div>
  </div>
</main>

<!-- Modal detalhe do cliente -->
<div class="modal-overlay" id="modalDetalhe">
  <div class="modal" style="width:480px">
    <h2>👤 Detalhes do Cliente</h2>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:4px">
      <div class="detalhe-row"><span class="detalhe-label">Nome</span><span id="detalhe-nome" class="detalhe-val"></span></div>
      <div class="detalhe-row"><span class="detalhe-label">Email</span><span id="detalhe-email" class="detalhe-val"></span></div>
      <div class="detalhe-row"><span class="detalhe-label">Plano</span><span id="detalhe-plano" class="detalhe-val"></span></div>
      <div class="detalhe-row"><span class="detalhe-label">Horário</span><span id="detalhe-hora" class="detalhe-val"></span></div>
      <div class="detalhe-row"><span class="detalhe-label">Status</span><span id="detalhe-status" class="detalhe-val"></span></div>
      <div style="border-top:1px solid var(--border);margin:4px 0"></div>
      <div class="detalhe-row cred-row">
        <span class="detalhe-label">Usuário Tiger</span>
        <span id="detalhe-usuario" class="detalhe-val" style="font-family:monospace;font-size:15px;color:#818cf8;font-weight:700"></span>
      </div>
      <div class="detalhe-row cred-row">
        <span class="detalhe-label">Senha Tiger</span>
        <span id="detalhe-senha" class="detalhe-val" style="font-family:monospace;font-size:15px;color:#818cf8;font-weight:700"></span>
      </div>
      <div class="detalhe-row" id="detalhe-erro-row" style="display:none">
        <span class="detalhe-label">Erro</span>
        <span id="detalhe-erro" class="detalhe-val" style="color:var(--red);font-size:12px"></span>
      </div>
    </div>
    <div class="modal-footer" style="margin-top:20px">
      <button class="btn-secondary" onclick="document.getElementById('modalDetalhe').classList.remove('open')">Fechar</button>
    </div>
  </div>
</div>

<!-- Modal reenvio de email -->
<div class="modal-overlay" id="modalReenvio">
  <div class="modal">
    <h2>📧 Reenviar Email de Acesso</h2>
    <label>Email do cliente</label>
    <input type="email" id="reenvioEmail" placeholder="cliente@email.com">
    <label>Nome do cliente</label>
    <input type="text" id="reenvioNome" placeholder="Nome Completo">
    <label>Plano</label>
    <select id="reenvioPlano">
      <option value="Hora do Filme [1 MÊS]">Hora do Filme [1 MÊS]</option>
      <option value="Hora do Filme [3 MESES]">Hora do Filme [3 MESES]</option>
      <option value="Hora do Filme [6 MESES]">Hora do Filme [6 MESES]</option>
      <option value="Hora do Filme [ANUAL]">Hora do Filme [ANUAL]</option>
      <option value="Hora do Filme [PLUS]">Hora do Filme [PLUS]</option>
    </select>
    <div class="modal-footer">
      <button class="btn-secondary" onclick="fecharModalReenvio()">Cancelar</button>
      <button class="btn-primary" onclick="enviarReenvio()">Criar Acesso e Enviar</button>
    </div>
  </div>
</div>

<script>
let dados = {};
let logLines = [];
let autoScroll = true;

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
}

function classificarLog(linha) {
  if (linha.includes('✅') || linha.includes('Sessão Tiger iniciada')) return 'ok';
  if (linha.includes('❌') || linha.includes('falhou') || linha.includes('Falha')) return 'err';
  if (linha.includes('⚠️') || linha.includes('renovando')) return 'warn';
  if (linha.includes('🔄') || linha.includes('▶') || linha.includes('📥') || linha.includes('Bot iniciado')) return 'info';
  return '';
}

function renderLogs(linhas) {
  const box = document.getElementById('logBox');
  box.innerHTML = linhas.map(l =>
    '<div class="log-line ' + classificarLog(l) + '">' + escHtml(l) + '</div>'
  ).join('');
  if (autoScroll) box.scrollTop = box.scrollHeight;
  document.getElementById('logCount').textContent = linhas.length + ' linhas';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let historicoCache = [];

function renderTabela(hist) {
  historicoCache = hist || [];
  const tbody = document.getElementById('tabelaVendas');
  if (!hist || hist.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Nenhuma venda processada ainda</td></tr>';
    return;
  }
  tbody.innerHTML = hist.map((v, i) => {
    const badge = v.status === 'sucesso'
      ? '<span class="badge badge-green">✓ OK</span>'
      : '<span class="badge badge-red">✗ Erro</span>';
    const nome = escHtml(v.nomeCliente || '—');
    const plano = escHtml(v.nomeProduto || '—');
    const hora = fmt(v.timestamp);
    return '<tr style="cursor:pointer" onclick="abrirDetalheCliente(' + i + ')" title="Ver detalhes"><td><div>' + nome + '</div><div style="font-size:11px;color:var(--muted)">' + escHtml(v.emailCliente||'') + '</div></td><td>' + plano + '</td><td>' + hora + '</td><td>' + badge + '</td></tr>';
  }).join('');
}

function abrirDetalheCliente(idx) {
  const v = historicoCache[idx];
  if (!v) return;
  document.getElementById('detalhe-nome').textContent   = v.nomeCliente || '—';
  document.getElementById('detalhe-email').textContent  = v.emailCliente || '—';
  document.getElementById('detalhe-plano').textContent  = v.nomeProduto || '—';
  document.getElementById('detalhe-hora').textContent   = fmt(v.timestamp);
  document.getElementById('detalhe-status').textContent = v.status === 'sucesso' ? '✓ Sucesso' : '✗ Erro';
  document.getElementById('detalhe-status').style.color = v.status === 'sucesso' ? 'var(--green)' : 'var(--red)';
  document.getElementById('detalhe-usuario').textContent = v.usuario || '—';
  document.getElementById('detalhe-senha').textContent   = v.senha || '—';
  document.getElementById('detalhe-erro').textContent   = v.erro || '';
  document.getElementById('detalhe-erro-row').style.display = v.erro ? 'flex' : 'none';
  document.getElementById('modalDetalhe').classList.add('open');
}

function renderPlanos(hist) {
  if (!hist || hist.length === 0) return;
  const contagem = {};
  hist.forEach(v => {
    if (v.status === 'sucesso') contagem[v.nomeProduto] = (contagem[v.nomeProduto]||0) + 1;
  });
  const total = Object.values(contagem).reduce((a,b)=>a+b,0) || 1;
  const lista = document.getElementById('planosList');
  const items = Object.entries(contagem).sort((a,b)=>b[1]-a[1]);
  if (items.length === 0) { lista.innerHTML = '<div class="empty">Sem dados ainda</div>'; return; }
  lista.innerHTML = items.map(([nome, qty]) => {
    const pct = Math.round((qty/total)*100);
    return '<div class="plano-item"><div class="plano-header"><span class="plano-name">' + escHtml(nome) + '</span><span class="plano-count">' + qty + ' (' + pct + '%)</span></div><div class="plano-bar"><div class="plano-fill" style="width:' + pct + '%"></div></div></div>';
  }).join('');
}

async function atualizar() {
  try {
    const [status, hist, logs] = await Promise.all([
      fetch('/api/status').then(r=>r.json()),
      fetch('/api/historico').then(r=>r.json()),
      fetch('/api/logs').then(r=>r.json())
    ]);

    // Cards
    const sucesso = hist.filter(v=>v.status==='sucesso').length;
    const erros   = hist.filter(v=>v.status==='erro').length; // 'resolvido' não conta
    const hoje = new Date().toDateString();
    const hojeCount = hist.filter(v=>v.status==='sucesso'&&new Date(v.timestamp).toDateString()===hoje).length;

    document.getElementById('totalSucesso').textContent = sucesso;
    document.getElementById('totalErros').textContent = erros;
    document.getElementById('naFila').textContent = status.vendasNaFila || 0;
    document.getElementById('vendasHoje').textContent = hojeCount;
    document.getElementById('dataHoje').textContent = new Date().toLocaleDateString('pt-BR');
    document.getElementById('filaStatus').textContent = status.processando ? '⚡ Processando agora' : 'Aguardando vendas';

    // Tiger badge
    const hb = document.getElementById('tigerBadge');
    if (status.sessaoTiger === 'ativa') {
      hb.className = 'badge badge-green'; hb.textContent = '✓ Conectado';
    } else {
      hb.className = 'badge badge-red'; hb.textContent = '✗ Desconectado';
    }

    // Processando badge
    const pb = document.getElementById('processandoBadge');
    if (status.processando) {
      pb.className = 'badge badge-yellow'; pb.textContent = '⚡ Sim';
    } else {
      pb.className = 'badge badge-green'; pb.textContent = '✓ Livre';
    }

    renderTabela(hist);
    renderPlanos(hist);
    renderLogs(logs);
  } catch(e) {
    console.error(e);
  }
}

// SSE para logs em tempo real
function conectarSSE() {
  const es = new EventSource('/logs/stream');
  es.onmessage = e => {
    const linha = JSON.parse(e.data);
    logLines.push(linha);
    if (logLines.length > 200) logLines.shift();
    renderLogs(logLines);
  };
  es.onerror = () => { setTimeout(conectarSSE, 3000); };
}

// Modal reenvio
function abrirModalReenvio() {
  document.getElementById('modalReenvio').classList.add('open');
}
function fecharModalReenvio() {
  document.getElementById('modalReenvio').classList.remove('open');
}
document.getElementById('modalReenvio').addEventListener('click', e => {
  if (e.target === e.currentTarget) fecharModalReenvio();
});

async function enviarReenvio() {
  const email = document.getElementById('reenvioEmail').value.trim();
  const nome  = document.getElementById('reenvioNome').value.trim() || 'Cliente';
  const plano = document.getElementById('reenvioPlano').value;

  if (!email) { toast('⚠️ Preencha o email do cliente', 'warn'); return; }

  const btn = document.querySelector('#modalReenvio .btn-primary');
  btn.textContent = '⏳ Criando acesso...';
  btn.disabled = true;

  try {
    const r = await fetch('/api/reenviar', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, nome, plano })
    });
    const d = await r.json();
    if (d.ok) { toast('✅ Acesso criado e email enviado!', 'ok'); fecharModalReenvio(); }
    else       { toast('❌ Erro: ' + d.erro, 'err'); }
  } catch(e) { toast('❌ Falha na requisição', 'err'); }
  finally {
    btn.textContent = 'Criar Acesso e Enviar';
    btn.disabled = false;
  }
}

async function reconectar() {
  toast('🔄 Reconectando ao Tiger...', 'info');
  try {
    const r = await fetch('/api/reconectar', { method: 'POST' });
    const d = await r.json();
    if (d.ok) toast('✅ Reconectado com sucesso!', 'ok');
    else      toast('❌ Falha: ' + d.erro, 'err');
  } catch(e) { toast('❌ Falha na requisição', 'err'); }
}

function limparLogs() {
  logLines = [];
  renderLogs([]);
}

function exportarHistorico() {
  fetch('/api/historico').then(r=>r.json()).then(hist => {
    const linhas = ['Data,Nome,Email,Plano,Usuario,Status'];
    hist.forEach(v => {
      linhas.push([
        new Date(v.timestamp).toLocaleString('pt-BR'),
        '"'+( v.nomeCliente||'').replace(/"/g,'""')+'"',
        v.emailCliente||'',
        '"'+(v.nomeProduto||'').replace(/"/g,'""')+'"',
        v.usuario||'',
        v.status
      ].join(','));
    });
    const blob = new Blob([linhas.join('\\n')], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vendas_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    toast('📥 CSV exportado!', 'ok');
  });
}

function toast(msg, tipo) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = tipo==='ok'?'rgba(16,185,129,.4)':tipo==='err'?'rgba(239,68,68,.4)':tipo==='warn'?'rgba(245,158,11,.4)':'var(--border)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

document.getElementById('modalDetalhe').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// Inicialização
atualizar();
conectarSSE();
setInterval(atualizar, 5000);
</script>
</body>
</html>`;
// ============================================================
// ROTAS
// ============================================================
const app = express();
app.use(express.json());

// Autenticação básica — protege o painel e a API (o /webhook fica de fora,
// pois já é validado pelo WEBHOOK_SECRET da Kirvano)
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Hora do Filme"');
  return res.status(401).send('Autenticação necessária');
});

// Dashboard HTML
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(dashboard);
});

// Status JSON
app.get('/api/status', (req, res) => {
  res.json({
    bot: 'HoraDoFilme',
    status: 'online',
    sessaoTiger: sessao ? 'ativa' : 'inativa',
    vendasNaFila: fila.length,
    processando,
    uptime: process.uptime()
  });
});

// Histórico de vendas
app.get('/api/historico', (req, res) => {
  res.json(historico);
});

// Logs recentes
app.get('/api/logs', (req, res) => {
  res.json(logBuffer);
});

// SSE — log em tempo real
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Envia buffer atual
  logBuffer.forEach(l => res.write(`data: ${JSON.stringify(l)}\n\n`));

  sseClients.push(res);
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i >= 0) sseClients.splice(i, 1);
  });
});

// Entrega manual — usa pool (mesma lógica da venda automática)
app.post('/api/reenviar', async (req, res) => {
  const { email, nome, plano } = req.body;
  if (!email || !plano) return res.json({ ok: false, erro: 'Campos obrigatórios: email e plano' });

  const nomeProduto = plano;
  const meses = MESES_POR_PLANO[nomeProduto.trim().toLowerCase()];
  if (!meses) return res.json({ ok: false, erro: `Plano não reconhecido: "${nomeProduto}"` });

  try {
    log(`📋 Entrega manual: ${nome || 'Cliente'} <${email}> — ${nomeProduto}`);

    const clienteDados = { nome: nome || 'Cliente', email, planoOriginal: nomeProduto, totalMeses: meses, mesesRestantes: meses - 1 };
    let usuario, senha;
    const slot = contaComSlot();

    if (slot) {
      usuario = slot.usuario;
      senha   = slot.senha;
      slot.clientes.push(clienteDados);
      salvarPool();
      log(`♻️ Reusando conta ${usuario}`);
    } else {
      const creds = await criarCliente(PACKAGE_ID_MENSAL);
      usuario = creds.usuario;
      senha   = creds.senha;
      novaEntradaPool(usuario, senha, clienteDados);
    }

    await enviarEmail(email, nome || 'Cliente', nomeProduto, usuario, senha);

    // Marca erros anteriores desse email como resolvidos (remove do contador de erros)
    historico.forEach(v => {
      if (v.emailCliente === email && v.status === 'erro') {
        v.status = 'resolvido';
      }
    });
    salvarHistorico();

    registrarVenda({ id: Date.now(), timestamp: new Date().toISOString(), nomeCliente: nome || 'Cliente', emailCliente: email, nomeProduto, usuario, senha, status: 'sucesso', erro: null });
    log(`✅ Entrega manual concluída: ${email} — usuário ${usuario}`);
    res.json({ ok: true, usuario, senha });
  } catch (err) {
    log(`❌ Falha na entrega manual para ${email}: ${err.message}`);
    res.json({ ok: false, erro: err.message });
  }
});

// Pool — visualização do estado atual
app.get('/api/pool', (req, res) => {
  const ativas = pool.filter(c => c.ativa);
  res.json({
    totalContas: ativas.length,
    slotsLivres: ativas.filter(c => c.clientes.length < 2).length,
    contas: ativas.map(c => ({
      usuario: c.usuario,
      dataExpiracao: c.dataExpiracao,
      slots: `${c.clientes.length}/2`,
      clientes: c.clientes.map(cl => ({ nome: cl.nome, email: cl.email, plano: cl.planoOriginal, mesesRestantes: cl.mesesRestantes }))
    }))
  });
});

// Reconectar Tiger
app.post('/api/reconectar', async (req, res) => {
  try {
    await invalidarSessao();
    await iniciarSessao();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

// Webhook Kirvano
app.post('/webhook', (req, res) => {
  try {
    const body  = req.body;
    const evento = body.event || '';

    const eventosAprovados = ['SALE_APPROVED', 'PURCHASE_APPROVED', 'COMPRA_APROVADA'];
    if (evento && !eventosAprovados.includes(evento)) {
      log(`Evento ignorado: ${evento}`);
      return res.json({ status: 'ignorado', evento });
    }

    // Validação de segredo (opcional — configure WEBHOOK_SECRET no Railway)
    if (WEBHOOK_SECRET) {
      const segredo = req.headers['x-webhook-secret'] || req.query.secret || '';
      if (segredo !== WEBHOOK_SECRET) {
        log(`⚠️  Webhook recusado: segredo inválido`);
        return res.status(401).json({ status: 'não autorizado' });
      }
    }

    const produto     = body.products?.find(p => !p.is_order_bump) || body.products?.[0];
    const nomeProdutoRaw = produto?.offer_name || produto?.checkout_name || produto?.name || body.product_name || '';
    const nomeProduto    = nomeProdutoRaw.trim();
    const emailCliente   = body.customer?.email || body.customer_email || '';
    const nomeCliente    = body.customer?.name  || body.customer_name  || 'Cliente';

    log(`\n=== NOVA VENDA ===`);
    log(`Evento: ${evento || 'SALE_APPROVED'}`);
    log(`Plano: ${nomeProduto}`);
    log(`Cliente: ${nomeCliente} <${emailCliente}>`);

    if (!emailCliente) {
      return res.status(400).json({ status: 'erro', mensagem: 'Email do cliente não encontrado no webhook' });
    }

    // Valida se o plano é reconhecido
    const mesesPlano = MESES_POR_PLANO[nomeProduto.toLowerCase()];
    if (!mesesPlano) {
      log(`❌ Plano não reconhecido: "${nomeProduto}"`);
      log(`Planos configurados: ${Object.keys(MESES_POR_PLANO).join(' | ')}`);
      return res.status(400).json({
        status: 'erro',
        mensagem: `Plano não reconhecido: "${nomeProduto}"`,
        planosDisponiveis: Object.keys(MESES_POR_PLANO)
      });
    }

    res.json({ status: 'recebido', posicaoNaFila: fila.length + 1 });
    adicionarNaFila({ emailCliente, nomeCliente, nomeProduto });

  } catch (err) {
    log(`❌ Erro no webhook: ${err.message}`);
    res.status(500).json({ status: 'erro', mensagem: err.message });
  }
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
app.listen(PORT, async () => {
  log(`\n🎬 Hora do Filme Bot iniciado na porta ${PORT}`);
  log(`Planos configurados: ${Object.keys(MESES_POR_PLANO).join(' | ')}`);
  carregarPool();
  carregarHistorico();
  verificarRenovacoes().catch(() => {});

  try {
    await iniciarSessao();
  } catch (err) {
    log(`⚠️  Sessão pré-aquecida falhou: ${err.message}`);
    log('A sessão será criada na primeira venda.\n');
  }
});

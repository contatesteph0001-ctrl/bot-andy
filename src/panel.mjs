import { Router } from 'express'
import express from 'express'
import bcrypt from 'bcryptjs'
import {
  getAgendamentosDia, getFaturamentoDia, getHistoricoCliente,
  getProdutosEmEstoque, getAllConfigs, setConfig, getConfig,
  atualizarEstoque, cancelarAgendamento, getServicosAtivos,
  updateServico, getDb,
  criarProduto, deletarProduto, updateProduto,
  criarServico, deletarServico, getServicoById,
  getAgendamentosAguardandoSinal, aprovarSinal, getAgendamento,
  enfileirarMensagem, getMetricasDiarias,
  getBarbeiros, getBarbeiroById,
  calcularComissaoPeriodo, getFechamentosByBarbeiro,
  updateBarbeiro, getComissaoOverrides, setComissaoOverride,
  criarFechamento, getFechamentosAbertos, registrarPagamentoFechamento,
  criarDespesa, getDespesas, deletarDespesa, getFechamentoDetalhe,
  confirmarPresenca, marcarNaoCompareceu,
  moverAgendamentoKanban, getAgendamentosKanban,
  getOuCriarCaixaDia, definirFundoInicial, registrarPagamentoCaixa,
  estornarPagamentoCaixa, getResumoCaixaDia, fecharCaixaDia,
  reabrirCaixaDia,   listarCaixas, registrarVendaProdutoAvulsa,
  getUsuarioPorUsername, getUsuarioPorStaffId, getUsuarioPorId, atualizarSenhaUsuario,
} from './db.mjs'
import { deleteEvent, createEvent, findFreeSlots } from './calendar.mjs'
import { criarAgendamentoTool } from './tools.mjs'
import { staff, schedule } from './config.mjs'
import { log } from './logger.mjs'
import { isoBRT } from './time.mjs'
import { M } from './messages.mjs'
import { redirectPosLogin, verificarSenha } from './auth.mjs'

const router = Router()
const receptionRouter = Router()
const barbeiroRouter = Router()

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ESTOQUE_MINIMO_PADRAO = 3

/** Nome do barbeiro: usuarios (fonte única) → fallback config.mjs */
function staffNameById(id) {
  const u = getUsuarioPorStaffId(id)
  if (u?.nome) return u.nome
  return staff.find(s => s.id === id)?.name || id
}

// Garante tabela de histórico de estoque
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id TEXT NOT NULL,
      produto_nome TEXT,
      quantidade_anterior INTEGER,
      quantidade_nova INTEGER,
      delta INTEGER,
      origem TEXT DEFAULT 'painel',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
} catch (e) { /* tabela já existe */ }

// ── Helpers ───────────────────────────────────────────────────────
function formatHora(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
}

function formatData(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })
}

/** Extrai HH:MM de ISO8601 no fuso America/Sao_Paulo (para inputs type=time). */
function isoParaHorarioInput(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo',
  })
}

/** Slots passados sem agendamento — só dia atual, intervalo 30 min. */
function gerarSlotsFantasmaAgendaHoje(data, ags) {
  if (data !== hojeStr()) return []
  const abertura = getConfig('horario_abertura') || '08:00'
  const fechamento = getConfig('horario_fechamento') || '22:00'
  const [aH, aM] = abertura.split(':').map(Number)
  const [cH, cM] = fechamento.split(':').map(Number)
  const agoraMs = Date.now()
  const fantasmas = []
  let h = aH
  let m = aM

  while (h < cH || (h === cH && m < cM)) {
    const slotIso = `${data}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`
    const slotMs = new Date(slotIso).getTime()
    if (slotMs > agoraMs) break

    const ocupado = ags.some((ag) => {
      if (ag.status === 'cancelado') return false
      const ini = new Date(ag.data_hora_inicio).getTime()
      const fim = new Date(ag.data_hora_fim).getTime()
      return slotMs >= ini && slotMs < fim
    })

    if (!ocupado) {
      fantasmas.push({ tipo: 'ghost', sortMs: slotMs, hora: formatHora(slotIso) })
    }

    m += 30
    while (m >= 60) { h += 1; m -= 60 }
  }
  return fantasmas
}

function hojeStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) // TZ-FIX: hoje em BRT
}

/** Categorias sugeridas para despesas (schema aceita texto livre). */
const CATEGORIAS_DESPESA = ['outros', 'aluguel', 'marketing', 'materiais', 'pessoal', 'utilidades', 'impostos']

const FORMAS_LABEL_SERVER = {
  pix: 'PIX',
  dinheiro: 'Dinheiro',
  debito: 'Cartão Débito',
  credito: 'Cartão Crédito',
}

function formatDataHoraPainel(sqliteDt) {
  if (!sqliteDt) return '—'
  const s = String(sqliteDt).trim()
  const asIso = /^\d{4}-\d{2}-\d{2} \d/.test(s)
    ? `${s.replace(' ', 'T')}-03:00`
    : s
  try {
    const d = new Date(asIso)
    if (Number.isNaN(d.getTime())) return s
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
  } catch {
    return s
  }
}

function initials(nome) {
  if (!nome) return '?'
  return nome.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
}

function badge(status) {
  const map = {
    confirmado: ['rgba(34,197,94,.12)', '#4ade80', 'Confirmado'],
    cancelado:  ['rgba(239,68,68,.12)', '#f87171', 'Cancelado'],
    concluido:  ['rgba(96,165,250,.12)', '#93c5fd', 'Concluído'],
    no_show:    ['rgba(251,146,60,.12)', '#fb923c', 'No-show'],
  }
  const [bg, color, label] = map[status] || ['rgba(255,255,255,.06)', '#999', status]
  return `<span style="background:${bg};color:${color};padding:.2rem .75rem;border-radius:20px;font-size:.68rem;font-weight:600;letter-spacing:.5px;text-transform:uppercase;white-space:nowrap">${label}</span>`
}

function getFaturamentoPeriodo(tipo) {
  const db = getDb()
  let whereDate
  if (tipo === 'semana') {
    whereDate = `date(data_hora_inicio, 'localtime') >= date('now', '-6 days', 'localtime')`
  } else if (tipo === 'mes') {
    whereDate = `strftime('%Y-%m', data_hora_inicio) = strftime('%Y-%m', 'now', 'localtime')`
  } else {
    whereDate = `strftime('%Y', data_hora_inicio) = strftime('%Y', 'now', 'localtime')`
  }
  return db.prepare(`
    SELECT
      date(a.data_hora_inicio, 'localtime') as dia,
      SUM(CASE WHEN a.status != 'cancelado' THEN COALESCE(s.preco, 0) ELSE 0 END) as total,
      COUNT(CASE WHEN a.status != 'cancelado' THEN 1 END) as atendimentos
    FROM agendamentos a
    LEFT JOIN servicos s ON s.id = a.servico_id
    WHERE ${whereDate.replace(/data_hora_inicio/g, 'a.data_hora_inicio')}
    GROUP BY dia
    ORDER BY dia ASC
  `).all()
}

// ── SVG Icons ─────────────────────────────────────────────────────
const ic = {
  cal:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  money: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  users: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  box:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  cut:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
  gear:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>`,
  plus:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  back:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
  lock:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  chart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  warn:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  menu:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
}

// ── CSS ───────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#000000;--surface:#0a0a0a;--elevated:#111111;--hover:#1a1a1a;--active:#222222;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.12);
  --white:#f0ece4;--muted:#888;--muted2:#444;

  --red:#cc1f1f;--red-l:#e53535;--red-dim:rgba(204,31,31,0.12);--red-dim2:rgba(204,31,31,0.06);
  --blue:#2563eb;--blue-l:#3b82f6;--blue-dim:rgba(37,99,235,0.12);

  --green:#22c55e;--green-dim:rgba(34,197,94,0.1);
  --amber:#f59e0b;--amber-dim:rgba(245,158,11,0.1);
  --red-sem:#ef4444;--red-sem-dim:rgba(239,68,68,0.1);

  --sidebar-w:220px;--radius:10px;--radius-sm:7px;--tr:.18s cubic-bezier(.4,0,.2,1);
}
html,body{height:100%;background:var(--bg);color:var(--white);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-size:15px;line-height:1.5}
.layout{display:flex;height:100vh;overflow:hidden}

/* ── SIDEBAR ── */
.sidebar{
  width:var(--sidebar-w);flex-shrink:0;background:var(--surface);
  border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto
}
.sidebar-logo{padding:20px 18px 14px;border-bottom:1px solid rgba(255,255,255,0.05)}
.sidebar-logo img{height:36px;width:auto;object-fit:contain;display:block}
.nav{padding:14px 10px;flex:1;display:flex;flex-direction:column;gap:2px}
.nav-label{padding:.6rem 1.25rem .25rem;font-size:.62rem;color:var(--muted2);text-transform:uppercase;letter-spacing:1.5px;font-weight:600}
.nav-item{
  display:flex;align-items:center;gap:.7rem;padding:.65rem .75rem;
  color:var(--muted);text-decoration:none;font-size:.84rem;font-weight:500;
  border-left:2px solid transparent;border-radius:8px;transition:var(--tr);margin:0;
  padding-left:.75rem
}
.nav-item:hover{color:var(--white);background:rgba(255,255,255,0.03);border-left-color:var(--border2)}
.nav-item.active{
  color:var(--red);background:var(--red-dim2);border-left-color:var(--red);font-weight:600;
  padding-left:calc(.75rem - 0px)
}
.nav-item svg{flex-shrink:0;opacity:.7}
.nav-item.active svg,.nav-item:hover svg{opacity:1}
.barber-stripe{
  height:3px;
  background:repeating-linear-gradient(90deg,#cc1f1f 0px,#cc1f1f 16px,#ffffff 16px,#ffffff 32px,#2563eb 32px,#2563eb 48px);
  opacity:.5;margin-bottom:.75rem;border-radius:2px
}
.sidebar-footer{
  padding:.9rem 1rem;border-top:1px solid rgba(255,255,255,0.05);
  font-size:.74rem;color:var(--muted);display:flex;align-items:center;gap:.5rem
}
.nav-label-finance{padding:.85rem 1.25rem .35rem;margin-top:.5rem;border-top:1px solid rgba(255,255,255,0.06)}
.pulse{
  width:6px;height:6px;background:var(--green);border-radius:50%;flex-shrink:0;
  box-shadow:0 0 0 0 rgba(34,197,94,.4),0 0 6px rgba(34,197,94,0.6);animation:pulse 2s infinite
}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.4),0 0 6px rgba(34,197,94,0.6)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0),0 0 6px rgba(34,197,94,0.6)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0),0 0 6px rgba(34,197,94,0.6)}}

/* ── MAIN ── */
.main{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-width:0}
.topbar{
  padding:22px 32px;border-bottom:1px solid var(--border);
  background:#000;
  display:flex;align-items:center;justify-content:space-between;
  position:sticky;top:0;z-index:20
}
.topbar-left h1{font-size:1.5rem;font-weight:700;color:var(--white);letter-spacing:-.02em}
.topbar-left p{font-size:.81rem;color:var(--muted);margin-top:.2rem}
.topbar-right{display:flex;gap:.5rem;align-items:center}
.content{padding:24px 32px;flex:1}

/* ── STATS ── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1.5rem}
.stat{
  background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.1rem 1.25rem;position:relative;overflow:hidden;transition:var(--tr);cursor:default
}
.stat:hover{border-color:var(--border2);transform:translateY(-1px)}
.stat-icon{
  width:30px;height:30px;border-radius:8px;display:flex;align-items:center;
  justify-content:center;margin-bottom:.85rem
}
.stat-icon.red{background:var(--red-dim);color:var(--red)}
.stat-icon.green{background:var(--green-dim);color:var(--green)}
.stat-icon.blue{background:var(--blue-dim);color:var(--blue-l)}
.stat-icon.amber{background:var(--amber-dim);color:var(--amber)}
.stat-val{font-size:1.55rem;font-weight:700;letter-spacing:-.5px;line-height:1;color:var(--white)}
.stat-lbl{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-top:.35rem;font-weight:500}
.stat-accent{
  position:absolute;bottom:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,var(--red),transparent)
}
.stat-accent.green{background:linear-gradient(90deg,var(--green),transparent)}
.stat-accent.blue{background:linear-gradient(90deg,var(--blue-l),transparent)}

/* ── TOOLBAR ── */
.toolbar{
  background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);
  padding:.9rem 1.1rem;display:flex;gap:.65rem;align-items:flex-end;flex-wrap:wrap;margin-bottom:1.1rem
}
.toolbar-group{display:flex;flex-direction:column;gap:.3rem;flex:1;min-width:130px}
.toolbar-label{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600}

/* ── INPUTS ── */
input,select,textarea{
  background:var(--hover);border:1px solid var(--border2);color:var(--white);
  padding:.55rem .9rem;border-radius:var(--radius-sm);font-size:.85rem;
  font-family:'Inter',sans-serif;width:100%;outline:none;transition:var(--tr)
}
input:focus,select:focus,textarea:focus{border-color:var(--red);box-shadow:0 0 0 3px var(--red-dim)}
input[type=number]{text-align:center;padding:.5rem .5rem}
input[type=date]::-webkit-calendar-picker-indicator{filter:invert(.6);opacity:.8;cursor:pointer}
input[type=date]::-webkit-datetime-edit-fields-wrapper{direction:ltr}
input[type=date]::-webkit-datetime-edit-day-field,
input[type=date]::-webkit-datetime-edit-month-field,
input[type=date]::-webkit-datetime-edit-year-field{color:var(--text1)}
select option{background:var(--elevated)}

/* ── BUTTONS ── */
.btn{
  display:inline-flex;align-items:center;gap:.4rem;padding:.55rem 1.1rem;
  border-radius:var(--radius-sm);font-size:.82rem;font-weight:500;cursor:pointer;
  border:1px solid;text-decoration:none;transition:var(--tr);
  font-family:'Inter',sans-serif;white-space:nowrap;line-height:1;letter-spacing:-.1px
}
.btn-primary{background:var(--red);color:#fff;border-color:var(--red);font-weight:600}
.btn-primary:hover{background:var(--red-l);border-color:var(--red-l);box-shadow:0 4px 16px rgba(204,31,31,0.25)}
.btn-ghost{background:transparent;color:var(--muted);border-color:var(--border2)}
.btn-ghost:hover{background:var(--hover);color:var(--white);border-color:var(--border2)}
.btn-danger{background:transparent;color:var(--red-sem);border-color:rgba(239,68,68,.25)}
.btn-danger:hover{background:var(--red-sem-dim);border-color:var(--red-sem)}
.btn-sm{padding:.35rem .75rem;font-size:.72rem}
.btn:active{transform:scale(.98)}

/* ── TABLE ── */
.table-wrap{background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
table{width:100%;border-collapse:collapse}
thead{background:var(--hover)}
th{padding:.75rem 1rem;font-size:.7rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;text-align:left;white-space:nowrap}
td{padding:.85rem 1rem;border-top:1px solid var(--border);font-size:.84rem;color:var(--white);vertical-align:middle}
tbody tr{transition:var(--tr)}
tbody tr:hover td{background:rgba(255,255,255,0.02)}
.td-muted{color:var(--muted)}
.td-mono{font-family:'Courier New',monospace;font-size:.75rem;color:var(--muted)}
.td-actions{display:flex;gap:.4rem;align-items:center}

/* ── AGENDA CARDS ── */
.agenda-list{display:flex;flex-direction:column;gap:.5rem}
.agenda-card{
  background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 18px;display:grid;grid-template-columns:110px 1fr auto;
  gap:18px;align-items:center;transition:var(--tr)
}
.agenda-card.current{
  background:rgba(204,31,31,0.04);
  border-color:rgba(204,31,31,0.35)
}
.agenda-card:hover{border-color:var(--border2);background:var(--hover)}
.agenda-card.status-cancelado{opacity:.45;filter:grayscale(.5)}
.agenda-time-block{}
.agenda-hour{
  font-size:1.125rem;font-weight:700;color:var(--white);
  font-variant-numeric:tabular-nums;letter-spacing:-.01em;
  display:flex;align-items:center;gap:6px;line-height:1
}
.agenda-hour-dot{
  width:6px;height:6px;border-radius:50%;background:var(--red);
  box-shadow:0 0 6px rgba(204,31,31,0.7);flex-shrink:0
}
.agenda-end{font-size:.75rem;color:var(--muted);margin-top:.2rem;font-variant-numeric:tabular-nums}
.agenda-body .client-name{font-weight:600;font-size:.935rem;color:var(--white);margin-bottom:.25rem}
.agenda-body .service-row{display:flex;align-items:center;gap:10px;margin-top:4px}
.agenda-body .service-name{font-size:.81rem;color:var(--muted)}
.agenda-body .barber-tag{
  display:inline-flex;align-items:center;font-size:.66rem;color:#aaa;
  background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);
  border-radius:6px;padding:.15rem .5rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase
}
.agenda-aside{display:flex;align-items:center;gap:14px}
.agenda-price{font-size:.94rem;font-weight:700;color:var(--green);min-width:70px;text-align:right;font-variant-numeric:tabular-nums}
.agenda-price.cancelled{color:var(--muted2);text-decoration:line-through}
.agenda-presenca-row{border-top:1px solid var(--border);margin-top:.75rem;padding-top:.75rem}
.agenda-card--ghost{opacity:.25;border-style:dashed;pointer-events:none}

/* ── PRODUCT CARDS ── */
.product-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.product-card{
  background:var(--elevated);border:1px solid var(--border);border-radius:14px;
  padding:18px 20px;display:flex;flex-direction:column;transition:var(--tr)
}
.product-card:hover{border-color:var(--border2)}
.product-card.inactive{opacity:.45}
.product-name{font-weight:700;font-size:1rem;color:var(--white);margin-bottom:.25rem;line-height:1.3;letter-spacing:-.01em}
.product-desc{font-size:.81rem;color:var(--muted);line-height:1.5;margin-bottom:.85rem;flex:1;min-height:2.5rem}
.product-price{font-size:1.125rem;font-weight:700;color:var(--white);margin-bottom:.7rem;font-variant-numeric:tabular-nums}
.stock-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem}
.stock-label{font-size:.75rem;color:var(--muted)}
.stock-count{font-size:.75rem;font-weight:600}
.stock-count.zero{color:var(--red-sem)}
.stock-count.low{color:var(--amber)}
.stock-count.ok{color:var(--green)}
.progress{height:6px;background:rgba(255,255,255,0.06);border-radius:999px;overflow:hidden;margin-bottom:.85rem}
.progress-fill{height:100%;border-radius:999px;transition:.3s}
.progress-fill.zero{background:var(--red-sem);width:4px!important}
.progress-fill.low{background:var(--amber)}
.progress-fill.ok{background:var(--green)}
.product-actions{display:flex;gap:.5rem;align-items:center;margin-top:.1rem}
/* Stepper pill */
.stepper{
  display:flex;align-items:center;
  background:var(--surface);border:1px solid rgba(255,255,255,0.10);
  border-radius:10px;overflow:hidden
}
.stepper-btn{
  width:36px;height:36px;background:transparent;border:none;
  color:var(--muted);cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:var(--tr)
}
.stepper-btn:hover{color:var(--white)}
.stepper-val{
  min-width:42px;text-align:center;color:var(--white);
  font-weight:600;font-size:.875rem;font-variant-numeric:tabular-nums;
  border-left:1px solid rgba(255,255,255,0.08);
  border-right:1px solid rgba(255,255,255,0.08);
  padding:8px 0
}

/* ── SERVICE CARDS ── */
.service-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:.75rem}
.service-card{
  background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.1rem 1.25rem;transition:var(--tr)
}
.service-card:hover{border-color:var(--border2)}
.service-name{font-weight:600;font-size:.88rem;margin-bottom:.15rem}
.service-cat{
  display:inline-flex;align-items:center;font-size:.65rem;color:var(--muted2);
  background:var(--hover);border:1px solid var(--border);border-radius:4px;
  padding:.1rem .5rem;margin-bottom:.85rem;text-transform:uppercase;letter-spacing:.5px
}
.service-fields{display:grid;grid-template-columns:1fr 1fr;gap:.4rem;margin-bottom:.65rem}
.field-label{font-size:.65rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:.25rem}

/* ── FORM ── */
.form-card{background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:1rem}
.form-card-title{font-size:.72rem;font-weight:600;color:var(--white);text-transform:uppercase;letter-spacing:1px;margin-bottom:1rem;padding-bottom:.6rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.4rem}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:.65rem}
.form-group{margin-bottom:.65rem}
.form-group:last-child{margin-bottom:0}
.form-label{display:block;font-size:.67rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.7px;margin-bottom:.3rem;font-weight:600}
.form-hint{font-size:.67rem;color:var(--muted2);margin-top:.3rem;display:flex;align-items:center;gap:.3rem}

/* ── CONFIG ── */
.config-section{background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:1rem}
.config-section-header{padding:.9rem 1.25rem;background:var(--hover);border-bottom:1px solid var(--border);font-size:.72rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;gap:.4rem}
.config-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:.9rem 1.25rem;border-bottom:1px solid var(--border);gap:1.5rem
}
.config-row:last-child{border-bottom:none}
.config-row:hover{background:rgba(255,255,255,.015)}
.config-meta .key{font-size:.88rem;font-weight:600;color:var(--white)}
.config-meta .desc{font-size:.76rem;color:var(--muted);margin-top:.2rem;line-height:1.4}
.config-ctrl{flex-shrink:0;width:220px}

/* ── AVATAR ── */
.avatar{
  width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,0.07);
  border:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;
  justify-content:center;font-size:.68rem;font-weight:700;color:var(--white);
  flex-shrink:0;text-transform:uppercase;letter-spacing:.5px
}

/* ── ALERT ── */
.alert{padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.8rem;display:flex;align-items:center;gap:.5rem;margin-bottom:1rem}
.alert-success{background:var(--green-dim);border:1px solid rgba(34,197,94,.25);color:var(--green)}
.alert-error{background:var(--red-sem-dim);border:1px solid rgba(239,68,68,.25);color:var(--red-sem)}

/* ── SECTION HEADER ── */
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.9rem}
.section-title{font-size:.88rem;font-weight:600;color:var(--white)}
.section-count{font-size:.72rem;color:var(--muted);background:var(--hover);border:1px solid var(--border);border-radius:20px;padding:.1rem .55rem}

/* ── EMPTY ── */
.empty{text-align:center;padding:3.5rem 1rem;color:var(--muted2)}
.empty-icon{font-size:2rem;opacity:.3;margin-bottom:.75rem}
.empty-text{font-size:.82rem}

/* ── CHART ── */
.chart-card{background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem}
.chart-title{font-size:.72rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:1rem;display:flex;align-items:center;gap:.35rem}
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:1.1rem}

/* ── DIVIDER ── */
hr{border:none;border-top:1px solid var(--border);margin:1.1rem 0}

/* ── TOAST ── */
.toast-container{position:fixed;bottom:1.5rem;right:1.5rem;z-index:999;display:flex;flex-direction:column;gap:.5rem}
.toast{
  background:var(--elevated);border:1px solid var(--border2);border-radius:var(--radius);
  padding:.7rem 1rem;font-size:.78rem;display:flex;align-items:center;gap:.5rem;
  box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:240px;
  animation:toastIn .25s cubic-bezier(.34,1.56,.64,1)
}
.toast.success{border-color:rgba(34,197,94,.35);color:var(--green)}
.toast.error{border-color:rgba(239,68,68,.35);color:var(--red-sem)}
@keyframes toastIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}

/* ── MOBILE ── */
@media(max-width:768px){
  #menuBtn{display:flex!important}
  .sidebar{
    position:fixed;inset:0;z-index:100;transform:translateX(-100%);
    transition:transform .25s cubic-bezier(.4,0,.2,1);width:min(280px,85vw);height:100%;
    border-right:1px solid var(--border2)
  }
  .sidebar.open{transform:translateX(0)}
  .sidebar-overlay{
    display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:99;
    backdrop-filter:blur(2px)
  }
  .sidebar.open~.sidebar-overlay{display:block}
  .content{padding:1rem}
  .topbar{padding:1rem}
  .form-row{grid-template-columns:1fr}
  .stats{grid-template-columns:1fr 1fr}
  .charts-grid{grid-template-columns:1fr}
  .agenda-card{grid-template-columns:60px 1fr}
  .agenda-aside{display:none}
  .product-grid,.service-grid{grid-template-columns:1fr}
}
@media(min-width:769px){
  #menuBtn{display:none!important}
}
`

/* ── Painel do barbeiro (mobile-first, acento azul) ── */
const CSS_BARBER = `
.barber-app{display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;background:var(--bg)}
.barber-header{
  position:sticky;top:0;z-index:30;display:flex;align-items:center;justify-content:space-between;gap:.75rem;
  padding:.85rem 1rem;background:var(--surface);border-bottom:1px solid var(--border)
}
.barber-header-greet{font-size:.95rem;font-weight:600;color:var(--white);line-height:1.3}
.barber-header-greet span{display:block;font-size:.72rem;font-weight:500;color:var(--muted);margin-top:.15rem}
.barber-header-actions{display:flex;align-items:center;gap:.5rem;flex-shrink:0}
.barber-logout{
  min-height:44px;min-width:44px;padding:0 .85rem;display:inline-flex;align-items:center;justify-content:center;
  background:transparent;border:1px solid var(--border2);border-radius:var(--radius-sm);
  color:var(--muted);font-size:.78rem;font-weight:500;cursor:pointer;font-family:inherit;text-decoration:none
}
.barber-logout:active{background:var(--hover);color:var(--white)}
.barber-body-wrap{flex:1;display:flex;min-height:0;width:100%}
.barber-sidebar{
  display:none;width:var(--sidebar-w);flex-shrink:0;background:var(--surface);
  border-right:1px solid var(--border);flex-direction:column;padding:1rem .65rem
}
.barber-sidebar .nav-item.active{color:var(--blue-l);background:var(--blue-dim);border-left-color:var(--blue)}
.barber-main{
  flex:1;overflow-y:auto;overflow-x:hidden;width:100%;
  padding:1rem 1rem calc(5.5rem + env(safe-area-inset-bottom));
  max-width:480px;margin:0 auto
}
.barber-page-title{font-size:.95rem;font-weight:700;color:var(--white);margin-bottom:.85rem;letter-spacing:-.02em}
.barber-footer{
  text-align:center;padding:.65rem 1rem calc(.35rem + env(safe-area-inset-bottom));
  font-size:.68rem;color:var(--muted2);border-top:1px solid var(--border);background:var(--surface)
}
.barber-footer a{color:var(--blue-l);text-decoration:none}
.barber-nav-bottom{
  position:fixed;left:0;right:0;bottom:0;z-index:40;display:flex;
  background:var(--surface);border-top:1px solid var(--border2);
  padding-bottom:env(safe-area-inset-bottom)
}
.bb-nav-item{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.2rem;
  min-height:56px;padding:.45rem .25rem;text-decoration:none;color:var(--muted);font-size:.62rem;font-weight:600;
  -webkit-tap-highlight-color:transparent
}
.bb-nav-item svg{opacity:.65}
.bb-nav-item.active{color:var(--blue-l);background:var(--blue-dim)}
.bb-nav-item.active svg{opacity:1}
.bb-section{margin-bottom:1.25rem}
.bb-section-title{font-size:.95rem;font-weight:700;margin-bottom:.75rem;color:var(--white)}
.bb-card{
  background:var(--elevated);border:1px solid var(--border);border-radius:12px;
  padding:1rem;margin-bottom:.75rem
}
.bb-card-row{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.35rem}
.bb-time{font-size:1rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--white)}
.bb-card-title{font-size:.88rem;font-weight:600;color:var(--white);margin-bottom:.25rem}
.bb-card-meta{font-size:.78rem;color:var(--muted);line-height:1.4}
.bb-money{color:var(--green);font-weight:600}
.bb-empty{text-align:center;padding:2rem 1rem;color:var(--muted);font-size:.82rem}
.bb-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.bb-stat{
  background:var(--elevated);border:1px solid var(--border);border-radius:12px;padding:1rem
}
.bb-stat-lbl{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:.35rem}
.bb-stat-val{font-size:1.4rem;font-weight:700;color:var(--blue-l);font-variant-numeric:tabular-nums;line-height:1.1}
.bb-stat-val.sm{font-size:1.05rem}
.bb-muted{font-size:.75rem;color:var(--muted);margin-top:.35rem}
.bb-link{
  display:inline-flex;align-items:center;min-height:44px;margin-top:.65rem;
  color:var(--blue-l);font-size:.84rem;font-weight:600;text-decoration:none
}
.bb-alert{
  display:flex;align-items:flex-start;gap:.5rem;padding:.75rem;border-radius:12px;margin-top:.75rem;
  background:var(--amber-dim);border:1px solid rgba(245,158,11,.35);color:var(--amber);font-size:.78rem;line-height:1.4
}
.bb-toolbar{display:flex;flex-direction:column;gap:.75rem;margin-bottom:1rem}
.bb-toolbar input[type=date]{min-height:44px;font-size:16px}
.bb-pills{display:flex;flex-wrap:wrap;gap:.5rem}
.bb-pill{
  min-height:44px;padding:0 .85rem;display:inline-flex;align-items:center;border-radius:999px;
  border:1px solid var(--border2);background:var(--elevated);color:var(--muted);
  font-size:.78rem;font-weight:600;text-decoration:none;cursor:pointer;font-family:inherit;
  -webkit-tap-highlight-color:transparent
}
.bb-pill.active,.bb-pill[aria-pressed=true]{background:var(--blue-dim);border-color:var(--blue);color:var(--blue-l)}
.bb-pill:active{background:var(--hover)}
.bb-ranking{
  background:linear-gradient(135deg,var(--blue-dim),transparent);border:1px solid rgba(37,99,235,.25);
  border-radius:12px;padding:1rem;margin-bottom:1rem;font-size:.88rem;color:var(--white)
}
.bb-ranking strong{color:var(--blue-l)}
.bb-servico-row{
  display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.65rem 0;
  border-bottom:1px solid var(--border);font-size:.82rem
}
.bb-servico-row:last-child{border-bottom:none}
.bb-atend-item{
  background:var(--elevated);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.75rem
}
.bb-atend-top{display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;margin-bottom:.35rem}
.bb-atend-date{font-size:.72rem;color:var(--muted)}
.bb-fech-card{
  background:var(--elevated);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.75rem
}
.bb-fech-row{display:flex;justify-content:space-between;font-size:.82rem;margin-top:.35rem;color:var(--muted)}
.bb-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-height:44px;margin:.75rem 0}
.bb-toggle{
  min-height:44px;padding:0 1rem;border-radius:999px;border:1px solid var(--border2);
  background:var(--elevated);color:var(--muted);font-size:.78rem;font-weight:600;cursor:pointer;font-family:inherit
}
.bb-toggle.on{background:var(--blue-dim);border-color:var(--blue);color:var(--blue-l)}
.bb-load-more{
  width:100%;min-height:44px;margin-top:.5rem;border-radius:12px;border:1px solid var(--border2);
  background:var(--elevated);color:var(--blue-l);font-weight:600;font-size:.84rem;cursor:pointer;font-family:inherit
}
.bb-period-btns{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem}
.bb-period-btns .bb-pill{font-size:.72rem;padding:0 .65rem}
.bb-date-range{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.finance-dlg{border:none;border-radius:12px;padding:0;background:var(--surface);color:var(--white);border:1px solid var(--border);max-width:440px;width:calc(100% - 2rem);box-shadow:0 24px 48px rgba(0,0,0,.45)}
.finance-dlg::backdrop{background:rgba(0,0,0,.68)}
.fin-dlg-hd{padding:.9rem 1.15rem;border-bottom:1px solid var(--border);font-weight:700;font-size:.92rem}
.fin-dlg-bd{padding:1.1rem 1.15rem;display:flex;flex-direction:column;gap:.85rem}
.fin-dlg-ft{padding:.85rem 1.15rem;border-top:1px solid var(--border);display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap}
.fin-cards{display:grid;gap:.85rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));margin-bottom:1.25rem}
.fin-mini{color:var(--muted);font-size:.72rem;margin-top:.2rem}
.badge-fin-err{display:inline-flex;align-items:center;background:rgba(204,31,31,.14);color:#f87171;border-radius:8px;padding:2px 8px;font-size:.68rem;font-weight:700}
@media(min-width:769px){
  .barber-nav-bottom{display:none}
  .barber-sidebar{display:flex}
  .barber-main{padding:1.25rem 1.5rem 1.5rem;max-width:480px}
  .barber-header{padding-left:0}
}
`

// ── Page Shell ─────────────────────────────────────────────────────
function isSidebarNavActive(page, navId) {
  if (navId.startsWith('financeiro/')) return page === navId
  if (navId === 'financeiro') return page === 'financeiro'
  return page === navId || page.startsWith(`${navId}/`)
}

function navItemHtml(panelPrefix, page, item) {
  const active = isSidebarNavActive(page, item.id) ? 'active' : ''
  return `<a href="/${panelPrefix}/${item.id}" class="nav-item ${active}">${item.icon}<span>${item.label}</span></a>`
}

function shell(page, title, subtitle, body, script = '', panelPrefix = 'admin') {
  const isReception = panelPrefix === 'recepcao'
  const navPrincipal = [
    { id:'kanban',                 label:'Atendimentos', icon:ic.chart },
    { id:'agenda',                 label:'Agenda',       icon:ic.cal },
    { id:'agenda/agendar-manual',  label:'Ag. Manual',   icon:ic.plus },
    { id:'faturamento',            label:'Faturamento',  icon:ic.money },
    { id:'clientes',               label:'Clientes',     icon:ic.users },
    { id:'estoque',                label:'Estoque',      icon:ic.box },
    { id:'servicos',               label:'Serviços',     icon:ic.cut },
    { id:'config',                 label:'Config',       icon:ic.gear },
    { id:'aprovar-sinais',         label:'Sinais Pix',   icon:ic.money },
    { id:'eventos-bot',            label:'Métricas',     icon:ic.chart },
  ]
  const navFinanceiro = [
    { id:'financeiro',              label:'Financeiro',           icon:ic.money },
    { id:'financeiro/caixa-hoje',   label:'Caixa Hoje',           icon:ic.chart },
    { id:'financeiro/comissoes',    label:'Comissões',           icon:ic.chart },
    { id:'financeiro/fechamentos',  label:'Fechamentos',         icon:ic.check },
    { id:'financeiro/despesas',     label:'Despesas',            icon:ic.box },
  ]
  const navReception = [
    { id:'kanban',                label:'Atendimentos', icon:ic.chart },
    { id:'caixa',                 label:'Caixa do Dia', icon:ic.money },
    { id:'agenda',                label:'Agenda',       icon:ic.cal },
    { id:'despesas',              label:'Despesas',     icon:ic.box },
  ]

  let navHtml = ''
  if (isReception) {
    navHtml += `<div class="nav-label">Menu</div>${navReception.map((n) => navItemHtml(panelPrefix, page, n)).join('')}`
  }
  else {
    navHtml += `<div class="nav-label">Menu</div>${navPrincipal.map((n) => navItemHtml(panelPrefix, page, n)).join('')}`
    navHtml += `<div class="nav-label nav-label-finance">${ic.chart} Financeiro</div>`
    navHtml += navFinanceiro.map((n) => navItemHtml(panelPrefix, page, n)).join('')
  }

  const hora = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' })
  const dataHoje = new Date().toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short', timeZone:'America/Sao_Paulo' })

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Andy Na Régua</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-logo">
    <img src="/logo.png" alt="Andy Na Régua">
    </div>
    <nav class="nav">
      ${navHtml}
    </nav>
    <div>
      <div class="barber-stripe"></div>
      <div class="sidebar-footer">
        <div class="pulse"></div>
        Online · ${hora} · ${dataHoje}
        <div style="margin-top:.5rem;display:flex;flex-wrap:wrap;gap:.65rem;font-size:.72rem">
          <a href="/${panelPrefix}/conta/senha" style="color:var(--muted)">Trocar senha</a>
          <a href="/logout" style="color:var(--muted)">Sair</a>
        </div>
      </div>
    </div>
  </aside>
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
  <div class="main">
    <div class="topbar">
      <div class="topbar-left">
        <h1>${title}</h1>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
      </div>
      <div class="topbar-right" id="tbar">
        <button class="btn btn-ghost btn-sm" id="menuBtn" onclick="toggleSidebar()" style="display:none" aria-label="Menu">
          ${ic.menu}
        </button>
      </div>
    </div>
    <div class="content">${body}</div>
  </div>
</div>
<div class="toast-container" id="toasts"></div>
<script>
function toast(msg,type='success'){
  const t=document.createElement('div')
  t.className='toast '+type
  t.innerHTML=(type==='success'?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>')+' '+msg
  document.getElementById('toasts').appendChild(t)
  setTimeout(()=>{t.style.animation='toastIn .2s reverse';setTimeout(()=>t.remove(),200)},3500)
}
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open')
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open')
}
document.addEventListener('click',e=>{
  const s=document.getElementById('sidebar')
  const btn=document.getElementById('menuBtn')
  if(s&&s.classList.contains('open')&&!s.contains(e.target)&&e.target!==btn&&!btn.contains(e.target)){
    s.classList.remove('open')
  }
})
${script}
</script>
</body></html>`
}

function fmtBRL(valor) {
  const n = Number(valor) || 0
  return `R$ ${n.toFixed(2).replace('.', ',')}`
}

/** Igual ao filtro temporal de `getFaturamentoPeriodo` — só agendamentos concluídos. */
function sqlWherePeriodoTipoConcluidos(tipo, alias = 'a') {
  const col = `${alias}.data_hora_inicio`
  if (tipo === 'semana') return `date(${col}, 'localtime') >= date('now', '-6 days', 'localtime')`
  if (tipo === 'mes') return `strftime('%Y-%m', ${col}, 'localtime') = strftime('%Y-%m', 'now', 'localtime')`
  return `strftime('%Y', ${col}, 'localtime') = strftime('%Y', 'now', 'localtime')`
}

/** Ranking por produtividade — concluídos no período (mesma semântica das abas existentes). */
function getRankingProdutividadeAdministrativo(tipo) {
  const w = sqlWherePeriodoTipoConcluidos(tipo)
  const det = getDb()
    .prepare(`
      SELECT a.staff_id, b.nome AS barbeiro_nome,
        s.id AS servico_id, s.nome AS servico_nome,
        COUNT(*) AS qtd,
        SUM(COALESCE(s.preco, 0)) AS sub_total
      FROM agendamentos a
      JOIN barbeiros b ON b.id = a.staff_id
      LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.status = 'concluido'
        AND ${w}
      GROUP BY a.staff_id, s.id
    `)
    .all()
  const porId = {}
  for (const r of det) {
    if (!porId[r.staff_id]) porId[r.staff_id] = { nome: r.barbeiro_nome, atendimentos: 0, total: 0, servicos: [] }
    porId[r.staff_id].atendimentos += r.qtd
    porId[r.staff_id].total += r.sub_total
    porId[r.staff_id].servicos.push({ nome: r.servico_nome || String(r.servico_id || ''), sub: r.sub_total })
  }
  return Object.entries(porId)
    .map(([staff_id, o]) => {
      let top = '—'
      let maxSub = -1
      for (const z of o.servicos) if (z.sub > maxSub) { maxSub = z.sub; top = z.nome }
      const at = o.atendimentos
      const tot = o.total
      return { staff_id, nome: o.nome, atendimentos: at, total_bruto: tot, ticket_medio: at ? tot / at : 0, top_servico: top }
    })
    .sort((a, b) => b.total_bruto - a.total_bruto)
    .map((row, idx) => ({ ...row, posicao: idx + 1 }))
}

/** Faturamento agregado por barbeiro (aba Por Barbeiro) — período igual ao geral. */
function getFaturamentoPorBarbeiroAdministrativo(tipo) {
  return getRankingProdutividadeAdministrativo(tipo)
}

function primeiroDiaMesAtualBR() {
  const h = hojeStr()
  return `${h.slice(0, 8)}01`
}

/** Segunda-feira da semana corrente (calendário local do servidor — alinhado ao uso de datas YYYY-MM-DD). */
function primeiroDiaSemanaAtualBR() {
  const [y, mo, da] = hojeStr().split('-').map(Number)
  const d = new Date(y, mo - 1, da)
  const dow = d.getDay()
  const monOffset = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + monOffset)
  const yy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function sumDespesasPeriodo(de, ate) {
  const r = getDb()
    .prepare(`SELECT COALESCE(SUM(valor), 0) AS t FROM despesas WHERE date(data) >= date(?) AND date(data) <= date(?)`)
    .get(de, ate)
  return Number(r?.t) || 0
}

function sumReceitaConcluidosPeriodo(de, ate) {
  const row = getDb()
    .prepare(`
      SELECT COALESCE(SUM(s.preco), 0) AS t
      FROM agendamentos a
      LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.status = 'concluido'
        AND date(a.data_hora_inicio) >= date(?)
        AND date(a.data_hora_inicio) <= date(?)
    `)
    .get(de, ate)
  return row?.t || 0
}

function sumComissoesFechamentosAbertos() {
  const rows = getFechamentosAbertos()
  return rows.reduce((s, f) => s + Number(f.total_comissao || 0), 0)
}

/** Últimas 4 semanas (intervalos de 7 dias até hoje, localtime), fat. concluído por barbeiro. */
function getFaturamento4SemanasPorBarbeiro() {
  const barbeiros = getBarbeiros()
  const totais = []
  let maxVal = 1
  for (let wi = 0; wi < 4; wi++) {
    const fromD = -(27 - wi * 7)
    const toD = fromD + 6
    const dr = getDb()
      .prepare(`
        SELECT date('now','localtime', ?) AS de,
               date('now','localtime', ?) AS ate
      `)
      .get(`${fromD} days`, `${toD} days`)
    const de = dr.de
    const ate = dr.ate
    const porBarbra = {}
    for (const b of barbeiros) {
      porBarbra[b.id] = Number(
        getDb()
          .prepare(`
            SELECT COALESCE(SUM(s.preco),0) AS t
            FROM agendamentos a LEFT JOIN servicos s ON s.id = a.servico_id
            WHERE a.status='concluido' AND a.staff_id=? AND date(a.data_hora_inicio)>=date(?)
              AND date(a.data_hora_inicio)<=date(?)
          `)
          .get(b.id, de, ate).t || 0,
      )
    }
    const maxSem = Math.max(...Object.values(porBarbra), 0)
    if (maxSem > maxVal) maxVal = maxSem
    totais.push({ de, ate, porBarbra })
  }

  const cores = ['#cc1f1f', '#2563eb', '#22c55e', '#f59e0b', '#a855f7', '#eab308']
  return { barbeiros, totais, maxVal: Math.max(maxVal, 1), cores }
}

/** Gera SVG de barras agrupadas (sem biblioteca externa). */
function renderSvgBarrasFinanceiro(barbeiros, totais, maxVal, cores) {
  const W = 600
  const H = 200
  const padL = 80
  const padB = 32
  const padT = 12
  const chartW = W - padL - 16
  const chartH = H - padB - padT
  const groupGap = 8
  const nG = Math.max(totais.length, 1)
  const groupW = (chartW - groupGap * (nG + 1)) / nG
  const bw = Math.max(6, Math.min(18, (groupW - 4) / Math.max(barbeiros.length, 1)))

  const legend = barbeiros
    .map(
      (b, i) => `
    <rect x="${10 + i * 120}" y="4" width="10" height="10" rx="2" fill="${cores[i % cores.length]}" />
    <text x="${24 + i * 120}" y="13" fill="#888" font-size="11" font-family="Inter,sans-serif">${escapeHtml(b.nome.slice(0, 18))}</text>`,
    )
    .join('')

  let bars = ''
  totais.forEach((sem, wi) => {
    const gx = padL + groupGap + wi * (groupW + groupGap)
    barbeiros.forEach((b, bi) => {
      const v = Number(sem.porBarbra[b.id] || 0)
      const bh = chartH * (v / maxVal)
      const x = gx + bi * (bw + 2)
      const y = padT + chartH - bh
      bars += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(bh, 0.5)}" rx="2" fill="${cores[bi % cores.length]}" opacity="0.85" />`
    })
    bars += `<text x="${gx + groupW / 2 - 28}" y="${H - 8}" fill="#888" font-size="10" font-family="Inter,sans-serif">Sem ${wi + 1}</text>`
  })

  const meioLinha = `
    <line x1="${padL}" y1="${padT + chartH / 2}" x2="${W - 16}" y2="${padT + chartH / 2}"
      stroke="rgba(255,255,255,0.06)" stroke-width="1" />
    <text x="4" y="${padT + chartH / 2 + 4}" fill="#666" font-size="10" font-family="Inter,sans-serif">${escapaMilValorEscala(maxVal)}</text>`

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}px" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">${legend}<rect x="${padL}" y="${padT}" width="${chartW}" height="${chartH}" fill="rgba(255,255,255,0.02)" rx="6" stroke="rgba(255,255,255,0.08)"/>${meioLinha}${bars}<text x="4" y="${padT + chartH + 12}" fill="#666" font-size="10" font-family="Inter,sans-serif">0</text></svg>`
}

/** Texto truncado pra eixo SVG (valor máximo como referência €). */
function escapaMilValorEscala(maxVal) {
  return `${Math.round(Number(maxVal) || 0).toLocaleString('pt-BR')}`
}

function atualizarObsFechamento(id, texto) {
  if (texto == null || String(texto).trim() === '') return
  getDb().prepare(`UPDATE fechamentos SET obs = ?, updated_at = datetime('now') WHERE id = ?`).run(texto.trim(), id)
}

function enqueueWhatsAppPagamento(barbeiro, fechamento, count, pct) {
  const w = (barbeiro?.whatsapp || '').replace(/\s/g, '')
  if (!w) return
  const apenasNum = w.replace(/^\+/, '').replace(/@.+$/, '').replace(/\D/g, '')
  if (!apenasNum || apenasNum.length < 10) return
  const jid = apenasNum.endsWith('@c.us') ? apenasNum : `${apenasNum}@c.us`
  const dataInicio = fechamento.periodo_inicio
  const dataFim = fechamento.periodo_fim
  const bruto = Number(fechamento.total_bruto || 0).toFixed(2).replace('.', ',')
  const comissao = Number(fechamento.total_comissao || 0).toFixed(2).replace('.', ',')
  const dataHoje = new Date().toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short', timeZone:'America/Sao_Paulo' })
  const msg = `✅ Fechamento processado!

Período: ${dataInicio} a ${dataFim}
Atendimentos: ${count}
Total bruto: R$ ${bruto}
Sua comissão (${pct}%): R$ ${comissao}

Pagamento registrado em ${dataHoje}.

Qualquer dúvida, fala com Andy 👊`
  enfileirarMensagem(jid, msg, 'critica')
}

/** Calcula linhas no período e cria fechamento + fechamento_agendamentos no banco. */
function criarFechamentoComCalculo(barbeiroId, periodoInicio, periodoFim) {
  const linhas = calcularComissaoPeriodo(barbeiroId, periodoInicio, periodoFim)
  if (!linhas.length) return { erro: 'Nenhum atendimento concluído neste período.' }
  const total_bruto = linhas.reduce((s, l) => s + Number(l.valor_bruto || 0), 0)
  const total_comissao = linhas.reduce((s, l) => s + Number(l.valor_comissao || 0), 0)
  const pct_aplicado = total_bruto > 0 ? (total_comissao / total_bruto) * 100 : 0
  const fechamento = criarFechamento({
    barbeiro_id: barbeiroId,
    periodo_inicio: periodoInicio,
    periodo_fim: periodoFim,
    total_bruto,
    total_comissao,
    pct_aplicado,
    status: 'aberto',
  })
  const ins = getDb().prepare(`
    INSERT INTO fechamento_agendamentos (fechamento_id, agendamento_id, servico_nome, valor_bruto, pct_comissao, valor_comissao)
    VALUES (?,?,?,?,?,?)
  `)
  for (const ln of linhas) {
    ins.run(fechamento.id, ln.agendamento_id, ln.servico_nome, ln.valor_bruto, ln.pct_comissao, ln.valor_comissao)
  }
  return { fechamento, count: linhas.length }
}

function listarFechamentosAdministrativo(statusFiltro, barbeiroId) {
  let sql = `
    SELECT f.*, b.nome AS barbeiro_nome,
      (SELECT COUNT(*) FROM fechamento_agendamentos fa WHERE fa.fechamento_id = f.id) AS n_atendimentos
    FROM fechamentos f
    JOIN barbeiros b ON b.id = f.barbeiro_id
    WHERE 1=1
  `
  const p = []
  if (statusFiltro === 'aberto') sql += ` AND f.status = 'aberto'`
  if (statusFiltro === 'pago') sql += ` AND f.status = 'pago'`
  if (barbeiroId) { sql += ` AND f.barbeiro_id = ?`; p.push(barbeiroId) }
  sql += ` ORDER BY f.id DESC LIMIT 200`
  return getDb().prepare(sql).all(...p)
}

/** Data inicial padrão do resumo financeiro do barbeiro (dia seguinte ao último fechamento ou 1º do mês). */
function getInicioPeriodoFinanceiro(barbeiroId) {
  const ultimo = getDb()
    .prepare(`
      SELECT periodo_fim FROM fechamentos
      WHERE barbeiro_id = ?
      ORDER BY periodo_fim DESC
      LIMIT 1
    `)
    .get(barbeiroId)
  if (ultimo?.periodo_fim) {
    const d = new Date(`${ultimo.periodo_fim}T12:00:00`)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  const hoje = hojeStr()
  return `${hoje.slice(0, 8)}01`
}

function getRankingPosicao(barbeiroId, de, ate) {
  const rows = getDb()
    .prepare(`
      SELECT a.staff_id, SUM(COALESCE(s.preco, 0)) AS total
      FROM agendamentos a
      LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.status = 'concluido'
        AND date(a.data_hora_inicio) >= date(?)
        AND date(a.data_hora_inicio) <= date(?)
        AND a.staff_id IN (SELECT id FROM barbeiros WHERE ativo = 1)
      GROUP BY a.staff_id
      ORDER BY total DESC
    `)
    .all(de, ate)
  const totalBarbeiros = Math.max(getBarbeiros().filter((b) => b.ativo).length, 1)
  const idx = rows.findIndex((r) => r.staff_id === barbeiroId)
  return { posicao: idx >= 0 ? idx + 1 : totalBarbeiros, total: totalBarbeiros }
}

/** Dados financeiros do período (atendimentos concluídos + resumo + ranking + fechamentos). */
function buildFinanceiroDados(barbeiroId, de, ate) {
  const barbeiro = getBarbeiroById(barbeiroId)
  const pctPadrao = Number(barbeiro?.comissao_padrao_pct) || 0
  const comissoes = calcularComissaoPeriodo(barbeiroId, de, ate)

  let metaRows = []
  if (comissoes.length) {
    const ids = comissoes.map((c) => c.agendamento_id)
    metaRows = getDb()
      .prepare(`
        SELECT a.id AS agendamento_id, a.data_hora_inicio, c.nome AS cliente_nome
        FROM agendamentos a
        LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
        WHERE a.id IN (${ids.map(() => '?').join(',')})
      `)
      .all(...ids)
  }
  const metaMap = Object.fromEntries(metaRows.map((r) => [r.agendamento_id, r]))

  const atendimentos = comissoes.map((c) => {
    const meta = metaMap[c.agendamento_id] || {}
    return {
      agendamento_id: c.agendamento_id,
      data: meta.data_hora_inicio ? String(meta.data_hora_inicio).slice(0, 10) : '',
      horario: formatHora(meta.data_hora_inicio),
      data_hora_inicio: meta.data_hora_inicio || '',
      cliente: meta.cliente_nome || 'Cliente',
      servico_nome: c.servico_nome,
      valor_bruto: c.valor_bruto,
      pct_comissao: c.pct_comissao,
      valor_comissao: c.valor_comissao,
    }
  }).sort((a, b) => String(b.data_hora_inicio).localeCompare(String(a.data_hora_inicio)))

  const total_bruto = atendimentos.reduce((s, a) => s + a.valor_bruto, 0)
  const total_comissao = atendimentos.reduce((s, a) => s + a.valor_comissao, 0)
  const qtd = atendimentos.length
  const ranking = getRankingPosicao(barbeiroId, de, ate)

  const servicoMap = {}
  for (const a of atendimentos) {
    if (!servicoMap[a.servico_nome]) {
      servicoMap[a.servico_nome] = { nome: a.servico_nome, quantidade: 0, total_bruto: 0 }
    }
    servicoMap[a.servico_nome].quantidade += 1
    servicoMap[a.servico_nome].total_bruto += a.valor_bruto
  }
  const top_servicos = Object.values(servicoMap)
    .sort((a, b) => b.total_bruto - a.total_bruto)
    .slice(0, 3)

  const fechamentos = getFechamentosByBarbeiro(barbeiroId, 20).filter((f) => {
    const limite = new Date()
    limite.setMonth(limite.getMonth() - 3)
    const fim = new Date(`${f.periodo_fim}T12:00:00`)
    return fim >= limite
  })

  return {
    resumo: {
      de,
      ate,
      total_bruto,
      total_comissao,
      atendimentos: qtd,
      ticket_medio: qtd ? total_bruto / qtd : 0,
      comissao_pct: pctPadrao,
      comissao_nao_configurada: pctPadrao === 0,
    },
    atendimentos,
    top_servicos,
    ranking_posicao: ranking.posicao,
    ranking_total: ranking.total,
    fechamentos,
  }
}

function getAgendamentosBarbeiroDia(data, staffId, statusFiltro = 'todos') {
  let query = `
    SELECT a.*, c.nome AS nome_cliente, c.no_show_count,
           s.nome AS servico_nome, s.preco AS servico_preco, s.duracao_minutos
    FROM agendamentos a
    LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
    LEFT JOIN servicos s ON s.id = a.servico_id
    WHERE date(a.data_hora_inicio) = ?
      AND a.staff_id = ?
  `
  const params = [data, staffId]
  if (statusFiltro === 'confirmado') query += ` AND a.status = 'confirmado'`
  else if (statusFiltro === 'concluido') query += ` AND a.status = 'concluido'`
  else if (statusFiltro === 'no-show') query += ` AND a.status = 'no_show'`
  else query += ` AND a.status IN ('confirmado', 'concluido', 'no_show')`
  query += ` ORDER BY a.data_hora_inicio ASC`
  return getDb().prepare(query).all(...params)
}

function renderBarbeiroAgendaCard(ag) {
  const preco = ag.servico_preco || 0
  return `
  <article class="bb-card">
    <div class="bb-card-row">
      <time class="bb-time">${formatHora(ag.data_hora_inicio)}</time>
      ${badge(ag.status)}
    </div>
    <div class="bb-card-title">${escapeHtml(ag.nome_cliente || 'Sem nome')}</div>
    <div class="bb-card-meta">${escapeHtml(ag.servico_nome || ag.servico_id)} · <span class="bb-money">${fmtBRL(preco)}</span></div>
  </article>`
}

function renderBarbeiroAgendaLista(ags, vazioMsg) {
  if (!ags.length) return `<div class="bb-empty">${escapeHtml(vazioMsg)}</div>`
  return ags.map(renderBarbeiroAgendaCard).join('')
}

function renderResumoFinanceiroHtml(dados, comLinkDetalhes = true) {
  const r = dados.resumo
  const aviso = r.comissao_nao_configurada
    ? `<div class="bb-alert">${ic.warn} Percentual não configurado — fale com Andy</div>`
    : `<p class="bb-muted">Comissão estimada (${r.comissao_pct}%)</p>`
  return `
  <section class="bb-section">
    <h2 class="bb-section-title">Resumo financeiro</h2>
    <p class="bb-muted" style="margin:-.35rem 0 .75rem;font-size:.72rem">${formatData(r.de + 'T12:00:00')} — ${formatData(r.ate + 'T12:00:00')}</p>
    <div class="bb-stat-grid">
      <div class="bb-stat">
        <div class="bb-stat-lbl">Total bruto</div>
        <div class="bb-stat-val">${fmtBRL(r.total_bruto)}</div>
      </div>
      <div class="bb-stat">
        <div class="bb-stat-lbl">Comissão est.</div>
        <div class="bb-stat-val">${fmtBRL(r.total_comissao)}</div>
      </div>
      <div class="bb-stat">
        <div class="bb-stat-lbl">Atendimentos</div>
        <div class="bb-stat-val sm">${r.atendimentos}</div>
      </div>
      <div class="bb-stat">
        <div class="bb-stat-lbl">Ticket médio</div>
        <div class="bb-stat-val sm">${fmtBRL(r.ticket_medio)}</div>
      </div>
    </div>
    ${aviso}
    ${comLinkDetalhes ? '<a href="/barbeiro/financeiro" class="bb-link">Ver detalhes →</a>' : ''}
  </section>`
}

function calcularPeriodoRapido(tipo) {
  const hoje = hojeStr()
  const parts = hoje.split('-').map(Number)
  const base = new Date(parts[0], parts[1] - 1, parts[2])
  const fmt = (d) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  if (tipo === 'semana') {
    const de = new Date(base)
    const dow = de.getDay()
    const diff = dow === 0 ? 6 : dow - 1
    de.setDate(de.getDate() - diff)
    return { de: fmt(de), ate: hoje }
  }
  if (tipo === 'mes') {
    return { de: `${parts[0]}-${String(parts[1]).padStart(2, '0')}-01`, ate: hoje }
  }
  if (tipo === 'mes_anterior') {
    const de = new Date(parts[0], parts[1] - 2, 1)
    const ate = new Date(parts[0], parts[1] - 1, 0)
    return { de: fmt(de), ate: fmt(ate) }
  }
  if (tipo === '3meses') {
    const de = new Date(base)
    de.setMonth(de.getMonth() - 3)
    return { de: fmt(de), ate: hoje }
  }
  return { de: hoje, ate: hoje }
}

/** Layout mobile-first do painel do barbeiro (acento azul). */
function shellBarbeiro(page, title, body, barbeiro, script = '', extraHead = '') {
  const nav = [
    { id: 'inicio', label: 'Início', icon: ic.cal, href: '/barbeiro/inicio' },
    { id: 'agenda', label: 'Minha Agenda', icon: ic.cal, href: '/barbeiro/agenda' },
    { id: 'financeiro', label: 'Meu Financeiro', icon: ic.money, href: '/barbeiro/financeiro' },
    { id: 'conta/senha', label: 'Trocar Senha', icon: ic.lock, href: '/barbeiro/conta/senha' },
  ]
  const isActive = (id) => page === id || (id === 'financeiro' && page.startsWith('financeiro')) || (id === 'conta/senha' && page.startsWith('conta/'))
  const navBottom = nav
    .map(
      (n) => `
    <a href="${n.href}" class="bb-nav-item ${isActive(n.id) ? 'active' : ''}" aria-current="${isActive(n.id) ? 'page' : 'false'}">
      ${n.icon}
      <span>${n.label}</span>
    </a>`,
    )
    .join('')
  const navSide = nav
    .map(
      (n) => `
    <a href="${n.href}" class="nav-item ${isActive(n.id) ? 'active' : ''}">${n.icon}<span>${n.label}</span></a>`,
    )
    .join('')

  const phoneRaw = getConfig('barbearia_phone') || getConfig('andy_phone') || ''
  const phoneDigits = phoneRaw.replace(/\D/g, '').replace(/@.*/, '')
  const suporteHref = phoneDigits ? `https://wa.me/${phoneDigits}` : 'tel:+5500000000000'

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)} — Andy Na Régua</title>
<style>${CSS}${CSS_BARBER}</style>
${extraHead}
</head>
<body>
<div class="barber-app">
  <header class="barber-header">
    <div class="barber-header-greet">
      Olá, ${escapeHtml(barbeiro.nome)}
      <span>${escapeHtml(title)}</span>
    </div>
    <div class="barber-header-actions" style="display:flex;align-items:center;gap:.5rem">
      <a href="/barbeiro/conta/senha" class="barber-logout" style="text-decoration:none">Trocar senha</a>
      <form method="POST" action="/barbeiro/logout" style="margin:0">
        <button type="submit" class="barber-logout" aria-label="Sair">Sair</button>
      </form>
    </div>
  </header>
  <div class="barber-body-wrap">
    <aside class="barber-sidebar" aria-label="Menu">
      <div class="sidebar-logo" style="padding:0 0 1rem;border:none">
        <img src="/logo.png" alt="Andy Na Régua" style="height:32px">
      </div>
      <nav class="nav">${navSide}</nav>
    </aside>
    <main class="barber-main" id="barberMain">
      ${body}
    </main>
  </div>
  <nav class="barber-nav-bottom" aria-label="Navegação principal">${navBottom}</nav>
  <footer class="barber-footer">
    Andy Na Régua · v1.0 · <a href="${suporteHref}" target="_blank" rel="noopener">Suporte</a>
  </footer>
</div>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>
<script>
${script}
</script>
</body></html>`
}

// ── LOGIN (montado em /login no app Express) ───────────────────────
export function renderLoginPage(req, res) {
  const erro = req.query.erro || ''
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acesso — Andy Na Régua</title>
<style>
${CSS}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--bg)}
.login-card{background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:2.5rem 2rem;width:100%;max-width:360px}
.login-logo{text-align:center;margin-bottom:2rem}
.login-logo img{height:56px;width:auto;object-fit:contain}
.login-title{font-size:1rem;font-weight:700;text-align:center;color:var(--white);margin-bottom:.35rem}
.login-sub{font-size:.78rem;color:var(--muted);text-align:center;margin-bottom:1.5rem}
</style>
</head>
<body>
<div class="login-card">
  <div class="login-logo"><img src="/logo.png" alt="Andy Na Régua"></div>
  <div class="login-title">Painel de Controle</div>
  <div class="login-sub">Andy Na Régua Barbearia</div>
  ${erro ? `<div class="alert alert-error" style="margin-bottom:1rem">${ic.warn} Usuário ou senha incorretos</div>` : ''}
  <form method="POST" action="/login">
    <div class="form-group">
      <label class="form-label">Usuário</label>
      <input type="text" name="usuario" autocomplete="username" placeholder="andy, recepcao, barbeiro1…" required autofocus>
      <div class="form-hint" style="font-size:.68rem;margin-top:.35rem">Use o login fixo (ex: barbeiro1), não o nome de exibição.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Senha</label>
      <input type="password" name="senha" placeholder="••••••••" required autocomplete="current-password">
    </div>
    <button type="submit" class="btn btn-primary" style="width:100%;margin-top:1rem;min-height:44px;justify-content:center">
      ${ic.check} Entrar
    </button>
  </form>
</div>
</body></html>`)
}

export function handleLoginPost(req, res) {
  const username = String(req.body?.usuario || '').trim().toLowerCase()
  const senha = req.body?.senha
  if (!username || !senha) return res.redirect('/login?erro=1')

  const usuario = getUsuarioPorUsername(username)
  if (!usuario || !verificarSenha(senha, usuario.senha_hash)) {
    return res.redirect('/login?erro=1')
  }

  req.session.user = {
    id: usuario.id,
    username: usuario.username,
    papel: usuario.papel,
    staff_id: usuario.staff_id || null,
    nome: usuario.nome || usuario.username,
  }
  return res.redirect(redirectPosLogin(usuario.papel))
}

/** Preenche req.barbeiro a partir da sessão (staff_id = barbeiro1/2/3). */
export function attachBarbeiroUser(req, res, next) {
  const u = req.session?.user
  if (!u?.staff_id) return res.redirect('/login')
  const fin = getBarbeiroById(u.staff_id)
  req.barbeiro = {
    id: u.staff_id,
    nome: u.nome || fin?.nome || u.username,
    username: u.username,
    comissao_padrao_pct: fin?.comissao_padrao_pct ?? 0,
  }
  next()
}

function painelHomeHref(panelPrefix) {
  if (panelPrefix === 'admin') return '/admin/kanban'
  if (panelPrefix === 'recepcao') return '/recepcao/kanban'
  return '/barbeiro/agenda'
}

function renderTrocarSenhaAlertas(msg) {
  if (msg === 'ok') {
    return `<div class="alert alert-success">${ic.check} Senha alterada com sucesso.</div>`
  }
  if (msg === 'atual') {
    return `<div class="alert" style="background:var(--red-sem-dim);border:1px solid rgba(239,68,68,.3);color:var(--red-sem);padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.8rem;margin-bottom:1rem">${ic.warn} Senha atual incorreta.</div>`
  }
  if (msg === 'curta') {
    return `<div class="alert" style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);color:var(--amber);padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.8rem;margin-bottom:1rem">${ic.warn} A nova senha deve ter no mínimo 6 caracteres.</div>`
  }
  if (msg === 'naoconfere') {
    return `<div class="alert" style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);color:var(--amber);padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.8rem;margin-bottom:1rem">${ic.warn} A confirmação não confere com a nova senha.</div>`
  }
  return ''
}

function renderTrocarSenhaAlertasBarbeiro(msg) {
  if (msg === 'ok') {
    return `<div class="bb-alert" style="background:var(--green-dim);border-color:rgba(34,197,94,.35);color:var(--green)">${ic.check} Senha alterada com sucesso.</div>`
  }
  if (msg === 'atual') return `<div class="bb-alert">${ic.warn} Senha atual incorreta.</div>`
  if (msg === 'curta') return `<div class="bb-alert">${ic.warn} A nova senha deve ter no mínimo 6 caracteres.</div>`
  if (msg === 'naoconfere') return `<div class="bb-alert">${ic.warn} A confirmação não confere com a nova senha.</div>`
  return ''
}

function trocarSenhaGetHandler(panelPrefix) {
  return (req, res) => {
    const u = req.session?.user
    if (!u) return res.redirect('/login')
    const msg = req.query.msg || ''
    const body = `
      ${renderTrocarSenhaAlertas(msg)}
      <div class="form-card" style="max-width:420px">
        <div class="form-card-title">${ic.lock} Alterar senha</div>
        <form method="POST" action="/${panelPrefix}/conta/senha" style="display:flex;flex-direction:column;gap:.75rem">
          <div class="form-group" style="margin:0">
            <label class="form-label" for="senha_atual">Senha atual</label>
            <input type="password" id="senha_atual" name="senha_atual" required autocomplete="current-password">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label" for="nova_senha">Nova senha (mínimo 6 caracteres)</label>
            <input type="password" id="nova_senha" name="nova_senha" required minlength="6" autocomplete="new-password">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label" for="confirmar_nova">Confirmar nova senha</label>
            <input type="password" id="confirmar_nova" name="confirmar_nova" required minlength="6" autocomplete="new-password">
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem">
            <button type="submit" class="btn btn-primary">${ic.check} Salvar</button>
            <a href="${painelHomeHref(panelPrefix)}" class="btn btn-ghost">${ic.back} Voltar</a>
          </div>
        </form>
      </div>`

    if (panelPrefix === 'barbeiro') {
      const b = req.barbeiro || { nome: u.nome, id: u.staff_id, username: u.username }
      const bbBody = `
        <h1 class="barber-page-title">Trocar senha</h1>
        ${renderTrocarSenhaAlertasBarbeiro(msg)}
        <form method="POST" action="/barbeiro/conta/senha" class="bb-section" style="display:flex;flex-direction:column;gap:.75rem">
          <div class="form-group" style="margin:0">
            <label class="form-label" for="senha_atual">Senha atual</label>
            <input type="password" id="senha_atual" name="senha_atual" required autocomplete="current-password" style="min-height:44px;font-size:16px">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label" for="nova_senha">Nova senha (mínimo 6 caracteres)</label>
            <input type="password" id="nova_senha" name="nova_senha" required minlength="6" autocomplete="new-password" style="min-height:44px;font-size:16px">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label" for="confirmar_nova">Confirmar nova senha</label>
            <input type="password" id="confirmar_nova" name="confirmar_nova" required minlength="6" autocomplete="new-password" style="min-height:44px;font-size:16px">
          </div>
          <button type="submit" class="btn btn-primary" style="min-height:48px;justify-content:center;margin-top:.5rem">${ic.check} Salvar nova senha</button>
          <a href="/barbeiro/agenda" class="btn btn-ghost" style="justify-content:center">${ic.back} Voltar</a>
        </form>`
      return res.send(shellBarbeiro('conta/senha', 'Trocar Senha', bbBody, b))
    }

    return res.send(shell('conta/senha', 'Trocar Senha', `Usuário: ${escapeHtml(u.username)}`, body, '', panelPrefix))
  }
}

function trocarSenhaPostHandler(panelPrefix) {
  return (req, res) => {
    const sess = req.session?.user
    if (!sess) return res.redirect('/login')
    const { senha_atual, nova_senha, confirmar_nova } = req.body || {}
    const base = `/${panelPrefix}/conta/senha`
    const user = getUsuarioPorId(sess.id)
    if (!user) return res.redirect('/login')
    if (!senha_atual || !verificarSenha(senha_atual, user.senha_hash)) {
      return res.redirect(`${base}?msg=atual`)
    }
    if (!nova_senha || String(nova_senha).length < 6) {
      return res.redirect(`${base}?msg=curta`)
    }
    if (nova_senha !== confirmar_nova) {
      return res.redirect(`${base}?msg=naoconfere`)
    }
    atualizarSenhaUsuario(user.id, bcrypt.hashSync(nova_senha, 10))
    return res.redirect(`${base}?msg=ok`)
  }
}

// ═══════════════════════════════════════════════════════════════
// ROTA: /agenda
// ═══════════════════════════════════════════════════════════════
function agendaHandler(panelPrefix) {
  return (req, res) => {
    const data        = req.query.data || hojeStr()
    const staffFilter = panelPrefix === 'barbeiro'
      ? (req.session?.user?.staff_id || null)
      : (req.query.barbeiro || '')
    const msg         = req.query.msg || ''
    const isRecepcao  = panelPrefix === 'recepcao'
    const ags         = getAgendamentosDia(data, staffFilter || null)
    const fat         = getFaturamentoDia(data)

    const dataLabel = new Date(data + 'T12:00:00-03:00').toLocaleDateString('pt-BR', {
      weekday:'long', day:'2-digit', month:'long', year:'numeric', timeZone:'America/Sao_Paulo',
    })

    const staffOpts = staff.map(s =>
      `<option value="${s.id}" ${staffFilter===s.id?'selected':''}>${staffNameById(s.id)}</option>`
    ).join('')

    const renderAgendaCard = (ag, data) => {
      const preco = ag.servico_preco || 0
      const now = new Date()
      const inicio = new Date(ag.data_hora_inicio)
      const fim = new Date(ag.data_hora_fim)
      const isCurrent = ag.status === 'confirmado' && inicio <= now && now <= fim
      return `
      <div class="agenda-card status-${ag.status}${isCurrent ? ' current' : ''}">
        <div class="agenda-time-block">
          <div class="agenda-hour">
            ${isCurrent ? '<span class="agenda-hour-dot"></span>' : ''}
            ${formatHora(ag.data_hora_inicio)}
          </div>
          <div class="agenda-end">até ${formatHora(ag.data_hora_fim)}</div>
        </div>
        <div class="agenda-body">
          <div class="client-name">${ag.nome_cliente || '<span style="color:var(--muted)">Sem nome</span>'}${ag.no_show_count >= 2 ? ' <span style="color:var(--amber);font-size:.65rem">⚠ histórico no-show</span>' : ''}</div>
          <div class="service-row">
            <span class="service-name">${ag.servico_nome || ag.servico_id}</span>
            <span class="barber-tag">${staffNameById(ag.staff_id)}</span>
          </div>
        </div>
        <div class="agenda-aside">
          ${badge(ag.status)}
          <div class="agenda-price${ag.status==='cancelado' ? ' cancelled' : ''}">R$ ${preco.toFixed(2)}</div>
          ${ag.status==='confirmado'?`
          <a href="/${panelPrefix}/agenda/editar/${ag.id}?data=${encodeURIComponent(data)}" class="btn btn-ghost btn-sm" title="Editar">${ic.gear}</a>
          <form method="POST" action="/${panelPrefix}/agenda/cancelar">
            <input type="hidden" name="id" value="${ag.id}">
            <input type="hidden" name="data" value="${data}">
            <button class="btn btn-danger btn-sm" type="submit" onclick="return confirm('Cancelar agendamento de ${ag.nome_cliente||'cliente'}?')">
              ${ic.trash}
            </button>
          </form>`:''}
        </div>
        ${
          isRecepcao && ag.status === 'confirmado'
            ? `
        <div class="agenda-presenca-row" style="grid-column:1/-1;display:flex;gap:.5rem">
          <form method="POST" action="/${panelPrefix}/agenda/presenca/${ag.id}" style="flex:1">
            <input type="hidden" name="data" value="${escapeHtml(data)}">
            <button type="submit" class="btn btn-primary btn-sm" style="width:100%;background:var(--green);border-color:var(--green)">
              ✓ Chegou
            </button>
          </form>
          <form method="POST" action="/${panelPrefix}/agenda/no-show/${ag.id}" style="flex:1">
            <input type="hidden" name="data" value="${escapeHtml(data)}">
            <button type="submit" class="btn btn-sm" style="width:100%;background:var(--red-sem-dim);color:var(--red-sem);border:1px solid rgba(239,68,68,.3)">
              ✗ Não veio
            </button>
          </form>
        </div>`
            : ''
        }
      </div>`
    }

    const renderGhostCard = (ghost) => `
      <div class="agenda-card agenda-card--ghost">
        <div class="agenda-time-block">
          <div class="agenda-hour">${ghost.hora}</div>
          <div class="agenda-end">slot livre</div>
        </div>
        <div class="agenda-body" style="color:var(--muted2)">— disponível —</div>
        <div class="agenda-aside"></div>
      </div>`

    const itensAgenda = [
      ...ags.map((ag) => ({
        tipo: 'ag',
        sortMs: new Date(ag.data_hora_inicio).getTime(),
        ag,
      })),
      ...(!staffFilter ? gerarSlotsFantasmaAgendaHoje(data, ags).map((g) => ({ ...g, tipo: 'ghost' })) : []),
    ].sort((a, b) => a.sortMs - b.sortMs)

    const agendaCards = itensAgenda.length
      ? itensAgenda.map((item) => (
          item.tipo === 'ghost' ? renderGhostCard(item) : renderAgendaCard(item.ag, data)
        )).join('')
      : `<div class="empty"><div class="empty-icon">📅</div><div class="empty-text">Nenhum agendamento para este dia</div></div>`

    const body = `
    ${msg==='criado'?`<div class="alert alert-success">${ic.check} Agendamento criado com sucesso!</div>`:''}
    ${msg==='editado'?`<div class="alert alert-success">${ic.check} Agendamento atualizado.</div>`:''}
    ${msg==='presenca_ok'?`<div class="alert alert-success">${ic.check} Presença confirmada — agendamento concluído.</div>`:''}
    ${msg==='noshow_ok'?`<div class="alert" style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);color:var(--amber);padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.8rem;display:flex;align-items:center;gap:.5rem;margin-bottom:1rem">${ic.warn} No-show registrado.</div>`:''}
    <div class="stats">
      <div class="stat">
        <div class="stat-icon red">${ic.cal}</div>
        <div class="stat-val">${ags.length}</div>
        <div class="stat-lbl">Agendamentos</div>
        <div class="stat-accent"></div>
      </div>
      <div class="stat">
        <div class="stat-icon green">${ic.money}</div>
        <div class="stat-val">R$ ${fat.totalServicos.toFixed(0)}</div>
        <div class="stat-lbl">Em serviços</div>
        <div class="stat-accent green"></div>
      </div>
      <div class="stat">
        <div class="stat-icon blue">${ic.box}</div>
        <div class="stat-val">R$ ${fat.totalProdutos.toFixed(0)}</div>
        <div class="stat-lbl">Em produtos</div>
        <div class="stat-accent blue"></div>
      </div>
      <div class="stat">
        <div class="stat-icon amber">${ic.chart}</div>
        <div class="stat-val">R$ ${fat.totalGeral.toFixed(0)}</div>
        <div class="stat-lbl">Total do dia</div>
      </div>
    </div>

    <div class="toolbar">
      <div class="toolbar-group">
        <span class="toolbar-label">Data</span>
        <input type="date" lang="pt-BR" id="dataInput" value="${data}">
      </div>
      <div class="toolbar-group">
        <span class="toolbar-label">Barbeiro</span>
        <select id="barbeiroInput">
          <option value="">Todos os barbeiros</option>
          ${staffOpts}
        </select>
      </div>
      <button class="btn btn-ghost" onclick="filtrar()">Filtrar</button>
      <a href="/${panelPrefix}/agenda/bloquear?data=${data}" class="btn btn-ghost">${ic.lock} Bloquear horário</a>
      <a href="/${panelPrefix}/agenda/agendar-manual?data=${data}" class="btn btn-primary">${ic.plus} Novo agendamento</a>
    </div>

    <div class="section-header">
      <span class="section-title" style="text-transform:capitalize">${dataLabel}</span>
      <span class="section-count">${ags.length} ${ags.length===1?'horário':'horários'}</span>
    </div>
    <div class="agenda-list">${agendaCards}</div>
    `

    const script = `
      function filtrar(){
        const d=document.getElementById('dataInput').value
        const b=document.getElementById('barbeiroInput').value
        window.location.href='/${panelPrefix}/agenda?data='+d+(b?'&barbeiro='+b:'')
      }
      document.getElementById('dataInput').addEventListener('keydown',e=>{if(e.key==='Enter')filtrar()})
      setTimeout(()=>location.reload(),90000)
    `

    res.send(shell('agenda', 'Agenda', dataLabel, body, script, panelPrefix))
  }
}

router.get('/agenda', agendaHandler('admin'))
receptionRouter.get('/agenda', agendaHandler('recepcao'))

router.get('/conta/senha', trocarSenhaGetHandler('admin'))
router.post('/conta/senha', express.urlencoded({ extended: false }), trocarSenhaPostHandler('admin'))
receptionRouter.get('/conta/senha', trocarSenhaGetHandler('recepcao'))
receptionRouter.post('/conta/senha', express.urlencoded({ extended: false }), trocarSenhaPostHandler('recepcao'))

function cancelarHandler(secret) {
  return async (req, res) => {
    const { id, data } = req.body
    try {
      const ag = getDb().prepare('SELECT * FROM agendamentos WHERE id = ?').get(Number(id))
      if (ag) {
        cancelarAgendamento(ag.id, 'manual')
        if (ag.google_event_id) await deleteEvent(ag.staff_id, ag.google_event_id).catch(() => {})
        log(`Painel: agendamento #${ag.id} cancelado manualmente`)
      }
    } catch (e) { log('Erro ao cancelar:', e.message) }
    res.redirect(`/${secret}/agenda?data=${data || hojeStr()}`)
  }
}

router.post('/agenda/cancelar', cancelarHandler('admin'))
receptionRouter.post('/agenda/cancelar', cancelarHandler('recepcao'))

function editarAgendaGetHandler(secret) {
  return (req, res) => {
    const id = Number(req.params.id)
    const dataRef = req.query.data || hojeStr()
    const ag = getDb().prepare(`
      SELECT a.*, s.nome AS servico_nome, s.preco AS servico_preco, s.duracao_minutos
      FROM agendamentos a
      LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.id = ?
    `).get(id)
    if (!ag) return res.redirect(`/${secret}/agenda?data=${encodeURIComponent(dataRef)}`)

    const servicos = getServicosAtivos()
    const dataAg = String(ag.data_hora_inicio).slice(0, 10)
    const horarioAg = isoParaHorarioInput(ag.data_hora_inicio)
    const staffOpts = staff.map((s) =>
      `<option value="${s.id}" ${ag.staff_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`,
    ).join('')
    const servicoOpts = servicos.map((s) =>
      `<option value="${escapeHtml(s.id)}" ${ag.servico_id === s.id ? 'selected' : ''}>${escapeHtml(s.nome)} — R$${s.preco} (${s.duracao_minutos}min)</option>`,
    ).join('')

    const body = `
    <a href="/${secret}/agenda?data=${encodeURIComponent(dataRef)}" class="btn btn-ghost btn-sm" style="margin-bottom:1.25rem;display:inline-flex">${ic.back} Voltar à agenda</a>
    <div class="form-card" style="max-width:560px">
      <div class="form-card-title">${ic.gear} Editar agendamento #${ag.id}</div>
      <form method="POST" action="/${secret}/agenda/editar/${ag.id}">
        <input type="hidden" name="data_ref" value="${escapeHtml(dataRef)}">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Nome do cliente *</label>
            <input type="text" name="nome" required value="${escapeHtml(ag.cliente_nome || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">WhatsApp</label>
            <input type="text" value="${escapeHtml(ag.whatsapp_number || '')}" disabled style="opacity:.7">
            <div class="form-hint">${ic.warn} Número não editável pelo painel</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Serviço *</label>
            <select name="servico_id" required>${servicoOpts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Barbeiro *</label>
            <select name="staff_id" required>${staffOpts}</select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Data *</label>
            <input type="date" lang="pt-BR" name="data" value="${escapeHtml(dataAg)}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Horário *</label>
            <input type="time" name="horario" value="${escapeHtml(horarioAg)}" required step="900">
          </div>
        </div>
        <div class="form-hint" style="margin-bottom:1rem">${ic.warn} Se houver evento no Google Calendar, ele será recriado com os novos dados.</div>
        <div style="display:flex;gap:.5rem">
          <button type="submit" class="btn btn-primary">${ic.check} Salvar alterações</button>
          <a href="/${secret}/agenda?data=${encodeURIComponent(dataRef)}" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>`

    res.send(shell('agenda', 'Editar Agendamento', `Agendamento #${ag.id}`, body, '', secret))
  }
}

function editarAgendaPostHandler(secret) {
  return async (req, res) => {
    const id = Number(req.params.id)
    const { nome, servico_id, staff_id, data, horario, data_ref } = req.body
    const dataRedirect = data_ref || data || hojeStr()
    if (!nome || !servico_id || !staff_id || !data || !horario) {
      return res.redirect(`/${secret}/agenda?data=${encodeURIComponent(dataRedirect)}&msg=err`)
    }

    const ag = getDb().prepare(`SELECT * FROM agendamentos WHERE id = ?`).get(id)
    if (!ag) return res.redirect(`/${secret}/agenda?data=${encodeURIComponent(dataRedirect)}`)

    const servico = getServicosAtivos().find((s) => s.id === servico_id) || getServicoById(servico_id)
    if (!servico) return res.redirect(`/${secret}/agenda/editar/${id}?data=${encodeURIComponent(dataRedirect)}`)

    const start_iso = `${data}T${horario}:00-03:00`
    const endDate = new Date(new Date(start_iso).getTime() + servico.duracao_minutos * 60000)
    const end_iso = isoBRT(endDate)

    try {
      if (ag.google_event_id) {
        await deleteEvent(ag.staff_id, ag.google_event_id).catch(() => {})
      }

      let googleEventId = null
      try {
        const evento = await createEvent(staff_id, {
          summary: `${servico.nome} — ${nome.trim()}`,
          description: `WhatsApp: ${ag.whatsapp_number}\nServiço: ${servico.nome}\nBarbeiro: ${staffNameById(staff_id)}`,
          startTime: start_iso,
          endTime: end_iso,
          clientePhone: ag.whatsapp_number,
        })
        googleEventId = evento?.id || null
      } catch (e) {
        log('Erro ao recriar evento Calendar na edição:', e.message)
      }

      getDb().prepare(`
        UPDATE agendamentos
        SET cliente_nome = ?, servico_id = ?, staff_id = ?,
            data_hora_inicio = ?, data_hora_fim = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(nome.trim(), servico_id, staff_id, start_iso, end_iso, id)

      if (googleEventId) {
        getDb().prepare(`UPDATE agendamentos SET google_event_id = ? WHERE id = ?`).run(googleEventId, id)
      }

      log(`Painel: agendamento #${id} editado — ${data} ${horario}`)
      res.redirect(`/${secret}/agenda?data=${encodeURIComponent(data)}&msg=editado`)
    } catch (e) {
      log('Erro ao editar agendamento:', e.message)
      res.redirect(`/${secret}/agenda?data=${encodeURIComponent(dataRedirect)}`)
    }
  }
}

router.get('/agenda/editar/:id', editarAgendaGetHandler('admin'))
router.post('/agenda/editar/:id', editarAgendaPostHandler('admin'))
receptionRouter.get('/agenda/editar/:id', editarAgendaGetHandler('recepcao'))
receptionRouter.post('/agenda/editar/:id', editarAgendaPostHandler('recepcao'))

receptionRouter.post('/agenda/presenca/:id', express.urlencoded({ extended: false }), (req, res) => {
  const id = Number(req.params.id)
  const data = req.body.data || hojeStr()
  confirmarPresenca(id)
  log(`Recepção: presença confirmada — agendamento #${id}`)
  res.redirect(`/recepcao/agenda?data=${encodeURIComponent(data)}&msg=presenca_ok`)
})

receptionRouter.post('/agenda/no-show/:id', express.urlencoded({ extended: false }), (req, res) => {
  const id = Number(req.params.id)
  const data = req.body.data || hojeStr()
  marcarNaoCompareceu(id)
  log(`Recepção: no-show — agendamento #${id}`)
  res.redirect(`/recepcao/agenda?data=${encodeURIComponent(data)}&msg=noshow_ok`)
})

receptionRouter.get('/despesas', (req, res) => {
  const ate = req.query.ate || hojeStr()
  const de = req.query.de || primeiroDiaSemanaAtualBR()
  const cat = typeof req.query.cat === 'string' && req.query.cat.trim() !== '' ? req.query.cat.trim() : null
  const lista = getDespesas({
    dataInicio: de,
    dataFim: ate,
    ...(cat ? { categoria: cat } : {}),
  })
  let totalPeriodo = 0
  for (const d of lista) totalPeriodo += Number(d.valor) || 0

  const msg = req.query.msg || ''
  const alert =
    msg === 'ok'
      ? `<div class="alert alert-success">${ic.check} Despesa registrada.</div>`
      : msg === 'err'
        ? `<div class="alert alert-error">${ic.warn} Confira valor e dados.</div>`
        : ''

  const optsCat =
    `<option value="" ${!cat ? 'selected' : ''}>Todas categorias</option>` +
    CATEGORIAS_DESPESA.map((c) => `<option value="${escapeHtml(c)}" ${cat === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')

  const linhasTab = lista.length
    ? lista
        .map(
          (d) => `
  <tr>
    <td>${escapeHtml(String(d.data))}</td>
    <td>${escapeHtml(d.descricao)}</td>
    <td>${escapeHtml(d.categoria)}</td>
    <td>${fmtBRL(d.valor)}</td>
    <td class="td-muted">${d.obs ? escapeHtml(d.obs) : '—'}</td>
  </tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><div class="empty"><div class="empty-text">Sem despesas no período.</div></div></td></tr>`

  const optsCatNova = CATEGORIAS_DESPESA.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')

  const body = `
  <a href="/recepcao/agenda" class="btn btn-ghost btn-sm" style="margin-bottom:1rem;display:inline-flex">${ic.back} Voltar à agenda</a>
  ${alert}
  <p class="form-hint" style="margin-bottom:1rem">${ic.cal} Período padrão: semana corrente (segunda a domingo, até hoje). Ajuste as datas para ver outro intervalo.</p>
  <div class="toolbar" style="flex-wrap:wrap;margin-bottom:1rem">
    <div class="toolbar-group"><span class="toolbar-label">De</span><input type="date" lang="pt-BR" name="de" form="filtDespRec" value="${escapeHtml(de)}"></div>
    <div class="toolbar-group"><span class="toolbar-label">Até</span><input type="date" lang="pt-BR" name="ate" form="filtDespRec" value="${escapeHtml(ate)}"></div>
    <div class="toolbar-group"><span class="toolbar-label">Categoria</span><select name="cat" form="filtDespRec">${optsCat}</select></div>
    <form id="filtDespRec" method="GET" action="/recepcao/despesas"><button type="submit" class="btn btn-primary btn-sm">${ic.cal} Filtrar</button></form>
  </div>

  <div class="stats" style="margin-bottom:1rem">
    <div class="stat"><div class="stat-icon amber">${ic.money}</div><div class="stat-val">${fmtBRL(totalPeriodo)}</div><div class="stat-lbl">Total do período</div></div>
  </div>

  <div class="section-header"><span class="section-title">${ic.plus} Nova despesa</span></div>
  <div class="form-card" style="max-width:640px;margin-bottom:1.25rem">
    <form method="POST" action="/recepcao/despesas/criar" class="form-row" style="flex-wrap:wrap;gap:.75rem;align-items:flex-end">
      <div class="form-group" style="margin:0;flex:2;min-width:160px"><label class="form-label">Descrição</label><input type="text" name="descricao" required placeholder="Ex.: Compra de material"></div>
      <div class="form-group" style="margin:0;width:120px"><label class="form-label">Valor</label><input type="text" inputmode="decimal" name="valor" required placeholder="150,00"></div>
      <div class="form-group" style="margin:0"><label class="form-label">Categoria</label><select name="categoria">${optsCatNova}</select></div>
      <div class="form-group" style="margin:0"><label class="form-label">Data</label><input type="date" lang="pt-BR" name="data" value="${escapeHtml(hojeStr())}" required></div>
      <div class="form-group" style="margin:0;flex:1;min-width:140px"><label class="form-label">Obs.</label><input type="text" name="obs" placeholder="Opcional"></div>
      <button type="submit" class="btn btn-primary">${ic.check} Salvar despesa</button>
    </form>
  </div>

  <div class="section-header"><span class="section-title">${ic.cal} Despesas no período</span></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Valor</th><th>Obs</th></tr></thead>
      <tbody>${linhasTab}</tbody>
    </table>
  </div>
  `

  res.send(shell('despesas', 'Despesas', 'Registro de saídas (recepção)', body, '', 'recepcao'))
})

receptionRouter.post('/despesas/criar', express.urlencoded({ extended: false }), (req, res) => {
  const { descricao, data, obs } = req.body
  let valorRaw = req.body.valor != null ? String(req.body.valor) : ''
  valorRaw = valorRaw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const valor = Number.parseFloat(valorRaw)
  const categoria = req.body.categoria || 'outros'
  if (!descricao?.trim() || !data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(valor)) {
    return res.redirect(`/recepcao/despesas?msg=err`)
  }
  criarDespesa({
    descricao: descricao.trim(),
    valor,
    categoria,
    data,
    registrado_por: 'recepcao',
    obs: obs?.trim() ? obs.trim() : null,
  })
  log(`Recepção: despesa "${descricao}" ${valor}`)
  res.redirect(`/recepcao/despesas?msg=ok`)
})

// ═══════════════════════════════════════════════════════════════
//  ROTAS DE CAIXA (recepção)
// ═══════════════════════════════════════════════════════════════

receptionRouter.post('/caixa/fundo-inicial', express.json(), (req, res) => {
  const { valor } = req.body || {}
  try {
    definirFundoInicial(hojeStr(), Number(valor) || 0)
    res.json({ ok: true })
  } catch (e) { log('Erro fundo-inicial:', e.message); res.status(500).json({ erro: e.message }) }
})

receptionRouter.post('/caixa/pagar-atendimento', express.json(), (req, res) => {
  const { agendamento_id, pagamento_itens, valor_recebido_dinheiro, troco, produtos_vendidos } = req.body || {}
  if (!agendamento_id || !pagamento_itens?.length) {
    return res.status(400).json({ erro: 'agendamento_id e pagamento_itens são obrigatórios' })
  }
  try {
    const ag = getAgendamento(Number(agendamento_id))
    if (!ag) return res.status(404).json({ erro: 'Agendamento não encontrado' })
    const servico = getDb().prepare(`SELECT * FROM servicos WHERE id = ?`).get(ag.servico_id)
    const hoje = hojeStr()
    getOuCriarCaixaDia(hoje)

    registrarPagamentoCaixa({
      data: hoje, tipo: 'servico', agendamento_id: ag.id, venda_produto_id: null,
      staff_id: ag.staff_id,
      descricao: `${servico?.nome || ag.servico_id} — ${ag.cliente_nome || 'Cliente'}`,
      valor_servico: servico?.preco || 0,
      pagamento_itens,
      valor_recebido_dinheiro: Number(valor_recebido_dinheiro) || 0,
      troco: Number(troco) || 0,
    })

    if (Array.isArray(produtos_vendidos) && produtos_vendidos.length > 0) {
      for (const pv of produtos_vendidos) {
        const prod = getDb().prepare(`SELECT * FROM produtos WHERE id = ?`).get(pv.produto_id)
        if (!prod) continue
        const vendaId = registrarVendaProdutoAvulsa({
          whatsapp_number: ag.whatsapp_number,
          produto_id: pv.produto_id,
          quantidade: pv.quantidade,
          valor_unitario: prod.preco,
        })
        getDb().prepare(`UPDATE vendas_produtos SET agendamento_id = ? WHERE id = ?`).run(ag.id, vendaId)
        registrarPagamentoCaixa({
          data: hoje, tipo: 'produto', agendamento_id: ag.id, venda_produto_id: vendaId,
          staff_id: ag.staff_id,
          descricao: `${prod.nome} (x${pv.quantidade})`,
          valor_servico: prod.preco * pv.quantidade,
          pagamento_itens,
          valor_recebido_dinheiro: 0, troco: 0,
        })
      }
    }

    // Conclui o agendamento independente do status kanban atual
    // (pode ser 'confirmado', 'chegou' ou 'em_atendimento')
    getDb().prepare(`
      UPDATE agendamentos
      SET status = 'concluido',
          presenca_confirmada_at = COALESCE(presenca_confirmada_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ? AND status NOT IN ('cancelado','no_show','concluido')
    `).run(ag.id)
    log(`Caixa: pagamento registrado — agendamento #${ag.id}`)
    res.json({ ok: true })
  } catch (e) {
    log('Erro pagar-atendimento:', e.message)
    res.status(500).json({ erro: e.message })
  }
})

receptionRouter.post('/caixa/venda-produto-avulsa', express.json(), (req, res) => {
  const { produto_id, quantidade, staff_id, pagamento_itens, valor_recebido_dinheiro, troco } = req.body || {}
  if (!produto_id || !staff_id || !pagamento_itens?.length) {
    return res.status(400).json({ erro: 'produto_id, staff_id e pagamento_itens são obrigatórios' })
  }
  try {
    const prod = getDb().prepare(`SELECT * FROM produtos WHERE id = ?`).get(produto_id)
    if (!prod) return res.status(404).json({ erro: 'Produto não encontrado' })
    const qtd = Number(quantidade) || 1
    const hoje = hojeStr()
    const vendaId = registrarVendaProdutoAvulsa({ whatsapp_number: 'avulso', produto_id, quantidade: qtd, valor_unitario: prod.preco })
    registrarPagamentoCaixa({
      data: hoje, tipo: 'produto', agendamento_id: null, venda_produto_id: vendaId,
      staff_id,
      descricao: `${prod.nome} (x${qtd}) — avulso`,
      valor_servico: prod.preco * qtd,
      pagamento_itens,
      valor_recebido_dinheiro: Number(valor_recebido_dinheiro) || 0,
      troco: Number(troco) || 0,
    })
    log(`Caixa: venda produto avulso — ${prod.nome} x${qtd}`)
    res.json({ ok: true })
  } catch (e) { log('Erro venda-produto-avulsa:', e.message); res.status(500).json({ erro: e.message }) }
})

receptionRouter.post('/caixa/estornar/:id', (req, res) => {
  const id = Number(req.params.id)
  estornarPagamentoCaixa(id)
  log(`Caixa: estorno pagamento #${id}`)
  res.json({ ok: true })
})

receptionRouter.post('/caixa/definir-fundo', express.urlencoded({ extended: false }), (req, res) => {
  definirFundoInicial(hojeStr(), Number(req.body?.valor) || 0)
  res.redirect(`/recepcao/caixa`)
})

receptionRouter.post('/caixa/fechar', express.urlencoded({ extended: false }), (req, res) => {
  const hoje = req.body.data || hojeStr()  // permite fechar caixa retroativo
  const resultado = fecharCaixaDia(hoje, 'recepcao')
  if (resultado.erro) return res.redirect(`/recepcao/caixa?msg=pendentes`)

  try {
    const andyPhone = getConfig('andy_phone') || ''
    const andyNum = andyPhone.replace(/\D/g, '').replace(/@.*/, '')
    if (andyNum && andyNum.length >= 10) {
      const jid = andyNum.endsWith('@c.us') ? andyNum : `${andyNum}@c.us`
      const r = resultado.resumo
      const dataLabel = new Date(hoje + 'T12:00:00-03:00').toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: 'long', timeZone: 'America/Sao_Paulo',
      })
      const formasTexto = Object.entries(r.totaisPorForma)
        .filter(([, v]) => v > 0)
        .map(([f, v]) => `  • ${FORMAS_LABEL_SERVER[f] || f}: R$ ${Number(v).toFixed(2).replace('.', ',')}`)
        .join('\n')
      const porBarbeiroTexto = r.porBarbeiro
        .filter(b => b.total > 0)
        .map(b => `  • ${b.nome}: ${b.atendimentos} atend. / ${b.produtos} prod. → R$ ${Number(b.total).toFixed(2).replace('.', ',')}`)
        .join('\n')
      const estornosTexto = r.estornos && r.estornos.length > 0
        ? `\n\n⚠️ *Estornos realizados (${r.estornos.length}):*\n` +
          r.estornos.map(e => `  • ${e.descricao} — R$ ${Number(e.valor_servico).toFixed(2).replace('.', ',')} (${e.barbeiro_nome || e.staff_id})`).join('\n') +
          `\n  Total estornado: -R$ ${Number(r.totalEstornado).toFixed(2).replace('.', ',')}`
        : ''
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      const msg = `📊 *FECHAMENTO DE CAIXA — ${dataLabel.toUpperCase()}*\n\n💰 *Total bruto:* R$ ${Number(r.totalBruto).toFixed(2).replace('.', ',')}\n💸 *Total despesas:* R$ ${Number(r.totalDespesas).toFixed(2).replace('.', ',')}\n✅ *Saldo líquido:* R$ ${Number(r.saldoLiquido).toFixed(2).replace('.', ',')}${estornosTexto}\n\n📋 *Por forma de pagamento:*\n${formasTexto || '  — Nenhum pagamento'}\n\n👤 *Por barbeiro:*\n${porBarbeiroTexto || '  — Nenhum atendimento'}\n\n🛒 *Atendimentos:* ${r.atendimentos} | *Produtos:* ${r.vendasProdutos}\n💵 *Fundo inicial:* R$ ${Number(r.caixa.fundo_inicial).toFixed(2).replace('.', ',')}\n\n_Fechado às ${hora} pela recepção_`
      enfileirarMensagem(jid, msg, 'critica')
    }
  } catch (e) { log('Erro ao enviar WhatsApp fechamento:', e.message) }

  log(`Caixa: fechado — ${hoje}`)
  res.redirect(`/recepcao/caixa?msg=fechado`)
})

receptionRouter.post('/caixa/reabrir', express.urlencoded({ extended: false }), (req, res) => {
  reabrirCaixaDia(hojeStr())
  log(`Caixa: reaberto — ${hojeStr()}`)
  res.redirect(`/recepcao/caixa?msg=reaberto`)
})

receptionRouter.get('/caixa', (req, res) => {
  const data = req.query.data || hojeStr()
  const resumo = getResumoCaixaDia(data)
  const caixa = resumo.caixa
  const msg = req.query.msg || ''
  const dataLabel = new Date(data + 'T12:00:00-03:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo',
  })

  const linhasPag = resumo.pagamentos.length
    ? resumo.pagamentos.map(p => {
        const itens = (() => { try { return JSON.parse(p.pagamento_itens || '[]') } catch { return [] } })()
        const formasStr = itens.map(i => `${FORMAS_LABEL_SERVER[i.forma] || i.forma}: R${Number(i.valor).toFixed(2).replace('.',',')}`).join(' + ')
        return `<tr>
          <td class="td-muted">${formatDataHoraPainel(p.created_at)}</td>
          <td>${escapeHtml(p.descricao)}</td>
          <td><span style="font-size:.72rem;color:${p.tipo==='produto'?'#f59e0b':'#60a5fa'}">${p.tipo === 'produto' ? 'Produto' : 'Serviço'}</span></td>
          <td>${escapeHtml(p.barbeiro_nome || p.staff_id)}</td>
          <td style="font-size:.75rem;color:#aaa">${escapeHtml(formasStr)}</td>
          <td style="color:var(--green);font-weight:600">${fmtBRL(p.valor_servico)}</td>
          <td><button class="btn btn-danger btn-sm" onclick="if(confirm('Estornar este pagamento? Isso será registrado no relatório.'))fetch('/recepcao/caixa/estornar/${p.id}',{method:'POST'}).then(()=>location.reload())">Estornar</button></td>
        </tr>`
      }).join('')
    : `<tr><td colspan="7"><div class="empty"><div class="empty-text">Nenhum pagamento registrado hoje</div></div></td></tr>`

  // Linhas de estornos do dia
  const linhasEstornos = resumo.estornos && resumo.estornos.length
    ? resumo.estornos.map(e => `
        <tr style="opacity:.65">
          <td class="td-muted">${formatDataHoraPainel(e.estornado_em)}</td>
          <td style="text-decoration:line-through;color:var(--muted)">${escapeHtml(e.descricao)}</td>
          <td><span style="font-size:.72rem;color:var(--red-sem)">Estornado</span></td>
          <td>${escapeHtml(e.barbeiro_nome || e.staff_id)}</td>
          <td style="font-size:.75rem;color:#555">—</td>
          <td style="color:var(--red-sem);font-weight:600">-${fmtBRL(e.valor_servico)}</td>
          <td></td>
        </tr>`).join('')
    : ''

  const alertaPendentes = resumo.semPagamento.length
    ? `<div style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);border-radius:var(--radius-sm);margin-bottom:1rem;overflow:hidden">
        <div style="padding:.7rem 1rem;color:var(--amber);font-size:.82rem;font-weight:600;display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="var n=this.nextElementSibling;n.style.display=n.style.display==='none'?'block':'none'">
          <span>${ic.warn} ${resumo.semPagamento.length} atendimento(s) sem pagamento — clique para regularizar</span>
          <span style="font-size:.7rem;opacity:.7">▼</span>
        </div>
        <div style="display:block;border-top:1px solid rgba(245,158,11,.2)">
          ${resumo.semPagamento.map(a => `
          <div style="padding:.75rem 1rem;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
            <div style="flex:1;min-width:160px">
              <div style="font-size:.82rem;font-weight:600;color:var(--text1)">${escapeHtml(a.cliente_nome || 'Cliente')}</div>
              <div style="font-size:.72rem;color:var(--muted)">${escapeHtml(a.servico_nome || a.servico_id)} &middot; ${formatHora(a.data_hora_inicio)} &middot; <span style="color:var(--green);font-weight:600">R$ ${Number(a.servico_preco||0).toFixed(2).replace('.',',')}</span></div>
            </div>
            <form onsubmit="pagarPendente(event,${a.id},${a.servico_preco||0})" style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <select name="forma" style="padding:.3rem .5rem;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text1);font-size:.75rem">
                <option value="pix">Pix</option>
                <option value="dinheiro">Dinheiro</option>
                <option value="cartao_debito">Cartão Débito</option>
                <option value="cartao_credito">Cartão Crédito</option>
              </select>
              <button type="submit" class="btn btn-primary btn-sm" style="font-size:.72rem;padding:.3rem .75rem">${ic.check} Registrar</button>
            </form>
          </div>`).join('')}
        </div>
      </div>` : ''

  const body = `
  <div class="toolbar" style="margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
    <div style="display:flex;align-items:center;gap:.5rem">
      <span class="toolbar-label" style="font-size:.75rem;color:var(--muted)">Data do caixa:</span>
      <input type="date" lang="pt-BR" id="caixaDataNav" value="${data}" style="padding:5px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text1);font-size:.8rem"
        onchange="window.location.href='/recepcao/caixa?data='+this.value">
    </div>
    ${data !== hojeStr() ? `<span style="font-size:.72rem;background:rgba(245,158,11,.15);color:var(--amber);padding:.2rem .65rem;border-radius:20px;border:1px solid rgba(245,158,11,.3)">${ic.warn} Caixa retroativo — ${dataLabel}</span>` : ''}
    <a href="/recepcao/caixa/historico" class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:.75rem">${ic.list || '📋'} Histórico de caixas</a>
  </div>
  ${msg === 'fechado' ? `<div class="alert alert-success">${ic.check} Caixa fechado! Relatório enviado para o Andy.</div>` : ''}
  ${msg === 'reaberto' ? `<div class="alert alert-success">${ic.check} Caixa reaberto.</div>` : ''}
  ${msg === 'pendentes' ? `<div class="alert" style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);color:var(--amber);padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.82rem;margin-bottom:1rem">${ic.warn} Há atendimentos sem pagamento. Regularize antes de fechar ou use o admin para forçar.</div>` : ''}
  ${alertaPendentes}
  <div class="stats" style="margin-bottom:1.25rem">
    <div class="stat"><div class="stat-icon green">${ic.money}</div><div class="stat-val">${fmtBRL(resumo.totalBruto)}</div><div class="stat-lbl">Total bruto</div><div class="stat-accent green"></div></div>
    <div class="stat"><div class="stat-icon amber">${ic.box}</div><div class="stat-val">${fmtBRL(resumo.totalDespesas)}</div><div class="stat-lbl">Despesas</div></div>
    <div class="stat"><div class="stat-icon ${resumo.saldoLiquido >= 0 ? 'green' : 'red'}">${ic.chart}</div><div class="stat-val">${fmtBRL(resumo.saldoLiquido)}</div><div class="stat-lbl">Saldo líquido</div><div class="stat-accent ${resumo.saldoLiquido >= 0 ? 'green' : ''}"></div></div>
    <div class="stat"><div class="stat-icon blue">${ic.cal}</div><div class="stat-val">${resumo.atendimentos}</div><div class="stat-lbl">Atendimentos</div><div class="stat-accent blue"></div></div>
  </div>
  <div class="section-header"><span class="section-title">Por forma de pagamento</span></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.65rem;margin-bottom:1.25rem">
    ${Object.entries(resumo.totaisPorForma).map(([f, v]) => `<div class="stat" style="padding:.85rem 1rem"><div class="stat-val" style="font-size:1.1rem">${fmtBRL(v)}</div><div class="stat-lbl">${FORMAS_LABEL_SERVER[f] || f}</div></div>`).join('')}
  </div>
  <div class="section-header"><span class="section-title">Por barbeiro</span></div>
  <div class="table-wrap" style="margin-bottom:1.25rem">
    <table>
      <thead><tr><th>Barbeiro</th><th>Atendimentos</th><th>Produtos</th><th>Total</th></tr></thead>
      <tbody>${resumo.porBarbeiro.length ? resumo.porBarbeiro.map(b => `<tr><td>${escapeHtml(b.nome)}</td><td class="td-muted">${b.atendimentos}</td><td class="td-muted">${b.produtos}</td><td style="color:var(--green);font-weight:600">${fmtBRL(b.total)}</td></tr>`).join('') : `<tr><td colspan="4"><div class="empty"><div class="empty-text">Sem dados</div></div></td></tr>`}</tbody>
    </table>
  </div>
  <div class="section-header"><span class="section-title">Pagamentos registrados</span><span class="section-count">${resumo.pagamentos.length}</span></div>
  <div class="table-wrap" style="margin-bottom:1.25rem">
    <table>
      <thead><tr><th>Hora</th><th>Descrição</th><th>Tipo</th><th>Barbeiro</th><th>Formas</th><th>Valor</th><th></th></tr></thead>
      <tbody>${linhasPag}${linhasEstornos}</tbody>
    </table>
  </div>
  <div class="form-card" style="max-width:480px;margin-bottom:1.25rem">
    <div class="form-card-title">${ic.money} Status do caixa</div>
    <div class="config-row" style="padding:.65rem 0">
      <div class="config-meta"><div class="key">Fundo inicial</div><div class="desc">Não entra no faturamento</div></div>
      <div style="display:flex;align-items:center;gap:.5rem">
        <span style="font-weight:600;color:var(--amber)">${fmtBRL(caixa.fundo_inicial)}</span>
        ${caixa.status === 'aberto' ? `<form method="POST" action="/recepcao/caixa/definir-fundo" style="display:flex;gap:.35rem;align-items:center"><input type="number" name="valor" min="0" step="0.01" placeholder="0,00" style="width:90px;padding:.35rem .5rem;font-size:.82rem"><button class="btn btn-ghost btn-sm" type="submit">Atualizar</button></form>` : ''}
      </div>
    </div>
    <div class="config-row" style="padding:.65rem 0">
      <div class="config-meta"><div class="key">Status</div></div>
      ${caixa.status === 'aberto' ? `<span style="color:var(--green);font-weight:600">🟢 Aberto</span>` : `<span style="color:var(--muted);font-weight:600">🔴 Fechado em ${formatDataHoraPainel(caixa.fechado_em)}</span>`}
    </div>
  </div>
  <div style="display:flex;gap:.75rem;flex-wrap:wrap">
    ${caixa.status === 'aberto'
      ? `<form method="POST" action="/recepcao/caixa/fechar"><input type="hidden" name="data" value="${data}"><button type="submit" class="btn btn-primary" onclick="return confirm('Fechar caixa de ' + '${dataLabel}' + '? Relatório será enviado para o Andy.')">${ic.check} ${data === hojeStr() ? 'Fechar caixa do dia' : 'Fechar caixa retroativo'}</button></form>`
      : `<form method="POST" action="/recepcao/caixa/reabrir"><button type="submit" class="btn btn-ghost" onclick="return confirm('Reabrir o caixa?')">Reabrir caixa</button></form>`}
    <a href="/recepcao/caixa/historico" class="btn btn-ghost">${ic.cal} Histórico</a>
  </div>`


  const script = `
    async function pagarPendente(e, agId, preco) {
      e.preventDefault()
      const forma = e.target.querySelector('[name=forma]').value
      const btn = e.target.querySelector('button')
      btn.disabled = true
      btn.textContent = 'Salvando...'
      try {
        const r = await fetch('/recepcao/caixa/pagar-atendimento', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agendamento_id: agId,
            pagamento_itens: [{ forma: forma, valor: Number(preco) }]
          })
        })
        const d = await r.json()
        if (d.erro) { alert('Erro: ' + d.erro); btn.disabled = false; btn.textContent = 'Registrar'; return }
        e.target.closest('[style*="border-bottom"]').style.opacity = '0.4'
        e.target.innerHTML = '<span style="color:var(--green)">✓ Registrado</span>'
        setTimeout(() => location.reload(), 800)
      } catch(err) { alert('Falha ao registrar'); btn.disabled = false; btn.textContent = 'Registrar' }
    }
  `
  res.send(shell('caixa', 'Caixa do Dia', dataLabel, body, script, 'recepcao'))
})

receptionRouter.get('/caixa/historico', (req, res) => {
  const de  = req.query.de  || primeiroDiaMesAtualBR()
  const ate = req.query.ate || hojeStr()
  const caixas = listarCaixas({ dataInicio: de, dataFim: ate, limit: 60 })

  const linhas = caixas.length
    ? caixas.map(c => {
        const r = getResumoCaixaDia(c.data)
        return `<tr>
          <td><a href="/recepcao/caixa?data=${encodeURIComponent(c.data)}" style="color:var(--blue-l)">${escapeHtml(c.data)}</a></td>
          <td style="color:var(--green);font-weight:600">${fmtBRL(r.totalBruto)}</td>
          <td style="color:var(--amber)">${fmtBRL(r.totalDespesas)}</td>
          <td style="color:${r.saldoLiquido>=0?'var(--green)':'var(--red-sem)'};font-weight:600">${fmtBRL(r.saldoLiquido)}</td>
          <td class="td-muted">${r.atendimentos}</td>
          <td>${c.status === 'fechado' ? `<span style="background:rgba(34,197,94,.12);color:#4ade80;padding:.2rem .65rem;border-radius:20px;font-size:.68rem;font-weight:600">Fechado</span>` : `<span style="background:rgba(245,158,11,.12);color:#f59e0b;padding:.2rem .65rem;border-radius:20px;font-size:.68rem;font-weight:600">Aberto</span>`}</td>
        </tr>`
      }).join('')
    : `<tr><td colspan="6"><div class="empty"><div class="empty-text">Nenhum caixa no período</div></div></td></tr>`

  const body = `
  <div class="toolbar" style="margin-bottom:1rem">
    <div class="toolbar-group"><span class="toolbar-label">De</span><input type="date" lang="pt-BR" id="histDe" value="${escapeHtml(de)}"></div>
    <div class="toolbar-group"><span class="toolbar-label">Até</span><input type="date" lang="pt-BR" id="histAte" value="${escapeHtml(ate)}"></div>
    <button class="btn btn-ghost" onclick="filtrar()">Filtrar</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Data</th><th>Total bruto</th><th>Despesas</th><th>Saldo líquido</th><th>Atend.</th><th>Status</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
  </div>`

  const script = `function filtrar(){ window.location.href='/recepcao/caixa/historico?de='+document.getElementById('histDe').value+'&ate='+document.getElementById('histAte').value }`
  res.send(shell('caixa', 'Histórico de Caixas', `${de} a ${ate}`, body, script, 'recepcao'))
})

// ── Bloquear horário ─────────────────────────────────────────────
function bloquearGetHandler(secret) {
  return (req, res) => {
    const data    = req.query.data || hojeStr()
    const staffOpts = staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')

    const body = `
    <a href="/${secret}/agenda?data=${data}" class="btn btn-ghost btn-sm" style="margin-bottom:1.25rem;display:inline-flex">${ic.back} Voltar à agenda</a>
    <div class="form-card" style="max-width:520px">
      <div class="form-card-title">${ic.lock} Bloquear horário</div>
      <form method="POST" action="/${secret}/agenda/bloquear">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Data</label>
            <input type="date" lang="pt-BR" name="data" value="${data}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Barbeiro</label>
            <select name="staff_id" required>${staffOpts}</select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Início</label>
            <input type="time" name="inicio" required>
          </div>
          <div class="form-group">
            <label class="form-label">Fim</label>
            <input type="time" name="fim" required>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Motivo</label>
          <input type="text" name="motivo" placeholder="Ex: Compromisso pessoal, Almoço...">
          <div class="form-hint">${ic.warn} Aparece como bloqueio no Google Calendar</div>
        </div>
        <div style="display:flex;gap:.5rem;margin-top:1rem">
          <button type="submit" class="btn btn-primary">${ic.check} Bloquear</button>
          <a href="/${secret}/agenda?data=${data}" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>`

    res.send(shell('agenda', 'Bloquear Horário', 'Adiciona bloqueio no Google Calendar do barbeiro', body, '', secret))
  }
}

function bloquearPostHandler(secret) {
  return async (req, res) => {
    const { data, staff_id, inicio, fim, motivo } = req.body
    try {
      await createEvent(staff_id, {
        summary:     `🔒 ${motivo || 'Indisponível'}`,
        description: 'Bloqueio via painel Andy Na Régua',
        startTime:   `${data}T${inicio}:00-03:00`,
        endTime:     `${data}T${fim}:00-03:00`,
      })
      log(`Painel: bloqueio — ${staff_id} — ${data} ${inicio}–${fim}`)
    } catch (e) { log('Erro ao bloquear:', e.message) }
    res.redirect(`/${secret}/agenda?data=${data}`)
  }
}

router.get('/agenda/bloquear',  bloquearGetHandler('admin'))
router.post('/agenda/bloquear', bloquearPostHandler('admin'))
receptionRouter.get('/agenda/bloquear',  bloquearGetHandler('recepcao'))
receptionRouter.post('/agenda/bloquear', bloquearPostHandler('recepcao'))

// ── Agendamento Manual ───────────────────────────────────────────
function agendarManualGetHandler(secret) {
  return (req, res) => {
    const data        = req.query.data || hojeStr()
    const msg         = req.query.msg  || ''
    const servicos    = getServicosAtivos()
    const staffOpts   = staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')
    const servicoOpts = servicos.map(s =>
      `<option value="${s.id}">${s.nome} — R$${s.preco} (${s.duracao_minutos}min)</option>`
    ).join('')

    const body = `
    <a href="/${secret}/agenda?data=${data}" class="btn btn-ghost btn-sm" style="margin-bottom:1.25rem;display:inline-flex">${ic.back} Voltar à agenda</a>
    ${msg==='ok'      ? `<div class="alert alert-success">${ic.check} Agendamento criado com sucesso!</div>` : ''}
    ${msg==='err'     ? `<div class="alert alert-error">${ic.warn} Erro ao criar. Verifique os dados e tente novamente.</div>` : ''}
    ${msg==='conflict'? `<div class="alert alert-error">${ic.warn} Horário já ocupado. Escolha outro horário ou barbeiro.</div>` : ''}
    <div class="form-card" style="max-width:560px">
      <div class="form-card-title">${ic.cal} Novo agendamento manual</div>
      <form method="POST" action="/${secret}/agenda/agendar-manual">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Nome do cliente *</label>
            <input type="text" name="nome" required placeholder="Nome completo">
          </div>
          <div class="form-group">
            <label class="form-label">WhatsApp *</label>
            <input type="tel" name="whatsapp" required placeholder="47999999999" pattern="[0-9]{10,13}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Serviço *</label>
            <select name="servico_id" required>${servicoOpts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Barbeiro *</label>
            <select name="staff_id" required>${staffOpts}</select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Data *</label>
            <input type="date" lang="pt-BR" name="data" value="${data}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Horário *</label>
            <input type="time" name="horario" required step="900">
          </div>
        </div>
        <div class="form-hint" style="margin-bottom:1rem">
          ${ic.warn} Criado diretamente — confirme no Google Calendar do barbeiro após criar.
        </div>
        <div style="display:flex;gap:.5rem">
          <button type="submit" class="btn btn-primary">${ic.check} Confirmar agendamento</button>
          <a href="/${secret}/agenda?data=${data}" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>`

    res.send(shell('agenda/agendar-manual', 'Novo Agendamento', 'Criação manual pelo painel', body, '', secret))
  }
}

function agendarManualPostHandler(secret) {
  return async (req, res) => {
    const { nome, whatsapp, servico_id, staff_id, data, horario } = req.body
    if (!nome || !whatsapp || !servico_id || !staff_id || !data || !horario) {
      return res.redirect(`/${secret}/agenda/agendar-manual?msg=err&data=${data || hojeStr()}`)
    }
    try {
      const numeroLimpo = whatsapp.replace(/\D/g, '')
      const wppNumber   = numeroLimpo.startsWith('55') ? `${numeroLimpo}@c.us` : `55${numeroLimpo}@c.us`
      const start_iso   = `${data}T${horario}:00-03:00`

      const resultado = await criarAgendamentoTool({
        whatsapp_number: wppNumber,
        cliente_nome:    nome.trim(),
        staff_id,
        servico_id,
        start_iso,
      })

      if (!resultado?.sucesso) {
        const isConflict = resultado?.erro?.toLowerCase().includes('ocupado') || resultado?.erro?.toLowerCase().includes('conflito')
        return res.redirect(`/${secret}/agenda/agendar-manual?msg=${isConflict?'conflict':'err'}&data=${data}`)
      }

      log(`Painel: agendamento manual — ${nome} — ${data} ${horario} — ${servico_id}`)
      res.redirect(`/${secret}/agenda?data=${data}&msg=criado`)
    } catch (e) {
      log('Erro agendamento manual:', e.message)
      res.redirect(`/${secret}/agenda/agendar-manual?msg=err&data=${data}`)
    }
  }
}

router.get('/agenda/agendar-manual',  agendarManualGetHandler('admin'))
router.post('/agenda/agendar-manual', agendarManualPostHandler('admin'))
receptionRouter.get('/agenda/agendar-manual',  agendarManualGetHandler('recepcao'))
receptionRouter.post('/agenda/agendar-manual', agendarManualPostHandler('recepcao'))

// ── Kanban recepção ──────────────────────────────────────────────
const KANBAN_COLS = [
  { key: 'confirmado', label: 'Agendado' },
  { key: 'chegou', label: 'Chegou' },
  { key: 'em_atendimento', label: 'Em atendimento' },
  { key: 'concluido', label: 'Concluído' },
  { key: 'nao_compareceu', label: 'No-show' },
  { key: 'cancelado', label: 'Cancelado' },
]

const KANBAN_CSS = `
/* ── Layout geral ── */
.kb-content{margin:-1.5rem -1.5rem 0;padding:0}
.kb-header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #2a2a2a;flex-wrap:wrap;background:#141414;margin:-1.5rem -1.5rem 0}
.kb-header h2{font-size:14px;font-weight:500;margin:0;color:#ccc;white-space:nowrap}
.kb-header input[type=date]{padding:5px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;width:130px}
.kb-totals{display:flex;gap:0;margin-left:auto;font-size:11px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden}
.kb-totals-item{padding:6px 14px;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;align-items:center;gap:1px}
.kb-totals-item:last-child{border-right:none}
.kb-totals-item b{font-size:15px;font-weight:500;color:#fff;line-height:1}
.kb-totals-item span{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.4px}
.kb-toggle{display:flex;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;overflow:hidden}
.kb-toggle button{padding:5px 12px;border:none;background:transparent;color:#666;cursor:pointer;font-size:11px;transition:all .15s}
.kb-toggle button.active{background:#2a2a2a;color:#fff}

/* ── Board e colunas ── */
.kb-board{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:12px;min-height:calc(100vh - 110px);align-items:flex-start}
.kb-col{background:#161616;border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
.kb-col-header{padding:10px 12px 8px;display:flex;align-items:center;gap:6px}
.kb-col-header-label{font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.5px;flex:1}
.kb-col-counter{font-size:11px;background:#242424;color:#666;padding:1px 7px;border-radius:10px;font-weight:400}
.kb-col-body{padding:6px;display:flex;flex-direction:column;gap:6px;flex:1;min-height:120px;max-height:calc(100vh - 220px);overflow-y:auto;transition:background .15s;border-radius:0 0 10px 10px;scrollbar-width:thin;scrollbar-color:#333 transparent}
.kb-col-body::-webkit-scrollbar{width:4px}
.kb-col-body::-webkit-scrollbar-track{background:transparent}
.kb-col-body::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
.kb-col-empty{display:flex;align-items:center;justify-content:center;min-height:80px;border:1.5px dashed #252525;border-radius:8px;color:#333;font-size:11px;margin:2px}

/* Cores por coluna */
.kb-col[data-col=confirmado] .kb-col-header{border-bottom:2px solid #3b82f6}
.kb-col[data-col=confirmado] .kb-col-header-label{color:#60a5fa}
.kb-col[data-col=chegou] .kb-col-header{border-bottom:2px solid #8b5cf6}
.kb-col[data-col=chegou] .kb-col-header-label{color:#a78bfa}
.kb-col[data-col=em_atendimento] .kb-col-header{border-bottom:2px solid #f59e0b}
.kb-col[data-col=em_atendimento] .kb-col-header-label{color:#fbbf24}
.kb-col[data-col=concluido] .kb-col-header{border-bottom:2px solid #10b981}
.kb-col[data-col=concluido] .kb-col-header-label{color:#34d399}
.kb-col[data-col=nao_compareceu] .kb-col-header{border-bottom:2px solid #6b7280}
.kb-col[data-col=nao_compareceu] .kb-col-header-label{color:#9ca3af}
.kb-col[data-col=cancelado] .kb-col-header{border-bottom:2px solid #ef4444}
.kb-col[data-col=cancelado] .kb-col-header-label{color:#f87171}

/* ── Cards ── */
.kb-card{background:#1e1e1e;border-radius:8px;padding:10px 12px;cursor:grab;border:1px solid #2a2a2a;transition:border-color .15s,box-shadow .15s;position:relative}
.kb-card:hover{border-color:#444;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.kb-card:active{cursor:grabbing}
.kb-card:hover .card-actions{max-height:32px;opacity:1;margin-top:8px}
.card-hora{font-size:13px;font-weight:600;color:#fff;letter-spacing:.3px}
.card-nome{font-size:13px;color:#e2e8f0;margin:3px 0 1px;font-weight:500}
.card-servico{font-size:11px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-footer{display:flex;justify-content:space-between;align-items:center;margin-top:6px}
.card-preco{font-size:12px;color:#94a3b8;font-weight:500}
.card-actions{max-height:0;opacity:0;display:flex;gap:4px;overflow:hidden;transition:max-height .2s,opacity .2s,margin-top .2s;flex-wrap:wrap}
.card-btn{font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #333;background:#242424;color:#aaa;cursor:pointer;transition:all .15s;white-space:nowrap}
.card-btn:hover{border-color:#555;color:#fff}
.card-btn-green{border-color:#166534;background:#052e16;color:#4ade80}
.card-btn-green:hover{background:#14532d}
.card-btn-amber{border-color:#78350f;background:#1c1400;color:#fbbf24}
.card-btn-amber:hover{background:#451a03}
.card-btn-red{border-color:#7f1d1d;background:#1c0606;color:#f87171}
.card-btn-red:hover{background:#450a0a}

/* Badges barbeiro */
.badge-b1{background:#1e3a5f;color:#93c5fd;font-size:10px;padding:2px 7px;border-radius:4px;font-weight:500}
.badge-b2{background:#1a3a2e;color:#6ee7b7;font-size:10px;padding:2px 7px;border-radius:4px;font-weight:500}
.badge-b3{background:#3a2210;color:#fdba74;font-size:10px;padding:2px 7px;border-radius:4px;font-weight:500}

/* Timer */
.timer-badge{font-size:10px;color:#fbbf24;margin-left:6px;background:#1c1400;padding:1px 5px;border-radius:3px;border:1px solid #78350f}

/* Drag estados */
.col-drag-over .kb-col-body{background:#0d1f0d;outline:1.5px dashed #22c55e;border-radius:0 0 10px 10px}
.col-no-drop{opacity:.3;pointer-events:none}

/* Refresh */
.refresh-tag{font-size:10px;color:#4ade80;opacity:0;transition:opacity .3s}
.refresh-tag.on{opacity:1}

/* Modal */
.kb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;align-items:center;justify-content:center;z-index:1000}
.kb-overlay.open{display:flex}
.kb-modal{background:#181818;border-radius:12px;padding:24px;width:460px;max-width:95vw;border:1px solid #2a2a2a;position:relative}
.kb-modal h3{margin:0 0 18px;font-size:15px;font-weight:500;color:#e2e8f0}
.fg{margin-bottom:12px}
.fg label{display:block;font-size:11px;color:#666;margin-bottom:3px;text-transform:uppercase;letter-spacing:.3px}
.fg input,.fg select{width:100%;padding:8px 10px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;transition:border-color .15s}
.fg input:focus,.fg select:focus{outline:none;border-color:#555}
.fg select:disabled{opacity:.35}
.modal-error{color:#f87171;font-size:12px;margin-top:8px;display:none;padding:6px 10px;background:#1c0606;border-radius:4px;border:1px solid #7f1d1d}
.modal-error.on{display:block}
.btn-red{background:#dc2626;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;transition:background .15s}
.btn-red:hover{background:#b91c1c}
.btn-ghost{background:transparent;color:#666;border:1px solid #333;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12px;transition:all .15s}
.btn-ghost:hover{border-color:#555;color:#aaa}
.kb-modal-footer{display:flex;gap:8px;margin-top:18px}
.kb-modal-close{position:absolute;top:14px;right:14px;background:transparent;border:none;color:#555;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px}
.kb-modal-close:hover{color:#aaa}

/* Modo por barbeiro */
.kb-by-barber{display:none;flex-direction:column;gap:16px;padding:12px}
.kb-barber-row{border:1px solid #1e1e1e;border-radius:10px;overflow:hidden}
.kb-barber-label{font-size:12px;font-weight:500;padding:8px 12px;background:#161616;color:#ccc;border-bottom:1px solid #1e1e1e}
.kb-barber-cols{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:8px;background:#0e0e0e}
.kb-barber-cols .kb-col{background:#141414}
.kb-barber-cols .kb-col-header{padding:7px 10px 6px}
.kb-barber-cols .kb-card{padding:8px 10px}
`

function kanbanStatusKey(status) {
  if (status === 'no_show') return 'nao_compareceu'
  if (status === 'aguardando_sinal_aprovacao') return 'confirmado'
  return status
}

function kanbanBadgeClass(staffId) {
  if (staffId === 'barbeiro2') return 'badge-b2'
  if (staffId === 'barbeiro3') return 'badge-b3'
  return 'badge-b1'
}

function renderKanbanCard(ag) {
  const colKey = kanbanStatusKey(ag.status)
  const preco = Number(ag.servico_preco || 0)
  const nome = escapeHtml(ag.nome_cliente || ag.cliente_nome || 'Sem nome')
  const servico = escapeHtml(ag.servico_nome || ag.servico_id || '—')
  const barbeiro = escapeHtml(staffNameById(ag.staff_id))
  const hora = formatHora(ag.data_hora_inicio)
  const timerHtml = colKey === 'em_atendimento'
    ? `<span class="timer-badge" data-inicio="${escapeHtml(ag.data_hora_inicio)}">0min</span>`
    : ''
  let acoes = ''
  if (colKey === 'confirmado') {
    acoes = `<button type="button" class="card-btn card-btn-green" data-action="chegou" data-id="${ag.id}">✓ Chegou</button>`
      + `<button type="button" class="card-btn card-btn-red" data-action="noshow" data-id="${ag.id}">✗ No-show</button>`
      + `<button type="button" class="card-btn card-btn-red" data-action="cancelar" data-id="${ag.id}">🗑</button>`
  } else if (colKey === 'chegou') {
    acoes = `<button type="button" class="card-btn card-btn-amber" data-action="iniciar" data-id="${ag.id}">▶ Iniciar</button>`
      + `<button type="button" class="card-btn card-btn-red" data-action="noshow" data-id="${ag.id}">✗ No-show</button>`
  } else if (colKey === 'em_atendimento') {
    acoes = `<button type="button" class="card-btn card-btn-green" data-action="concluir" data-id="${ag.id}">✓ Concluir</button>`
  }
  return `
  <div class="kb-card" draggable="true" data-card-id="${ag.id}" data-staff-id="${escapeHtml(ag.staff_id)}"
       data-drag-id="${ag.id}" data-drag-status="${colKey}"
       data-ag-id="${ag.id}"
       data-nome="${escapeHtml(ag.cliente_nome || '')}"
       data-servico="${escapeHtml(ag.servico_nome || ag.servico_id || '')}"
       data-barbeiro="${escapeHtml(staffNameById(ag.staff_id))}"
       data-preco="${ag.servico_preco || 0}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <span class="card-hora">${hora}${timerHtml}</span>
      <span class="${kanbanBadgeClass(ag.staff_id)}">${barbeiro}</span>
    </div>
    <div class="card-nome">${nome}</div>
    <div class="card-servico">${servico}</div>
    <div class="card-footer">
      <span class="card-preco">R$ ${preco.toFixed(2)}</span>
    </div>
    ${acoes ? `<div class="card-actions">${acoes}</div>` : ''}
  </div>`
}

function renderKanbanColumn(col, ags) {
  const cardsHtml = ags
    .filter((a) => kanbanStatusKey(a.status) === col.key)
    .sort((a, b) => new Date(b.data_hora_inicio) - new Date(a.data_hora_inicio))
    .map((a) => renderKanbanCard(a))
    .join('')
  const count = ags.filter((a) => kanbanStatusKey(a.status) === col.key).length
  const colBody = cardsHtml || '<div class="kb-col-empty">Arraste aqui</div>'
  return `
  <div class="kb-col" data-col="${col.key}">
    <div class="kb-col-header">
      <span class="kb-col-header-label">${col.label}</span>
      <span class="kb-col-counter kb-count">${count}</span>
    </div>
    <div class="kb-col-body">${colBody}</div>
  </div>`
}

function calcularTotaisKanban(ags) {
  const ativos = ags.filter((a) => !['cancelado', 'nao_compareceu', 'no_show'].includes(a.status))
  const concluidos = ags.filter((a) => a.status === 'concluido')
  const totalValor = concluidos.reduce((s, a) => s + Number(a.servico_preco || 0), 0)
  return {
    totalAtivos: ativos.length,
    totalValor,
    qtdConcluidos: concluidos.length,
  }
}

function renderKanbanPage(req, res) {
  const panelPrefix = req.panelPrefix || 'recepcao'
  const data = req.query.data || hojeStr()
  const ags = getAgendamentosKanban(data)
  const servicos = getServicosAtivos()
  const produtosEstoque = getProdutosEmEstoque()
  const staffOptsKanban = staff.filter(s => s.active)
    .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')
  const totais = calcularTotaisKanban(ags)
  const dataTitulo = new Date(`${data}T12:00:00-03:00`).toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', timeZone: 'America/Sao_Paulo',
  })
  const tituloDia = data === hojeStr() ? `Hoje — ${dataTitulo}` : dataTitulo
  const staffOpts = staff.filter((s) => s.active).map((s) =>
    `<option value="${s.id}">${escapeHtml(s.name)}</option>`,
  ).join('')
  const servicoOpts = servicos.map((s) =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nome)} — R$${s.preco}</option>`,
  ).join('')
  const colsHtml = KANBAN_COLS.map((c) => renderKanbanColumn(c, ags)).join('')
  const barberRowsHtml = staff.filter((s) => s.active).map((s) => {
    const staffAgs = ags.filter((a) => a.staff_id === s.id)
    const cols = KANBAN_COLS.map((c) => renderKanbanColumn(c, staffAgs)).join('')
    return `
    <div class="kb-barber-row" data-staff="${escapeHtml(s.id)}">
      <div class="kb-barber-label">${escapeHtml(s.name)}</div>
      <div class="kb-barber-cols kb-board">${cols}</div>
    </div>`
  }).join('')

  const body = `
  <style>${KANBAN_CSS}</style>
  <div class="kb-content">
    <div class="kb-header">
      <h2>${escapeHtml(tituloDia)}</h2>
      <label style="font-size:11px;color:#666;display:flex;flex-direction:column;gap:3px">Data
        <input type="date" lang="pt-BR" id="kbData" value="${escapeHtml(data)}">
      </label>
      <button type="button" class="btn btn-primary btn-sm" id="btnNovoAg">${ic.plus} Novo agendamento</button>
      <div class="kb-toggle">
        <button type="button" id="toggleTodos" class="active">Todos os barbeiros</button>
        <button type="button" id="toggleBarbeiro">Por barbeiro</button>
      </div>
      <button onclick="openVendaAvulsa()"
        style="font-size:11px;padding:5px 14px;background:#1c1400;border:1px solid #78350f;color:#fbbf24;border-radius:6px;cursor:pointer">
        + Vender Produto
      </button>
      <span class="refresh-tag" id="refreshTag">Atualizado</span>
      <div class="kb-totals">
        <div class="kb-totals-item"><b>${totais.totalAtivos}</b><span>Agendados</span></div>
        <div class="kb-totals-item"><b>R$${totais.totalValor.toFixed(0)}</b><span>Em aberto</span></div>
        <div class="kb-totals-item"><b>${totais.qtdConcluidos}</b><span>Concluídos</span></div>
      </div>
    </div>
    <div id="kbBoard" class="kb-board" data-mode="todos">${colsHtml}</div>
    <div id="kbByBarber" class="kb-by-barber">${barberRowsHtml}</div>
  </div>
  <div class="kb-overlay" id="kbOverlay">
    <div class="kb-modal" onclick="event.stopPropagation()">
      <button type="button" id="kbModalClose" class="kb-modal-close" aria-label="Fechar">✕</button>
      <h3>Novo agendamento</h3>
      <div class="fg"><label>Nome do cliente *</label><input type="text" id="mNome" required></div>
      <div class="fg"><label>WhatsApp</label><input type="tel" id="mWhats" placeholder="55XXXXXXXXXXX"></div>
      <div class="fg"><label>Serviço *</label><select id="mServico" required><option value="">Selecione...</option>${servicoOpts}</select></div>
      <div class="fg"><label>Barbeiro *</label><select id="mStaff" required><option value="">Selecione...</option>${staffOpts}</select></div>
      <div class="fg"><label>Data *</label><input type="date" lang="pt-BR" id="mData" value="${escapeHtml(data)}" required></div>
      <div class="fg"><label>Horário *</label><select id="mHorario" disabled><option value="">Selecione barbeiro, data e serviço</option></select></div>
      <div class="modal-error" id="modalErr"></div>
      <div class="kb-modal-footer">
        <button type="button" class="btn-red" id="btnAgendar">Agendar</button>
        <button type="button" class="btn-ghost" id="btnModalCancel">Cancelar</button>
      </div>
    </div>
  </div>

  <div class="kb-overlay" id="payOverlay">
    <div class="kb-modal" style="width:500px;max-width:95vw">
      <button class="kb-modal-close" onclick="closePayModal()">✕</button>
      <h3 id="payModalTitle">Registrar Pagamento</h3>

      <div id="payResumo" style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="color:#888">Cliente</span>
          <span id="payClienteNome" style="color:#e2e8f0;font-weight:500"></span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="color:#888">Serviço</span>
          <span id="payServicoNome" style="color:#e2e8f0"></span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="color:#888">Barbeiro</span>
          <span id="payBarbeiroNome" style="color:#e2e8f0"></span>
        </div>
        <div style="display:flex;justify-content:space-between;font-weight:600;margin-top:6px;padding-top:6px;border-top:1px solid #2a2a2a">
          <span style="color:#888">Valor do serviço</span>
          <span id="payValorServico" style="color:#4ade80;font-size:15px"></span>
        </div>
      </div>

      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">Produtos vendidos (opcional)</div>
        <div id="payProdutosList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <button type="button" onclick="adicionarLinhaProduto()"
          style="font-size:11px;color:#60a5fa;background:transparent;border:1px dashed #1e3a5f;padding:5px 12px;border-radius:5px;cursor:pointer;width:100%">
          + Adicionar produto
        </button>
      </div>

      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">
          Formas de pagamento <span style="color:#ef4444">*</span>
        </div>
        <div id="payFormasList" style="display:flex;flex-direction:column;gap:6px"></div>
        <button type="button" onclick="adicionarLinhaForma()"
          style="font-size:11px;color:#60a5fa;background:transparent;border:1px dashed #1e3a5f;padding:5px 12px;border-radius:5px;cursor:pointer;width:100%;margin-top:6px">
          + Dividir pagamento
        </button>
      </div>

      <div id="payTrocoSection" style="display:none;background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:10px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;color:#fbbf24">Pagamento em dinheiro</span>
          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;color:#888">Recebido:</label>
            <input type="number" id="payValorRecebido" min="0" step="0.01" placeholder="0,00"
              style="width:90px;padding:5px 8px;background:#242424;border:1px solid #555;border-radius:5px;color:#fff;font-size:13px;text-align:right"
              oninput="calcularTroco()">
          </div>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="font-size:12px;color:#888">Troco a devolver:</span>
          <span id="payTrocoValor" style="font-size:14px;font-weight:600;color:#fbbf24">R$ 0,00</span>
        </div>
      </div>

      <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#888;margin-bottom:4px">
          <span>Total a pagar</span>
          <span id="payTotalAPagar" style="color:#fff;font-weight:600"></span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#888">
          <span>Total informado</span>
          <span id="payTotalInformado" style="font-weight:600"></span>
        </div>
      </div>

      <div id="payError" class="modal-error"></div>
      <div class="kb-modal-footer">
        <button class="btn-red" id="payConfirmBtn" onclick="confirmarPagamento()">Confirmar pagamento</button>
        <button class="btn-ghost" onclick="closePayModal()">Cancelar</button>
      </div>
    </div>
  </div>

  <div class="kb-overlay" id="fundoOverlay">
    <div class="kb-modal" style="width:380px;max-width:95vw">
      <h3>Abrir Caixa — Fundo Inicial</h3>
      <p style="font-size:13px;color:#888;margin-bottom:16px">
        Informe o valor em dinheiro que está no caixa antes de começar o dia.
        Este valor NÃO entra no faturamento.
      </p>
      <div class="fg">
        <label>Fundo inicial (R$)</label>
        <input type="number" id="fundoValor" min="0" step="0.01" placeholder="70,00"
          style="font-size:16px;text-align:center">
      </div>
      <div class="kb-modal-footer">
        <button class="btn-red" onclick="confirmarFundo()">Confirmar</button>
        <button class="btn-ghost" onclick="closeFundoModal()">Pular</button>
      </div>
    </div>
  </div>

  <div class="kb-overlay" id="vendaAvulsaOverlay">
    <div class="kb-modal" style="width:460px;max-width:95vw">
      <button class="kb-modal-close" onclick="closeVendaAvulsa()">✕</button>
      <h3>Venda de Produto</h3>
      <div class="fg">
        <label>Produto</label>
        <select id="vaSelectProduto" onchange="vaAtualizarPreco()">
          <option value="">Selecione...</option>
        </select>
      </div>
      <div class="fg">
        <label>Barbeiro responsável</label>
        <select id="vaSelectBarbeiro">
          ${staffOptsKanban}
        </select>
      </div>
      <div class="fg" style="display:flex;gap:8px;align-items:flex-end">
        <div style="flex:1">
          <label>Quantidade</label>
          <input type="number" id="vaQtd" min="1" value="1" oninput="vaAtualizarPreco()">
        </div>
        <div style="flex:1">
          <label>Total</label>
          <input type="text" id="vaTotal" readonly style="background:#111;color:#4ade80;font-weight:600">
        </div>
      </div>
      <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.3px;margin:12px 0 6px">
        Forma de pagamento
      </div>
      <div id="vaFormasList" style="display:flex;flex-direction:column;gap:6px"></div>
      <button type="button" onclick="vaAdicionarForma()"
        style="font-size:11px;color:#60a5fa;background:transparent;border:1px dashed #1e3a5f;padding:5px 12px;border-radius:5px;cursor:pointer;width:100%;margin-top:6px">
        + Dividir pagamento
      </button>
      <div id="vaTrocoSection" style="display:none;background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:10px;margin-top:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span style="font-size:12px;color:#fbbf24">Recebido em dinheiro:</span>
          <input type="number" id="vaValorRecebido" min="0" step="0.01" placeholder="0,00"
            style="width:90px;padding:5px 8px;background:#242424;border:1px solid #555;border-radius:5px;color:#fff;font-size:13px;text-align:right"
            oninput="vaCalcTroco()">
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px">
          <span style="font-size:12px;color:#888">Troco:</span>
          <span id="vaTrocoValor" style="font-weight:600;color:#fbbf24">R$ 0,00</span>
        </div>
      </div>
      <div id="vaError" class="modal-error" style="margin-top:10px"></div>
      <div class="kb-modal-footer" style="margin-top:14px">
        <button class="btn-red" onclick="confirmarVendaAvulsa()">Confirmar venda</button>
        <button class="btn-ghost" onclick="closeVendaAvulsa()">Cancelar</button>
      </div>
    </div>
  </div>`

  const script = `
  window.__PRODUTOS__ = ${JSON.stringify(produtosEstoque.map(p => ({ id: p.id, nome: p.nome, preco: p.preco })))};
  const PANEL_PREFIX = ${JSON.stringify(panelPrefix)};
  const KB_STAFF_NAMES = ${JSON.stringify(Object.fromEntries(staff.filter(s => s.active).map(s => [s.id, staffNameById(s.id)])))};
  const MOVIMENTOS = {
    confirmado: ['chegou','nao_compareceu','cancelado'],
    chegou: ['em_atendimento','nao_compareceu','cancelado'],
    em_atendimento: ['concluido'],
    concluido: [], nao_compareceu: [], cancelado: []
  };
  function kbStatusKey(s) {
    if (s === 'no_show') return 'nao_compareceu';
    if (s === 'aguardando_sinal_aprovacao') return 'confirmado';
    return s;
  }
  function kbBadgeClass(id) {
    if (id === 'barbeiro2') return 'badge-b2';
    if (id === 'barbeiro3') return 'badge-b3';
    return 'badge-b1';
  }
  function formatHoraJs(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' });
  }
  function cardHtml(ag) {
    const colKey = kbStatusKey(ag.status);
    const preco = Number(ag.servico_preco || 0);
    const nome = (ag.nome_cliente || ag.cliente_nome || 'Sem nome').replace(/</g,'&lt;');
    const servico = (ag.servico_nome || ag.servico_id || '—').replace(/</g,'&lt;');
    const barbeiro = (KB_STAFF_NAMES[ag.staff_id] || ag.staff_id).replace(/</g,'&lt;');
    const hora = formatHoraJs(ag.data_hora_inicio);
    const timer = colKey === 'em_atendimento'
      ? '<span class="timer-badge" data-inicio="'+ag.data_hora_inicio+'">'+Math.floor((Date.now()-new Date(ag.data_hora_inicio))/60000)+'min</span>' : '';
    const btnChegou = '<button type="button" class="card-btn card-btn-green" data-action="chegou" data-id="'+ag.id+'">✓ Chegou</button>';
    const btnIniciar = '<button type="button" class="card-btn card-btn-amber" data-action="iniciar" data-id="'+ag.id+'">▶ Iniciar</button>';
    const btnConcluir = '<button type="button" class="card-btn card-btn-green" data-action="concluir" data-id="'+ag.id+'">✓ Concluir</button>';
    const btnNoshow = '<button type="button" class="card-btn card-btn-red" data-action="noshow" data-id="'+ag.id+'">✗ No-show</button>';
    const btnCancel = '<button type="button" class="card-btn card-btn-red" data-action="cancelar" data-id="'+ag.id+'">🗑</button>';
    let acoes = '';
    if (colKey === 'confirmado') acoes = btnChegou + btnNoshow + btnCancel;
    else if (colKey === 'chegou') acoes = btnIniciar + btnNoshow;
    else if (colKey === 'em_atendimento') acoes = btnConcluir;
    return '<div class="kb-card" draggable="true" data-card-id="'+ag.id+'" data-staff-id="'+ag.staff_id+'" data-drag-id="'+ag.id+'" data-drag-status="'+colKey+'"'
      + ' data-ag-id=\"'+ag.id+'\"'
      + ' data-nome=\"'+String(ag.cliente_nome || '').replace(/</g,'&lt;')+'\"'
      + ' data-servico=\"'+String(ag.servico_nome || ag.servico_id || '').replace(/</g,'&lt;')+'\"'
      + ' data-barbeiro=\"'+String(KB_STAFF_NAMES[ag.staff_id] || ag.staff_id).replace(/</g,'&lt;')+'\"'
      + ' data-preco=\"'+preco+'\">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      + '<span class="card-hora">'+hora+timer+'</span>'
      + '<span class="'+kbBadgeClass(ag.staff_id)+'">'+barbeiro+'</span>'
      + '</div>'
      + '<div class="card-nome">'+nome+'</div>'
      + '<div class="card-servico">'+servico+'</div>'
      + '<div class="card-footer"><span class="card-preco">R$ '+preco.toFixed(2)+'</span></div>'
      + (acoes ? '<div class="card-actions">'+acoes+'</div>' : '')
      + '</div>';
  }

  // ── Constantes de formas de pagamento ──────────────────────────
  const FORMAS_PAG = ['pix', 'dinheiro', 'debito', 'credito']
  const FORMAS_LABEL = { pix: 'PIX', dinheiro: 'Dinheiro', debito: 'Cartão Débito', credito: 'Cartão Crédito' }

  // ── Estado do modal de pagamento ──────────────────────────────
  let _payAgendamentoId = null
  let _payValorServico = 0

  function openPayModal(agendamentoId, nome, servico, barbeiro, valor, cardEl, destCol) {
    _payAgendamentoId = agendamentoId
    _payValorServico = Number(valor) || 0

    document.getElementById('payClienteNome').textContent = nome
    document.getElementById('payServicoNome').textContent = servico
    document.getElementById('payBarbeiroNome').textContent = barbeiro
    document.getElementById('payValorServico').textContent = 'R$ ' + _payValorServico.toFixed(2).replace('.', ',')
    document.getElementById('payTotalAPagar').textContent = 'R$ ' + _payValorServico.toFixed(2).replace('.', ',')
    document.getElementById('payError').classList.remove('on')
    document.getElementById('payProdutosList').innerHTML = ''
    document.getElementById('payValorRecebido').value = ''
    document.getElementById('payTrocoSection').style.display = 'none'
    document.getElementById('payTrocoValor').textContent = 'R$ 0,00'

    const formasList = document.getElementById('payFormasList')
    formasList.innerHTML = ''
    adicionarLinhaForma()
    atualizarTotalInformado()
    document.getElementById('payOverlay').classList.add('open')
  }

  function closePayModal() {
    document.getElementById('payOverlay').classList.remove('open')
    _payAgendamentoId = null
  }

  function adicionarLinhaForma(formaDefault = 'pix', valorDefault = '') {
    const container = document.getElementById('payFormasList')
    const isUnica = container.children.length === 0 // primeira linha
    const div = document.createElement('div')
    div.style.cssText = 'display:flex;gap:6px;align-items:center'
    const opts = FORMAS_PAG.map(f => '<option value="'+f+'"'+(f===formaDefault?' selected':'')+'>'+FORMAS_LABEL[f]+'</option>').join('')
    // Para formas não-dinheiro em linha única: sem campo de valor (usa total automaticamente)
    const formaInicial = formaDefault || 'pix'
    const precisaValor = formaInicial === 'dinheiro' || !isUnica
    const inputStyle = precisaValor
      ? 'width:110px;padding:7px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;text-align:right'
      : 'width:110px;padding:7px 8px;background:#181818;border:1px solid #222;border-radius:6px;color:#555;font-size:13px;text-align:right'
    const inputPlaceholder = precisaValor ? 'Valor' : 'Total auto'
    const inputReadonly = precisaValor ? '' : 'readonly '
    const inputValue = precisaValor ? (valorDefault || '') : getValorTotalComProdutos().toFixed(2)
    div.innerHTML =
      '<select onchange="onFormaChange(this)" style="flex:1;padding:7px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px">'+opts+'</select>'
      + '<input type="number" min="0" step="0.01" placeholder="'+inputPlaceholder+'" value="'+inputValue+'"'
      + ' '+inputReadonly
      + ' style="'+inputStyle+'"'
      + ' oninput="atualizarTotalInformado()">'
      + '<button type="button" onclick="onRemoveForma(this)"'
      + ' style="background:transparent;border:none;color:#555;cursor:pointer;font-size:16px;padding:0 4px">✕</button>'
    container.appendChild(div)
    verificarDinheiro()
    atualizarTotalInformado()
  }

  // Chamado quando muda a forma de pagamento em uma linha
  function onFormaChange(sel) {
    const linha = sel.parentElement
    const input = linha.querySelector('input[type=number]')
    const container = document.getElementById('payFormasList')
    const isUnica = container.children.length === 1
    if (sel.value === 'dinheiro' || !isUnica) {
      // Precisa de valor manual
      input.readOnly = false
      input.style.background = '#242424'
      input.style.border = '1px solid #333'
      input.style.color = '#fff'
      input.placeholder = 'Valor'
      if (input.readOnly === false && !input.value) input.value = ''
    } else {
      // Pix/Débito/Crédito único — valor automático
      input.readOnly = true
      input.style.background = '#181818'
      input.style.border = '1px solid #222'
      input.style.color = '#555'
      input.placeholder = 'Total auto'
      input.value = getValorTotalComProdutos().toFixed(2)
    }
    verificarDinheiro()
    atualizarTotalInformado()
  }

  // Ao remover uma linha: se sobrou só uma e não é dinheiro, volta para auto
  function onRemoveForma(btn) {
    btn.parentElement.remove()
    verificarDinheiro()
    atualizarTotalInformado()
    const container = document.getElementById('payFormasList')
    if (container.children.length === 1) {
      const linha = container.children[0]
      const sel = linha.querySelector('select')
      const input = linha.querySelector('input[type=number]')
      if (sel && input && sel.value !== 'dinheiro') {
        input.readOnly = true
        input.style.background = '#181818'
        input.style.border = '1px solid #222'
        input.style.color = '#555'
        input.value = getValorTotalComProdutos().toFixed(2)
        atualizarTotalInformado()
      }
    }
  }

  function adicionarLinhaProduto() {
    const container = document.getElementById('payProdutosList')
    const div = document.createElement('div')
    div.style.cssText = 'display:flex;gap:6px;align-items:center'
    const opts = (window.__PRODUTOS__ || []).map(p =>
      '<option value="'+p.id+'" data-preco="'+p.preco+'">'+p.nome+' — R$ '+Number(p.preco).toFixed(2).replace('.',',')+'</option>'
    ).join('')
    div.innerHTML =
      '<select style="flex:1;padding:7px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px" onchange="atualizarTotalComProdutos()">'
      + '<option value="">Selecione produto...</option>' + opts
      + '</select>'
      + '<input type="number" min="1" value="1" placeholder="Qtd"'
      + ' style="width:60px;padding:7px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;text-align:center"'
      + ' oninput="atualizarTotalComProdutos()">'
      + '<button type="button" onclick="this.parentElement.remove();atualizarTotalComProdutos()"'
      + ' style="background:transparent;border:none;color:#555;cursor:pointer;font-size:16px;padding:0 4px">✕</button>'
    container.appendChild(div)
  }

  function getValorTotalComProdutos() {
    let total = _payValorServico
    const linhas = document.getElementById('payProdutosList').children
    for (const l of linhas) {
      const sel = l.querySelector('select')
      const qtd = parseInt(l.querySelector('input').value) || 0
      if (sel && sel.value) {
        const preco = parseFloat(sel.selectedOptions[0]?.dataset?.preco || 0)
        total += preco * qtd
      }
    }
    return total
  }

  function atualizarTotalComProdutos() {
    const total = getValorTotalComProdutos()
    document.getElementById('payTotalAPagar').textContent = 'R$ ' + total.toFixed(2).replace('.', ',')
    atualizarTotalInformado()
  }

  function atualizarTotalInformado() {
    const linhas = document.getElementById('payFormasList').children
    let soma = 0
    for (const l of linhas) {
      // Conta tanto inputs editáveis quanto readonly (auto)
      const input = l.querySelector('input[type=number]')
      soma += parseFloat(input?.value || 0) || 0
    }
    const total = getValorTotalComProdutos()
    // Atualiza inputs readonly quando o total muda (ex: produto adicionado)
    for (const l of linhas) {
      const sel = l.querySelector('select')
      const input = l.querySelector('input[type=number]')
      const container = document.getElementById('payFormasList')
      if (input && input.readOnly && container.children.length === 1) {
        input.value = total.toFixed(2)
        soma = total // recalcula
      }
    }
    const el = document.getElementById('payTotalInformado')
    el.textContent = 'R$ ' + soma.toFixed(2).replace('.', ',')
    el.style.color = Math.abs(soma - total) < 0.01 ? '#4ade80' : '#f87171'
  }

  function verificarDinheiro() {
    const linhas = document.getElementById('payFormasList').children
    let temDinheiro = false
    for (const l of linhas) {
      if (l.querySelector('select')?.value === 'dinheiro') { temDinheiro = true; break }
    }
    document.getElementById('payTrocoSection').style.display = temDinheiro ? 'block' : 'none'
    if (!temDinheiro) document.getElementById('payTrocoValor').textContent = 'R$ 0,00'
  }

  function calcularTroco() {
    const recebido = parseFloat(document.getElementById('payValorRecebido').value) || 0
    // Soma todas as parcelas marcadas como dinheiro
    let parcelaDinheiro = 0
    const linhas = document.getElementById('payFormasList').children
    for (const l of linhas) {
      const sel = l.querySelector('select')
      if (!sel) continue
      // Verifica pelo value do select E pelo texto visível selecionado
      const forma = sel.options[sel.selectedIndex]?.value || sel.value
      if (forma === 'dinheiro') {
        // Pega APENAS o input imediato dentro da linha (não o payValorRecebido)
        const inp = Array.from(l.querySelectorAll('input')).find(i => i !== document.getElementById('payValorRecebido'))
        parcelaDinheiro += parseFloat(inp?.value || 0) || 0
      }
    }
    // Se não achou parcela de dinheiro mas só tem dinheiro na lista, usa o total a pagar
    if (parcelaDinheiro === 0) {
      const todasFormas = Array.from(document.getElementById('payFormasList').children)
      const somenteUmaForma = todasFormas.length === 1
      const unicaFormaDinheiro = somenteUmaForma && (todasFormas[0]?.querySelector('select')?.value === 'dinheiro')
      if (unicaFormaDinheiro) parcelaDinheiro = getValorTotalComProdutos()
    }
    const troco = Math.max(0, recebido - parcelaDinheiro)
    document.getElementById('payTrocoValor').textContent = 'R$ ' + troco.toFixed(2).replace('.', ',')
  }

  async function confirmarPagamento() {
    const err = document.getElementById('payError')
    err.classList.remove('on')

    const formasLinhas = document.getElementById('payFormasList').children
    const pagamentoItens = []
    for (const l of formasLinhas) {
      const forma = l.querySelector('select')?.value
      const valor = parseFloat(l.querySelector('input[type=number]')?.value || 0) || 0
      if (forma && valor > 0) pagamentoItens.push({ forma, valor })
    }

    if (pagamentoItens.length === 0) {
      err.textContent = 'Informe ao menos uma forma de pagamento com valor.'
      err.classList.add('on'); return
    }

    const totalInformado = pagamentoItens.reduce((s, i) => s + i.valor, 0)
    const totalDevido = getValorTotalComProdutos()
    if (Math.abs(totalInformado - totalDevido) > 0.01) {
      err.textContent = 'Total informado (R$ ' + totalInformado.toFixed(2).replace('.',',') + ') difere do valor a pagar (R$ ' + totalDevido.toFixed(2).replace('.',',') + ').'
      err.classList.add('on'); return
    }

    const valorRecebidoDinheiro = parseFloat(document.getElementById('payValorRecebido').value) || 0
    const parcelaDinheiro = pagamentoItens.filter(i => i.forma === 'dinheiro').reduce((s, i) => s + i.valor, 0)
    const troco = Math.max(0, valorRecebidoDinheiro - parcelaDinheiro)

    const produtoLinhas = document.getElementById('payProdutosList').children
    const produtosVendidos = []
    for (const l of produtoLinhas) {
      const sel = l.querySelector('select')
      const qtd = parseInt(l.querySelector('input').value) || 0
      if (sel && sel.value && qtd > 0) {
        const preco = parseFloat(sel.selectedOptions[0]?.dataset?.preco || 0)
        produtosVendidos.push({ produto_id: sel.value, quantidade: qtd, valor_unitario: preco })
      }
    }

    document.getElementById('payConfirmBtn').disabled = true
    try {
      const resp = await fetch('/' + PANEL_PREFIX + '/caixa/pagar-atendimento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agendamento_id: _payAgendamentoId, pagamento_itens: pagamentoItens, valor_recebido_dinheiro: valorRecebidoDinheiro, troco, produtos_vendidos: produtosVendidos }),
      })
      const data = await resp.json()
      if (!resp.ok || data.erro) throw new Error(data.erro || 'Erro ao registrar pagamento')
      closePayModal()
      location.reload()
    } catch (e) {
      err.textContent = e.message
      err.classList.add('on')
    } finally {
      document.getElementById('payConfirmBtn').disabled = false
    }
  }

  // ── Fundo inicial ──────────────────────────────────────────────
  function openFundoModal() {
    document.getElementById('fundoOverlay').classList.add('open')
    setTimeout(() => document.getElementById('fundoValor')?.focus(), 100)
  }
  function closeFundoModal() { document.getElementById('fundoOverlay').classList.remove('open') }
  async function confirmarFundo() {
    const val = parseFloat(document.getElementById('fundoValor').value) || 0
    await fetch('/' + PANEL_PREFIX + '/caixa/fundo-inicial', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valor: val }),
    })
    closeFundoModal()
  }

  function openVendaAvulsa() {
    const sel = document.getElementById('vaSelectProduto')
    sel.innerHTML = '<option value=\"\">Selecione...</option>'
    ;(window.__PRODUTOS__ || []).forEach(p => {
      const o = document.createElement('option')
      o.value = p.id
      o.dataset.preco = p.preco
      o.textContent = p.nome + ' — R$ ' + Number(p.preco).toFixed(2).replace('.',',')
      sel.appendChild(o)
    })
    document.getElementById('vaFormasList').innerHTML = ''
    vaAdicionarForma()
    document.getElementById('vaError').classList.remove('on')
    document.getElementById('vaQtd').value = 1
    document.getElementById('vaTotal').value = ''
    document.getElementById('vaTrocoSection').style.display = 'none'
    document.getElementById('vaValorRecebido').value = ''
    document.getElementById('vaTrocoValor').textContent = 'R$ 0,00'
    document.getElementById('vendaAvulsaOverlay').classList.add('open')
  }
  function closeVendaAvulsa() { document.getElementById('vendaAvulsaOverlay').classList.remove('open') }

  function vaAdicionarForma(formaDefault = 'pix', valorDefault = '') {
    const container = document.getElementById('vaFormasList')
    const div = document.createElement('div')
    div.style.cssText = 'display:flex;gap:6px;align-items:center'
    const opts = FORMAS_PAG.map(f => '<option value=\"'+f+'\"'+(f===formaDefault?' selected':'')+'>'+FORMAS_LABEL[f]+'</option>').join('')
    div.innerHTML =
      '<select onchange="vaVerificarDinheiro()" style="flex:1;padding:7px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px">'+opts+'</select>'
      + '<input type="number" min="0" step="0.01" placeholder="Valor" value="'+valorDefault+'"'
      + ' style="width:110px;padding:7px 8px;background:#242424;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;text-align:right">'
      + '<button type="button" onclick="this.parentElement.remove();vaVerificarDinheiro()"'
      + ' style="background:transparent;border:none;color:#555;cursor:pointer;font-size:16px;padding:0 4px">✕</button>'
    container.appendChild(div)
    vaVerificarDinheiro()
  }
  function vaAtualizarPreco() {
    const sel = document.getElementById('vaSelectProduto')
    const qtd = parseInt(document.getElementById('vaQtd').value) || 1
    const preco = parseFloat(sel.selectedOptions[0]?.dataset?.preco || 0)
    document.getElementById('vaTotal').value = 'R$ ' + (preco * qtd).toFixed(2).replace('.', ',')
  }
  function vaVerificarDinheiro() {
    const linhas = document.getElementById('vaFormasList').children
    let tem = false
    for (const l of linhas) if (l.querySelector('select')?.value === 'dinheiro') { tem = true; break }
    document.getElementById('vaTrocoSection').style.display = tem ? 'block' : 'none'
  }
  function vaCalcTroco() {
    const recebido = parseFloat(document.getElementById('vaValorRecebido').value) || 0
    const linhas = document.getElementById('vaFormasList').children
    let parcelaDinheiro = 0
    for (const l of linhas) {
      if (l.querySelector('select')?.value === 'dinheiro') {
        parcelaDinheiro += parseFloat(l.querySelector('input[type=number]')?.value || 0) || 0
      }
    }
    document.getElementById('vaTrocoValor').textContent = 'R$ ' + Math.max(0, recebido - parcelaDinheiro).toFixed(2).replace('.', ',')
  }
  async function confirmarVendaAvulsa() {
    const err = document.getElementById('vaError')
    err.classList.remove('on')
    const prodId  = document.getElementById('vaSelectProduto').value
    const staffId = document.getElementById('vaSelectBarbeiro').value
    const qtd     = parseInt(document.getElementById('vaQtd').value) || 0
    if (!prodId)  { err.textContent = 'Selecione um produto.'; err.classList.add('on'); return }
    if (!staffId) { err.textContent = 'Selecione o barbeiro responsável.'; err.classList.add('on'); return }
    if (qtd < 1)  { err.textContent = 'Quantidade inválida.'; err.classList.add('on'); return }

    const linhas = document.getElementById('vaFormasList').children
    const pagamentoItens = []
    for (const l of linhas) {
      const forma = l.querySelector('select')?.value
      const valor = parseFloat(l.querySelector('input[type=number]')?.value || 0) || 0
      if (forma && valor > 0) pagamentoItens.push({ forma, valor })
    }
    if (!pagamentoItens.length) { err.textContent = 'Informe a forma de pagamento.'; err.classList.add('on'); return }

    const recebido = parseFloat(document.getElementById('vaValorRecebido').value) || 0
    const parcelaDinheiro = pagamentoItens.filter(i => i.forma === 'dinheiro').reduce((s, i) => s + i.valor, 0)
    const troco = Math.max(0, recebido - parcelaDinheiro)

    try {
      const resp = await fetch('/' + PANEL_PREFIX + '/caixa/venda-produto-avulsa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ produto_id: prodId, quantidade: qtd, staff_id: staffId, pagamento_itens: pagamentoItens, valor_recebido_dinheiro: recebido, troco }),
      })
      const data = await resp.json()
      if (!resp.ok || data.erro) throw new Error(data.erro || 'Erro')
      closeVendaAvulsa()
      if (typeof toast === 'function') toast('Venda registrada!', 'success')
    } catch (e) {
      err.textContent = e.message
      err.classList.add('on')
    }
  }
  function isByBarber() {
    const el = document.getElementById('kbByBarber');
    // Checa tanto o inline style quanto se o kbBoard está oculto
    return el.style.display === 'flex' || document.getElementById('kbBoard').style.display === 'none';
  }
  function colBodyFor(status, staffId) {
    if (isByBarber() && staffId) {
      const row = document.querySelector('#kbByBarber .kb-barber-row[data-staff="'+staffId+'"]');
      return row && row.querySelector('[data-col="'+status+'"] .kb-col-body');
    }
    const board = document.getElementById('kbBoard');
    return board && board.querySelector('[data-col="'+status+'"] .kb-col-body');
  }
  function atualizarContadores() {
    const roots = isByBarber()
      ? document.querySelectorAll('#kbByBarber .kb-barber-row')
      : [document.getElementById('kbBoard')];
    roots.forEach(root => {
      if (!root) return;
      root.querySelectorAll('.kb-col').forEach(col => {
        const n = col.querySelectorAll('.kb-card').length;
        const el = col.querySelector('.kb-count');
        if (el) el.textContent = String(n);
      });
    });
  }
  let dragStatus = null;
  let dragStaff = null;
  document.addEventListener('dragstart', e => {
    const card = e.target.closest('.kb-card');
    if (!card) return;
    dragStatus = card.dataset.dragStatus;
    dragStaff = card.dataset.staffId;
    e.dataTransfer.setData('text/plain', card.dataset.dragId);
    e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragend', () => {
    dragStatus = null;
    dragStaff = null;
    document.querySelectorAll('.col-drag-over,.col-no-drop').forEach(el => {
      el.classList.remove('col-drag-over','col-no-drop');
    });
  });
  function colunasVisiveis() {
    if (isByBarber() && dragStaff) {
      const row = document.querySelector('#kbByBarber .kb-barber-row[data-staff="'+dragStaff+'"]');
      return row ? row.querySelectorAll('.kb-col') : [];
    }
    return document.querySelectorAll('#kbBoard .kb-col');
  }
  document.addEventListener('dragover', e => {
    const col = e.target.closest('.kb-col');
    if (!col || !dragStatus) return;
    if (isByBarber()) {
      const rowStaff = col.closest('.kb-barber-row')?.dataset.staff;
      if (rowStaff && dragStaff && rowStaff !== dragStaff) return;
    }
    const dest = col.dataset.col;
    const allowed = (MOVIMENTOS[dragStatus] || []).includes(dest);
    colunasVisiveis().forEach(c => {
      c.classList.remove('col-drag-over','col-no-drop');
      const d = c.dataset.col;
      const ok = (MOVIMENTOS[dragStatus] || []).includes(d);
      if (ok) c.classList.add('col-drag-over');
      else c.classList.add('col-no-drop');
    });
    if (allowed) e.preventDefault();
  });
  document.addEventListener('dragleave', e => {
    const col = e.target.closest('.kb-col');
    if (!col) return;
    if (!col.contains(e.relatedTarget)) {
      col.classList.remove('col-drag-over');
    }
  });
  function atualizarCardUI(card, dest) {
    const id = card.dataset.cardId;
    // timer badge
    const horaEl = card.querySelector('.card-hora');
    if (horaEl) {
      horaEl.querySelectorAll('.timer-badge').forEach(t => t.remove());
      if (dest === 'em_atendimento') {
        const inicio = new Date().toISOString();
        card.dataset.inicio = inicio;
        const badge = document.createElement('span');
        badge.className = 'timer-badge';
        badge.dataset.inicio = inicio;
        badge.textContent = '0min'; // Correto: acabou de iniciar
        horaEl.appendChild(badge);
      }
    }
    // botões de ação
    card.querySelectorAll('.card-actions').forEach(el => el.remove());
    let acoes = '';
    if (dest === 'confirmado') {
      acoes = '<button type="button" class="card-btn card-btn-green" data-action="chegou" data-id="'+id+'">✓ Chegou</button>'
            + '<button type="button" class="card-btn card-btn-red" data-action="noshow" data-id="'+id+'">✗ No-show</button>'
            + '<button type="button" class="card-btn card-btn-red" data-action="cancelar" data-id="'+id+'">🗑</button>';
    } else if (dest === 'chegou') {
      acoes = '<button type="button" class="card-btn card-btn-amber" data-action="iniciar" data-id="'+id+'">▶ Iniciar</button>'
            + '<button type="button" class="card-btn card-btn-red" data-action="noshow" data-id="'+id+'">✗ No-show</button>';
    } else if (dest === 'em_atendimento') {
      acoes = '<button type="button" class="card-btn card-btn-green" data-action="concluir" data-id="'+id+'">✓ Concluir</button>';
    }
    if (acoes) {
      const div = document.createElement('div');
      div.className = 'card-actions';
      div.innerHTML = acoes;
      card.appendChild(div);
    }
    // remover placeholder "Arraste aqui" se existir na coluna de destino
    const body = card.parentElement;
    if (body) body.querySelectorAll('.kb-col-empty').forEach(el => el.remove());
  }

  document.addEventListener('drop', async e => {
    const col = e.target.closest('.kb-col');
    if (!col || !dragStatus) return;
    e.preventDefault();
    const dest = col.dataset.col;
    if (!(MOVIMENTOS[dragStatus] || []).includes(dest)) return;
    const id = e.dataTransfer.getData('text/plain');
    const card = document.querySelector('[data-card-id="'+id+'"]');
    document.querySelectorAll('.col-drag-over,.col-no-drop').forEach(el => {
      el.classList.remove('col-drag-over','col-no-drop');
    });
    if (dest === 'concluido' && dragStatus !== 'concluido' && card) {
      const agId = card.dataset.agId
      const nome = card.dataset.nome || ''
      const servico = card.dataset.servico || ''
      const barbeiro = card.dataset.barbeiro || ''
      const valor = card.dataset.preco || 0
      openPayModal(agId, nome, servico, barbeiro, valor, card, dest)
      return
    }
    // Mover card visualmente ANTES da API (otimista)
    const origemBody = card ? card.parentElement : null;
    const origemStatus = dragStatus;
    const destBody = colBodyFor(dest, card ? card.dataset.staffId : null);
    if (card && destBody) {
      destBody.appendChild(card);
      card.dataset.dragStatus = dest;
      atualizarCardUI(card, dest);
      atualizarContadores();
      atualizarTimers();
    }
    try {
      const r = await fetch('/' + PANEL_PREFIX + '/kanban/mover', {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'id='+encodeURIComponent(id)+'&novo_status='+encodeURIComponent(dest)
      });
      const data = await r.json();
      if (!data.ok && card && origemBody) {
        // Reverter se a API falhar
        origemBody.appendChild(card);
        card.dataset.dragStatus = origemStatus;
        atualizarCardUI(card, origemStatus);
        atualizarContadores();
      }
    } catch (err) {
      // Reverter em caso de erro de rede
      if (card && origemBody) {
        origemBody.appendChild(card);
        card.dataset.dragStatus = origemStatus;
        atualizarCardUI(card, origemStatus);
        atualizarContadores();
      }
    }
  });
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const statusMap = { chegou:'chegou', iniciar:'em_atendimento', concluir:'concluido', noshow:'nao_compareceu', cancelar:'cancelado' };
    const novoStatus = statusMap[action];
    if (!novoStatus) return;
    // Interceptar botão "Concluir" — abre modal de pagamento
    if (novoStatus === 'concluido') {
      const card = document.querySelector('[data-card-id="'+id+'"]');
      if (card) {
        const agId     = card.dataset.agId
        const nome     = card.dataset.nome    || ''
        const servico  = card.dataset.servico || ''
        const barbeiro = card.dataset.barbeiro|| ''
        const valor    = card.dataset.preco   || 0
        openPayModal(agId, nome, servico, barbeiro, valor, card, 'concluido')
        return
      }
    }
    // Mover card visualmente ANTES da API (otimista)
    const card = document.querySelector('[data-card-id="'+id+'"]');
    const origemBody = card ? card.parentElement : null;
    const origemStatus = card ? card.dataset.dragStatus : null;
    const destBody = colBodyFor(novoStatus, card?.dataset.staffId);
    if (card && destBody) {
      destBody.appendChild(card);
      card.dataset.dragStatus = novoStatus;
      if (typeof atualizarCardUI === 'function') atualizarCardUI(card, novoStatus);
      atualizarContadores();
      atualizarTimers();
    }
    try {
      const r = await fetch('/' + PANEL_PREFIX + '/kanban/mover', {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'id='+encodeURIComponent(id)+'&novo_status='+encodeURIComponent(novoStatus)
      });
      const data = await r.json();
      if (!data.ok && card && origemBody) {
        origemBody.appendChild(card);
        card.dataset.dragStatus = origemStatus;
        if (typeof atualizarCardUI === 'function') atualizarCardUI(card, origemStatus);
        atualizarContadores();
      }
    } catch (err) {
      if (card && origemBody) {
        origemBody.appendChild(card);
        card.dataset.dragStatus = origemStatus;
        if (typeof atualizarCardUI === 'function') atualizarCardUI(card, origemStatus);
        atualizarContadores();
      }
    }
  });
  function atualizarTimers() {
    document.querySelectorAll('[data-inicio]').forEach(el => {
      const mins = Math.floor((Date.now() - new Date(el.dataset.inicio)) / 60000);
      el.textContent = mins + 'min';
    });
  }
  atualizarTimers();
  setInterval(atualizarTimers, 60000);
  const dataAtual = () => document.getElementById('kbData').value;
  document.getElementById('kbData').addEventListener('change', () => {
    window.location.href = '/' + PANEL_PREFIX + '/kanban?data=' + dataAtual();
  });
  setInterval(async () => {
    try {
      const r = await fetch('/' + PANEL_PREFIX + '/kanban/dados?data=' + dataAtual());
      const { agendamentos } = await r.json();
      agendamentos.sort((a, b) => new Date(b.data_hora_inicio) - new Date(a.data_hora_inicio))
      const ids = new Set(agendamentos.map(a => String(a.id)));
      document.querySelectorAll('.kb-card').forEach(card => {
        if (!ids.has(card.dataset.cardId)) card.remove();
      });
      agendamentos.forEach(ag => {
        const id = String(ag.id);
        let card = document.querySelector('[data-card-id="'+id+'"]');
        const colKey = kbStatusKey(ag.status);
        const target = colBodyFor(colKey, ag.staff_id);
        if (!target) return;
        if (!card) {
          target.insertAdjacentHTML('beforeend', cardHtml(ag));
        } else if (card.dataset.dragStatus !== colKey) {
          card.remove();
          target.insertAdjacentHTML('beforeend', cardHtml(ag));
        }
      });
      atualizarContadores();
      atualizarTimers();
      const tag = document.getElementById('refreshTag');
      tag.classList.add('on');
      setTimeout(() => tag.classList.remove('on'), 2000);
    } catch (err) {}
  }, 30000);
  document.getElementById('toggleTodos').addEventListener('click', () => {
    document.getElementById('kbBoard').style.display = 'flex';
    document.getElementById('kbByBarber').style.display = 'none';
    document.getElementById('toggleTodos').classList.add('active');
    document.getElementById('toggleBarbeiro').classList.remove('active');
  });
  document.getElementById('toggleBarbeiro').addEventListener('click', () => {
    document.getElementById('kbBoard').style.display = 'none';
    document.getElementById('kbByBarber').style.display = 'flex';
    document.getElementById('toggleBarbeiro').classList.add('active');
    document.getElementById('toggleTodos').classList.remove('active');
  });
  document.getElementById('btnNovoAg').addEventListener('click', () => {
    document.getElementById('kbOverlay').style.display = 'flex';
  });
  const closeModal = () => { document.getElementById('kbOverlay').style.display = 'none'; };
  document.getElementById('kbOverlay').addEventListener('click', e => {
    if (e.target.id === 'kbOverlay') closeModal();
  });
  document.getElementById('kbModalClose').addEventListener('click', closeModal);
  document.getElementById('btnModalCancel').addEventListener('click', closeModal);
  async function carregarSlots() {
    const staffId = document.getElementById('mStaff').value;
    const data = document.getElementById('mData').value;
    const servicoId = document.getElementById('mServico').value;
    if (!staffId || !data || !servicoId) return;
    const sel = document.getElementById('mHorario');
    sel.disabled = true;
    sel.innerHTML = '<option>Carregando...</option>';
    const r = await fetch('/' + PANEL_PREFIX + '/kanban/slots?staff_id='+encodeURIComponent(staffId)+'&data='+encodeURIComponent(data)+'&servico_id='+encodeURIComponent(servicoId));
    const { slots } = await r.json();
    if (!slots.length) {
      sel.innerHTML = '<option value="">Sem horários disponíveis</option>';
    } else {
      sel.innerHTML = '<option value="">Selecione...</option>' + slots.map(s => '<option value="'+s+'">'+s+'</option>').join('');
      sel.disabled = false;
    }
  }
  ['mStaff','mData','mServico'].forEach(id => document.getElementById(id).addEventListener('change', carregarSlots));
  document.getElementById('btnAgendar').addEventListener('click', async () => {
    const err = document.getElementById('modalErr');
    err.className = 'modal-error';
    const body = new URLSearchParams({
      nome: document.getElementById('mNome').value.trim(),
      whatsapp: document.getElementById('mWhats').value.trim(),
      servico_id: document.getElementById('mServico').value,
      staff_id: document.getElementById('mStaff').value,
      data: document.getElementById('mData').value,
      horario: document.getElementById('mHorario').value,
    });
    const r = await fetch('/' + PANEL_PREFIX + '/kanban/agendar', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    const res = await r.json();
    if (res.erro) {
      err.textContent = res.erro;
      err.className = 'modal-error on';
      return;
    }
    closeModal();
    location.reload();
  });`

  res.send(shell('kanban', 'Atendimentos', dataTitulo, body, script, panelPrefix))
}

receptionRouter.get('/kanban', (req, res) => {
  req.panelPrefix = 'recepcao'
  renderKanbanPage(req, res)
})
router.get('/kanban', (req, res) => {
  req.panelPrefix = 'admin'
  renderKanbanPage(req, res)
})

function registerKanbanApiRoutes(targetRouter) {
  targetRouter.get('/kanban/dados', (req, res) => {
    const data = req.query.data || hojeStr()
    res.json({ agendamentos: getAgendamentosKanban(data), timestamp: Date.now() })
  })

  targetRouter.post('/kanban/mover', express.urlencoded({ extended: false }), async (req, res) => {
  const { id, novo_status } = req.body
  const permitidos = ['chegou', 'em_atendimento', 'concluido', 'nao_compareceu', 'cancelado']
  if (!id || !permitidos.includes(novo_status)) {
    return res.status(400).json({ erro: 'Parâmetros inválidos' })
  }
  try {
    const ag = getAgendamento(Number(id))
    if (!ag) return res.status(400).json({ erro: 'Agendamento não encontrado' })
    moverAgendamentoKanban(Number(id), novo_status)
    if (novo_status === 'cancelado' && ag.google_event_id) {
      await deleteEvent(ag.staff_id, ag.google_event_id).catch(() => {})
    }
    return res.json({ ok: true })
  } catch (e) {
    return res.status(400).json({ erro: e.message || 'Erro ao mover' })
  }
  })

  targetRouter.get('/kanban/slots', async (req, res) => {
  try {
    const { staff_id, data, servico_id } = req.query
    if (!staff_id || !data || !servico_id) {
      return res.status(400).json({ erro: 'parâmetros faltando', slots: [] })
    }
    const dow = new Date(`${data}T12:00:00-03:00`).getDay()
    if (!schedule.openDays.includes(dow)) {
      return res.json({ slots: [] })
    }
    const servico = getServicoById(servico_id)
    if (!servico) return res.status(400).json({ erro: 'serviço inválido', slots: [] })
    const member = staff.find((s) => s.id === staff_id)
    if (!member?.active) return res.status(400).json({ erro: 'barbeiro inválido', slots: [] })
    const antecedenciaMinutos = Number(getConfig('antecedencia_minima_minutos') || 30)
    const limiteMinimo = new Date(Date.now() + antecedenciaMinutos * 60 * 1000)
    const raw = await findFreeSlots(staff_id, data, servico.duracao_minutos)
    const slots = raw
      .filter((slot) => new Date(slot.start) >= limiteMinimo)
      .map((slot) => slot.label || formatHora(slot.start))
    return res.json({ slots })
  } catch (e) {
    return res.status(500).json({ erro: e.message, slots: [] })
  }
  })

  targetRouter.post('/kanban/agendar', express.urlencoded({ extended: false }), async (req, res) => {
  const { nome, whatsapp, servico_id, staff_id, data, horario } = req.body
  if (!nome || !whatsapp || !servico_id || !staff_id || !data || !horario) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' })
  }
  try {
    const numeroLimpo = String(whatsapp).replace(/\D/g, '')
    const wppNumber = numeroLimpo.startsWith('55') ? `${numeroLimpo}@c.us` : `55${numeroLimpo}@c.us`
    const start_iso = `${data}T${horario}:00-03:00`
    const resultado = await criarAgendamentoTool({
      whatsapp_number: wppNumber,
      cliente_nome: nome.trim(),
      staff_id,
      servico_id,
      start_iso,
    })
    if (!resultado?.sucesso) {
      return res.status(400).json({ erro: resultado?.erro || resultado?.mensagem || 'Erro ao agendar' })
    }
    const ag = getAgendamento(resultado.agendamento_id)
    return res.json({ ok: true, agendamento: ag || resultado })
  } catch (e) {
    return res.status(400).json({ erro: e.message || 'Erro ao agendar' })
  }
  })
}

registerKanbanApiRoutes(receptionRouter)
registerKanbanApiRoutes(router)

// ═══════════════════════════════════════════════════════════════
// ROTA: /faturamento
// ═══════════════════════════════════════════════════════════════
router.get('/faturamento', (req, res) => {
  const data    = req.query.data    || hojeStr()
  const periodo = req.query.periodo || 'semana'
  const aba     = req.query.aba === 'barbeiros' ? 'barbeiros' : 'geral'

  const tabGeral = `/admin/faturamento?data=${encodeURIComponent(data)}&periodo=${periodo}&aba=geral`
  const tabBarb  = `/admin/faturamento?data=${encodeURIComponent(data)}&periodo=${periodo}&aba=barbeiros`
  const abasTopo = `
  <div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap;align-items:center">
    <a href="${tabGeral}" class="btn ${aba === 'geral' ? 'btn-primary' : 'btn-ghost'} btn-sm">Geral</a>
    <a href="${tabBarb}" class="btn ${aba === 'barbeiros' ? 'btn-primary' : 'btn-ghost'} btn-sm">Por barbeiro</a>
  </div>`

  if (aba === 'barbeiros') {
    const porBarbaraRows = getFaturamentoPorBarbeiroAdministrativo(periodo)
    const abasPeriodoBarb = ['semana', 'mes', 'ano'].map((p) => `
      <a href="/admin/faturamento?periodo=${p}&data=${encodeURIComponent(data)}&aba=barbeiros" class="btn ${periodo === p ? 'btn-primary' : 'btn-ghost'} btn-sm">${
  { semana:'7 dias', mes:'Este mês', ano:'Este ano' }[p]
}</a>`).join('')
    const linhasBarb = porBarbaraRows.length
      ? porBarbaraRows.map((row) => `
      <tr>
        <td><strong>${escapeHtml(row.nome)}</strong></td>
        <td>${row.atendimentos}</td>
        <td style="font-weight:600;color:var(--green)">R$ ${row.total_bruto.toFixed(2)}</td>
        <td class="td-muted">R$ ${row.ticket_medio.toFixed(2)}</td>
        <td>${escapeHtml(row.top_servico || '—')}</td>
      </tr>`).join('')
      : `<tr><td colspan="5"><div class="empty"><div class="empty-text">Nenhum atendimento concluído no período</div></div></td></tr>`

    const bodyBarb = `
    ${abasTopo}
    <div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${abasPeriodoBarb}</div>
    <div class="toolbar" style="margin-bottom:1rem">
      <div class="toolbar-group">
        <span class="toolbar-label">Data base</span>
        <input type="date" lang="pt-BR" id="dataInput" value="${data}">
      </div>
      <button class="btn btn-ghost" onclick="window.location.href='/admin/faturamento?data='+document.getElementById('dataInput').value+'&periodo=${periodo}&aba=barbeiros'">Ver</button>
    </div>
    <p class="form-hint" style="margin-bottom:1rem">${ic.warn} Apenas serviços concluídos. Período: ${{ semana:'7 dias', mes:'Este mês', ano:'Este ano' }[periodo]} (mesmo critério do gráfico geral).</p>
    <div class="section-header">
      <span class="section-title">Total por barbeiro</span>
      <span class="section-count">${porBarbaraRows.length} barbeiros</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Barbeiro</th><th>Atendimentos</th><th>Total Bruto</th><th>Ticket Médio</th><th>Top Serviço</th></tr></thead>
        <tbody>${linhasBarb}</tbody>
      </table>
    </div>`

    return res.send(
      shell(
        'faturamento',
        'Faturamento',
        `${{ semana:'7 dias rolling', mes:'Mês corrente', ano:'Ano corrente' }[periodo]} — Por barbeiro`,
        bodyBarb,
        '',
      ),
    )
  }

  const fat     = getFaturamentoDia(data)
  const ags     = fat.agendamentos || []

  const porBarbeiro = {}
  for (const a of ags) {
    const nome = staffNameById(a.staff_id)
    if (!porBarbeiro[nome]) porBarbeiro[nome] = 0
    porBarbeiro[nome] += (a.servico_preco || 0)
  }

  const dadosPeriodo = getFaturamentoPeriodo(periodo)

  const linhas = ags.length ? ags.map(ag => `
    <tr>
      <td>${formatHora(ag.data_hora_inicio)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:.6rem">
          <div class="avatar">${initials(ag.nome_cliente)}</div>
          <span>${ag.nome_cliente || '<span class="td-muted">—</span>'}</span>
        </div>
      </td>
      <td>${ag.servico_nome || ag.servico_id}</td>
      <td>${staffNameById(ag.staff_id)}</td>
      <td style="font-weight:600;color:var(--green)">R$ ${(ag.servico_preco||0).toFixed(2)}</td>
      <td>${badge(ag.status)}</td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty"><div class="empty-icon">💰</div><div class="empty-text">Sem movimentação neste dia</div></div></td></tr>`

  const abasPeriodo = ['semana','mes','ano'].map(p => `
    <a href="/admin/faturamento?periodo=${p}&data=${encodeURIComponent(data)}&aba=geral" class="btn ${periodo===p?'btn-primary':'btn-ghost'} btn-sm">${
      {semana:'7 dias',mes:'Este mês',ano:'Este ano'}[p]
    }</a>`).join('')

  const totalPeriodo = dadosPeriodo.reduce((s, d) => s + (d.total || 0), 0)
  const atenPeriodo  = dadosPeriodo.reduce((s, d) => s + (d.atendimentos || 0), 0)

  const body = `
  ${abasTopo}
  <div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">
    ${abasPeriodo}
  </div>

  <div class="toolbar" style="margin-bottom:1.25rem">
    <div class="toolbar-group">
      <span class="toolbar-label">Data base</span>
      <input type="date" lang="pt-BR" id="dataInput" value="${data}">
    </div>
    <button class="btn btn-ghost" onclick="window.location.href='/admin/faturamento?data='+document.getElementById('dataInput').value+'&periodo=${periodo}&aba=geral'">Ver</button>
  </div>

  <div class="stats" style="margin-bottom:1.25rem">
    <div class="stat">
      <div class="stat-icon green">${ic.money}</div>
      <div class="stat-val" style="color:var(--green)">R$ ${fat.totalServicos.toFixed(2)}</div>
      <div class="stat-lbl">Serviços (hoje)</div>
      <div class="stat-accent green"></div>
    </div>
    <div class="stat">
      <div class="stat-icon blue">${ic.box}</div>
      <div class="stat-val" style="color:var(--blue-l)">R$ ${fat.totalProdutos.toFixed(2)}</div>
      <div class="stat-lbl">Produtos (hoje)</div>
      <div class="stat-accent blue"></div>
    </div>
    <div class="stat">
      <div class="stat-icon red">${ic.chart}</div>
      <div class="stat-val">R$ ${totalPeriodo.toFixed(2)}</div>
      <div class="stat-lbl">Total período</div>
      <div class="stat-accent"></div>
    </div>
    <div class="stat">
      <div class="stat-icon amber">${ic.users}</div>
      <div class="stat-val">${atenPeriodo}</div>
      <div class="stat-lbl">Atend. período</div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <div class="chart-title">${ic.chart} Serviços × Produtos</div>
      <canvas id="chartPie" height="180"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">${ic.chart} Período: ${{semana:'7 dias',mes:'Este mês',ano:'Este ano'}[periodo]}</div>
      <canvas id="chartBar" height="180"></canvas>
    </div>
  </div>

  <div class="section-header">
    <span class="section-title">Detalhamento do dia</span>
    <span class="section-count">${ags.length} registros</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Hora</th><th>Cliente</th><th>Serviço</th><th>Barbeiro</th><th>Valor</th><th>Status</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
  </div>`

  const trendLabels  = JSON.stringify(dadosPeriodo.map(d => d.dia.slice(5)))
  const trendData    = JSON.stringify(dadosPeriodo.map(d => d.total || 0))
  const barberLabels = JSON.stringify(Object.keys(porBarbeiro))
  const barberData   = JSON.stringify(Object.values(porBarbeiro))

  const script = `
  const s=document.createElement('script')
  s.src='https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
  s.onload=()=>{
    new Chart(document.getElementById('chartPie'),{
      type:'doughnut',
      data:{
        labels:['Serviços','Produtos'],
        datasets:[{data:[${fat.totalServicos},${fat.totalProdutos}],backgroundColor:['rgba(204,31,31,.8)','rgba(37,99,235,.4)'],borderColor:['rgba(204,31,31,1)','rgba(37,99,235,1)'],borderWidth:1}]
      },
      options:{cutout:'70%',plugins:{legend:{position:'bottom',labels:{color:'#888',font:{size:11,family:'Inter'},boxWidth:10,padding:12}}}}
    })
    new Chart(document.getElementById('chartBar'),{
      type:'bar',
      data:{
        labels:${trendLabels},
        datasets:[{label:'Faturamento',data:${trendData},backgroundColor:'rgba(204,31,31,.6)',borderColor:'rgba(204,31,31,1)',borderWidth:1,borderRadius:4}]
      },
      options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#666',font:{size:10}},grid:{display:false}},y:{ticks:{color:'#666',font:{size:10},callback:v=>'R$'+v},grid:{color:'rgba(255,255,255,.04)'}}}}
    })
  }
  document.head.appendChild(s)
  `

  res.send(shell('faturamento', 'Faturamento', `Relatório de ${formatData(data + 'T12:00:00-03:00')}`, body, script))
})

// ═══════════════════════════════════════════════════════════════
// FINANCEIRO (admin)
// ═══════════════════════════════════════════════════════════════

router.get('/financeiro', (req, res) => {
  const per = ['semana', 'mes', 'ano'].includes(req.query.per) ? req.query.per : 'mes'
  const mesDe = primeiroDiaMesAtualBR()
  const mesAte = hojeStr()
  const receitaMes = sumReceitaConcluidosPeriodo(mesDe, mesAte)
  const despesasMes = sumDespesasPeriodo(mesDe, mesAte)
  const comissoesAbertasTot = sumComissoesFechamentosAbertos()
  const saldoEstimado = receitaMes - despesasMes - comissoesAbertasTot
  const ranking = getRankingProdutividadeAdministrativo(per)
  const { barbeiros, totais, maxVal, cores } = getFaturamento4SemanasPorBarbeiro()
  const svgChart = renderSvgBarrasFinanceiro(barbeiros, totais, maxVal, cores)
  const perLabels = { semana: '7 dias', mes: 'Este mês', ano: 'Este ano' }
  const pillsPer = ['semana', 'mes', 'ano']
    .map(
      (p) =>
        `<a href="/admin/financeiro?per=${p}" class="btn ${per === p ? 'btn-primary' : 'btn-ghost'} btn-sm">${perLabels[p]}</a>`,
    )
    .join('')

  const linhasRanking = ranking.length
    ? ranking.map(
        (r) => `
    <tr>
      <td class="td-muted"><strong>${r.posicao}º</strong></td>
      <td>${escapeHtml(r.nome)}</td>
      <td>${r.atendimentos}</td>
      <td style="font-weight:600;color:var(--green)">${fmtBRL(r.total_bruto)}</td>
      <td class="td-muted">${fmtBRL(r.ticket_medio)}</td>
      <td>${escapeHtml(r.top_servico || '—')}</td>
    </tr>`,
      ).join('')
    : `<tr><td colspan="6"><div class="empty"><div class="empty-text">Sem atendimentos concluídos no período</div></div></td></tr>`

  const body = `
  <div style="margin-bottom:.5rem;display:flex;flex-wrap:wrap;gap:.5rem">${pillsPer}</div>
  <p class="form-hint" style="margin-bottom:1.1rem">${ic.chart} Ranking e totais lateral: período "${perLabels[per]}" (${per === 'semana' ? 'rolling local' : 'calendário corrente'}).</p>

  <div class="stats" style="margin-bottom:1.25rem">
    <div class="stat"><div class="stat-icon green">${ic.money}</div><div class="stat-val">${fmtBRL(receitaMes)}</div><div class="stat-lbl">Receita do mês</div><div class="stat-accent"></div></div>
    <div class="stat"><div class="stat-icon amber">${ic.box}</div><div class="stat-val">${fmtBRL(despesasMes)}</div><div class="stat-lbl">Despesas do mês</div></div>
    <div class="stat"><div class="stat-icon red">${ic.chart}</div><div class="stat-val">${fmtBRL(saldoEstimado)}</div><div class="stat-lbl">Saldo estimado</div></div>
    <div class="stat"><div class="stat-icon blue">${ic.cal}</div><div class="stat-val">${fmtBRL(comissoesAbertasTot)}</div><div class="stat-lbl">Comissões abertas (total)</div></div>
  </div>

  <div class="section-header"><span class="section-title">${ic.chart} Ranking de produtividade</span><span class="section-count">${ranking.length} barbeiros</span></div>
  <div class="table-wrap" style="margin-bottom:1.5rem">
    <table>
      <thead><tr><th>#</th><th>Barbeiro</th><th>Atendimentos</th><th>Total bruto</th><th>Ticket médio</th><th>Top serviço</th></tr></thead>
      <tbody>${linhasRanking}</tbody>
    </table>
  </div>

  <div class="section-header"><span class="section-title">${ic.chart} Faturamento por barbeiro (últimas 4 semanas)</span></div>
  <div class="chart-card" style="margin-bottom:.5rem">${svgChart}</div>
  <p class="form-hint">${ic.warn} Agrupamento de 7 em 7 dias até hoje; apenas serviços concluídos (bruto).</p>`

  res.send(shell('financeiro', 'Financeiro', 'Visão consolidada e ranking Andy Na Régua', body))
})

router.get('/financeiro/comissoes', (req, res) => {
  const de = req.query.de || primeiroDiaMesAtualBR()
  const ate = req.query.ate || hojeStr()
  const msg = req.query.msg || ''
  const servicos = getServicosAtivos()
  const barberos = getBarbeiros().filter((b) => b.ativo).sort((a, z) => a.nome.localeCompare(z.nome))
  let cards = ''

  for (const b of barberos) {
    const linCalc = calcularComissaoPeriodo(b.id, de, ate)
    const atk = linCalc.length
    const totalBruto = linCalc.reduce((s, row) => s + Number(row.valor_bruto || 0), 0)
    const totalComEst = linCalc.reduce((s, row) => s + Number(row.valor_comissao || 0), 0)
    const pctPad = Number(b.comissao_padrao_pct) || 0
    const semPctBadge =
      pctPad === 0
        ? `<span class="badge-fin-err">${ic.warn} Sem % configurado</span>`
        : `<span class="form-hint" style="margin:0;display:inline">${pctPad}%</span>`

    const overrides = getComissaoOverrides(b.id)
    const rowsOv = overrides.length
      ? overrides
          .map(
            (o) =>
              `<tr>
      <td>${escapeHtml(o.servico_id)}</td>
      <td>${escapeHtml(String(o.pct ?? ''))}%</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/financeiro/comissoes/override-remover" style="display:inline">
          <input type="hidden" name="barbeiro_id" value="${escapeHtml(b.id)}">
          <input type="hidden" name="servico_id" value="${escapeHtml(o.servico_id)}">
          <button type="submit" class="btn btn-ghost btn-sm">${ic.box} Remover</button>
        </form>
      </td>
    </tr>`,
          )
          .join('')
      : `<tr><td colspan="3" class="td-muted">Nenhum override</td></tr>`

    const optsServico = servicos
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nome)}</option>`)
      .join('')

    cards += `
    <div style="border:1px solid var(--border);border-radius:12px;background:var(--elevated);padding:1rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;margin-bottom:.5rem;flex-wrap:wrap">
        <div><strong>${escapeHtml(b.nome)}</strong><div style="margin-top:.35rem">${semPctBadge}</div></div>
        <div style="display:flex;flex-wrap:wrap;gap:.35rem">
          ${
            pctPad === 0
              ? `<a href="/admin/financeiro/comissoes?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}#cfg-padrao-${escapeHtml(b.id)}" class="btn btn-primary btn-sm">${ic.gear} Configurar</a>`
              : ''
          }
          <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('dlg-f-${escapeHtml(b.id)}').showModal()">${ic.check} Criar fechamento</button>
        </div>
      </div>
      <div class="fin-mini">Período: ${escapeHtml(de)} → ${escapeHtml(ate)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem;margin:.75rem 0;font-size:.82rem">
        <div><span class="fin-mini">Atendimentos</span><div><strong>${atk}</strong></div></div>
        <div><span class="fin-mini">Total bruto</span><div><strong style="color:var(--green)">${fmtBRL(totalBruto)}</strong></div></div>
        <div><span class="fin-mini">Comissão estimada</span><div><strong style="color:var(--blue-l)">${fmtBRL(totalComEst)}</strong></div></div>
      </div>
      <dialog id="dlg-f-${escapeHtml(b.id)}" class="finance-dlg">
        <div class="fin-dlg-hd">${ic.check} Novo fechamento — ${escapeHtml(b.nome)}</div>
        <form method="POST" action="/admin/financeiro/fechamentos/criar">
          <input type="hidden" name="barbeiro_id" value="${escapeHtml(b.id)}">
          <div class="fin-dlg-bd">
            <div class="form-group" style="margin:0"><label class="form-label">Início do período</label><input type="date" lang="pt-BR" name="periodo_inicio" value="${escapeHtml(de)}" required></div>
            <div class="form-group" style="margin:0"><label class="form-label">Fim do período</label><input type="date" lang="pt-BR" name="periodo_fim" value="${escapeHtml(ate)}" required></div>
            <p class="form-hint" style="margin:0">${ic.warn} O sistema soma apenas atendimentos concluídos no intervalo e vincula ao fechamento.</p>
          </div>
          <div class="fin-dlg-ft">
            <button type="button" class="btn btn-ghost" onclick="this.closest('dialog').close()">Cancelar</button>
            <button type="submit" class="btn btn-primary">${ic.check} Gerar</button>
          </div>
        </form>
      </dialog>
      <details style="margin-top:.5rem;font-size:.8rem"><summary>${ic.chart} Overrides por serviço</summary>
      <div class="table-wrap" style="margin-top:.5rem"><table><thead><tr><th>Serviço ID</th><th>%</th><th></th></tr></thead><tbody>${rowsOv}</tbody></table></div>
      <form method="POST" action="/admin/financeiro/comissoes/override" style="margin-top:.5rem;display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end">
        <input type="hidden" name="barbeiro_id" value="${escapeHtml(b.id)}">
        <div class="form-group" style="margin:0"><label class="form-label">Serviço</label><select name="servico_id" required><option value="" disabled selected>Escolha…</option>${optsServico}</select></div>
        <div class="form-group" style="margin:0;width:92px"><label class="form-label">% comissão</label><input type="number" name="pct_override" step="0.01" min="0" max="100" required placeholder="35"></div>
        <button type="submit" class="btn btn-ghost btn-sm">${ic.plus} Salvar override</button>
      </form>
      </details>
    </div>`
  }

  const inputsPadrao = barberos
    .map((b) => {
      const v = Number(b.comissao_padrao_pct) || 0
      return `
    <div class="form-group" id="cfg-padrao-${escapeHtml(b.id)}" style="margin:.5rem 0;">
      <label class="form-label">${escapeHtml(b.nome)} — % padrão</label>
      <input type="number" step="0.01" min="0" max="100" name="pct_${b.id}" value="${v}">
    </div>`
    })
    .join('')

  const alert =
    msg === 'cfg'
      ? `<div class="alert alert-success">${ic.check} Percentuais salvos.</div>`
      : msg === 'ov'
        ? `<div class="alert alert-success">${ic.check} Override atualizado.</div>`
        : msg === 'rm'
          ? `<div class="alert alert-success">${ic.check} Override removido.</div>`
          : ''

  const body = `
  ${alert}
  <div class="toolbar" style="margin-bottom:1rem">
    <div class="toolbar-group"><span class="toolbar-label">De</span><input type="date" lang="pt-BR" id="cfDe" value="${escapeHtml(de)}"></div>
    <div class="toolbar-group"><span class="toolbar-label">Até</span><input type="date" lang="pt-BR" id="cfAte" value="${escapeHtml(ate)}"></div>
    <button type="button" class="btn btn-ghost" onclick="window.location.href='/admin/financeiro/comissoes?de='+document.getElementById('cfDe').value+'&ate='+document.getElementById('cfAte').value">${ic.cal} Ver período</button>
  </div>

  <div class="section-header"><span class="section-title">${ic.chart} Comissões do período (por barbeiro)</span></div>
  <div class="fin-cards">${cards || `<div class="empty"><div class="empty-text">Nenhum barbeiro ativo</div></div>`}</div>

  <div class="section-header" style="margin-top:1.5rem" id="config-pcts"><span class="section-title">${ic.gear} Configurar percentuais</span></div>
  <div class="form-card" style="max-width:560px;margin-bottom:.5rem"><div class="form-card-title">${ic.gear} % padrão por barbeiro</div><form method="POST" action="/admin/financeiro/comissoes/config">${inputsPadrao}<div style="margin-top:1rem"><button type="submit" class="btn btn-primary">${ic.check} Salvar percentuais</button></div></form></div>
  `

  res.send(shell('financeiro/comissoes', 'Comissões', 'Configuração e estimativas Andy Na Régua', body))
})

router.post('/financeiro/comissoes/config', express.urlencoded({ extended: false }), (req, res) => {
  for (const b of getBarbeiros()) {
    const key = `pct_${b.id}`
    const raw = req.body[key]
    if (raw === undefined) continue
    const v = Number.parseFloat(raw)
    if (Number.isNaN(v)) continue
    updateBarbeiro(b.id, { comissao_padrao_pct: v })
  }
  log('Painel: comissões — percentuais padrão atualizados')
  res.redirect(`/admin/financeiro/comissoes?msg=cfg`)
})

router.post('/financeiro/comissoes/override', express.urlencoded({ extended: false }), (req, res) => {
  const { barbeiro_id, servico_id } = req.body
  let pct = Number.parseFloat(req.body.pct_override)
  if (!barbeiro_id || !servico_id || Number.isNaN(pct)) return res.redirect(`/admin/financeiro/comissoes?msg=err`)
  pct = Math.max(0, Math.min(100, pct))
  setComissaoOverride(barbeiro_id, servico_id, pct)
  log(`Painel: override comissão — ${barbeiro_id}/${servico_id} → ${pct}%`)
  res.redirect(`/admin/financeiro/comissoes?msg=ov`)
})

router.post('/financeiro/comissoes/override-remover', express.urlencoded({ extended: false }), (req, res) => {
  const { barbeiro_id, servico_id } = req.body
  if (!barbeiro_id || !servico_id) return res.redirect(`/admin/financeiro/comissoes`)
  getDb().prepare(`DELETE FROM comissao_overrides WHERE barbeiro_id = ? AND servico_id = ?`).run(barbeiro_id, servico_id)
  res.redirect(`/admin/financeiro/comissoes?msg=rm`)
})

router.get('/financeiro/fechamentos', (req, res) => {
  const st = req.query.st === 'aberto' || req.query.st === 'pago' ? req.query.st : 'todos'
  const bid = req.query.barbeiro && String(req.query.barbeiro).trim() !== '' ? String(req.query.barbeiro).trim() : null
  const lista = listarFechamentosAdministrativo(st === 'todos' ? null : st, bid)
  const msg = req.query.msg || ''

  const barberos = getBarbeiros().filter((b) => b.ativo)
  const optBarb =
    `<option value="" ${!bid ? 'selected' : ''}>Todos os barbeiros</option>` +
    barberos.map((b) => `<option value="${escapeHtml(b.id)}" ${bid === b.id ? 'selected' : ''}>${escapeHtml(b.nome)}</option>`).join('')

  const filtLinks = `
  <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem">
    <a href="/admin/financeiro/fechamentos?st=todos${bid ? `&barbeiro=${encodeURIComponent(bid)}` : ''}" class="btn ${st === 'todos' ? 'btn-primary' : 'btn-ghost'} btn-sm">Todos</a>
    <a href="/admin/financeiro/fechamentos?st=aberto${bid ? `&barbeiro=${encodeURIComponent(bid)}` : ''}" class="btn ${st === 'aberto' ? 'btn-primary' : 'btn-ghost'} btn-sm">Abertos</a>
    <a href="/admin/financeiro/fechamentos?st=pago${bid ? `&barbeiro=${encodeURIComponent(bid)}` : ''}" class="btn ${st === 'pago' ? 'btn-primary' : 'btn-ghost'} btn-sm">Pagos</a>
  </div>`

  const alert =
    msg === 'criado'
      ? `<div class="alert alert-success">${ic.check} Fechamento criado.</div>`
      : msg === 'pago'
        ? `<div class="alert alert-success">${ic.check} Pagamento registrado e barbeiro notificado (WhatsApp se houver).</div>`
        : msg === 'erro_data'
          ? `<div class="alert alert-error">${ic.warn} Datas inválidas.</div>`
          : msg === 'vazio'
            ? `<div class="alert alert-error">${ic.warn} Nenhum atendimento no período.</div>`
            : ''

  const cards = lista.length
    ? lista
        .map((f) => {
          const stLabel = f.status === 'pago' ? `Pago` : `Aberto`
          const stCol = f.status === 'pago' ? `#4ade80` : `#fbbf24`
          const quandoPago =
            f.status === 'pago'
              ? `<div class="fin-mini">Registrado em <strong>${formatDataHoraPainel(f.pago_em)}</strong> por ${escapeHtml(f.pago_por || '—')}</div>`
              : ''

          const acaoPg =
            f.status === 'aberto'
              ? `<button type="button" class="btn btn-primary btn-sm" onclick="document.getElementById('dlg-pg-${f.id}').showModal()">${ic.money} Registrar pagamento</button>`
              : `<span class="form-hint">—</span>`

          return `
<div style="border:1px solid var(--border);border-radius:12px;background:var(--elevated);padding:1rem;margin-bottom:.85rem;border-left:3px solid ${stCol}">
  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:center">
    <div><strong>${escapeHtml(f.barbeiro_nome || f.barbeiro_id)}</strong> · <span style="color:${stCol};font-weight:700;font-size:.78rem">${stLabel}</span></div>${acaoPg}</div>
  <div class="fin-mini">${escapeHtml(f.periodo_inicio)} → ${escapeHtml(f.periodo_fim)}</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.65rem;margin-top:.65rem;font-size:.82rem">
    <div><span class="fin-mini">Atendimentos</span><div>${f.n_atendimentos ?? 0}</div></div>
    <div><span class="fin-mini">Bruto</span><div>${fmtBRL(f.total_bruto)}</div></div>
    <div><span class="fin-mini">Comissão (${Number(f.pct_aplicado || 0).toFixed(1)}%)</span><div>${fmtBRL(f.total_comissao)}</div></div>
  </div>
  ${f.obs ? `<div class="form-hint" style="margin-top:.5rem">Obs: ${escapeHtml(f.obs)}</div>` : ''}
  ${quandoPago}
  ${
    f.status === 'aberto'
      ? `<dialog id="dlg-pg-${f.id}" class="finance-dlg">
    <form method="POST" action="/admin/financeiro/fechamentos/${f.id}/pagar"><div class="fin-dlg-hd">${ic.money} Confirmar pagamento</div><div class="fin-dlg-bd"><p style="margin:0;font-size:.82rem">Confirme o pagamento ao barbeiro. Opcionalmente deixe uma observação.</p><div class="form-group" style="margin-bottom:0"><label class="form-label">Observação interna</label><textarea name="obs" rows="3" placeholder="Ex.: PIX chave xxx, conferido pela recepção."></textarea></div></div><div class="fin-dlg-ft"><button type="button" class="btn btn-ghost" onclick="this.closest('dialog').close()">Cancelar</button><button type="submit" class="btn btn-primary">${ic.check} Registrar pagamento</button></div></form>
    </dialog>`
      : ''
  }
</div>`
        })
        .join('')
    : `<div class="empty"><div class="empty-text">Nenhum fechamento encontrado.</div></div>`

  const body = `
  ${alert}
  ${filtLinks}
  <form method="GET" action="/admin/financeiro/fechamentos" class="toolbar" style="margin-bottom:1rem;flex-wrap:wrap">
    <input type="hidden" name="st" value="${escapeHtml(st)}">
    <div class="toolbar-group"><span class="toolbar-label">Barbeiro</span><select name="barbeiro" onchange="this.form.submit()">${optBarb}</select></div>
  </form>
  <div class="section-header"><span class="section-title">${ic.cal} Histórico de fechamentos</span><span class="section-count">${lista.length} registros</span></div>
  ${cards}`

  res.send(shell('financeiro/fechamentos', 'Fechamentos', 'Comissões e pagamentos aos barbeiros', body))
})

router.post('/financeiro/fechamentos/criar', express.urlencoded({ extended: false }), (req, res) => {
  const barbeiroId = req.body.barbeiro_id
  const pi = req.body.periodo_inicio
  const pf = req.body.periodo_fim
  if (!barbeiroId || !pi || !pf || !/^\d{4}-\d{2}-\d{2}$/.test(pi) || !/^\d{4}-\d{2}-\d{2}$/.test(pf)) {
    return res.redirect(`/admin/financeiro/fechamentos?msg=erro_data`)
  }
  const r = criarFechamentoComCalculo(barbeiroId, pi, pf)
  if (r.erro) {
    log(`Painel: fechamento falhou (${barbeiroId} ${pi}–${pf}): ${r.erro}`)
    return res.redirect(`/admin/financeiro/fechamentos?msg=vazio`)
  }
  log(`Painel: fechamento #${r.fechamento.id} criado — ${barbeiroId} (${r.count} atend.)`)
  res.redirect(`/admin/financeiro/fechamentos?msg=criado`)
})

router.post('/financeiro/fechamentos/:id/pagar', express.urlencoded({ extended: false }), (req, res) => {
  const id = Number(req.params.id)
  const obs = req.body.obs || ''
  const f = getDb().prepare(`SELECT * FROM fechamentos WHERE id = ?`).get(id)
  if (!f || f.status !== 'aberto') return res.redirect(`/admin/financeiro/fechamentos`)
  const det = getFechamentoDetalhe(id)
  registrarPagamentoFechamento(id, 'Administrador (painel)')
  atualizarObsFechamento(id, obs)
  const barbeiro = getBarbeiroById(f.barbeiro_id)
  const count = det?.agendamentos?.length ?? 0
  const pctFmt = Number(f.pct_aplicado || 0).toFixed(1).replace('.', ',')
  enqueueWhatsAppPagamento(barbeiro, f, count, pctFmt)
  log(`Painel: fechamento #${id} pago (${count} atend.; WhatsApp disparado)`)
  res.redirect(`/admin/financeiro/fechamentos?msg=pago`)
})

router.get('/financeiro/despesas', (req, res) => {
  const de = req.query.de || primeiroDiaMesAtualBR()
  const ate = req.query.ate || hojeStr()
  const cat = typeof req.query.cat === 'string' && req.query.cat.trim() !== '' ? req.query.cat.trim() : null
  const lista = getDespesas({
    dataInicio: de,
    dataFim: ate,
    ...(cat ? { categoria: cat } : {}),
  })
  let totalPeriodo = 0
  for (const d of lista) totalPeriodo += Number(d.valor) || 0

  const msg = req.query.msg || ''
  const alert =
    msg === 'ok'
      ? `<div class="alert alert-success">${ic.check} Despesa registrada.</div>`
      : msg === 'del'
        ? `<div class="alert alert-success">${ic.check} Despesa removida.</div>`
        : msg === 'err'
          ? `<div class="alert alert-error">${ic.warn} Confira valor e dados.</div>`
          : ''

  const optsCat =
    `<option value="" ${!cat ? 'selected' : ''}>Todas categorias</option>` +
    CATEGORIAS_DESPESA.map((c) => `<option value="${escapeHtml(c)}" ${cat === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')

  const linhasTab = lista.length
    ? lista
        .map(
          (d) => `
  <tr>
    <td>${escapeHtml(String(d.data))}</td>
    <td>${escapeHtml(d.descricao)}</td>
    <td>${escapeHtml(d.categoria)}</td>
    <td>${fmtBRL(d.valor)}</td>
    <td class="td-muted">${d.obs ? escapeHtml(d.obs) : '—'}</td>
    <td style="white-space:nowrap">
      <form method="POST" action="/admin/financeiro/despesas/${d.id}/deletar" style="display:inline" onsubmit="return confirm('Excluir esta despesa permanentemente?')">
        <button type="submit" class="btn btn-ghost btn-sm">${ic.box} Excluir</button>
      </form>
    </td>
  </tr>`,
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty"><div class="empty-text">Sem despesas no período.</div></div></td></tr>`

  const optsCatNova = CATEGORIAS_DESPESA.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')

  const body = `
  ${alert}
  <div class="toolbar" style="flex-wrap:wrap;margin-bottom:1rem">
    <div class="toolbar-group"><span class="toolbar-label">De</span><input type="date" lang="pt-BR" name="de" form="filtDesp" value="${escapeHtml(de)}"></div>
    <div class="toolbar-group"><span class="toolbar-label">Até</span><input type="date" lang="pt-BR" name="ate" form="filtDesp" value="${escapeHtml(ate)}"></div>
    <div class="toolbar-group"><span class="toolbar-label">Categoria</span><select name="cat" form="filtDesp">${optsCat}</select></div>
    <form id="filtDesp" method="GET" action="/admin/financeiro/despesas"><button type="submit" class="btn btn-primary btn-sm">${ic.cal} Filtrar</button></form>
  </div>

  <div class="stats" style="margin-bottom:1rem">
    <div class="stat"><div class="stat-icon amber">${ic.money}</div><div class="stat-val">${fmtBRL(totalPeriodo)}</div><div class="stat-lbl">Total filtrado</div></div>
  </div>

  <div class="section-header"><span class="section-title">${ic.plus} Nova despesa</span></div>
  <div class="form-card" style="max-width:640px;margin-bottom:1.25rem">
    <form method="POST" action="/admin/financeiro/despesas/criar" class="form-row" style="flex-wrap:wrap;gap:.75rem;align-items:flex-end">
      <div class="form-group" style="margin:0;flex:2;min-width:160px"><label class="form-label">Descrição</label><input type="text" name="descricao" required placeholder="Ex.: Aluguel loja Maio"></div>
      <div class="form-group" style="margin:0;width:120px"><label class="form-label">Valor</label><input type="text" inputmode="decimal" name="valor" required placeholder="1500,00"></div>
      <div class="form-group" style="margin:0"><label class="form-label">Categoria</label><select name="categoria">${optsCatNova}</select></div>
      <div class="form-group" style="margin:0"><label class="form-label">Data</label><input type="date" lang="pt-BR" name="data" value="${escapeHtml(hojeStr())}" required></div>
      <div class="form-group" style="margin:0;flex:1;min-width:140px"><label class="form-label">Obs.</label><input type="text" name="obs" placeholder="Opcional"></div>
      <button type="submit" class="btn btn-primary">${ic.check} Salvar despesa</button>
    </form>
  </div>

  <div class="section-header"><span class="section-title">${ic.cal} Lista de despesas</span></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Valor</th><th>Obs</th><th></th></tr></thead>
      <tbody>${linhasTab}</tbody>
    </table>
  </div>`

  res.send(shell('financeiro/despesas', 'Despesas', 'Controle de saídas do negócio', body))
})

router.post('/financeiro/despesas/criar', express.urlencoded({ extended: false }), (req, res) => {
  const { descricao, data, obs } = req.body
  let valorRaw = req.body.valor != null ? String(req.body.valor) : ''
  valorRaw = valorRaw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const valor = Number.parseFloat(valorRaw)
  const categoria = req.body.categoria || 'outros'
  if (!descricao?.trim() || !data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(valor)) {
    return res.redirect(`/admin/financeiro/despesas?msg=err`)
  }
  criarDespesa({
    descricao: descricao.trim(),
    valor,
    categoria,
    data,
    registrado_por: 'admin',
    obs: obs?.trim() ? obs.trim() : null,
  })
  log(`Painel: despesa criada "${descricao}" ${valor}`)
  res.redirect(`/admin/financeiro/despesas?msg=ok`)
})

router.post('/financeiro/despesas/:id/deletar', express.urlencoded({ extended: false }), (req, res) => {
  const id = Number(req.params.id)
  deletarDespesa(id)
  log(`Painel: despesa #${id} removida`)
  res.redirect(`/admin/financeiro/despesas?msg=del`)
})

router.get('/financeiro/caixa-hoje', (req, res) => {
  const data = req.query.data || hojeStr()
  const r = getResumoCaixaDia(data)
  const dataLabel = new Date(data + 'T12:00:00-03:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo',
  })

  const body = `
  <div class="toolbar" style="margin-bottom:1.25rem">
    <div class="toolbar-group"><span class="toolbar-label">Data</span><input type="date" lang="pt-BR" id="cxData" value="${escapeHtml(data)}"></div>
    <button class="btn btn-ghost" onclick="window.location.href='/admin/financeiro/caixa-hoje?data='+document.getElementById('cxData').value">Ver</button>
    <a href="/admin/financeiro/caixa-hoje" class="btn btn-ghost">Hoje</a>
  </div>
  <div class="stats" style="margin-bottom:1.25rem">
    <div class="stat"><div class="stat-icon green">${ic.money}</div><div class="stat-val">${fmtBRL(r.totalBruto)}</div><div class="stat-lbl">Total bruto</div><div class="stat-accent green"></div></div>
    <div class="stat"><div class="stat-icon amber">${ic.box}</div><div class="stat-val">${fmtBRL(r.totalDespesas)}</div><div class="stat-lbl">Despesas</div></div>
    <div class="stat"><div class="stat-icon ${r.saldoLiquido>=0?'green':'red'}">${ic.chart}</div><div class="stat-val">${fmtBRL(r.saldoLiquido)}</div><div class="stat-lbl">Saldo líquido</div><div class="stat-accent ${r.saldoLiquido>=0?'green':''}"></div></div>
    <div class="stat"><div class="stat-icon blue">${ic.cal}</div><div class="stat-val">${r.atendimentos}</div><div class="stat-lbl">Atendimentos</div><div class="stat-accent blue"></div></div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.65rem;margin-bottom:1.25rem">
    ${Object.entries(r.totaisPorForma).map(([f, v]) => `<div class="stat" style="padding:.85rem 1rem"><div class="stat-val" style="font-size:1.1rem">${fmtBRL(v)}</div><div class="stat-lbl">${FORMAS_LABEL_SERVER[f] || f}</div></div>`).join('')}
  </div>
  <div class="section-header"><span class="section-title">Por barbeiro</span></div>
  <div class="table-wrap" style="margin-bottom:1.25rem">
    <table>
      <thead><tr><th>Barbeiro</th><th>Atendimentos</th><th>Produtos</th><th>Total</th></tr></thead>
      <tbody>${r.porBarbeiro.length ? r.porBarbeiro.map(b => `<tr><td>${escapeHtml(b.nome)}</td><td class="td-muted">${b.atendimentos}</td><td class="td-muted">${b.produtos}</td><td style="color:var(--green);font-weight:600">${fmtBRL(b.total)}</td></tr>`).join('') : `<tr><td colspan="4"><div class="empty"><div class="empty-text">Sem dados</div></div></td></tr>`}</tbody>
    </table>
  </div>
  ${r.semPagamento.length ? `<div class="alert" style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);color:var(--amber);padding:.7rem 1rem;border-radius:var(--radius-sm);font-size:.82rem">${ic.warn} ${r.semPagamento.length} atendimento(s) concluído(s) sem pagamento.</div>` : ''}
  <p style="font-size:.72rem;color:var(--muted);margin-top:1rem">Status: ${r.caixa.status === 'fechado' ? '🔴 Fechado' : '🟢 Aberto'} · Fundo inicial: ${fmtBRL(r.caixa.fundo_inicial)}${r.caixa.status === 'fechado' ? ` · Fechado em ${formatDataHoraPainel(r.caixa.fechado_em)}` : ''}</p>`

  res.send(shell('financeiro/caixa-hoje', 'Caixa Hoje', dataLabel, body))
})

// ═══════════════════════════════════════════════════════════════
// ROTA: /clientes
// ═══════════════════════════════════════════════════════════════
router.get('/clientes', (req, res) => {
  const busca = req.query.q || ''
  let clientes
  if (busca) {
    clientes = getDb().prepare(`SELECT * FROM clientes WHERE nome LIKE ? OR whatsapp_number LIKE ? ORDER BY updated_at DESC LIMIT 80`).all(`%${busca}%`, `%${busca}%`)
  } else {
    clientes = getDb().prepare(`SELECT * FROM clientes ORDER BY updated_at DESC LIMIT 80`).all()
  }

  const linhas = clientes.length ? clientes.map(c => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:.65rem">
          <div class="avatar">${initials(c.nome)}</div>
          <div>
            <div style="font-weight:500">${c.nome || '<span class="td-muted">Sem nome</span>'}</div>
            ${c.no_show_count >= 2 ? `<div style="font-size:.67rem;color:var(--amber);margin-top:.1rem">⚠ Confirmação rigorosa</div>` : ''}
          </div>
        </div>
      </td>
      <td class="td-mono">${c.whatsapp_number.replace('@c.us','')}</td>
      <td>
        <span style="font-weight:600;color:${c.no_show_count>=2?'var(--red-sem)':c.no_show_count>0?'var(--amber)':'var(--muted)'}">${c.no_show_count || 0}</span>
      </td>
      <td>${c.lgpd_aceito?`<span style="color:var(--green);font-size:.75rem">Aceito</span>`:`<span class="td-muted" style="font-size:.75rem">Pendente</span>`}</td>
      <td class="td-muted">${formatData(c.created_at)}</td>
      <td>
        <a href="/admin/clientes/${encodeURIComponent(c.whatsapp_number)}" class="btn btn-ghost btn-sm">Ver histórico</a>
      </td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty"><div class="empty-icon">👥</div><div class="empty-text">${busca?'Nenhum cliente encontrado':'Nenhum cliente cadastrado ainda'}</div></div></td></tr>`

  const body = `
  <div class="toolbar">
    <div class="toolbar-group">
      <span class="toolbar-label">Buscar</span>
      <input type="text" id="busca" value="${busca}" placeholder="Nome ou número WhatsApp...">
    </div>
    <button class="btn btn-ghost" onclick="window.location.href='/admin/clientes?q='+encodeURIComponent(document.getElementById('busca').value)">Buscar</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Cliente</th><th>WhatsApp</th><th>No-shows</th><th>LGPD</th><th>Desde</th><th>Ação</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
  </div>`

  const script = `document.getElementById('busca').addEventListener('keydown',e=>{if(e.key==='Enter')window.location.href='/admin/clientes?q='+encodeURIComponent(e.target.value)})`

  res.send(shell('clientes', 'Clientes', `${clientes.length} cadastrados`, body, script))
})

router.get('/clientes/:numero', (req, res) => {
  const numero    = decodeURIComponent(req.params.numero)
  const cliente   = getDb().prepare('SELECT * FROM clientes WHERE whatsapp_number = ?').get(numero)
  if (!cliente) return res.redirect(`/admin/clientes`)

  const historico  = getHistoricoCliente(numero)
  const totalGasto = historico.reduce((s, a) => s + (a.servico_preco || 0), 0)

  const linhas = historico.length ? historico.map(ag => `
    <tr>
      <td>${formatData(ag.data_hora_inicio)} <span class="td-muted">${formatHora(ag.data_hora_inicio)}</span></td>
      <td>${ag.servico_id}</td>
      <td>${staffNameById(ag.staff_id)}</td>
      <td>${badge(ag.status)}</td>
    </tr>`).join('') : `<tr><td colspan="4"><div class="empty"><div class="empty-text">Sem agendamentos registrados</div></div></td></tr>`

  const body = `
  <a href="/admin/clientes" class="btn btn-ghost btn-sm" style="margin-bottom:1.25rem;display:inline-flex">${ic.back} Voltar</a>
  <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
    <div class="avatar" style="width:48px;height:48px;font-size:1rem">${initials(cliente.nome)}</div>
    <div>
      <div style="font-size:1.1rem;font-weight:600">${cliente.nome || 'Cliente sem nome'}</div>
      <div class="td-mono" style="margin-top:.2rem">${cliente.whatsapp_number.replace('@c.us','')}</div>
    </div>
  </div>
  <div class="stats" style="margin-bottom:1.5rem">
    <div class="stat"><div class="stat-icon red">${ic.cal}</div><div class="stat-val">${historico.length}</div><div class="stat-lbl">Agendamentos</div></div>
    <div class="stat"><div class="stat-icon green">${ic.money}</div><div class="stat-val">R$ ${totalGasto.toFixed(0)}</div><div class="stat-lbl">Total gasto</div><div class="stat-accent green"></div></div>
    <div class="stat"><div class="stat-icon ${cliente.no_show_count>=2?'amber':'blue'}">${ic.warn}</div><div class="stat-val" style="color:${cliente.no_show_count>=2?'var(--amber)':'var(--white)'}">${cliente.no_show_count||0}</div><div class="stat-lbl">No-shows</div></div>
  </div>
  <div class="section-header">
    <span class="section-title">Histórico de agendamentos</span>
    <span class="section-count">${historico.length}</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Data / Hora</th><th>Serviço</th><th>Barbeiro</th><th>Status</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
  </div>`

  res.send(shell('clientes', cliente.nome || 'Cliente', 'Histórico completo', body))
})

// ═══════════════════════════════════════════════════════════════
// ROTA: /estoque
// ═══════════════════════════════════════════════════════════════
router.get('/estoque', (req, res) => {
  const msg      = req.query.msg  || ''
  const editId   = req.query.editar || ''
  const produtos = getDb().prepare('SELECT * FROM produtos ORDER BY nome').all()
  const totalItens = produtos.reduce((s, p) => s + p.estoque, 0)
  const semEstoque = produtos.filter(p => p.estoque === 0 && p.ativo).length

  const produtosAlerta = produtos.filter(p => p.ativo && p.estoque > 0 && p.estoque <= ESTOQUE_MINIMO_PADRAO)
  const produtosZero   = produtos.filter(p => p.ativo && p.estoque === 0)
  const editando = editId ? getDb().prepare('SELECT * FROM produtos WHERE id = ?').get(editId) : null

  // Histórico de movimentações
  let movimentacoes = []
  try {
    movimentacoes = getDb().prepare(`
      SELECT m.*, p.nome as nome_produto
      FROM estoque_movimentacoes m
      LEFT JOIN produtos p ON p.id = m.produto_id
      ORDER BY m.created_at DESC
      LIMIT 50
    `).all()
  } catch (e) { /* tabela pode não existir em instâncias antigas */ }

  const formNovo = `
  <div class="form-card" style="margin-bottom:1.25rem">
    <div class="form-card-title">${ic.plus} Adicionar novo produto</div>
    <form method="POST" action="/admin/estoque/criar">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Nome do produto *</label>
          <input type="text" name="nome" required placeholder="Ex: Pomada Efeito Matte">
        </div>
        <div class="form-group">
          <label class="form-label">Preço (R$) *</label>
          <input type="number" name="preco" required min="0" step="0.01" placeholder="45.00">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Descrição</label>
        <input type="text" name="descricao" placeholder="Breve descrição do produto">
      </div>
      <div style="margin-top:.5rem">
        <button type="submit" class="btn btn-primary">${ic.plus} Adicionar produto</button>
      </div>
    </form>
  </div>`

  const formEditar = editando ? `
  <div class="form-card" style="margin-bottom:1.25rem;border-color:var(--red);box-shadow:0 0 0 1px var(--red-dim)">
    <div class="form-card-title">${ic.check} Editando: ${editando.nome}</div>
    <form method="POST" action="/admin/estoque/editar">
      <input type="hidden" name="id" value="${editando.id}">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Nome</label>
          <input type="text" name="nome" value="${editando.nome}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Preço (R$)</label>
          <input type="number" name="preco" value="${editando.preco}" min="0" step="0.01" required>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Descrição</label>
        <input type="text" name="descricao" value="${editando.descricao || ''}">
      </div>
      <div style="display:flex;gap:.5rem;margin-top:.5rem">
        <button type="submit" class="btn btn-primary">${ic.check} Salvar alterações</button>
        <a href="/admin/estoque" class="btn btn-ghost">Cancelar</a>
      </div>
    </form>
  </div>` : ''

  const cards = produtos.map(p => {
    const maxStock = 20
    const pct      = Math.min((p.estoque / maxStock) * 100, 100)
    const cls      = p.estoque === 0 ? 'zero' : p.estoque <= ESTOQUE_MINIMO_PADRAO ? 'low' : 'ok'

    return `
    <div class="product-card ${!p.ativo?'inactive':''}" ${editId===p.id?'style="border-color:var(--red)"':''}>
      <div class="product-name">${p.nome}</div>
      <div class="product-desc">${p.descricao||'—'}</div>
      <div class="product-price">R$ ${p.preco.toFixed(2)}</div>
      <div class="stock-row">
        <span class="stock-label">Estoque atual</span>
        <span class="stock-count ${cls}">${p.estoque} un.</span>
      </div>
      <div class="progress">
        <div class="progress-fill ${cls}" style="width:${pct}%"></div>
      </div>
      <!-- Stepper de estoque -->
      <div class="product-actions" style="align-items:center;justify-content:space-between">
        <span class="stock-label">Ajustar</span>
        <div style="display:flex;align-items:center;gap:.35rem">
          <form method="POST" action="/admin/estoque/ajustar" style="display:contents">
            <input type="hidden" name="id" value="${p.id}">
            <input type="hidden" name="delta" value="-1">
            <button class="btn btn-ghost btn-sm" type="submit" style="padding:.35rem .65rem" ${p.estoque===0?'disabled':''}>−</button>
          </form>
          <span class="stock-count ${cls}" style="min-width:2.5rem;text-align:center;font-size:.9rem">${p.estoque}</span>
          <form method="POST" action="/admin/estoque/ajustar" style="display:contents">
            <input type="hidden" name="id" value="${p.id}">
            <input type="hidden" name="delta" value="1">
            <button class="btn btn-ghost btn-sm" type="submit" style="padding:.35rem .65rem">+</button>
          </form>
        </div>
      </div>
      <div style="display:flex;gap:.35rem;margin-top:.4rem">
        <a href="/admin/estoque?editar=${p.id}" class="btn btn-ghost btn-sm" style="flex:1;justify-content:center">Editar</a>
        <form method="POST" action="/admin/estoque/toggle" style="flex:1">
          <input type="hidden" name="id" value="${p.id}">
          <input type="hidden" name="ativo" value="${p.ativo?'0':'1'}">
          <button class="btn btn-ghost btn-sm" type="submit" style="width:100%">${p.ativo?'Desativar':'Ativar'}</button>
        </form>
        <form method="POST" action="/admin/estoque/deletar" style="flex:0">
          <input type="hidden" name="id" value="${p.id}">
          <button class="btn btn-danger btn-sm" type="submit" onclick="return confirm('Excluir ${p.nome.replace(/'/g,"\\'")}? Essa ação não pode ser desfeita.')">${ic.trash}</button>
        </form>
      </div>
    </div>`
  }).join('')

  const historicoHtml = movimentacoes.length ? `
  <div class="section-header" style="margin-top:2rem">
    <span class="section-title">Histórico de movimentações</span>
    <span class="section-count">${movimentacoes.length} registros</span>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Produto</th><th>Antes</th><th>Depois</th><th>Variação</th><th>Origem</th><th>Quando</th></tr></thead>
      <tbody>
        ${movimentacoes.map(m => `
          <tr>
            <td>${m.produto_nome || m.produto_id}</td>
            <td class="td-muted">${m.quantidade_anterior}</td>
            <td style="font-weight:600">${m.quantidade_nova}</td>
            <td style="color:${m.delta>0?'var(--green)':m.delta<0?'var(--red-sem)':'var(--muted)'}">
              ${m.delta>0?'+':''}${m.delta}
            </td>
            <td class="td-muted">${m.origem}</td>
            <td class="td-muted">${formatData(m.created_at)} ${formatHora(m.created_at)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''

  const body = `
  ${msg==='ok'  ? `<div class="alert alert-success">${ic.check} Operação realizada com sucesso!</div>` : ''}
  ${msg==='err' ? `<div class="alert alert-error">${ic.warn} Erro ao processar. Tente novamente.</div>` : ''}
  ${produtosZero.length  ? `<div class="alert alert-error">${ic.warn} ${produtosZero.length} produto(s) sem estoque: ${produtosZero.map(p=>p.nome).join(', ')}</div>` : ''}
  ${produtosAlerta.length? `<div class="alert" style="background:var(--amber-dim);border:1px solid rgba(245,158,11,.3);color:var(--amber)">${ic.warn} Estoque baixo: ${produtosAlerta.map(p=>`${p.nome} (${p.estoque} un.)`).join(', ')}</div>` : ''}

  <div class="stats" style="margin-bottom:1.25rem">
    <div class="stat"><div class="stat-icon red">${ic.box}</div><div class="stat-val">${produtos.length}</div><div class="stat-lbl">Produtos</div></div>
    <div class="stat"><div class="stat-icon green">${ic.chart}</div><div class="stat-val">${totalItens}</div><div class="stat-lbl">Total em estoque</div><div class="stat-accent green"></div></div>
    <div class="stat"><div class="stat-icon ${semEstoque>0?'amber':'blue'}">${ic.warn}</div><div class="stat-val" style="color:${semEstoque>0?'var(--amber)':'var(--muted)'}">${semEstoque}</div><div class="stat-lbl">Sem estoque</div></div>
  </div>

  ${formEditar}
  ${formNovo}

  <div class="section-header">
    <span class="section-title">Produtos cadastrados</span>
    <span class="section-count">${produtos.length} itens</span>
  </div>
  <div class="product-grid">${cards}</div>
  ${historicoHtml}`

  res.send(shell('estoque', 'Estoque', 'Gerencie produtos e upsell automático', body))
})

router.post('/estoque/ajustar', express.urlencoded({ extended: false }), (req, res) => {
  const { id, delta } = req.body
  const produto = getDb().prepare('SELECT * FROM produtos WHERE id = ?').get(id)
  if (!produto) return res.redirect(`/admin/estoque`)
  const novoEstoque = Math.max(0, produto.estoque + Number(delta))
  atualizarEstoque(id, novoEstoque)
  try {
    getDb().prepare(`
      INSERT INTO estoque_movimentacoes (produto_id, produto_nome, quantidade_anterior, quantidade_nova, delta, origem)
      VALUES (?, ?, ?, ?, ?, 'painel')
    `).run(id, produto.nome, produto.estoque, novoEstoque, Number(delta))
  } catch (e) { /* sem log se tabela não existe */ }
  log(`Painel: ajuste estoque — produto ${id}: ${produto.estoque} → ${novoEstoque}`)
  res.redirect(`/admin/estoque`)
})

router.post('/estoque/atualizar', express.urlencoded({ extended: false }), (req, res) => {
  const { id, estoque } = req.body
  const produto = getDb().prepare('SELECT * FROM produtos WHERE id = ?').get(id)
  const novo = Number(estoque)
  atualizarEstoque(id, novo)
  if (produto) {
    try {
      getDb().prepare(`
        INSERT INTO estoque_movimentacoes (produto_id, produto_nome, quantidade_anterior, quantidade_nova, delta, origem)
        VALUES (?, ?, ?, ?, ?, 'painel-form')
      `).run(id, produto.nome, produto.estoque, novo, novo - produto.estoque)
    } catch (e) { /* sem log se tabela não existe */ }
  }
  res.redirect(`/admin/estoque?msg=ok`)
})

router.post('/estoque/toggle', express.urlencoded({ extended: false }), (req, res) => {
  const { id, ativo } = req.body
  getDb().prepare(`UPDATE produtos SET ativo = ?, updated_at = datetime('now') WHERE id = ?`).run(Number(ativo), id)
  res.redirect(`/admin/estoque`)
})

router.post('/estoque/criar', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { nome, preco, descricao } = req.body
    if (!nome || !preco) return res.redirect(`/admin/estoque?msg=err`)
    criarProduto({ nome: nome.trim(), preco: Number(preco), descricao: (descricao||'').trim() })
    log(`Painel: produto criado — ${nome}`)
    res.redirect(`/admin/estoque?msg=ok`)
  } catch (e) {
    log('Erro ao criar produto:', e.message)
    res.redirect(`/admin/estoque?msg=err`)
  }
})

router.post('/estoque/editar', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { id, nome, preco, descricao } = req.body
    updateProduto(id, { nome: nome.trim(), preco: Number(preco), descricao: (descricao||'').trim() })
    log(`Painel: produto editado — ${id}`)
    res.redirect(`/admin/estoque?msg=ok`)
  } catch (e) {
    log('Erro ao editar produto:', e.message)
    res.redirect(`/admin/estoque?msg=err`)
  }
})

router.post('/estoque/deletar', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { id } = req.body
    deletarProduto(id)
    log(`Painel: produto deletado — ${id}`)
    res.redirect(`/admin/estoque?msg=ok`)
  } catch (e) {
    log('Erro ao deletar produto:', e.message)
    res.redirect(`/admin/estoque?msg=err`)
  }
})

// ═══════════════════════════════════════════════════════════════
// ROTA: /servicos
// ═══════════════════════════════════════════════════════════════
router.get('/servicos', (req, res) => {
  const msg      = req.query.msg    || ''
  const editId   = req.query.editar || ''
  const servicos = getServicosAtivos()
  const editando = editId ? getServicoById(editId) : null

  const catColors = { cabelo:'var(--blue-l)', barba:'var(--amber)', estetica:'var(--green)' }
  const catOpts   = ['cabelo','barba','estetica'].map(c => `<option value="${c}">${c}</option>`).join('')

  const formNovo = `
  <div class="form-card" style="margin-bottom:1.25rem">
    <div class="form-card-title">${ic.plus} Adicionar novo serviço</div>
    <form method="POST" action="/admin/servicos/criar">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Nome do serviço *</label>
          <input type="text" name="nome" required placeholder="Ex: Platinado c/ Corte">
        </div>
        <div class="form-group">
          <label class="form-label">Categoria</label>
          <select name="categoria">${catOpts}</select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Preço (R$) *</label>
          <input type="number" name="preco" required min="0" step="0.01" placeholder="80.00">
        </div>
        <div class="form-group">
          <label class="form-label">Duração (min) *</label>
          <input type="number" name="duracao" required min="5" step="5" placeholder="60">
        </div>
      </div>
      <button type="submit" class="btn btn-primary">${ic.plus} Adicionar serviço</button>
    </form>
  </div>`

  const formEditar = editando ? `
  <div class="form-card" style="margin-bottom:1.25rem;border-color:var(--red);box-shadow:0 0 0 1px var(--red-dim)">
    <div class="form-card-title">${ic.check} Editando: ${editando.nome}</div>
    <form method="POST" action="/admin/servicos/editar">
      <input type="hidden" name="id" value="${editando.id}">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Nome</label>
          <input type="text" name="nome" value="${editando.nome}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Categoria</label>
          <select name="categoria">
            ${['cabelo','barba','estetica'].map(c=>`<option value="${c}" ${editando.categoria===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Preço (R$)</label>
          <input type="number" name="preco" value="${editando.preco}" min="0" step="0.01" required>
        </div>
        <div class="form-group">
          <label class="form-label">Duração (min)</label>
          <input type="number" name="duracao" value="${editando.duracao_minutos}" min="5" step="5" required>
        </div>
      </div>
      <div style="display:flex;gap:.5rem;margin-top:.5rem">
        <button type="submit" class="btn btn-primary">${ic.check} Salvar alterações</button>
        <a href="/admin/servicos" class="btn btn-ghost">Cancelar</a>
      </div>
    </form>
  </div>` : ''

  const cards = servicos.map(s => {
    const cor = catColors[s.categoria] || 'var(--muted2)'
    return `
    <div class="service-card" ${editId===s.id?'style="border-color:var(--red)"':''}>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:.25rem">
        <div class="service-name">${s.nome}</div>
      </div>
      <div class="service-cat" style="color:${cor};background:${cor}18;border-color:${cor}33">${s.categoria}</div>
      <div class="service-fields">
        <div>
          <div class="field-label">Preço</div>
          <div style="font-size:1rem;font-weight:700;color:var(--white)">R$ ${s.preco.toFixed(2)}</div>
        </div>
        <div>
          <div class="field-label">Duração</div>
          <div style="font-size:1rem;font-weight:700;color:var(--white)">${s.duracao_minutos} min</div>
        </div>
      </div>
      <div style="display:flex;gap:.35rem;margin-top:.5rem">
        <a href="/admin/servicos?editar=${s.id}" class="btn btn-ghost btn-sm" style="flex:1;justify-content:center">Editar</a>
        <form method="POST" action="/admin/servicos/deletar">
          <input type="hidden" name="id" value="${s.id}">
          <button class="btn btn-danger btn-sm" type="submit" onclick="return confirm('Excluir o serviço ${s.nome.replace(/'/g,"\\'")}?')">${ic.trash}</button>
        </form>
      </div>
    </div>`
  }).join('')

  const body = `
  ${msg==='ok'  ? `<div class="alert alert-success">${ic.check} Operação realizada! Reflete imediatamente no bot.</div>` : ''}
  ${msg==='err' ? `<div class="alert alert-error">${ic.warn} Erro ao processar. Tente novamente.</div>` : ''}
  <div class="form-hint" style="margin-bottom:1.25rem;font-size:.8rem;color:var(--muted)">
    ${ic.warn} Qualquer alteração reflete imediatamente nas respostas do bot e no cálculo de horários.
  </div>
  ${formEditar}
  ${formNovo}
  <div class="section-header">
    <span class="section-title">Serviços ativos</span>
    <span class="section-count">${servicos.length} serviços</span>
  </div>
  <div class="service-grid">${cards}</div>`

  res.send(shell('servicos', 'Serviços', 'Preços e durações editáveis', body))
})

router.post('/servicos/atualizar', express.urlencoded({ extended: false }), (req, res) => {
  const { id, preco, duracao } = req.body
  updateServico(id, { preco: Number(preco), duracao_minutos: Number(duracao) })
  res.redirect(`/admin/servicos?msg=ok`)
})

router.post('/servicos/criar', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { nome, preco, duracao, categoria } = req.body
    if (!nome || !preco || !duracao) return res.redirect(`/admin/servicos?msg=err`)
    criarServico({ nome: nome.trim(), preco: Number(preco), duracao_minutos: Number(duracao), categoria: categoria || 'cabelo' })
    log(`Painel: serviço criado — ${nome}`)
    res.redirect(`/admin/servicos?msg=ok`)
  } catch (e) {
    log('Erro ao criar serviço:', e.message)
    res.redirect(`/admin/servicos?msg=err`)
  }
})

router.post('/servicos/editar', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { id, nome, preco, duracao, categoria } = req.body
    updateServico(id, { nome: nome.trim(), preco: Number(preco), duracao_minutos: Number(duracao) })
    if (categoria) getDb().prepare(`UPDATE servicos SET categoria = ? WHERE id = ?`).run(categoria, id)
    log(`Painel: serviço editado — ${id}`)
    res.redirect(`/admin/servicos?msg=ok`)
  } catch (e) {
    log('Erro ao editar serviço:', e.message)
    res.redirect(`/admin/servicos?msg=err`)
  }
})

router.post('/servicos/deletar', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { id } = req.body
    deletarServico(id)
    log(`Painel: serviço deletado — ${id}`)
    res.redirect(`/admin/servicos?msg=ok`)
  } catch (e) {
    log('Erro ao deletar serviço:', e.message)
    res.redirect(`/admin/servicos?msg=err`)
  }
})

// ═══════════════════════════════════════════════════════════════
// ROTA: /config
// ═══════════════════════════════════════════════════════════════
function configLabel(chave) {
  const labels = {
    notificacoes_ativas:         'Notificações para o Andy',
    andy_phone:                  'WhatsApp pessoal do Andy',
    barbearia_phone:             'WhatsApp da barbearia',
    antecedencia_minima_minutos: 'Antecedência mínima para agendamento',
    max_mensagens_ativas_dia:    'Limite de mensagens proativas por dia',
    horario_abertura:            'Horário de abertura',
    horario_fechamento:          'Horário de fechamento',
    horario_almoco_inicio:       'Início do intervalo de almoço',
    horario_almoco_fim:          'Fim do intervalo de almoço',
  }
  return labels[chave] || chave.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

router.get('/config', (req, res) => {
  const msg     = req.query.msg || ''
  const configs = getAllConfigs()

  const grupos = {
    'Notificações':   ['notificacoes_ativas', 'andy_phone', 'barbearia_phone'],
    'Agendamento':    ['antecedencia_minima_minutos', 'max_mensagens_ativas_dia'],
    'Horário de Funcionamento': ['horario_abertura', 'horario_fechamento', 'horario_almoco_inicio', 'horario_almoco_fim'],
  }

  const configMap = {}
  for (const c of configs) configMap[c.chave] = c

  let sections = ''
  for (const [grupo, chaves] of Object.entries(grupos)) {
    const rows = chaves.map(chave => {
      const c = configMap[chave]
      if (!c) return ''
      const isPhone = chave.includes('phone')
      const isBool  = chave === 'notificacoes_ativas'
      let control = ''
      if (isBool) {
        control = `
          <div style="display:flex;align-items:center;gap:.5rem">
            <select name="${c.chave}" style="width:auto">
              <option value="1" ${c.valor==='1'?'selected':''}>Ativado</option>
              <option value="0" ${c.valor==='0'?'selected':''}>Desativado</option>
            </select>
          </div>`
      } else {
        control = `<input type="text" name="${c.chave}" value="${c.valor}" placeholder="${isPhone?'5547999999999@c.us':''}">`
      }
      return `
        <div class="config-row">
          <div class="config-meta">
            <div class="key">${configLabel(c.chave)}</div>
            <div class="desc">${c.descricao || ''}</div>
          </div>
          <div class="config-ctrl">${control}</div>
        </div>`
    }).join('')

    sections += `
    <div class="config-section">
      <div class="config-section-header">${ic.gear} ${grupo}</div>
      ${rows}
    </div>`
  }

  const mapeadas = Object.values(grupos).flat()
  const extras   = configs.filter(c => !mapeadas.includes(c.chave))
  if (extras.length) {
    const rows = extras.map(c => `
      <div class="config-row">
        <div class="config-meta">
          <div class="key">${c.chave}</div>
          <div class="desc">${c.descricao || ''}</div>
        </div>
        <div class="config-ctrl"><input type="text" name="${c.chave}" value="${c.valor}"></div>
      </div>`).join('')
    sections += `<div class="config-section"><div class="config-section-header">${ic.gear} Outros</div>${rows}</div>`
  }

  const body = `
  ${msg==='ok' ? `<div class="alert alert-success">${ic.check} Configurações salvas com sucesso!</div>` : ''}
  <form method="POST" action="/admin/config">
    ${sections}
    <div style="margin-top:1.25rem">
      <button type="submit" class="btn btn-primary">${ic.check} Salvar configurações</button>
    </div>
  </form>`

  res.send(shell('config', 'Configurações', 'Parâmetros do sistema e notificações', body))
})

router.post('/config', express.urlencoded({ extended: true }), (req, res) => {
  const configs = getAllConfigs()
  for (const c of configs) {
    if (req.body[c.chave] !== undefined) setConfig(c.chave, req.body[c.chave])
  }
  log('Painel: configurações atualizadas')
  res.redirect(`/admin/config?msg=ok`)
})

// ═══════════════════════════════════════════════════════════════
// ROTA: /aprovar-sinais
// ═══════════════════════════════════════════════════════════════
router.get('/aprovar-sinais', (req, res) => {
  const msg = req.query.msg || ''
  const pendentes = getAgendamentosAguardandoSinal()

  const linhas = pendentes.length ? pendentes.map(a => `
    <tr>
      <td>${a.nome_cliente || a.whatsapp_number}</td>
      <td>R$ ${(a.sinal_valor || 0).toFixed(2)}</td>
      <td class="td-muted">${a.sinal_pago_at || '—'}</td>
      <td>${a.sinal_comprovante ? `<a href="${a.sinal_comprovante}" target="_blank" class="btn btn-ghost btn-sm">Ver</a>` : '—'}</td>
      <td>
        <form method="POST" action="/admin/aprovar-sinais/${a.id}">
          <button type="submit" class="btn btn-primary btn-sm">${ic.check} Aprovar</button>
        </form>
      </td>
    </tr>`).join('') : `<tr><td colspan="5"><div class="empty"><div class="empty-text">Nenhum sinal aguardando aprovação</div></div></td></tr>`

  const body = `
  ${msg==='ok' ? `<div class="alert alert-success">${ic.check} Sinal aprovado — cliente será notificado.</div>` : ''}
  <div class="table-wrap">
    <table>
      <thead><tr><th>Cliente</th><th>Valor</th><th>Recebido</th><th>Comprovante</th><th>Ação</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
  </div>
  <p class="form-hint" style="margin-top:1rem">Andy também pode aprovar pelo WhatsApp: <code>OK [id]</code></p>`

  res.send(shell('aprovar-sinais', 'Sinais Pix', `${pendentes.length} aguardando aprovação`, body))
})

router.post('/aprovar-sinais/:id', async (req, res) => {
  const id = Number(req.params.id)
  aprovarSinal(id)
  const ag = getAgendamento(id)
  if (ag) {
    const horaLabel = new Date(ag.data_hora_inicio).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' })
    const dataLabel = new Date(ag.data_hora_inicio).toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'2-digit', timeZone:'America/Sao_Paulo' })
    enfileirarMensagem(ag.whatsapp_number, M.sinalAprovado({ hora: horaLabel, dataLabel, barbeiro: staffNameById(ag.staff_id), servico: ag.servico_id }), 'critica')
    log(`Painel: sinal aprovado — agendamento #${id}`)
  }
  res.redirect(`/admin/aprovar-sinais?msg=ok`)
})

// ═══════════════════════════════════════════════════════════════
// ROTA: /eventos-bot
// ═══════════════════════════════════════════════════════════════
router.get('/eventos-bot', (req, res) => {
  const metricas = getMetricasDiarias(14)
  const hoje = new Date().toISOString().slice(0, 10)

  const eventosHoje = getDb().prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(tokens_input), 0) AS ti,
      COALESCE(SUM(tokens_output), 0) AS to_,
      SUM(CASE WHEN precisou_handoff = 1 THEN 1 ELSE 0 END) AS handoffs,
      SUM(CASE WHEN conversa_resolveu_agendamento = 1 THEN 1 ELSE 0 END) AS agendamentos
    FROM eventos_bot WHERE date(created_at) = ?
  `).get(hoje)

  const linhas = metricas.length ? metricas.map(m => `
    <tr>
      <td>${m.data}</td>
      <td>${m.total_msgs_entrada}</td>
      <td>${m.total_msgs_saida}</td>
      <td>${m.total_conversas_unicas}</td>
      <td>${m.total_agendamentos}</td>
      <td>${m.total_handoffs}</td>
      <td class="td-mono">${m.tokens_input_total + m.tokens_output_total}</td>
    </tr>`).join('') : `<tr><td colspan="7"><div class="empty"><div class="empty-text">Sem métricas agregadas ainda</div></div></td></tr>`

  const body = `
  <div class="stats" style="margin-bottom:1.25rem">
    <div class="stat"><div class="stat-icon red">${ic.chart}</div><div class="stat-val">${eventosHoje?.total||0}</div><div class="stat-lbl">Respostas bot hoje</div></div>
    <div class="stat"><div class="stat-icon green">${ic.cal}</div><div class="stat-val">${eventosHoje?.agendamentos||0}</div><div class="stat-lbl">Agendamentos via bot</div></div>
    <div class="stat"><div class="stat-icon amber">${ic.warn}</div><div class="stat-val">${eventosHoje?.handoffs||0}</div><div class="stat-lbl">Handoffs hoje</div></div>
    <div class="stat"><div class="stat-icon blue">${ic.money}</div><div class="stat-val">${((eventosHoje?.ti||0)+(eventosHoje?.to_||0))}</div><div class="stat-lbl">Tokens hoje</div></div>
  </div>
  <div class="section-header"><span class="section-title">Métricas diárias (últimos 14 dias)</span></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Data</th><th>Msgs entrada</th><th>Msgs saída</th><th>Conversas</th><th>Agendamentos</th><th>Handoffs</th><th>Tokens</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
  </div>`

  res.send(shell('eventos-bot', 'Métricas do Bot', 'Telemetria e uso de tokens', body))
})

// Redirects raiz
router.get('/', (req, res) => res.redirect(`/admin/kanban`))
receptionRouter.get('/', (req, res) => res.redirect(`/recepcao/kanban`))

// ═══════════════════════════════════════════════════════════════
//  PAINEL DO BARBEIRO (/barbeiro/*)
// ═══════════════════════════════════════════════════════════════

barbeiroRouter.use(attachBarbeiroUser)

barbeiroRouter.get('/', (req, res) => res.redirect('/barbeiro/agenda'))

barbeiroRouter.post('/logout', express.urlencoded({ extended: false }), (req, res) => {
  req.session.destroy(() => res.redirect('/login'))
})

barbeiroRouter.get('/senha', (req, res) => res.redirect('/barbeiro/conta/senha'))
barbeiroRouter.get('/conta/senha', trocarSenhaGetHandler('barbeiro'))
barbeiroRouter.post('/conta/senha', express.urlencoded({ extended: false }), trocarSenhaPostHandler('barbeiro'))

barbeiroRouter.get('/financeiro/dados', (req, res) => {
  const de = req.query.de
  const ate = req.query.ate
  if (!de || !ate || !/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
    return res.status(400).json({ erro: 'Parâmetros de e ate obrigatórios (YYYY-MM-DD)' })
  }
  res.json(buildFinanceiroDados(req.barbeiro.id, de, ate))
})

barbeiroRouter.get('/inicio', (req, res) => {
  const b = req.barbeiro
  const hoje = hojeStr()
  const ags = getAgendamentosDia(hoje, b.id)
  const deFin = getInicioPeriodoFinanceiro(b.id)
  const fin = buildFinanceiroDados(b.id, deFin, hoje)
  const dataLabel = new Date(`${hoje}T12:00:00`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    timeZone: 'America/Sao_Paulo',
  })
  const body = `
    <h1 class="barber-page-title">Início</h1>
    <section class="bb-section">
      <h2 class="bb-section-title">Agenda de hoje</h2>
      <p class="bb-muted" style="margin:-.5rem 0 .75rem;font-size:.72rem;text-transform:capitalize">${escapeHtml(dataLabel)}</p>
      ${renderBarbeiroAgendaLista(ags, 'Sem agendamentos hoje')}
    </section>
    ${renderResumoFinanceiroHtml(fin)}
  `
  res.send(shellBarbeiro('inicio', 'Início', body, b))
})

barbeiroRouter.get('/agenda', (req, res) => {
  const b = req.barbeiro
  const data = req.query.data || hojeStr()
  const status = req.query.status || 'todos'
  const ags = getAgendamentosBarbeiroDia(data, b.id, status)
  const pillLabels = { todos: 'Todos', confirmado: 'Confirmado', concluido: 'Concluído', 'no-show': 'No-show' }
  const pills = Object.keys(pillLabels)
    .map((s) => {
      const active = status === s
      return `<a href="/barbeiro/agenda?data=${encodeURIComponent(data)}&status=${s}" class="bb-pill ${active ? 'active' : ''}" aria-pressed="${active}">${pillLabels[s]}</a>`
    })
    .join('')
  const body = `
    <h1 class="barber-page-title">Minha agenda</h1>
    <div class="bb-toolbar">
      <label class="form-label" for="agendaDate">Data</label>
      <input type="date" lang="pt-BR" id="agendaDate" value="${escapeHtml(data)}" aria-label="Selecionar data">
      <div class="bb-pills" role="group" aria-label="Filtrar por status">${pills}</div>
    </div>
    ${renderBarbeiroAgendaLista(ags, 'Nenhum agendamento neste dia')}
  `
  const script = `
    document.getElementById('agendaDate').addEventListener('change', function(){
      window.location.href='/barbeiro/agenda?data='+encodeURIComponent(this.value)+'&status=${escapeHtml(status)}'
    })
  `
  res.send(shellBarbeiro('agenda', 'Minha Agenda', body, b, script))
})

barbeiroRouter.get('/financeiro', (req, res) => {
  const b = req.barbeiro
  const deDefault = req.query.de || getInicioPeriodoFinanceiro(b.id)
  const ateDefault = req.query.ate || hojeStr()
  const periodo = req.query.periodo || ''

  const body = `
    <div x-data="financeiroBarbeiro()" x-init="init()" class="bb-financeiro">
      <h1 class="barber-page-title">Meu financeiro</h1>

      <div class="bb-period-btns" role="group" aria-label="Período rápido">
        <button type="button" class="bb-pill" :class="periodoAtivo==='semana'?'active':''" @click="setPeriodo('semana')">Esta semana</button>
        <button type="button" class="bb-pill" :class="periodoAtivo==='mes'?'active':''" @click="setPeriodo('mes')">Este mês</button>
        <button type="button" class="bb-pill" :class="periodoAtivo==='mes_anterior'?'active':''" @click="setPeriodo('mes_anterior')">Mês anterior</button>
        <button type="button" class="bb-pill" :class="periodoAtivo==='3meses'?'active':''" @click="setPeriodo('3meses')">Últimos 3 meses</button>
      </div>

      <div class="bb-date-range bb-toolbar">
        <div class="form-group" style="margin:0">
          <label class="form-label" for="finDe">De</label>
          <input type="date" lang="pt-BR" id="finDe" x-model="de" @change="periodoAtivo='manual'; carregar()">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label" for="finAte">Até</label>
          <input type="date" lang="pt-BR" id="finAte" x-model="ate" @change="periodoAtivo='manual'; carregar()">
        </div>
      </div>

      <template x-if="carregando">
        <p class="bb-empty">Carregando…</p>
      </template>

      <template x-if="!carregando && dados">
        <div>
          <template x-if="dados.resumo.comissao_nao_configurada">
            <div class="bb-alert">${ic.warn} Percentual não configurado — fale com Andy</div>
          </template>

          <div class="bb-stat-grid" style="margin-top:.75rem">
            <div class="bb-stat" x-show="modoCompleto">
              <div class="bb-stat-lbl">Total bruto</div>
              <div class="bb-stat-val" x-text="fmt(dados.resumo.total_bruto)"></div>
            </div>
            <div class="bb-stat">
              <div class="bb-stat-lbl">Comissão est.</div>
              <div class="bb-stat-val" x-text="fmt(dados.resumo.total_comissao)"></div>
            </div>
            <div class="bb-stat">
              <div class="bb-stat-lbl">Atendimentos</div>
              <div class="bb-stat-val sm" x-text="dados.resumo.atendimentos"></div>
            </div>
            <div class="bb-stat" x-show="modoCompleto">
              <div class="bb-stat-lbl">Ticket médio</div>
              <div class="bb-stat-val sm" x-text="fmt(dados.resumo.ticket_medio)"></div>
            </div>
          </div>

          <div class="bb-toggle-row">
            <span class="bb-muted">Exibir valores</span>
            <button type="button" class="bb-toggle" :class="modoCompleto?'on':''" @click="modoCompleto=!modoCompleto"
              x-text="modoCompleto ? 'Bruto + comissão' : 'Só comissão'"></button>
          </div>

          <div class="bb-ranking" x-show="dados.ranking_total > 0">
            Você é o <strong x-text="dados.ranking_posicao + 'º'"></strong> de
            <strong x-text="dados.ranking_total"></strong> barbeiros neste período
          </div>

          <section class="bb-section" x-show="dados.top_servicos.length">
            <h2 class="bb-section-title">Top 3 serviços</h2>
            <template x-for="s in dados.top_servicos" :key="s.nome">
              <div class="bb-servico-row">
                <span x-text="s.nome"></span>
                <span><span x-text="s.quantidade"></span>× · <strong x-text="fmt(s.total_bruto)"></strong></span>
              </div>
            </template>
          </section>

          <section class="bb-section">
            <h2 class="bb-section-title">Atendimentos do período</h2>
            <template x-if="!atendimentosVisiveis.length">
              <div class="bb-empty">Nenhum atendimento concluído no período</div>
            </template>
            <template x-for="a in atendimentosVisiveis" :key="a.agendamento_id">
              <article class="bb-atend-item">
                <div class="bb-atend-top">
                  <div>
                    <div class="bb-card-title" x-text="a.cliente"></div>
                    <div class="bb-atend-date" x-text="a.data + ' · ' + a.horario"></div>
                  </div>
                  <div style="text-align:right">
                    <div class="bb-money" x-show="modoCompleto" x-text="fmt(a.valor_bruto)"></div>
                    <div class="bb-money" x-show="!modoCompleto" x-text="fmt(a.valor_comissao)"></div>
                    <div class="bb-muted" style="font-size:.72rem;margin-top:.2rem" x-show="modoCompleto" x-text="'Comissão: ' + fmt(a.valor_comissao)"></div>
                  </div>
                </div>
                <div class="bb-card-meta" x-text="a.servico_nome"></div>
              </article>
            </template>
            <button type="button" class="bb-load-more" x-show="limiteAtend < dados.atendimentos.length"
              @click="limiteAtend += 20">Carregar mais</button>
          </section>

          <section class="bb-section" x-show="dados.fechamentos.length">
            <h2 class="bb-section-title">Histórico de fechamentos</h2>
            <template x-for="f in dados.fechamentos" :key="f.id">
              <article class="bb-fech-card">
                <div class="bb-card-row">
                  <strong x-text="f.periodo_inicio + ' → ' + f.periodo_fim"></strong>
                  <span x-html="fechBadge(f.status)"></span>
                </div>
                <div class="bb-fech-row"><span>Bruto</span><span x-text="fmt(f.total_bruto)"></span></div>
                <div class="bb-fech-row"><span>Comissão</span><span x-text="fmt(f.total_comissao)"></span></div>
                <div class="bb-fech-row" x-show="f.pago_em"><span>Pago em</span><span x-text="f.pago_em"></span></div>
              </article>
            </template>
          </section>
        </div>
      </template>
    </div>
  `

  const periodosServidor = {
    semana: calcularPeriodoRapido('semana'),
    mes: calcularPeriodoRapido('mes'),
    mes_anterior: calcularPeriodoRapido('mes_anterior'),
    '3meses': calcularPeriodoRapido('3meses'),
  }

  const script = `
    const PERIODOS = ${JSON.stringify(periodosServidor)};

    function financeiroBarbeiro() {
      return {
        de: ${JSON.stringify(deDefault)},
        ate: ${JSON.stringify(ateDefault)},
        periodoAtivo: ${JSON.stringify(periodo || 'custom')},
        dados: null,
        carregando: true,
        modoCompleto: true,
        limiteAtend: 20,
        fmt(v) {
          const n = Number(v) || 0;
          return 'R$ ' + n.toFixed(2).replace('.', ',');
        },
        fechBadge(status) {
          if (status === 'pago') {
            return '<span style="background:rgba(34,197,94,.12);color:#4ade80;padding:.2rem .65rem;border-radius:20px;font-size:.68rem;font-weight:600">Pago</span>';
          }
          return '<span style="background:rgba(245,158,11,.12);color:#f59e0b;padding:.2rem .65rem;border-radius:20px;font-size:.68rem;font-weight:600">Aberto</span>';
        },
        get atendimentosVisiveis() {
          if (!this.dados) return [];
          return this.dados.atendimentos.slice(0, this.limiteAtend);
        },
        init() {
          const pInicial = ${JSON.stringify(periodo || '')};
          if (pInicial && PERIODOS[pInicial]) {
            this.de = PERIODOS[pInicial].de;
            this.ate = PERIODOS[pInicial].ate;
            this.periodoAtivo = pInicial;
          }
          this.carregar();
        },
        setPeriodo(tipo) {
          const p = PERIODOS[tipo];
          if (!p) return;
          this.de = p.de;
          this.ate = p.ate;
          this.periodoAtivo = tipo;
          this.carregar();
        },
        async carregar() {
          this.carregando = true;
          this.limiteAtend = 20;
          try {
            const q = new URLSearchParams({ de: this.de, ate: this.ate });
            const r = await fetch('/barbeiro/financeiro/dados?' + q.toString());
            if (!r.ok) throw new Error('Erro ao carregar');
            this.dados = await r.json();
          } catch (e) {
            this.dados = null;
          }
          this.carregando = false;
        },
      };
    }
  `

  res.send(shellBarbeiro('financeiro', 'Meu Financeiro', body, b, script))
})

export { router as panelRouter, receptionRouter, barbeiroRouter }

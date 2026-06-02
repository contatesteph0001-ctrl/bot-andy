import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import fs       from 'fs'
import path     from 'path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'url'
import { log } from './logger.mjs'
import { nowIsoBRT, nowIsoBRTOffsetMinutes } from './time.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR  = path.join(__dirname, '..', 'data')
const DB_PATH   = process.env.DB_PATH || path.join(DATA_DIR, 'chatbot.db')

let db = null

// ═══════════════════════════════════════════════════════════════
//  SCHEMA
// ═══════════════════════════════════════════════════════════════
const SCHEMA = `

-- Clientes identificados pelo número WhatsApp
CREATE TABLE IF NOT EXISTS clientes (
  whatsapp_number      TEXT PRIMARY KEY,
  nome                 TEXT,
  no_show_count        INTEGER NOT NULL DEFAULT 0,
  confirmacao_rigorosa INTEGER NOT NULL DEFAULT 0, -- 1 após 2 no-shows
  lgpd_aceito          INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Agendamentos (espelho do Google Calendar)
CREATE TABLE IF NOT EXISTS agendamentos (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number                 TEXT    NOT NULL,
  cliente_nome                    TEXT,
  staff_id                        TEXT    NOT NULL DEFAULT 'barbeiro1',
  servico_id                      TEXT    NOT NULL,
  data_hora_inicio                TEXT    NOT NULL,  -- ISO8601
  data_hora_fim                   TEXT    NOT NULL,  -- ISO8601
  google_event_id                 TEXT,
  status                          TEXT    NOT NULL DEFAULT 'confirmado',
    -- confirmado | cancelado | concluido | no_show
  lembrete_2h_enviado_at          TEXT,
  confirmado_pelo_cliente_at      TEXT,
  cancelado_automaticamente_at    TEXT,
  upsell_pos_agendamento_enviado  INTEGER NOT NULL DEFAULT 0,
  upsell_pos_servico_enviado      INTEGER NOT NULL DEFAULT 0,
  created_at                      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (whatsapp_number) REFERENCES clientes(whatsapp_number)
);

-- Log de todas as mensagens (auditoria)
CREATE TABLE IF NOT EXISTS mensagens_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number  TEXT NOT NULL,
  direcao          TEXT NOT NULL CHECK (direcao IN ('entrada', 'saida')),
  tipo             TEXT NOT NULL DEFAULT 'texto',  -- texto | audio | imagem | sticker
  conteudo         TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Produtos com controle de estoque
CREATE TABLE IF NOT EXISTS produtos (
  id          TEXT    PRIMARY KEY,  -- mesmo id do config.mjs
  nome        TEXT    NOT NULL,
  descricao   TEXT,
  preco       REAL    NOT NULL,
  estoque     INTEGER NOT NULL DEFAULT 0,
  ativo       INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Vendas de produtos (para faturamento separado)
CREATE TABLE IF NOT EXISTS vendas_produtos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id   INTEGER,  -- nullable (venda avulsa)
  whatsapp_number  TEXT    NOT NULL,
  produto_id       TEXT    NOT NULL,
  quantidade       INTEGER NOT NULL DEFAULT 1,
  valor_unitario   REAL    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);

-- Fila de espera (cache diário — expira quando o horário passa)
CREATE TABLE IF NOT EXISTS fila_espera (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number  TEXT NOT NULL,
  cliente_nome     TEXT,
  staff_id         TEXT,             -- NULL = qualquer barbeiro
  servico_id       TEXT NOT NULL,
  data_hora_alvo   TEXT NOT NULL,    -- ISO8601 do horário desejado
  notificado_at    TEXT,             -- quando o bot avisou do slot aberto
  respondeu        INTEGER NOT NULL DEFAULT 0,
  expirado         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- No-shows registrados
CREATE TABLE IF NOT EXISTS no_shows (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number  TEXT    NOT NULL,
  agendamento_id   INTEGER NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id)
);

-- Contador de mensagens ativas por cliente por dia
-- (para não ultrapassar MAX_DAILY_ACTIVE_MESSAGES)
CREATE TABLE IF NOT EXISTS mensagens_ativas_dia (
  whatsapp_number  TEXT NOT NULL,
  data             TEXT NOT NULL,   -- formato YYYY-MM-DD
  contagem         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (whatsapp_number, data)
);

-- Configurações editáveis pelo painel (key-value)
CREATE TABLE IF NOT EXISTS configuracoes (
  chave       TEXT PRIMARY KEY,
  valor       TEXT NOT NULL,
  descricao   TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Serviços com preços editáveis pelo painel
CREATE TABLE IF NOT EXISTS servicos (
  id               TEXT    PRIMARY KEY,
  nome             TEXT    NOT NULL,
  duracao_minutos  INTEGER NOT NULL,
  preco            REAL    NOT NULL,
  categoria        TEXT    NOT NULL DEFAULT 'cabelo',
  ativo            INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Conversas persistentes (substitui Map em memória)
CREATE TABLE IF NOT EXISTS conversas (
  whatsapp_number   TEXT PRIMARY KEY,
  historico         TEXT NOT NULL DEFAULT '[]',
  resumo            TEXT,
  ultima_atividade  TEXT NOT NULL DEFAULT (datetime('now')),
  aguardando_andy_since TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fila de mensagens proativas com retry
CREATE TABLE IF NOT EXISTS mensagens_pendentes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number  TEXT    NOT NULL,
  conteudo         TEXT    NOT NULL,
  tipo             TEXT    NOT NULL DEFAULT 'proativa',
  status           TEXT    NOT NULL DEFAULT 'pendente',
  tentativas       INTEGER NOT NULL DEFAULT 0,
  proximo_retry    TEXT    NOT NULL DEFAULT (datetime('now')),
  ultimo_erro      TEXT,
  enviada_at       TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Telemetria estruturada do bot
CREATE TABLE IF NOT EXISTS eventos_bot (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number                 TEXT NOT NULL,
  conversa_resolveu_agendamento   INTEGER NOT NULL DEFAULT 0,
  tools_chamadas                  TEXT,
  tokens_input                    INTEGER DEFAULT 0,
  tokens_output                   INTEGER DEFAULT 0,
  latencia_resposta_ms            INTEGER DEFAULT 0,
  precisou_handoff                INTEGER NOT NULL DEFAULT 0,
  motivo_handoff                  TEXT,
  cliente_silenciou               INTEGER NOT NULL DEFAULT 0,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Métricas diárias agregadas
CREATE TABLE IF NOT EXISTS metricas_diarias (
  data                     TEXT PRIMARY KEY,
  total_msgs_entrada       INTEGER NOT NULL DEFAULT 0,
  total_msgs_saida         INTEGER NOT NULL DEFAULT 0,
  total_conversas_unicas   INTEGER NOT NULL DEFAULT 0,
  total_agendamentos       INTEGER NOT NULL DEFAULT 0,
  total_no_shows           INTEGER NOT NULL DEFAULT 0,
  total_handoffs           INTEGER NOT NULL DEFAULT 0,
  tokens_input_total       INTEGER NOT NULL DEFAULT 0,
  tokens_output_total      INTEGER NOT NULL DEFAULT 0
);

-- Interesses em produtos
CREATE TABLE IF NOT EXISTS interesses_produtos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_number  TEXT NOT NULL,
  produto_id       TEXT NOT NULL,
  contexto         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);

-- Rate limiting por número
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  whatsapp_number  TEXT PRIMARY KEY,
  msgs_hora_atual  INTEGER NOT NULL DEFAULT 0,
  janela_inicio    TEXT NOT NULL DEFAULT (datetime('now')),
  bloqueado_ate    TEXT,
  loop_count       INTEGER NOT NULL DEFAULT 0
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_agend_whatsapp   ON agendamentos(whatsapp_number);
CREATE INDEX IF NOT EXISTS idx_agend_data_hora  ON agendamentos(data_hora_inicio);
CREATE INDEX IF NOT EXISTS idx_agend_status     ON agendamentos(status);
CREATE INDEX IF NOT EXISTS idx_agend_staff      ON agendamentos(staff_id);
CREATE INDEX IF NOT EXISTS idx_msg_whatsapp     ON mensagens_log(whatsapp_number);
CREATE INDEX IF NOT EXISTS idx_fila_data_hora   ON fila_espera(data_hora_alvo);
CREATE INDEX IF NOT EXISTS idx_fila_expirado    ON fila_espera(expirado);
CREATE INDEX IF NOT EXISTS idx_pendentes_status ON mensagens_pendentes(status, proximo_retry);
CREATE INDEX IF NOT EXISTS idx_eventos_created  ON eventos_bot(created_at);
CREATE INDEX IF NOT EXISTS idx_interesses_wpp   ON interesses_produtos(whatsapp_number);
`

function columnExists(table, column) {
  return getDb().pragma(`table_info(${table})`).some(c => c.name === column)
}

function addColumnIfMissing(table, column, definition) {
  if (!columnExists(table, column)) {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    log(`Migration: ${table}.${column}`)
  }
}

/**
 * Migrações do módulo financeiro: barbeiros, comissões, fechamentos, despesas e sessões.
 * Idempotente (CREATE IF NOT EXISTS / colunas condicionais).
 */
function runFinanceiroMigrations() {
  const database = getDb()
  database.exec(`
CREATE TABLE IF NOT EXISTS barbeiros (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  whatsapp    TEXT,
  senha_hash  TEXT NOT NULL,
  comissao_padrao_pct REAL NOT NULL DEFAULT 0,
  ativo       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comissao_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  barbeiro_id TEXT NOT NULL,
  servico_id  TEXT NOT NULL,
  pct         REAL NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (barbeiro_id) REFERENCES barbeiros(id),
  UNIQUE(barbeiro_id, servico_id)
);

CREATE TABLE IF NOT EXISTS fechamentos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barbeiro_id     TEXT NOT NULL,
  periodo_inicio  TEXT NOT NULL,
  periodo_fim     TEXT NOT NULL,
  total_bruto     REAL NOT NULL DEFAULT 0,
  total_comissao  REAL NOT NULL DEFAULT 0,
  pct_aplicado    REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'aberto',
  pago_em         TEXT,
  pago_por        TEXT,
  obs             TEXT,
  notificado_barbeiro INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (barbeiro_id) REFERENCES barbeiros(id)
);

CREATE TABLE IF NOT EXISTS fechamento_agendamentos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fechamento_id   INTEGER NOT NULL,
  agendamento_id  INTEGER NOT NULL,
  servico_nome    TEXT NOT NULL,
  valor_bruto     REAL NOT NULL,
  pct_comissao    REAL NOT NULL,
  valor_comissao  REAL NOT NULL,
  FOREIGN KEY (fechamento_id) REFERENCES fechamentos(id),
  FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id)
);

CREATE TABLE IF NOT EXISTS despesas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  descricao   TEXT NOT NULL,
  valor       REAL NOT NULL,
  categoria   TEXT NOT NULL DEFAULT 'outros',
  categoria_livre TEXT,
  data        TEXT NOT NULL,
  registrado_por TEXT NOT NULL DEFAULT 'admin',
  obs         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessoes_barbeiro (
  id          TEXT PRIMARY KEY,
  barbeiro_id TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (barbeiro_id) REFERENCES barbeiros(id)
);

CREATE INDEX IF NOT EXISTS idx_fechamentos_barbeiro ON fechamentos(barbeiro_id);
CREATE INDEX IF NOT EXISTS idx_fechamentos_status ON fechamentos(status);
CREATE INDEX IF NOT EXISTS idx_despesas_data ON despesas(data);
CREATE INDEX IF NOT EXISTS idx_sessoes_barbeiro ON sessoes_barbeiro(barbeiro_id);
CREATE INDEX IF NOT EXISTS idx_sessoes_expires ON sessoes_barbeiro(expires_at);
`)

  // ── Colunas de pagamento nos agendamentos ──────────────────────
  // Adiciona forma_pagamento e troco ao agendamento (idempotente)
  addColumnIfMissing('agendamentos', 'forma_pagamento', 'TEXT')
  // JSON serializado: [{"forma":"pix","valor":30},{"forma":"dinheiro","valor":20}]
  addColumnIfMissing('agendamentos', 'pagamento_itens', 'TEXT')
  // Valor total recebido em dinheiro (para cálculo de troco)
  addColumnIfMissing('agendamentos', 'valor_recebido_dinheiro', 'REAL')
  // Troco calculado
  addColumnIfMissing('agendamentos', 'troco', 'REAL')
  // Timestamp de quando o pagamento foi registrado
  addColumnIfMissing('agendamentos', 'pago_em', 'TEXT')

  // ── Vendas de produtos avulsas com pagamento ──────────────────
  addColumnIfMissing('vendas_produtos', 'forma_pagamento', 'TEXT')
  addColumnIfMissing('vendas_produtos', 'pagamento_itens', 'TEXT')
  addColumnIfMissing('vendas_produtos', 'valor_recebido_dinheiro', 'REAL')
  addColumnIfMissing('vendas_produtos', 'troco', 'REAL')
  addColumnIfMissing('vendas_produtos', 'pago_em', 'TEXT')

  // ── Tabela: caixas_dia ─────────────────────────────────────────
  // Um registro por dia. O caixa "abre" automaticamente no primeiro pagamento.
  database.exec(`
    CREATE TABLE IF NOT EXISTS caixas_dia (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      data            TEXT NOT NULL UNIQUE,
      fundo_inicial   REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'aberto',
      fechado_em      TEXT,
      fechado_por     TEXT,
      obs             TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_caixas_data ON caixas_dia(data);
    CREATE INDEX IF NOT EXISTS idx_caixas_status ON caixas_dia(status);
  `)

  // ── Tabela: caixa_pagamentos ───────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS caixa_pagamentos (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id          INTEGER NOT NULL,
      data              TEXT NOT NULL,
      tipo              TEXT NOT NULL DEFAULT 'servico',
      agendamento_id    INTEGER,
      venda_produto_id  INTEGER,
      staff_id          TEXT NOT NULL,
      descricao         TEXT NOT NULL,
      valor_servico     REAL NOT NULL DEFAULT 0,
      pagamento_itens   TEXT NOT NULL DEFAULT '[]',
      valor_recebido_dinheiro REAL DEFAULT 0,
      troco             REAL DEFAULT 0,
      estornado         INTEGER NOT NULL DEFAULT 0,
      estornado_em      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (caixa_id) REFERENCES caixas_dia(id)
    );
    CREATE INDEX IF NOT EXISTS idx_caixa_pagamentos_caixa ON caixa_pagamentos(caixa_id);
    CREATE INDEX IF NOT EXISTS idx_caixa_pagamentos_data ON caixa_pagamentos(data);
    CREATE INDEX IF NOT EXISTS idx_caixa_pagamentos_agendamento ON caixa_pagamentos(agendamento_id);
    CREATE INDEX IF NOT EXISTS idx_caixa_pagamentos_staff ON caixa_pagamentos(staff_id);
  `)

  // Placeholders iniciais dos barbeiros (senha provisória: mudar123)
  const senhaPlaceholder = bcrypt.hashSync('mudar123', 10)
  const insertBarbeiro = database.prepare(`
    INSERT OR IGNORE INTO barbeiros (id, nome, senha_hash, comissao_padrao_pct)
    VALUES (@id, @nome, @senha_hash, 0)
  `)
  insertBarbeiro.run({ id: 'barbeiro1', nome: 'Barbeiro 1', senha_hash: senhaPlaceholder })
  insertBarbeiro.run({ id: 'barbeiro2', nome: 'Barbeiro 2', senha_hash: senhaPlaceholder })
  insertBarbeiro.run({ id: 'barbeiro3', nome: 'Barbeiro 3', senha_hash: senhaPlaceholder })
  log('Migration: financeiro (tabelas barbeiros/fechamentos/despesas etc.)')
}

export function runMigrations() {
  addColumnIfMissing('agendamentos', 'sinal_valor', 'REAL')
  addColumnIfMissing('agendamentos', 'sinal_pago_at', 'TEXT')
  addColumnIfMissing('agendamentos', 'sinal_comprovante', 'TEXT')
  addColumnIfMissing('agendamentos', 'sinal_aprovado_at', 'TEXT')
  addColumnIfMissing('agendamentos', 'feedback_nota', 'INTEGER')
  addColumnIfMissing('agendamentos', 'feedback_enviado_at', 'TEXT')
  addColumnIfMissing('clientes', 'bloqueado', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('clientes', 'motivo_bloqueio', 'TEXT')
  addColumnIfMissing('clientes', 'ultima_reativacao_at', 'TEXT')
  addColumnIfMissing('clientes', 'fotos_recebidas_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('clientes', 'sticker_respondido', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agendamentos', 'concluido_automatico', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agendamentos', 'presenca_confirmada_at', 'TEXT')
  addColumnIfMissing('agendamentos', 'no_show_marcado_at', 'TEXT')
  runFinanceiroMigrations()
  runUsuariosMigrations()
}

function runUsuariosMigrations() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL,
      staff_id TEXT,
      nome TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios(username);
    CREATE INDEX IF NOT EXISTS idx_usuarios_staff ON usuarios(staff_id);
  `)
}

export function getUsuarioPorUsername(username) {
  return getDb()
    .prepare(`SELECT * FROM usuarios WHERE username = ? AND ativo = 1`)
    .get(username)
}

export function getUsuarioPorStaffId(staffId) {
  return getDb()
    .prepare(`SELECT * FROM usuarios WHERE staff_id = ? AND ativo = 1 LIMIT 1`)
    .get(staffId)
}

export function getUsuarioPorId(id) {
  return getDb()
    .prepare(`SELECT * FROM usuarios WHERE id = ? AND ativo = 1`)
    .get(id)
}

export function listarUsuarios() {
  return getDb()
    .prepare(`SELECT id, username, papel, staff_id, nome, ativo, created_at FROM usuarios ORDER BY papel, username`)
    .all()
}

export function atualizarSenhaUsuario(id, senhaHash) {
  return getDb()
    .prepare(`UPDATE usuarios SET senha_hash = ? WHERE id = ? AND ativo = 1`)
    .run(senhaHash, id)
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
export function initDb(configData = {}) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  runMigrations()
  seedConfiguracoes()
  if (configData.services) seedServicos(configData.services)
  if (configData.products) seedProdutos(configData.products)
  log('SQLite pronto:', DB_PATH)
  return db
}

export function getDb() {
  if (!db) throw new Error('Banco não inicializado — chame initDb() primeiro')
  return db
}

// ── Seeds ────────────────────────────────────────────────────────
function seedConfiguracoes() {
  const defaults = [
    {
      chave:    'andy_phone',
      valor:    process.env.ANDY_PHONE || '',
      descricao: 'Número pessoal do Andy para notificações (formato: 5547999999999@c.us)',
    },
    {
      chave:    'barbearia_phone',
      valor:    process.env.BARBEARIA_PHONE || '',
      descricao: 'Número principal da barbearia',
    },
    {
      chave:    'notificacoes_ativas',
      valor:    '1',
      descricao: 'Andy recebe notificações? (1=sim, 0=não)',
    },
    {
      chave:    'antecedencia_minima_minutos',
      valor:    '30',
      descricao: 'Minutos mínimos de antecedência para agendamento online',
    },
    {
      chave:    'max_mensagens_ativas_dia',
      valor:    '5',
      descricao: 'Máximo de mensagens proativas por cliente por dia',
    },
    {
      chave:    'horario_abertura',
      valor:    '09:00',
      descricao: 'Horário de abertura padrão',
    },
    {
      chave:    'horario_fechamento',
      valor:    '19:00',
      descricao: 'Horário de fechamento padrão',
    },
    {
      chave:    'horario_almoco_inicio',
      valor:    '12:00',
      descricao: 'Início do almoço',
    },
    {
      chave:    'horario_almoco_fim',
      valor:    '13:00',
      descricao: 'Fim do almoço',
    },
    {
      chave:    'chave_pix_sinal',
      valor:    '',
      descricao: 'Chave Pix da barbearia pra sinal de 50%',
    },
    {
      chave:    'google_review_link',
      valor:    '',
      descricao: 'Link da review do Google da barbearia',
    },
    {
      chave:    'janela_proativa_inicio',
      valor:    '8',
      descricao: 'Hora de início pra mensagens proativas (24h)',
    },
    {
      chave:    'janela_proativa_fim',
      valor:    '22',
      descricao: 'Hora de fim pra mensagens proativas (24h)',
    },
  ]

  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO configuracoes (chave, valor, descricao)
    VALUES (@chave, @valor, @descricao)
  `)
  for (const row of defaults) insert.run(row)
}

function seedProdutos(products = []) {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO produtos (id, nome, descricao, preco, estoque, ativo)
    VALUES (@id, @name, @description, @price, 0, 1)
  `)
  for (const p of products) insert.run({ id: p.id, name: p.name, description: p.description || '', price: p.price })
}

function seedServicos(services = []) {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO servicos (id, nome, duracao_minutos, preco, categoria)
    VALUES (@id, @nome, @duracao_minutos, @preco, @categoria)
  `)
  for (const s of services) {
    insert.run({
      id:              s.id,
      nome:            s.name,
      duracao_minutos: s.durationMinutes,
      preco:           s.price,
      categoria:       s.category || 'cabelo',
    })
  }
}

// ═══════════════════════════════════════════════════════════════
//  CLIENTES
// ═══════════════════════════════════════════════════════════════
export function upsertCliente(whatsappNumber, nome = null) {
  const existing = getCliente(whatsappNumber)
  if (existing) {
    if (nome && nome !== existing.nome) {
      getDb()
        .prepare(`UPDATE clientes SET nome = ?, updated_at = datetime('now') WHERE whatsapp_number = ?`)
        .run(nome, whatsappNumber)
    }
    return getCliente(whatsappNumber)
  }
  getDb()
    .prepare(`INSERT INTO clientes (whatsapp_number, nome) VALUES (?, ?)`)
    .run(whatsappNumber, nome)
  return getCliente(whatsappNumber)
}

export function getCliente(whatsappNumber) {
  return getDb()
    .prepare(`SELECT * FROM clientes WHERE whatsapp_number = ?`)
    .get(whatsappNumber)
}

export function marcarLgpdAceito(whatsappNumber) {
  getDb()
    .prepare(`UPDATE clientes SET lgpd_aceito = 1, updated_at = datetime('now') WHERE whatsapp_number = ?`)
    .run(whatsappNumber)
}

// ═══════════════════════════════════════════════════════════════
//  AGENDAMENTOS
// ═══════════════════════════════════════════════════════════════
export function criarAgendamento({ whatsappNumber, clienteNome, staffId, servicoId, dataHoraInicio, dataHoraFim, googleEventId }) {
  const result = getDb()
    .prepare(`
      INSERT INTO agendamentos
        (whatsapp_number, cliente_nome, staff_id, servico_id, data_hora_inicio, data_hora_fim, google_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(whatsappNumber, clienteNome, staffId, servicoId, dataHoraInicio, dataHoraFim, googleEventId)
  return getAgendamento(result.lastInsertRowid)
}

export function getAgendamento(id) {
  return getDb().prepare(`SELECT * FROM agendamentos WHERE id = ?`).get(id)
}

export function getAgendamentoByGoogleId(googleEventId) {
  return getDb()
    .prepare(`SELECT * FROM agendamentos WHERE google_event_id = ?`)
    .get(googleEventId)
}

export function getAgendamentosFuturosCliente(whatsappNumber) {
  const agora = nowIsoBRT() // TZ-FIX: comparação em BRT, não UTC do SQLite
  return getDb()
    .prepare(`
      SELECT * FROM agendamentos
      WHERE whatsapp_number = ?
        AND status = 'confirmado'
        AND data_hora_inicio > ?
      ORDER BY data_hora_inicio ASC
    `)
    .all(whatsappNumber, agora)
}

export function cancelarAgendamento(id, motivo = 'manual') {
  getDb()
    .prepare(`
      UPDATE agendamentos
      SET status = 'cancelado',
          cancelado_automaticamente_at = CASE WHEN ? = 'automatico' THEN datetime('now') ELSE NULL END,
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(motivo, id)
}

export function marcarConcluido(id) {
  getDb()
    .prepare(`UPDATE agendamentos SET status = 'concluido', updated_at = datetime('now') WHERE id = ?`)
    .run(id)
}

export function marcarNoShow(id) {
  getDb()
    .prepare(`UPDATE agendamentos SET status = 'no_show', updated_at = datetime('now') WHERE id = ?`)
    .run(id)
}

export function marcarLembrete2hEnviado(id) {
  getDb()
    .prepare(`UPDATE agendamentos SET lembrete_2h_enviado_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(id)
}

export function marcarConfirmadoPeloCliente(id) {
  getDb()
    .prepare(`UPDATE agendamentos SET confirmado_pelo_cliente_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(id)
}

export function marcarUpsellPosAgendamento(id) {
  getDb()
    .prepare(`UPDATE agendamentos SET upsell_pos_agendamento_enviado = 1, updated_at = datetime('now') WHERE id = ?`)
    .run(id)
}

export function marcarUpsellPosServico(id) {
  getDb()
    .prepare(`UPDATE agendamentos SET upsell_pos_servico_enviado = 1, updated_at = datetime('now') WHERE id = ?`)
    .run(id)
}

// Agendamentos que precisam de lembrete (entre 2h e 2h30 do início, ainda não enviado)
export function getAgendamentosParaLembrete() {
  const agora = nowIsoBRT() // TZ-FIX: janela do lembrete 2h antes em BRT
  return getDb()
    .prepare(`
      SELECT a.*, c.nome as nome_cliente
      FROM agendamentos a
      LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
      WHERE a.status = 'confirmado'
        AND a.lembrete_2h_enviado_at IS NULL
        AND datetime(a.data_hora_inicio, '-2 hours', '+30 minutes') >= ?
        AND datetime(a.data_hora_inicio, '-2 hours') <= ?
    `)
    .all(agora, agora)
}

// Agendamentos sem confirmação que devem ser cancelados (início em menos de 1h)
export function getAgendamentosParaCancelarAutomatico() {
  const agora = nowIsoBRT() // TZ-FIX: cancelamento automático 1h antes em BRT
  return getDb()
    .prepare(`
      SELECT a.*, c.nome as nome_cliente
      FROM agendamentos a
      LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
      WHERE a.status = 'confirmado'
        AND a.lembrete_2h_enviado_at IS NOT NULL
        AND a.confirmado_pelo_cliente_at IS NULL
        AND datetime(a.data_hora_inicio, '-1 hour') <= ?
        AND a.data_hora_inicio > ?
    `)
    .all(agora, agora)
}

// Agendamentos que terminaram e o upsell pós-serviço ainda não foi enviado
export function getAgendamentosParaUpsellPosServico() {
  const agora = nowIsoBRT() // TZ-FIX: upsell nos 30 min após o fim em BRT
  const ha30min = nowIsoBRTOffsetMinutes(-30)
  return getDb()
    .prepare(`
      SELECT a.*, c.nome as nome_cliente
      FROM agendamentos a
      LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
      WHERE a.status = 'concluido'
        AND a.upsell_pos_servico_enviado = 0
        AND a.data_hora_fim <= ?
        AND a.data_hora_fim >= ?
    `)
    .all(agora, ha30min)
}

// ═══════════════════════════════════════════════════════════════
//  NO-SHOWS
// ═══════════════════════════════════════════════════════════════
export function registrarNoShow(whatsappNumber, agendamentoId) {
  getDb()
    .prepare(`INSERT INTO no_shows (whatsapp_number, agendamento_id) VALUES (?, ?)`)
    .run(whatsappNumber, agendamentoId)

  const cliente = getCliente(whatsappNumber)
  const novoCount = (cliente?.no_show_count || 0) + 1
  const rigorosa  = novoCount >= 2 ? 1 : 0

  getDb()
    .prepare(`
      UPDATE clientes
      SET no_show_count = ?, confirmacao_rigorosa = ?, updated_at = datetime('now')
      WHERE whatsapp_number = ?
    `)
    .run(novoCount, rigorosa, whatsappNumber)

  return { novoCount, confirmacaoRigorosa: rigorosa === 1 }
}

// ═══════════════════════════════════════════════════════════════
//  FILA DE ESPERA
// ═══════════════════════════════════════════════════════════════
export function adicionarFilaEspera({ whatsappNumber, clienteNome, staffId, servicoId, dataHoraAlvo }) {
  // Evita duplicata para o mesmo número + horário
  const existente = getDb()
    .prepare(`
      SELECT id FROM fila_espera
      WHERE whatsapp_number = ? AND data_hora_alvo = ? AND expirado = 0
    `)
    .get(whatsappNumber, dataHoraAlvo)
  if (existente) return existente

  const result = getDb()
    .prepare(`
      INSERT INTO fila_espera (whatsapp_number, cliente_nome, staff_id, servico_id, data_hora_alvo)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(whatsappNumber, clienteNome, staffId, servicoId, dataHoraAlvo)
  return { id: result.lastInsertRowid }
}

export function getFilaParaHorario(dataHoraAlvo, staffId = null) {
  let query = `
    SELECT * FROM fila_espera
    WHERE data_hora_alvo = ?
      AND expirado = 0
      AND respondeu = 0
      AND notificado_at IS NULL
  `
  const params = [dataHoraAlvo]
  if (staffId) { query += ` AND (staff_id = ? OR staff_id IS NULL)`; params.push(staffId) }
  query += ` ORDER BY created_at ASC`
  return getDb().prepare(query).all(...params)
}

export function marcarNotificadoFila(id) {
  getDb()
    .prepare(`UPDATE fila_espera SET notificado_at = datetime('now') WHERE id = ?`)
    .run(id)
}

export function marcarRespondeufila(id) {
  getDb()
    .prepare(`UPDATE fila_espera SET respondeu = 1 WHERE id = ?`)
    .run(id)
}

export function expirarFilaPassada() {
  getDb()
    .prepare(`
      UPDATE fila_espera SET expirado = 1
      WHERE data_hora_alvo < ? AND expirado = 0
    `)
    .run(nowIsoBRT()) // TZ-FIX: comparar com agora em BRT
}

export function removerClienteFila(whatsappNumber) {
  getDb()
    .prepare(`UPDATE fila_espera SET expirado = 1 WHERE whatsapp_number = ? AND expirado = 0`)
    .run(whatsappNumber)
}

// ═══════════════════════════════════════════════════════════════
//  MENSAGENS ATIVAS (limite diário)
// ═══════════════════════════════════════════════════════════════
export function getMensagensAtivasHoje(whatsappNumber) {
  const hoje = new Date().toISOString().slice(0, 10)
  const row  = getDb()
    .prepare(`SELECT contagem FROM mensagens_ativas_dia WHERE whatsapp_number = ? AND data = ?`)
    .get(whatsappNumber, hoje)
  return row?.contagem || 0
}

export function incrementarMensagemAtiva(whatsappNumber) {
  const hoje = new Date().toISOString().slice(0, 10)
  getDb()
    .prepare(`
      INSERT INTO mensagens_ativas_dia (whatsapp_number, data, contagem)
      VALUES (?, ?, 1)
      ON CONFLICT (whatsapp_number, data) DO UPDATE SET contagem = contagem + 1
    `)
    .run(whatsappNumber, hoje)
}

// ═══════════════════════════════════════════════════════════════
//  PRODUTOS E ESTOQUE
// ═══════════════════════════════════════════════════════════════
export function getProduto(id) {
  return getDb().prepare(`SELECT * FROM produtos WHERE id = ?`).get(id)
}

export function getProdutosEmEstoque() {
  return getDb().prepare(`SELECT * FROM produtos WHERE estoque > 0 AND ativo = 1`).all()
}

export function atualizarEstoque(id, quantidade) {
  getDb()
    .prepare(`UPDATE produtos SET estoque = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(quantidade, id)
}

export function registrarVendaProduto({ whatsappNumber, produtoId, quantidade, valorUnitario, agendamentoId = null }) {
  getDb()
    .prepare(`
      INSERT INTO vendas_produtos (agendamento_id, whatsapp_number, produto_id, quantidade, valor_unitario)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(agendamentoId, whatsappNumber, produtoId, quantidade, valorUnitario)

  // Decrementa estoque
  getDb()
    .prepare(`UPDATE produtos SET estoque = estoque - ?, updated_at = datetime('now') WHERE id = ?`)
    .run(quantidade, produtoId)
}

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES DO PAINEL
// ═══════════════════════════════════════════════════════════════
export function getConfig(chave) {
  const row = getDb().prepare(`SELECT valor FROM configuracoes WHERE chave = ?`).get(chave)
  return row?.valor ?? null
}

export function setConfig(chave, valor) {
  getDb()
    .prepare(`
      INSERT INTO configuracoes (chave, valor, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now')
    `)
    .run(chave, String(valor))
}

export function getAllConfigs() {
  return getDb().prepare(`SELECT * FROM configuracoes ORDER BY chave`).all()
}

// ═══════════════════════════════════════════════════════════════
//  LOG DE MENSAGENS
// ═══════════════════════════════════════════════════════════════
export function logMensagem(whatsappNumber, direcao, conteudo, tipo = 'texto') {
  getDb()
    .prepare(`INSERT INTO mensagens_log (whatsapp_number, direcao, tipo, conteudo) VALUES (?, ?, ?, ?)`)
    .run(whatsappNumber, direcao, tipo, conteudo)
}

// ═══════════════════════════════════════════════════════════════
//  RELATÓRIOS (para o painel)
// ═══════════════════════════════════════════════════════════════
export function getFaturamentoDia(data) {
  // data: 'YYYY-MM-DD'
  const agendamentos = getDb()
    .prepare(`
      SELECT a.*, s.nome AS servico_nome, s.preco AS servico_preco
      FROM agendamentos a
      LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE date(a.data_hora_inicio, '-03:00') = ?
        AND a.status IN ('confirmado', 'concluido')
      ORDER BY a.data_hora_inicio ASC
    `)
    .all(data)

  const totalServicos = agendamentos.reduce((sum, a) => sum + (a.servico_preco || 0), 0)

  const totalProdutos = getDb()
    .prepare(`
      SELECT COALESCE(SUM(v.quantidade * v.valor_unitario), 0) AS total
      FROM vendas_produtos v
      WHERE date(v.created_at) = ?
    `)
    .get(data)?.total || 0

  return {
    totalServicos,
    totalProdutos,
    totalGeral: totalServicos + totalProdutos,
    agendamentos,
  }
}

export function getAgendamentosDia(data, staffId = null) {
  let query = `
    SELECT a.*, c.nome AS nome_cliente, c.no_show_count,
           s.nome AS servico_nome, s.preco AS servico_preco, s.duracao_minutos
    FROM agendamentos a
    LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
    LEFT JOIN servicos s ON s.id = a.servico_id
    WHERE date(a.data_hora_inicio, '-03:00') = ?
      AND a.status IN ('confirmado', 'concluido')
  `
  const params = [data]
  if (staffId) { query += ` AND a.staff_id = ?`; params.push(staffId) }
  query += ` ORDER BY a.data_hora_inicio ASC`
  return getDb().prepare(query).all(...params)
}

/** Kanban recepção: altera status operacional do agendamento. */
export function moverAgendamentoKanban(id, novoStatus) {
  return getDb()
    .prepare(`UPDATE agendamentos SET status=?, updated_at=datetime('now') WHERE id=?`)
    .run(novoStatus, id)
}

/** Kanban recepção: agendamentos do dia com dados do serviço. */
export function getAgendamentosKanban(data) {
  return getDb()
    .prepare(`
      SELECT a.*, s.nome AS servico_nome, s.preco AS servico_preco,
             s.duracao_minutos,
             COALESCE(a.cliente_nome, c.nome) AS nome_cliente
      FROM agendamentos a
      LEFT JOIN servicos s ON a.servico_id = s.id
      LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
      WHERE date(a.data_hora_inicio, '-03:00') = date(?)
      ORDER BY a.data_hora_inicio ASC
    `)
    .all(data)
}

export function getHistoricoCliente(whatsappNumber) {
  return getDb()
    .prepare(`
      SELECT a.*, c.nome as nome_cliente
      FROM agendamentos a
      LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
      WHERE a.whatsapp_number = ?
      ORDER BY a.data_hora_inicio DESC
      LIMIT 50
    `)
    .all(whatsappNumber)
}

// ═══════════════════════════════════════════════════════════════
//  SERVIÇOS (preços e duração editáveis pelo painel)
// ═══════════════════════════════════════════════════════════════
export function getServico(id) {
  return getDb().prepare(`SELECT * FROM servicos WHERE id = ?`).get(id)
}

export function getServicosAtivos() {
  return getDb().prepare(`SELECT * FROM servicos WHERE ativo = 1 ORDER BY nome`).all()
}

export function updateServico(id, { nome, duracao_minutos, preco, ativo }) {
  const fields = []
  const values = []
  if (nome             !== undefined) { fields.push(`nome = ?`);             values.push(nome) }
  if (duracao_minutos  !== undefined) { fields.push(`duracao_minutos = ?`);  values.push(duracao_minutos) }
  if (preco            !== undefined) { fields.push(`preco = ?`);            values.push(preco) }
  if (ativo            !== undefined) { fields.push(`ativo = ?`);            values.push(ativo ? 1 : 0) }
  if (!fields.length) return
  fields.push(`updated_at = datetime('now')`)
  values.push(id)
  getDb().prepare(`UPDATE servicos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getServico(id)
}

// ── CRUD Produtos ────────────────────────────────────────────────
export function criarProduto({ id, nome, descricao, preco, categoria }) {
  const slug = id || nome.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  getDb()
    .prepare(`INSERT OR IGNORE INTO produtos (id, nome, descricao, preco, estoque, ativo) VALUES (?, ?, ?, ?, 0, 1)`)
    .run(slug, nome, descricao || '', preco)
  return getProduto(slug)
}

export function deletarProduto(id) {
  getDb().prepare(`DELETE FROM produtos WHERE id = ?`).run(id)
}

export function updateProduto(id, { nome, descricao, preco }) {
  const fields = []
  const values = []
  if (nome      !== undefined) { fields.push(`nome = ?`);      values.push(nome) }
  if (descricao !== undefined) { fields.push(`descricao = ?`); values.push(descricao) }
  if (preco     !== undefined) { fields.push(`preco = ?`);     values.push(preco) }
  if (!fields.length) return
  fields.push(`updated_at = datetime('now')`)
  values.push(id)
  getDb().prepare(`UPDATE produtos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getProduto(id)
}

// ── CRUD Serviços ────────────────────────────────────────────────
export function criarServico({ nome, duracao_minutos, preco, categoria }) {
  const id = nome.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  getDb()
    .prepare(`INSERT OR IGNORE INTO servicos (id, nome, duracao_minutos, preco, categoria, ativo) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(id, nome, duracao_minutos, preco, categoria || 'cabelo')
  return getServico(id)
}

export function deletarServico(id) {
  getDb().prepare(`DELETE FROM servicos WHERE id = ?`).run(id)
}

export function getServicoById(id) {
  return getDb().prepare(`SELECT * FROM servicos WHERE id = ?`).get(id)
}

// ═══════════════════════════════════════════════════
//  CONVERSAS PERSISTENTES
// ═══════════════════════════════════════════════════
export function getConversa(whatsappNumber) {
  const row = getDb().prepare(`SELECT * FROM conversas WHERE whatsapp_number = ?`).get(whatsappNumber)
  if (!row) return { historico: [], resumo: null, aguardando_andy: false }
  return {
    historico: JSON.parse(row.historico || '[]'),
    resumo: row.resumo,
    aguardando_andy: !!row.aguardando_andy_since,
    aguardando_andy_since: row.aguardando_andy_since,
  }
}

export function salvarConversa(whatsappNumber, historico, resumo = null) {
  const hist = JSON.stringify(historico)
  getDb().prepare(`
    INSERT INTO conversas (whatsapp_number, historico, resumo, ultima_atividade, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT (whatsapp_number) DO UPDATE SET
      historico = excluded.historico,
      resumo = COALESCE(excluded.resumo, conversas.resumo),
      ultima_atividade = datetime('now'),
      updated_at = datetime('now')
  `).run(whatsappNumber, hist, resumo)
}

export function marcarAguardandoAndy(whatsappNumber, motivo = null) {
  getDb().prepare(`
    UPDATE conversas SET aguardando_andy_since = datetime('now'), updated_at = datetime('now')
    WHERE whatsapp_number = ?
  `).run(whatsappNumber)
}

export function limparAguardandoAndy(whatsappNumber) {
  getDb().prepare(`
    UPDATE conversas SET aguardando_andy_since = NULL, updated_at = datetime('now')
    WHERE whatsapp_number = ?
  `).run(whatsappNumber)
}

export function getConversasAguardandoAndyAntigas(minutos = 60) {
  return getDb().prepare(`
    SELECT * FROM conversas
    WHERE aguardando_andy_since IS NOT NULL
      AND datetime(aguardando_andy_since, '+${minutos} minutes') <= datetime('now')
  `).all()
}

export function getConversasAtivasCount() {
  return getDb().prepare(`
    SELECT COUNT(*) AS c FROM conversas
    WHERE datetime(ultima_atividade) > datetime('now', '-1 hour')
  `).get()?.c || 0
}

// ═══════════════════════════════════════════════════
//  MENSAGENS PENDENTES (retry)
// ═══════════════════════════════════════════════════
export function enfileirarMensagem(whatsappNumber, conteudo, tipo = 'proativa') {
  const result = getDb().prepare(`
    INSERT INTO mensagens_pendentes (whatsapp_number, conteudo, tipo)
    VALUES (?, ?, ?)
  `).run(whatsappNumber, conteudo, tipo)
  return result.lastInsertRowid
}

export function getMensagensParaEnviar() {
  return getDb().prepare(`
    SELECT * FROM mensagens_pendentes
    WHERE status = 'pendente' AND datetime(proximo_retry) <= datetime('now')
    ORDER BY created_at ASC LIMIT 20
  `).all()
}

export function marcarMensagemEnviada(id) {
  getDb().prepare(`
    UPDATE mensagens_pendentes SET status = 'enviada', enviada_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

export function marcarMensagemFalha(id, erro, proximaTentativaMinutos) {
  getDb().prepare(`
    UPDATE mensagens_pendentes
    SET tentativas = tentativas + 1,
        ultimo_erro = ?,
        proximo_retry = datetime('now', '+${proximaTentativaMinutos} minutes'),
        status = CASE WHEN tentativas + 1 >= 3 THEN 'falhou' ELSE 'pendente' END
    WHERE id = ?
  `).run(erro, id)
}

export function getMensagensFalhasNotificar() {
  return getDb().prepare(`
    SELECT * FROM mensagens_pendentes WHERE status = 'falhou' AND tipo = 'critica'
  `).all()
}

// ═══════════════════════════════════════════════════
//  EVENTOS BOT (telemetria)
// ═══════════════════════════════════════════════════
export function registrarEvento(evento) {
  getDb().prepare(`
    INSERT INTO eventos_bot (
      whatsapp_number, conversa_resolveu_agendamento, tools_chamadas,
      tokens_input, tokens_output, latencia_resposta_ms,
      precisou_handoff, motivo_handoff, cliente_silenciou
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evento.whatsapp_number,
    evento.conversa_resolveu_agendamento ? 1 : 0,
    JSON.stringify(evento.tools_chamadas || []),
    evento.tokens_input || 0,
    evento.tokens_output || 0,
    evento.latencia_resposta_ms || 0,
    evento.precisou_handoff ? 1 : 0,
    evento.motivo_handoff || null,
    evento.cliente_silenciou ? 1 : 0,
  )
}

// ═══════════════════════════════════════════════════
//  PERFIL PROGRESSIVO DO CLIENTE
// ═══════════════════════════════════════════════════
export function getPerfilProgressivo(whatsappNumber) {
  const cliente = getCliente(whatsappNumber)
  if (!cliente) return null

  const agendamentos = getDb().prepare(`
    SELECT staff_id, servico_id, data_hora_inicio
    FROM agendamentos
    WHERE whatsapp_number = ? AND status IN ('confirmado', 'concluido')
    ORDER BY data_hora_inicio DESC LIMIT 20
  `).all(whatsappNumber)

  if (agendamentos.length === 0) {
    return {
      no_show_count: cliente.no_show_count,
      confirmacao_rigorosa: !!cliente.confirmacao_rigorosa,
    }
  }

  const contagemBarbeiro = {}
  for (const a of agendamentos) contagemBarbeiro[a.staff_id] = (contagemBarbeiro[a.staff_id] || 0) + 1
  const barbeiroFav = Object.entries(contagemBarbeiro).find(([, c]) => c >= 2)?.[0] || null

  const contagemServico = {}
  for (const a of agendamentos) contagemServico[a.servico_id] = (contagemServico[a.servico_id] || 0) + 1
  const servicoHab = Object.entries(contagemServico).find(([, c]) => c >= 2)?.[0] || null

  const ultima = agendamentos[0]
  const ultimaVisitaDias = ultima
    ? Math.floor((Date.now() - new Date(ultima.data_hora_inicio).getTime()) / 86400000)
    : null

  const produtosInt = getDb().prepare(`
    SELECT DISTINCT p.nome FROM interesses_produtos i
    JOIN produtos p ON p.id = i.produto_id
    WHERE i.whatsapp_number = ?
    ORDER BY i.created_at DESC LIMIT 5
  `).all(whatsappNumber).map(r => r.nome)

  return {
    barbeiro_favorito: barbeiroFav,
    servico_habitual: servicoHab,
    ultima_visita_dias: ultimaVisitaDias,
    no_show_count: cliente.no_show_count,
    confirmacao_rigorosa: !!cliente.confirmacao_rigorosa,
    produtos_interessou: produtosInt,
    total_visitas: agendamentos.length,
  }
}

// ═══════════════════════════════════════════════════
//  RATE LIMITING
// ═══════════════════════════════════════════════════
export function checarRateLimit(whatsappNumber, maxPorHora = 20) {
  const row = getDb().prepare(`SELECT * FROM rate_limit_buckets WHERE whatsapp_number = ?`).get(whatsappNumber)
  const agora = new Date()

  if (!row) {
    getDb().prepare(`
      INSERT INTO rate_limit_buckets (whatsapp_number, msgs_hora_atual, janela_inicio)
      VALUES (?, 1, datetime('now'))
    `).run(whatsappNumber)
    return { permitido: true, restante: maxPorHora - 1 }
  }

  if (row.bloqueado_ate && new Date(row.bloqueado_ate) > agora) {
    return { permitido: false, bloqueado: true }
  }

  const janelaInicio = new Date(row.janela_inicio)
  const minutosDecorridos = (agora - janelaInicio) / 60000

  if (minutosDecorridos >= 60) {
    getDb().prepare(`
      UPDATE rate_limit_buckets SET msgs_hora_atual = 1, janela_inicio = datetime('now'), bloqueado_ate = NULL
      WHERE whatsapp_number = ?
    `).run(whatsappNumber)
    return { permitido: true, restante: maxPorHora - 1 }
  }

  if (row.msgs_hora_atual >= maxPorHora) {
    getDb().prepare(`
      UPDATE rate_limit_buckets SET bloqueado_ate = datetime('now', '+30 minutes')
      WHERE whatsapp_number = ?
    `).run(whatsappNumber)
    return { permitido: false, bloqueado: true }
  }

  getDb().prepare(`
    UPDATE rate_limit_buckets SET msgs_hora_atual = msgs_hora_atual + 1
    WHERE whatsapp_number = ?
  `).run(whatsappNumber)
  return { permitido: true, restante: maxPorHora - row.msgs_hora_atual - 1 }
}

// DEPRECATED: removido em rodada de fix (loop detection prematura); mantida por compatibilidade
export function incrementarLoopCount(whatsappNumber) {
  getDb().prepare(`
    INSERT INTO rate_limit_buckets (whatsapp_number, msgs_hora_atual, janela_inicio, loop_count)
    VALUES (?, 0, datetime('now'), 1)
    ON CONFLICT (whatsapp_number) DO UPDATE SET loop_count = loop_count + 1
  `).run(whatsappNumber)
  const row = getDb().prepare(`SELECT loop_count FROM rate_limit_buckets WHERE whatsapp_number = ?`).get(whatsappNumber)
  return row?.loop_count || 0
}

// DEPRECATED: removido em rodada de fix; ainda usada em confirmação de lembrete (whatsapp.mjs)
export function resetLoopCount(whatsappNumber) {
  getDb().prepare(`UPDATE rate_limit_buckets SET loop_count = 0 WHERE whatsapp_number = ?`).run(whatsappNumber)
}

// ═══════════════════════════════════════════════════
//  BLOQUEIO MANUAL
// ═══════════════════════════════════════════════════
export function clienteBloqueado(whatsappNumber) {
  const row = getDb().prepare(`SELECT bloqueado FROM clientes WHERE whatsapp_number = ?`).get(whatsappNumber)
  return !!row?.bloqueado
}

export function bloquearCliente(whatsappNumber, motivo) {
  getDb().prepare(`
    UPDATE clientes SET bloqueado = 1, motivo_bloqueio = ? WHERE whatsapp_number = ?
  `).run(motivo, whatsappNumber)
}

export function incrementarNoShowParcial(whatsappNumber, delta = 0.5) {
  const cliente = getCliente(whatsappNumber)
  const novoCount = (cliente?.no_show_count || 0) + delta
  const rigorosa = novoCount >= 2 ? 1 : 0
  getDb().prepare(`
    UPDATE clientes SET no_show_count = ?, confirmacao_rigorosa = ?, updated_at = datetime('now')
    WHERE whatsapp_number = ?
  `).run(novoCount, rigorosa, whatsappNumber)
  return { novoCount, confirmacaoRigorosa: rigorosa === 1 }
}

export function incrementarFotosRecebidas(whatsappNumber) {
  getDb().prepare(`
    UPDATE clientes SET fotos_recebidas_count = fotos_recebidas_count + 1, updated_at = datetime('now')
    WHERE whatsapp_number = ?
  `).run(whatsappNumber)
  return getCliente(whatsappNumber)?.fotos_recebidas_count || 0
}

export function marcarStickerRespondido(whatsappNumber) {
  getDb().prepare(`
    UPDATE clientes SET sticker_respondido = 1, updated_at = datetime('now') WHERE whatsapp_number = ?
  `).run(whatsappNumber)
}

// ═══════════════════════════════════════════════════
//  INTERESSES EM PRODUTOS
// ═══════════════════════════════════════════════════
export function registrarInteresseProduto(whatsappNumber, produtoId, contexto = null) {
  getDb().prepare(`
    INSERT INTO interesses_produtos (whatsapp_number, produto_id, contexto)
    VALUES (?, ?, ?)
  `).run(whatsappNumber, produtoId, contexto)
}

export function getInteressesAgregados(diasAtras = 30) {
  return getDb().prepare(`
    SELECT p.id, p.nome, COUNT(*) AS total
    FROM interesses_produtos i
    JOIN produtos p ON p.id = i.produto_id
    WHERE datetime(i.created_at) >= datetime('now', '-${diasAtras} days')
    GROUP BY p.id ORDER BY total DESC
  `).all()
}

// ═══════════════════════════════════════════════════
//  SINAL PIX
// ═══════════════════════════════════════════════════
export function registrarSinalRecebido(agendamentoId, valor, comprovantePath) {
  getDb().prepare(`
    UPDATE agendamentos
    SET sinal_valor = ?, sinal_pago_at = datetime('now'), sinal_comprovante = ?,
        status = 'aguardando_sinal_aprovacao', updated_at = datetime('now')
    WHERE id = ?
  `).run(valor, comprovantePath, agendamentoId)
}

export function aprovarSinal(agendamentoId) {
  getDb().prepare(`
    UPDATE agendamentos
    SET sinal_aprovado_at = datetime('now'), status = 'confirmado', updated_at = datetime('now')
    WHERE id = ?
  `).run(agendamentoId)
}

export function getAgendamentosAguardandoSinal() {
  return getDb().prepare(`
    SELECT a.*, c.nome as nome_cliente FROM agendamentos a
    LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
    WHERE a.status = 'aguardando_sinal_aprovacao'
    ORDER BY a.sinal_pago_at ASC
  `).all()
}

// ═══════════════════════════════════════════════════
//  REATIVAÇÃO
// ═══════════════════════════════════════════════════
export function getClientesParaReativar(diasMin = 35, intervaloReativacao = 60) {
  const agora = nowIsoBRT() // TZ-FIX: última visita / agendamento futuro em BRT
  return getDb().prepare(`
    SELECT c.* FROM clientes c
    WHERE c.bloqueado = 0
      AND c.no_show_count < 2
      AND (c.ultima_reativacao_at IS NULL
           OR datetime(c.ultima_reativacao_at, '+${intervaloReativacao} days') <= ?)
      AND EXISTS (
        SELECT 1 FROM agendamentos a
        WHERE a.whatsapp_number = c.whatsapp_number
          AND a.status IN ('concluido', 'confirmado')
          AND datetime(a.data_hora_inicio, '+${diasMin} days') <= ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM agendamentos a2
        WHERE a2.whatsapp_number = c.whatsapp_number
          AND a2.status = 'confirmado'
          AND a2.data_hora_inicio > ?
      )
    LIMIT 20
  `).all(agora, agora, agora)
}

export function marcarReativacaoEnviada(whatsappNumber) {
  getDb().prepare(`
    UPDATE clientes SET ultima_reativacao_at = datetime('now') WHERE whatsapp_number = ?
  `).run(whatsappNumber)
}

// ═══════════════════════════════════════════════════
//  FEEDBACK PÓS-SERVIÇO
// ═══════════════════════════════════════════════════
export function getAgendamentosParaFeedback() {
  const agora = nowIsoBRT() // TZ-FIX: feedback 4–5h após o fim em BRT
  return getDb().prepare(`
    SELECT a.*, c.nome as nome_cliente FROM agendamentos a
    LEFT JOIN clientes c ON c.whatsapp_number = a.whatsapp_number
    WHERE a.status = 'concluido'
      AND a.feedback_enviado_at IS NULL
      AND datetime(a.data_hora_fim, '+1 hours') <= ?
      AND datetime(a.data_hora_fim, '+6 hours') >= ?
  `).all(agora, agora)
}

export function marcarFeedbackEnviado(agendamentoId) {
  getDb().prepare(`
    UPDATE agendamentos SET feedback_enviado_at = datetime('now') WHERE id = ?
  `).run(agendamentoId)
}

export function getAgendamentoAguardandoFeedback(whatsappNumber) {
  const agora = nowIsoBRT()
  // Aceita nota mesmo sem o cron ter enviado: qualquer atendimento concluido/confirmado nas ultimas 48h BRT
  return getDb().prepare(`
    SELECT * FROM agendamentos
    WHERE whatsapp_number = ?
      AND feedback_nota IS NULL
      AND status IN ('concluido', 'confirmado')
      AND datetime(data_hora_fim, '+48 hours') >= ?
    ORDER BY data_hora_fim DESC LIMIT 1
  `).get(whatsappNumber, agora)
}

export function registrarFeedbackNota(agendamentoId, nota) {
  getDb().prepare(`
    UPDATE agendamentos SET feedback_nota = ? WHERE id = ?
  `).run(nota, agendamentoId)
}

export function getMetricasDiarias(limit = 30) {
  return getDb().prepare(`
    SELECT * FROM metricas_diarias ORDER BY data DESC LIMIT ?
  `).all(limit)
}

// ═══════════════════════════════════════════════════
//  TTL E AGREGAÇÃO DE LOGS
// ═══════════════════════════════════════════════════
export function agregarMetricasDoDia(data) {
  const r = getDb().prepare(`
    SELECT
      SUM(CASE WHEN direcao = 'entrada' THEN 1 ELSE 0 END) AS entrada,
      SUM(CASE WHEN direcao = 'saida' THEN 1 ELSE 0 END) AS saida,
      COUNT(DISTINCT whatsapp_number) AS conversas
    FROM mensagens_log WHERE date(created_at) = ?
  `).get(data)

  const ag = getDb().prepare(`
    SELECT COUNT(*) AS total FROM agendamentos WHERE date(created_at) = ?
  `).get(data)

  const ns = getDb().prepare(`
    SELECT COUNT(*) AS total FROM no_shows WHERE date(created_at) = ?
  `).get(data)

  const ev = getDb().prepare(`
    SELECT
      COALESCE(SUM(tokens_input), 0) AS ti,
      COALESCE(SUM(tokens_output), 0) AS to_,
      SUM(CASE WHEN precisou_handoff = 1 THEN 1 ELSE 0 END) AS handoffs
    FROM eventos_bot WHERE date(created_at) = ?
  `).get(data)

  getDb().prepare(`
    INSERT INTO metricas_diarias (data, total_msgs_entrada, total_msgs_saida, total_conversas_unicas, total_agendamentos, total_no_shows, total_handoffs, tokens_input_total, tokens_output_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (data) DO UPDATE SET
      total_msgs_entrada = excluded.total_msgs_entrada,
      total_msgs_saida = excluded.total_msgs_saida,
      total_conversas_unicas = excluded.total_conversas_unicas,
      total_agendamentos = excluded.total_agendamentos,
      total_no_shows = excluded.total_no_shows,
      total_handoffs = excluded.total_handoffs,
      tokens_input_total = excluded.tokens_input_total,
      tokens_output_total = excluded.tokens_output_total
  `).run(data, r.entrada || 0, r.saida || 0, r.conversas || 0, ag.total || 0, ns.total || 0, ev.handoffs || 0, ev.ti, ev.to_)
}

export function purgarMensagensAntigas(diasTtl = 180) {
  const result = getDb().prepare(`
    DELETE FROM mensagens_log WHERE datetime(created_at) < datetime('now', '-${diasTtl} days')
  `).run()
  return result.changes
}

export function getDbPath() { return DB_PATH }

// ═══════════════════════════════════════════════════════════════
//  BARBEIROS, FECHAMENTOS, DESPESAS E SESSÕES (módulo financeiro)
// ═══════════════════════════════════════════════════════════════

export function getBarbeiros() {
  return getDb().prepare(`SELECT * FROM barbeiros WHERE ativo = 1 ORDER BY id`).all()
}

/** barbeiro1/2/3 com dados de barbeiros + usuário vinculado (login). */
export function listarBarbeiros() {
  return getDb()
    .prepare(`SELECT b.id, b.nome, b.comissao_padrao_pct, b.ativo,
              u.username, u.nome as usuario_nome
              FROM barbeiros b
              LEFT JOIN usuarios u ON u.staff_id = b.id AND u.ativo = 1
              ORDER BY b.id`)
    .all()
}

/** Troca o barbeiro de uma cadeira (staff_id fixo). */
export function trocarBarbeiro(staffId, novoNome, novaSenha, limparAgendamentosFuturos) {
  const db = getDb()
  const existe = db.prepare('SELECT id FROM barbeiros WHERE id = ?').get(staffId)
  if (!existe) throw new Error(`Barbeiro "${staffId}" não encontrado no banco.`)
  const senhaHash = bcrypt.hashSync(novaSenha, 10)
  const now = nowIsoBRT()

  const trocar = db.transaction(() => {
    db.prepare(`UPDATE barbeiros SET nome = ?, updated_at = ? WHERE id = ?`)
      .run(novoNome, now, staffId)

    db.prepare(`UPDATE usuarios SET nome = ?, senha_hash = ? WHERE staff_id = ? AND ativo = 1`)
      .run(novoNome, senhaHash, staffId)

    if (limparAgendamentosFuturos) {
      db.prepare(`
        UPDATE agendamentos
        SET status = 'cancelado', updated_at = ?
        WHERE staff_id = ?
          AND status IN ('confirmado', 'em_atendimento')
          AND data_hora_inicio > ?
      `).run(now, staffId, now)
    }
  })

  trocar()
}

export function getBarbeiroById(id) {
  return getDb().prepare(`SELECT * FROM barbeiros WHERE id = ?`).get(id)
}

export function getBarbeiroByNome(nome) {
  return getDb()
    .prepare(`SELECT * FROM barbeiros WHERE lower(nome) = lower(?) AND ativo = 1`)
    .get(nome)
}

export function updateBarbeiro(id, dados) {
  const fields = []
  const values = []
  if (dados.nome                 !== undefined) { fields.push(`nome = ?`);                 values.push(dados.nome) }
  if (dados.whatsapp             !== undefined) { fields.push(`whatsapp = ?`);             values.push(dados.whatsapp) }
  if (dados.senha_hash           !== undefined) { fields.push(`senha_hash = ?`);           values.push(dados.senha_hash) }
  if (dados.comissao_padrao_pct  !== undefined) { fields.push(`comissao_padrao_pct = ?`);  values.push(dados.comissao_padrao_pct) }
  if (dados.ativo                !== undefined) { fields.push(`ativo = ?`);                values.push(dados.ativo ? 1 : 0) }
  if (!fields.length) return getBarbeiroById(id)
  fields.push(`updated_at = datetime('now')`)
  values.push(id)
  getDb().prepare(`UPDATE barbeiros SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getBarbeiroById(id)
}

export function getComissaoOverrides(barbeiroId) {
  return getDb()
    .prepare(`SELECT * FROM comissao_overrides WHERE barbeiro_id = ? ORDER BY servico_id`)
    .all(barbeiroId)
}

export function setComissaoOverride(barbeiroId, servicoId, pct) {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO comissao_overrides (barbeiro_id, servico_id, pct)
      VALUES (?, ?, ?)
    `)
    .run(barbeiroId, servicoId, pct)
}

export function criarFechamento(dados) {
  const r = getDb()
    .prepare(`
      INSERT INTO fechamentos (
        barbeiro_id, periodo_inicio, periodo_fim, total_bruto, total_comissao, pct_aplicado,
        status, pago_em, pago_por, obs, notificado_barbeiro
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      dados.barbeiro_id,
      dados.periodo_inicio,
      dados.periodo_fim,
      dados.total_bruto ?? 0,
      dados.total_comissao ?? 0,
      dados.pct_aplicado ?? 0,
      dados.status ?? 'aberto',
      dados.pago_em ?? null,
      dados.pago_por ?? null,
      dados.obs ?? null,
      dados.notificado_barbeiro ? 1 : 0,
    )
  return getDb().prepare(`SELECT * FROM fechamentos WHERE id = ?`).get(r.lastInsertRowid)
}

export function getFechamentosByBarbeiro(barbeiroId, limit = 10) {
  return getDb()
    .prepare(`SELECT * FROM fechamentos WHERE barbeiro_id = ? ORDER BY id DESC LIMIT ?`)
    .all(barbeiroId, limit)
}

export function getFechamentosAbertos() {
  return getDb()
    .prepare(`SELECT * FROM fechamentos WHERE status = 'aberto' ORDER BY created_at ASC`)
    .all()
}

export function registrarPagamentoFechamento(id, pagoPor) {
  getDb()
    .prepare(`
      UPDATE fechamentos
      SET status = 'pago',
          pago_em = datetime('now'),
          pago_por = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(pagoPor, id)
  return getDb().prepare(`SELECT * FROM fechamentos WHERE id = ?`).get(id)
}

export function getFechamentoDetalhe(id) {
  const fechamento = getDb().prepare(`SELECT * FROM fechamentos WHERE id = ?`).get(id)
  if (!fechamento) return null
  const linhas = getDb()
    .prepare(`
      SELECT * FROM fechamento_agendamentos
      WHERE fechamento_id = ?
      ORDER BY id
    `)
    .all(id)
  return { fechamento, agendamentos: linhas }
}

export function criarDespesa(dados) {
  const r = getDb()
    .prepare(`
      INSERT INTO despesas (descricao, valor, categoria, categoria_livre, data, registrado_por, obs)
      VALUES (@descricao, @valor, COALESCE(@categoria, 'outros'), @categoria_livre, @data, COALESCE(@registrado_por, 'admin'), @obs)
    `)
    .run({
      descricao: dados.descricao,
      valor: dados.valor,
      categoria: dados.categoria ?? 'outros',
      categoria_livre: dados.categoria_livre ?? null,
      data: dados.data,
      registrado_por: dados.registrado_por ?? 'admin',
      obs: dados.obs ?? null,
    })
  return getDb().prepare(`SELECT * FROM despesas WHERE id = ?`).get(r.lastInsertRowid)
}

export function getDespesas(filtros = {}) {
  let q = `SELECT * FROM despesas WHERE 1=1`
  const params = []
  if (filtros.dataInicio) {
    q += ` AND date(data) >= date(?)`
    params.push(filtros.dataInicio)
  }
  if (filtros.dataFim) {
    q += ` AND date(data) <= date(?)`
    params.push(filtros.dataFim)
  }
  if (filtros.categoria) {
    q += ` AND categoria = ?`
    params.push(filtros.categoria)
  }
  q += ` ORDER BY data DESC, id DESC`
  return getDb().prepare(q).all(...params)
}

export function deletarDespesa(id) {
  const r = getDb().prepare(`DELETE FROM despesas WHERE id = ?`).run(id)
  return r.changes > 0
}

export function criarSessaoBarbeiro(barbeiroId) {
  const id = randomUUID()
  getDb()
    .prepare(`
      INSERT INTO sessoes_barbeiro (id, barbeiro_id, expires_at)
      VALUES (?, ?, datetime('now', '+7 days'))
    `)
    .run(id, barbeiroId)
  const row = getDb().prepare(`SELECT expires_at FROM sessoes_barbeiro WHERE id = ?`).get(id)
  return { id, expires_at: row.expires_at }
}

export function getSessaoBarbeiro(sessionId) {
  return getDb()
    .prepare(`
      SELECT * FROM sessoes_barbeiro
      WHERE id = ? AND datetime(expires_at) >= datetime('now')
    `)
    .get(sessionId)
}

export function deletarSessaoBarbeiro(sessionId) {
  const r = getDb().prepare(`DELETE FROM sessoes_barbeiro WHERE id = ?`).run(sessionId)
  return r.changes > 0
}

export function limparSessoesExpiradas() {
  const r = getDb()
    .prepare(`DELETE FROM sessoes_barbeiro WHERE datetime(expires_at) < datetime('now')`)
    .run()
  return r.changes
}

export function calcularComissaoPeriodo(barbeiroId, dataInicio, dataFim) {
  const rows = getDb()
    .prepare(`
      SELECT
        a.id AS agendamento_id,
        s.nome AS servico_nome,
        s.preco AS valor_bruto,
        COALESCE(co.pct, b.comissao_padrao_pct) AS pct_comissao
      FROM agendamentos a
      JOIN servicos s ON s.id = a.servico_id
      JOIN barbeiros b ON b.id = a.staff_id
      LEFT JOIN comissao_overrides co
        ON co.barbeiro_id = a.staff_id AND co.servico_id = a.servico_id
      WHERE a.staff_id = ?
        AND a.status IN ('concluido', 'confirmado')
        AND date(a.data_hora_inicio) >= date(?)
        AND date(a.data_hora_inicio) <= date(?)
      ORDER BY a.data_hora_inicio ASC
    `)
    .all(barbeiroId, dataInicio, dataFim)

  return rows.map((r) => {
    const pct = Number(r.pct_comissao) || 0
    const bruto = Number(r.valor_bruto) || 0
    const valor_comissao = bruto * (pct / 100)
    return {
      agendamento_id: r.agendamento_id,
      servico_nome: r.servico_nome,
      valor_bruto: bruto,
      pct_comissao: pct,
      valor_comissao,
    }
  })
}

/** Agendamentos confirmados sem presença/no-show, com fim há pelo menos 60 min (hora local). */
export function getAgendamentosParaConcluir() {
  const limite = nowIsoBRTOffsetMinutes(-60) // TZ-FIX: fim há ≥60 min em BRT
  return getDb()
    .prepare(`
      SELECT id, staff_id, servico_id, data_hora_fim, whatsapp_number
      FROM agendamentos
      WHERE status = 'confirmado'
        AND presenca_confirmada_at IS NULL
        AND no_show_marcado_at IS NULL
        AND data_hora_fim <= ?
    `)
    .all(limite)
}

/** Marca como concluído pelo cron; só altera se ainda estiver confirmado. Retorna true se atualizou uma linha. */
export function concluirAgendamentoAuto(id) {
  const r = getDb()
    .prepare(`
      UPDATE agendamentos
      SET status = 'concluido',
          concluido_automatico = 1,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmado'
    `)
    .run(id)
  return r.changes > 0
}

/** Recepção: cliente compareceu — conclui o agendamento e registra timestamp. */
export function confirmarPresenca(agendamentoId) {
  const r = getDb()
    .prepare(`
      UPDATE agendamentos
      SET presenca_confirmada_at = datetime('now'),
          status = 'concluido',
          updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmado'
    `)
    .run(agendamentoId)
  return r.changes > 0
}

/** Recepção: no-show manual — atualiza status e repete a lógica de registrarNoShow (contador do cliente). */
export function marcarNaoCompareceu(agendamentoId) {
  const ag = getDb().prepare(`SELECT * FROM agendamentos WHERE id = ?`).get(agendamentoId)
  if (!ag) return false
  const r = getDb()
    .prepare(`
      UPDATE agendamentos
      SET no_show_marcado_at = datetime('now'),
          status = 'no_show',
          updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmado'
    `)
    .run(agendamentoId)
  if (r.changes > 0 && ag.whatsapp_number) {
    registrarNoShow(ag.whatsapp_number, agendamentoId)
  }
  return r.changes > 0
}

// ═══════════════════════════════════════════════════════════════
//  MÓDULO DE CAIXA DIÁRIO
// ═══════════════════════════════════════════════════════════════

export function getOuCriarCaixaDia(data) {
  const db = getDb()
  let caixa = db.prepare(`SELECT * FROM caixas_dia WHERE data = ?`).get(data)
  if (!caixa) {
    db.prepare(`INSERT OR IGNORE INTO caixas_dia (data, fundo_inicial, status) VALUES (?, 0, 'aberto')`).run(data)
    caixa = db.prepare(`SELECT * FROM caixas_dia WHERE data = ?`).get(data)
  }
  return caixa
}

export function definirFundoInicial(data, fundoInicial) {
  const db = getDb()
  getOuCriarCaixaDia(data)
  db.prepare(`
    UPDATE caixas_dia SET fundo_inicial = ?, updated_at = datetime('now')
    WHERE data = ?
  `).run(Number(fundoInicial) || 0, data)
  return db.prepare(`SELECT * FROM caixas_dia WHERE data = ?`).get(data)
}

export function registrarPagamentoCaixa({
  data, tipo, agendamento_id, venda_produto_id, staff_id,
  descricao, valor_servico, pagamento_itens,
  valor_recebido_dinheiro, troco,
}) {
  const db = getDb()
  const caixa = getOuCriarCaixaDia(data)
  const pagItensJson = JSON.stringify(pagamento_itens || [])
  const formaSimples = pagamento_itens?.length === 1 ? pagamento_itens[0].forma : 'misto'

  const r = db.prepare(`
    INSERT INTO caixa_pagamentos
      (caixa_id, data, tipo, agendamento_id, venda_produto_id, staff_id, descricao,
       valor_servico, pagamento_itens, valor_recebido_dinheiro, troco)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    caixa.id, data, tipo,
    agendamento_id ?? null, venda_produto_id ?? null,
    staff_id, descricao,
    Number(valor_servico) || 0, pagItensJson,
    Number(valor_recebido_dinheiro) || 0, Number(troco) || 0,
  )

  if (agendamento_id) {
    db.prepare(`
      UPDATE agendamentos
      SET forma_pagamento = ?, pagamento_itens = ?,
          valor_recebido_dinheiro = ?, troco = ?,
          pago_em = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(formaSimples, pagItensJson, Number(valor_recebido_dinheiro) || 0, Number(troco) || 0, agendamento_id)
  }

  if (venda_produto_id) {
    db.prepare(`
      UPDATE vendas_produtos
      SET forma_pagamento = ?, pagamento_itens = ?,
          valor_recebido_dinheiro = ?, troco = ?, pago_em = datetime('now')
      WHERE id = ?
    `).run(formaSimples, pagItensJson, Number(valor_recebido_dinheiro) || 0, Number(troco) || 0, venda_produto_id)
  }

  return r.lastInsertRowid
}

export function estornarPagamentoCaixa(caixaPagamentoId) {
  const db = getDb()
  const cp = db.prepare(`SELECT * FROM caixa_pagamentos WHERE id = ?`).get(caixaPagamentoId)
  if (!cp || cp.estornado) return false

  db.prepare(`UPDATE caixa_pagamentos SET estornado = 1, estornado_em = datetime('now') WHERE id = ?`).run(caixaPagamentoId)

  if (cp.agendamento_id) {
    db.prepare(`
      UPDATE agendamentos
      SET forma_pagamento = NULL, pagamento_itens = NULL,
          valor_recebido_dinheiro = NULL, troco = NULL, pago_em = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(cp.agendamento_id)
  }

  return true
}

export function getResumoCaixaDia(data) {
  const db = getDb()
  const caixa = getOuCriarCaixaDia(data)

  const pagamentos = db.prepare(`
    SELECT cp.*, b.nome AS barbeiro_nome
    FROM caixa_pagamentos cp
    LEFT JOIN barbeiros b ON b.id = cp.staff_id
    WHERE cp.data = ? AND cp.estornado = 0
    ORDER BY cp.created_at ASC
  `).all(data)

  // Estornos do dia (para rastreabilidade no relatório)
  const estornos = db.prepare(`
    SELECT cp.*, b.nome AS barbeiro_nome
    FROM caixa_pagamentos cp
    LEFT JOIN barbeiros b ON b.id = cp.staff_id
    WHERE cp.data = ? AND cp.estornado = 1
    ORDER BY cp.estornado_em ASC
  `).all(data)
  const totalEstornado = estornos.reduce((s, e) => s + Number(e.valor_servico) || 0, 0)

  const totaisPorForma = { pix: 0, dinheiro: 0, debito: 0, credito: 0 }
  let totalBruto = 0
  for (const p of pagamentos) {
    totalBruto += Number(p.valor_servico) || 0
    try {
      const itens = JSON.parse(p.pagamento_itens || '[]')
      for (const item of itens) {
        if (totaisPorForma[item.forma] !== undefined) {
          totaisPorForma[item.forma] += Number(item.valor) || 0
        }
      }
    } catch {}
  }

  const porBarbeiro = {}
  for (const p of pagamentos) {
    if (!porBarbeiro[p.staff_id]) {
      porBarbeiro[p.staff_id] = { nome: p.barbeiro_nome || p.staff_id, total: 0, atendimentos: 0, produtos: 0 }
    }
    porBarbeiro[p.staff_id].total += Number(p.valor_servico) || 0
    if (p.tipo === 'servico') porBarbeiro[p.staff_id].atendimentos += 1
    if (p.tipo === 'produto') porBarbeiro[p.staff_id].produtos += 1
  }

  const despesas = db.prepare(`SELECT * FROM despesas WHERE date(data) = date(?) ORDER BY created_at ASC`).all(data)
  const totalDespesas = despesas.reduce((s, d) => s + Number(d.valor), 0)

  const semPagamento = db.prepare(`
    SELECT a.id, a.cliente_nome, a.staff_id, a.servico_id, a.data_hora_inicio,
           s.nome AS servico_nome, s.preco AS servico_preco
    FROM agendamentos a
    LEFT JOIN servicos s ON s.id = a.servico_id
    WHERE date(a.data_hora_inicio) = date(?)
      AND a.status = 'concluido'
      AND (a.pago_em IS NULL OR a.forma_pagamento IS NULL)
    ORDER BY a.data_hora_inicio ASC
  `).all(data)

  return {
    caixa,
    pagamentos,
    estornos,
    totalEstornado,
    totaisPorForma,
    totalBruto,
    totalDespesas,
    saldoLiquido: totalBruto - totalDespesas,
    porBarbeiro: Object.entries(porBarbeiro).map(([id, v]) => ({ staff_id: id, ...v })),
    despesas,
    semPagamento,
    atendimentos: pagamentos.filter(p => p.tipo === 'servico').length,
    vendasProdutos: pagamentos.filter(p => p.tipo === 'produto').length,
  }
}

export function fecharCaixaDia(data, fechadoPor = 'recepcao', obs = null, forcar = false) {
  const db = getDb()
  const resumo = getResumoCaixaDia(data)

  if (!forcar && resumo.semPagamento.length > 0) {
    return {
      erro: `Há ${resumo.semPagamento.length} atendimento(s) concluído(s) sem pagamento registrado.`,
      semPagamento: resumo.semPagamento,
    }
  }

  db.prepare(`
    UPDATE caixas_dia
    SET status = 'fechado', fechado_em = datetime('now'), fechado_por = ?, obs = ?, updated_at = datetime('now')
    WHERE data = ?
  `).run(fechadoPor, obs ?? null, data)

  return { ok: true, resumo }
}

export function reabrirCaixaDia(data) {
  const db = getDb()
  db.prepare(`
    UPDATE caixas_dia
    SET status = 'aberto', fechado_em = NULL, fechado_por = NULL, updated_at = datetime('now')
    WHERE data = ?
  `).run(data)
  return db.prepare(`SELECT * FROM caixas_dia WHERE data = ?`).get(data)
}

export function listarCaixas({ dataInicio, dataFim, status, limit = 30 } = {}) {
  const db = getDb()
  let q = `SELECT * FROM caixas_dia WHERE 1=1`
  const p = []
  if (dataInicio) { q += ` AND date(data) >= date(?)`; p.push(dataInicio) }
  if (dataFim)    { q += ` AND date(data) <= date(?)`; p.push(dataFim) }
  if (status)     { q += ` AND status = ?`; p.push(status) }
  q += ` ORDER BY data DESC LIMIT ?`
  p.push(limit)
  return db.prepare(q).all(...p)
}

export function registrarVendaProdutoAvulsa({ whatsapp_number, produto_id, quantidade, valor_unitario }) {
  const db = getDb()
  db.prepare(`UPDATE produtos SET estoque = MAX(0, estoque - ?), updated_at = datetime('now') WHERE id = ?`)
    .run(Number(quantidade) || 1, produto_id)
  const r = db.prepare(`
    INSERT INTO vendas_produtos (agendamento_id, whatsapp_number, produto_id, quantidade, valor_unitario)
    VALUES (NULL, ?, ?, ?, ?)
  `).run(whatsapp_number || 'avulso', produto_id, Number(quantidade) || 1, Number(valor_unitario))
  return r.lastInsertRowid
}

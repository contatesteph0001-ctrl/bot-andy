import wppconnect from '@wppconnect-team/wppconnect'
import express    from 'express'
import OpenAI     from 'openai'
import fs         from 'fs'
import path       from 'path'
import { SESSION, PORT, staff } from './config.mjs'
import { askClaude, getActiveConversationCount } from './claude.mjs'
import {
  upsertCliente, logMensagem, marcarLgpdAceito, getCliente,
  incrementarMensagemAtiva, getMensagensAtivasHoje,
  checarRateLimit, clienteBloqueado, resetLoopCount,
  marcarAguardandoAndy, getConfig, aprovarSinal, getAgendamento,
  enfileirarMensagem, incrementarFotosRecebidas, marcarStickerRespondido,
  getAgendamentoAguardandoFeedback, registrarFeedbackNota,
} from './db.mjs'
import { log, warn, error as logError } from './logger.mjs'
import { detectarRespostaConfirmacao, notificarAndy } from './reminders.mjs'
import { getAgendamentosFuturosCliente, marcarConfirmadoPeloCliente, cancelarAgendamento } from './db.mjs'
import { deleteEvent } from './calendar.mjs'
import session from 'express-session'
import BetterSqliteStore from 'better-sqlite3-session-store'
import {
  panelRouter,
  receptionRouter,
  barbeiroRouter,
  renderLoginPage,
  handleLoginPost,
} from './panel.mjs'
import { requireAuth, requireRole, redirectPosLogin, currentUser } from './auth.mjs'
import { getUsuarioPorStaffId, getDb, listarBarbeiros, trocarBarbeiro } from './db.mjs'
import { bookingRouter } from './booking.mjs'
import { registerSender } from './queue.mjs'
import { temDadoSensivel, sanitizarTexto, tentativaInjection } from './security.mjs'
import { M } from './messages.mjs'

let client = null
let BOT_CONNECTED_AT = null
const app  = express()
app.use(express.json())

const MAX_FOTOS_CONVERSA = 5
const MAX_AUDIO_SEGUNDOS = 120

function staffNameById(id) {
  const u = getUsuarioPorStaffId(id)
  if (u?.nome) return u.nome
  return staff.find(s => s.id === id)?.name || id
}

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY
  if (!key || key === 'COLE_SUA_CHAVE_OPENAI_AQUI') return null
  return new OpenAI({ apiKey: key })
}

async function transcribeAudio(mediaBuffer, mimeType = 'audio/ogg', durationSec = 0) {
  if (durationSec > MAX_AUDIO_SEGUNDOS) return null
  const openai = getOpenAI()
  if (!openai) return '[áudio recebido — transcrição indisponível]'
  try {
    const ext  = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('mpeg') ? 'mp3' : 'ogg'
    const tmp  = path.join(process.cwd(), `tmp_audio_${Date.now()}.${ext}`)
    fs.writeFileSync(tmp, mediaBuffer)
    const resp = await openai.audio.transcriptions.create({
      file:  fs.createReadStream(tmp),
      model: 'whisper-1',
      language: 'pt',
    })
    fs.unlinkSync(tmp)
    return resp.text || '[áudio sem conteúdo]'
  } catch (err) {
    logError('Whisper erro:', err.message)
    return '[não consegui transcrever o áudio]'
  }
}

async function analyzeImage(mediaBuffer, mimeType = 'image/jpeg') {
  try {
    const base64 = mediaBuffer.toString('base64')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text',  text: 'Essa é uma imagem enviada por um cliente de barbearia. Descreva o estilo de cabelo/barba mostrado em 1-2 frases curtas em português, focando no que o cliente provavelmente quer replicar.' },
          ],
        }],
      }),
    })
    const data = await response.json()
    return data.content?.[0]?.text || '[imagem recebida]'
  } catch (err) {
    logError('Vision erro:', err.message)
    return '[imagem recebida — não consegui analisar]'
  }
}

export function getClient() { return client }

export function createExpressApp() {
  // ── Rate limit global — protege contra abuso e custos inesperados ─
  const _rlWindowMs = 60_000 // janela de 1 minuto
  const _rlMap = new Map()
  app.use((req, res, next) => {
    // Só aplica nas rotas da API pública (não aplica em /qr e /)
    if (!req.path.startsWith('/api/')) return next()
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const entry = _rlMap.get(ip) || { count: 0, windowStart: now }
    if (now - entry.windowStart > _rlWindowMs) {
      entry.count = 0
      entry.windowStart = now
    }
    entry.count++
    _rlMap.set(ip, entry)
    if (entry.count > 60) { // máximo 60 requests/min por IP
      res.status(429).json({ erro: 'Muitas requisições. Tente novamente em breve.' })
      return
    }
    next()
  })

  // CORS — permite que bot-andy.vercel.app acesse a API do servidor local via ngrok
  app.use((req, res, next) => {
    const allowedOrigins = (process.env.PUBLIC_BOOKING_ORIGINS || 'https://bot-andy.vercel.app')
      .split(',').map(s => s.trim())
    const origin = req.headers.origin
    if (!origin || allowedOrigins.some(o => origin === o || origin.startsWith(o))) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*')
    } else {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0])
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning, Authorization')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
  app.use(express.urlencoded({ extended: true }))

  const isProd = process.env.NODE_ENV === 'production'
  // Railway/proxy: sem isto, req.protocol é 'http' e o cookie secure:true NUNCA é setado → sessão não persiste.
  if (isProd) app.set('trust proxy', 1)
  const sessionSecret = process.env.SESSION_SECRET || (isProd ? null : 'dev-session-secret-change-me')
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET é obrigatório em produção (NODE_ENV=production)')
  }
  const SqliteStore = BetterSqliteStore(session)
  app.use(session({
    store: new SqliteStore({ client: getDb() }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }))

  app.get('/admin/barbeiros', requireAuth, requireRole('admin'), (req, res) => {
    res.json(listarBarbeiros())
  })

  app.post('/admin/barbeiros/:staffId/trocar', requireAuth, requireRole('admin'), express.urlencoded({ extended: true }), (req, res) => {
    const { staffId } = req.params
    const { novoNome, novaSenha, limparAgendamentos } = req.body

    const staffsValidos = ['barbeiro1', 'barbeiro2', 'barbeiro3']
    if (!staffsValidos.includes(staffId)) {
      return res.status(400).json({ ok: false, erro: 'staffId inválido' })
    }
    if (!novoNome || typeof novoNome !== 'string' || novoNome.trim().length < 2) {
      return res.status(400).json({ ok: false, erro: 'Nome inválido' })
    }
    if (!novaSenha || typeof novaSenha !== 'string' || novaSenha.length < 6) {
      return res.status(400).json({ ok: false, erro: 'Senha deve ter no mínimo 6 caracteres' })
    }

    try {
      trocarBarbeiro(staffId, novoNome.trim(), novaSenha, !!limparAgendamentos)
      res.json({ ok: true, mensagem: `${staffId} atualizado para ${novoNome.trim()}` })
    } catch (err) {
      res.status(500).json({ ok: false, erro: err.message })
    }
  })

  app.post('/admin/limpar-banco-teste', requireAuth, requireRole('admin'), (req, res) => {
    try {
      const db = getDb()
      db.prepare('DELETE FROM agendamentos').run()
      db.prepare('DELETE FROM clientes').run()
      db.prepare('DELETE FROM mensagens_log').run()
      db.prepare('DELETE FROM mensagens_pendentes').run()
      res.json({ ok: true, mensagem: 'Banco limpo com sucesso.' })
    } catch (err) {
      res.status(500).json({ ok: false, erro: err.message })
    }
  })

  app.get('/qr', requireAuth, requireRole('admin'), (req, res) => {
    if (!app._qr) return res.send('<p>Aguarde o QR...</p><script>setTimeout(()=>location.reload(),3000)</script>')
    res.send(`<img src="${app._qr}" style="width:300px"><p>Escaneie com o WhatsApp</p>`)
  })

  app.get('/', requireAuth, requireRole('admin'), (req, res) => {
    res.send(`
      <h1>Andy Na Régua — Chatbot</h1>
      <p>Status: ${client ? '✅ Conectado' : '⏳ Aguardando'}</p>
      <p>Conversas ativas: ${getActiveConversationCount()}</p>
      <a href="/qr">QR Code</a>
    `)
  })

  app.get('/login', renderLoginPage)
  app.post('/login', handleLoginPost)
  const logoutHandler = (req, res) => {
    req.session.destroy(() => res.redirect('/login'))
  }
  app.get('/logout', logoutHandler)
  app.post('/logout', logoutHandler)

  app.get('/painel', (req, res) => {
    const user = currentUser(req)
    if (!user) return res.redirect('/login')
    return res.redirect(redirectPosLogin(user.papel))
  })

  app.use('/admin', requireAuth, requireRole('admin'), panelRouter)
  app.use('/recepcao', requireAuth, requireRole('recepcao', 'admin'), receptionRouter)
  app.use('/barbeiro', requireAuth, requireRole('barbeiro'), barbeiroRouter)

  app.use(bookingRouter)

  return app
}

// ── Fila por número (concurrency control) ───────────────────────
// Garante que mensagens do mesmo cliente sejam processadas em ordem, uma de cada vez.
// Sem isso, 2 mensagens rápidas do mesmo número podem rodar em paralelo e o histórico
// é corrompido (uma sobrescreve a outra). Cada número tem sua própria fila, mas números
// diferentes continuam processando em paralelo (escalável).
const filasPorNumero = new Map()

function enfileirarPorNumero(userPhone, tarefa) {
  const filaAtual = filasPorNumero.get(userPhone) || Promise.resolve()
  const novaFila = filaAtual.then(tarefa).catch(err => logError(`Erro na fila de ${userPhone}:`, err))
  filasPorNumero.set(userPhone, novaFila)
  // Limpa a referência quando terminar (evita memory leak)
  novaFila.finally(() => {
    if (filasPorNumero.get(userPhone) === novaFila) filasPorNumero.delete(userPhone)
  })
  return novaFila
}

async function handleIncomingMessage(message) {
  if (message.isGroupMsg)              return
  if (message.from === 'status@broadcast') return
  if (message.fromMe)                  return
  if (BOT_CONNECTED_AT && message.timestamp && message.timestamp < BOT_CONNECTED_AT) return
  // Serializa por número — evita respostas trocadas em conversas paralelas
  return enfileirarPorNumero(message.from, () => processarMensagem(message))
}

async function processarMensagem(message) {
  const userPhone = message.from
  const tipo      = message.type

  if (clienteBloqueado(userPhone)) return

  const rl = checarRateLimit(userPhone, 20)
  if (!rl.permitido) {
    log(`Rate limit atingido pra ${userPhone}`)
    return
  }

  // ── Limite diário de mensagens por número (protege custo API) ─────
  const MAX_MSG_DIA = Number(process.env.MAX_MSG_DIA_POR_NUMERO || 50)
  const _msgKey = `msg_dia_${userPhone}_${new Date().toISOString().slice(0, 10)}`
  if (!processarMensagem._msgContadores) processarMensagem._msgContadores = new Map()
  const _msgCount = (processarMensagem._msgContadores.get(_msgKey) || 0) + 1
  processarMensagem._msgContadores.set(_msgKey, _msgCount)
  if (_msgCount > MAX_MSG_DIA) {
    log(`Limite diário de ${MAX_MSG_DIA} mensagens atingido para ${userPhone}`)
    return
  }

  const andyPhone = getConfig('andy_phone') || process.env.ANDY_PHONE || ''

  let textToProcess = null
  let logTipo       = 'texto'

  if (tipo === 'chat') {
    if (!message.body) return
    textToProcess = message.body

    if (userPhone === andyPhone) {
      const matchOk = textToProcess.match(/^OK\s+(\d+)$/i)
      if (matchOk) {
        const agId = Number(matchOk[1])
        aprovarSinal(agId)
        const ag = getAgendamento(agId)
        if (ag) {
          const horaLabel = new Date(ag.data_hora_inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
          const dataLabel = new Date(ag.data_hora_inicio).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
          enfileirarMensagem(ag.whatsapp_number, M.sinalAprovado({ hora: horaLabel, dataLabel, barbeiro: staffNameById(ag.staff_id), servico: ag.servico_id }), 'critica')
          await client.sendText(andyPhone, `✅ Sinal aprovado pra agendamento #${agId}. Cliente notificado.`)
        }
        return
      }
    }
  } else if (tipo === 'audio' || tipo === 'ptt') {
    log(`🎤 Áudio recebido de ${userPhone}`)
    const durationSec = message.duration || message.seconds || 0
    if (durationSec > MAX_AUDIO_SEGUNDOS) {
      await client.sendText(userPhone, M.audioLongo())
      return
    }
    try {
      const mediaBuffer = await client.decryptFile(message)
      const transcricao = await transcribeAudio(Buffer.from(mediaBuffer), message.mimetype || 'audio/ogg', durationSec)
      if (!transcricao) {
        await client.sendText(userPhone, M.audioLongo())
        return
      }
      textToProcess = `[áudio transcrito]: ${transcricao}`
      logTipo       = 'audio'
    } catch (err) {
      logError('Erro ao processar áudio:', err)
      textToProcess = '[cliente enviou áudio, mas não consegui transcrever]'
    }
  } else if (tipo === 'image') {
    const clienteImg = getCliente(userPhone)
    const fotosCount = clienteImg?.fotos_recebidas_count || 0
    if (fotosCount >= MAX_FOTOS_CONVERSA) {
      log(`Limite de fotos atingido para ${userPhone}`)
      return
    }
    incrementarFotosRecebidas(userPhone)
    log(`🖼️ Imagem recebida de ${userPhone}`)
    try {
      const mediaBuffer = await client.decryptFile(message)
      const descricao   = await analyzeImage(Buffer.from(mediaBuffer), message.mimetype || 'image/jpeg')
      const caption     = message.caption ? ` — Legenda: "${message.caption}"` : ''
      textToProcess = `[cliente enviou foto de referência de corte]: ${descricao}${caption}`
      logTipo       = 'imagem'
    } catch (err) {
      logError('Erro ao processar imagem:', err)
      textToProcess = '[cliente enviou uma foto de referência de corte]'
    }
  } else if (tipo === 'sticker') {
    const clienteSt = getCliente(userPhone)
    if (clienteSt?.sticker_respondido) return
    marcarStickerRespondido(userPhone)
    await client.sendText(userPhone, M.sticker())
    return
  } else {
    return
  }

  if (tipo === 'chat' && message.body) {
    // Só chama Haiku classificador se houver lembrete pendente aguardando resposta — evita custo em toda msg
    const agendamentos = getAgendamentosFuturosCliente(userPhone)
    const pendente = agendamentos.find(a =>
      a.lembrete_2h_enviado_at && !a.confirmado_pelo_cliente_at && a.status === 'confirmado'
    )
    if (pendente) {
      const resposta = await detectarRespostaConfirmacao(message.body, userPhone)
      if (resposta === 'confirmar') {
        marcarConfirmadoPeloCliente(pendente.id)
        resetLoopCount(userPhone)
        await client.sendText(userPhone, M.confirmadoLembrete())
        logMensagem(userPhone, 'saida', 'Confirmação registrada', 'texto')
        return
      } else if (resposta === 'cancelar') {
        cancelarAgendamento(pendente.id, 'cliente')
        if (pendente.google_event_id) {
          await deleteEvent(pendente.staff_id, pendente.google_event_id).catch(() => {})
        }
        await client.sendText(userPhone, M.canceladoCliente())
        logMensagem(userPhone, 'saida', 'Cancelamento pelo cliente registrado', 'texto')
        return
      }
    }
  }

  if (!textToProcess) return

  if (temDadoSensivel(textToProcess)) {
    await client.sendText(userPhone, M.dadoSensivel())
    return
  }

  if (tentativaInjection(textToProcess)) {
    log(`⚠️ Tentativa de injection de ${userPhone}: ${textToProcess.slice(0, 80)}`)
    await notificarAndy(`🚨 Tentativa de manipulação por ${userPhone}: "${textToProcess.slice(0, 100)}"`)
  }

  log(`📩 [${userPhone}] [${logTipo}]: ${textToProcess?.slice(0, 80)}`)

  const clienteExistente = getCliente(userPhone)
  upsertCliente(userPhone)
  if (clienteExistente && !clienteExistente.lgpd_aceito) {
    marcarLgpdAceito(userPhone)
  }

  logMensagem(userPhone, 'entrada', textToProcess, logTipo)

  const textoLimpo = sanitizarTexto(textToProcess)

  // ── Handler: resposta a feedback pós-serviço (nota 0-10) ──────────
  const aguardandoFeedback = getAgendamentoAguardandoFeedback(userPhone)
  if (aguardandoFeedback) {
    const matchNota = textoLimpo.trim().match(/^(\d{1,2})(?:\D|$)/)
    if (matchNota) {
      const nota = Math.min(10, Math.max(0, Number(matchNota[1])))
      registrarFeedbackNota(aguardandoFeedback.id, nota)

      if (nota >= 8) {
        const reviewLink = getConfig('google_review_link') || ''

        const msg = M.feedbackPositivo(reviewLink)
        // (feedbackPositivo já trata link vazio)
        await client.sendText(userPhone, msg)
        logMensagem(userPhone, 'saida', msg, 'texto')
      } else if (nota <= 6) {
        await client.sendText(userPhone, M.feedbackNegativo())
        logMensagem(userPhone, 'saida', M.feedbackNegativo(), 'texto')
        const cliente = getCliente(userPhone)
        await notificarAndy(`⚠️ Feedback negativo (${nota}/10) de ${cliente?.nome || userPhone} — agendamento #${aguardandoFeedback.id}`)
        marcarAguardandoAndy(userPhone, 'feedback_negativo')
      } else {
        const msg = `Valeu pelo feedback, brother! 🙏 Qualquer detalhe que quiser melhorar pode falar — tamos sempre evoluindo.`
        await client.sendText(userPhone, msg)
        logMensagem(userPhone, 'saida', msg, 'texto')
      }
      return
    }
  }

  try {
    await client.startTyping(userPhone)
    const { text: reply } = await askClaude(textoLimpo, userPhone)
    await client.stopTyping(userPhone)
    await client.sendText(userPhone, reply)
    logMensagem(userPhone, 'saida', reply, 'texto')
    log(`🤖 Resposta: ${reply.slice(0, 80)}`)
  } catch (err) {
    logError('Erro ao processar mensagem:', err)
    const fallback = M.falhaTecnica()
    await client.sendText(userPhone, fallback).catch(() => {})
    logMensagem(userPhone, 'saida', fallback, 'texto')
  }
}

export async function sendProactiveMessage(whatsappNumber, text) {
  enfileirarMensagem(whatsappNumber, text, 'proativa')
  return true
}

export async function startWhatsApp() {
  const devWhitelist = (process.env.DEV_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)

  registerSender(async (numero, texto) => {
    if (!client) return false
    try {
      const isDevNumber = devWhitelist.includes(numero)
      const limite  = Number(process.env.MAX_DAILY_ACTIVE_MESSAGES || 5)
      const atual   = getMensagensAtivasHoje(numero)
      if (!isDevNumber && atual >= limite) { warn(`Limite diário atingido para ${numero}`); return false }
      await client.sendText(numero, texto)
      incrementarMensagemAtiva(numero)
      logMensagem(numero, 'saida', texto, 'texto')
      return true
    } catch {
      return false
    }
  })

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined
  const folderNameToken = process.env.WPP_TOKENS_DIR || path.resolve(process.cwd(), 'tokens')
  const userDataDir = process.env.WPP_USER_DATA_DIR || path.join(folderNameToken, SESSION)

  return wppconnect.create({
    session:         SESSION,
    folderNameToken: folderNameToken,
    useChrome:       false,
    autoClose:       0,
    disableWelcome:  true,
    catchQR:     (base64Qr, asciiQR) => {
      log(`QR Code gerado — http://localhost:${PORT}/qr`)
      console.log(asciiQR)
      app._qr = base64Qr
    },
    statusFind:  (statusSession) => { log('WPPConnect status:', statusSession) },
    headless:    true,
    logQR:       true,
    browserArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    puppeteerOptions: {
      userDataDir,
      ...(executablePath && { executablePath }),
    },
  }).then((c) => {
    client = c
    BOT_CONNECTED_AT = Math.floor(Date.now() / 1000)
    log('WhatsApp conectado — aguardando mensagens')
    client.onMessage(handleIncomingMessage)
    return c
  })
}

export function startHttpServer() {
  app.listen(PORT, () => {
    log(`Servidor HTTP em http://localhost:${PORT}`)
    log(`QR Code: http://localhost:${PORT}/qr`)
  })
  return app
}

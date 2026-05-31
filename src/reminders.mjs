import cron from 'node-cron'
import {
  getAgendamentosParaLembrete,
  getAgendamentosParaCancelarAutomatico,
  getAgendamentosParaUpsellPosServico,
  getAgendamentosParaConcluir,
  concluirAgendamentoAuto,
  marcarLembrete2hEnviado,
  cancelarAgendamento,
  marcarUpsellPosServico,
  registrarNoShow,
  getFilaParaHorario,
  marcarNotificadoFila,
  expirarFilaPassada,
  getConfig,
  getUsuarioPorStaffId,
  getCliente,
  getDb,
  enfileirarMensagem,
  getClientesParaReativar,
  marcarReativacaoEnviada,
  getAgendamentosParaFeedback,
  marcarFeedbackEnviado,
  getConversasAguardandoAndyAntigas,
  limparAguardandoAndy,
  agregarMetricasDoDia,
  purgarMensagensAntigas,
} from './db.mjs'
import { deleteEvent } from './calendar.mjs'
import { getUpsellParaServico } from './tools.mjs'
import { staff } from './config.mjs'
import { M } from './messages.mjs'
import { processarFilaProativa } from './queue.mjs'
import { log, warn, error as logError } from './logger.mjs'

function staffNameById(id) {
  const u = getUsuarioPorStaffId(id)
  if (u?.nome) return u.nome
  return staff.find(s => s.id === id)?.name || id
}

function formatHora(isoStr) {
  return new Date(isoStr).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  })
}

function formatData(isoStr) {
  return new Date(isoStr).toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo',
  })
}

function notificacoesAtivas() {
  return getConfig('notificacoes_ativas') !== '0'
}

function getAndyPhone() {
  return getConfig('andy_phone') || process.env.ANDY_PHONE || ''
}

function dentroDaJanelaProativa() {
  const inicio = Number(getConfig('janela_proativa_inicio') || 8)
  const fim    = Number(getConfig('janela_proativa_fim') || 22)
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const hora = agora.getHours()
  return hora >= inicio && hora < fim
}

export async function notificarAndy(texto) {
  if (!notificacoesAtivas()) return
  const andyPhone = getAndyPhone()
  if (!andyPhone) { warn('ANDY_PHONE não configurado — notificação ignorada'); return }
  enfileirarMensagem(andyPhone, texto, 'critica')
}

async function jobLembretes() {
  if (!dentroDaJanelaProativa()) return
  try {
    const agendamentos = getAgendamentosParaLembrete()
    for (const ag of agendamentos) {
      const hora     = formatHora(ag.data_hora_inicio)
      const servico  = ag.servico_nome || ag.servico_id
      const barbeiro = staffNameById(ag.staff_id)
      const msg = M.lembrete2h({ nome: ag.nome_cliente, hora, servico, barbeiro })
      enfileirarMensagem(ag.whatsapp_number, msg, 'proativa')
      marcarLembrete2hEnviado(ag.id)
      log(`⏰ Lembrete enfileirado para ${ag.whatsapp_number} — agendamento #${ag.id}`)
    }
  } catch (err) {
    logError('jobLembretes erro:', err)
  }
}

async function jobCancelamentosAutomaticos() {
  if (!dentroDaJanelaProativa()) return
  try {
    const agendamentos = getAgendamentosParaCancelarAutomatico()
    for (const ag of agendamentos) {
      const hora     = formatHora(ag.data_hora_inicio)
      const barbeiro = staffNameById(ag.staff_id)

      cancelarAgendamento(ag.id, 'automatico')
      if (ag.google_event_id) {
        await deleteEvent(ag.staff_id, ag.google_event_id).catch(() => {})
      }

      const { confirmacaoRigorosa } = registrarNoShow(ag.whatsapp_number, ag.id)
      const msgCliente = M.cancelAuto({ hora, rigorosa: confirmacaoRigorosa })
      enfileirarMensagem(ag.whatsapp_number, msgCliente, 'proativa')

      const cliente = getCliente(ag.whatsapp_number)
      const nomeCliente = cliente?.nome || ag.whatsapp_number
      await notificarAndy(`⚠️ Horário das ${hora} cancelado automaticamente — ${nomeCliente} não confirmou. Slot liberado para ${barbeiro}.`)

      log(`🚫 Cancelamento automático: agendamento #${ag.id} — ${ag.whatsapp_number}`)
      await jobNotificarFila(ag.data_hora_inicio, ag.staff_id)
    }
  } catch (err) {
    logError('jobCancelamentosAutomaticos erro:', err)
  }
}

async function jobUpsellPosServico() {
  if (!dentroDaJanelaProativa()) return
  try {
    const agendamentos = getAgendamentosParaUpsellPosServico()
    for (const ag of agendamentos) {
      const produtos = getUpsellParaServico(ag.servico_id)
      if (!produtos.length) {
        marcarUpsellPosServico(ag.id)
        continue
      }
      const msg = M.upsellPosServico({ nome: ag.nome_cliente, produtos })
      enfileirarMensagem(ag.whatsapp_number, msg, 'proativa')
      marcarUpsellPosServico(ag.id)
      log(`🛍️ Upsell pós-serviço enfileirado para ${ag.whatsapp_number} — #${ag.id}`)
    }
  } catch (err) {
    logError('jobUpsellPosServico erro:', err)
  }
}

// Encerra agendamentos ainda "confirmados" quando a recepção não marcou presença nem no-show
// e já passou 1h do horário de fim (ver getAgendamentosParaConcluir em db.mjs).
async function jobConcluirAgendamentosAutomatico() {
  try {
    const candidatos = getAgendamentosParaConcluir()
    const idsAfetados = []
    for (const ag of candidatos) {
      if (concluirAgendamentoAuto(ag.id)) idsAfetados.push(ag.id)
    }
    const count = idsAfetados.length
    if (count === 0) return
    log(`[auto-conclusão] ${count} agendamento(s) concluído(s) automaticamente`)
    log(`[auto-conclusão] IDs afetados: ${idsAfetados.join(', ')}`)
  } catch (err) {
    logError('jobConcluirAgendamentosAutomatico erro:', err)
  }
}

async function jobNotificarFila(dataHoraAlvo = null, staffId = null) {
  try {
    if (!dataHoraAlvo) {
      expirarFilaPassada()
      return
    }

    const fila = getFilaParaHorario(dataHoraAlvo, staffId)
    if (!fila.length) return

    const primeiro = fila[0]
    const hora     = formatHora(dataHoraAlvo)
    const data     = formatData(dataHoraAlvo)
    const msg = M.filaAbriu({ hora, dataLabel: data })

    enfileirarMensagem(primeiro.whatsapp_number, msg, 'proativa')
    marcarNotificadoFila(primeiro.id)
    log(`📋 Fila notificada: ${primeiro.whatsapp_number} para ${dataHoraAlvo}`)
  } catch (err) {
    logError('jobNotificarFila erro:', err)
  }
}

async function jobReativacao() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const dow = agora.getDay()
  const hora = agora.getHours()
  if (![2, 3, 4, 5].includes(dow) || hora < 10 || hora >= 12) return

  const clientes = getClientesParaReativar(35, 60)
  for (const c of clientes) {
    const ag = getDb().prepare(`
      SELECT data_hora_inicio FROM agendamentos
      WHERE whatsapp_number = ? AND status = 'concluido'
      ORDER BY data_hora_inicio DESC LIMIT 1
    `).get(c.whatsapp_number)
    if (!ag) continue
    const dias = Math.floor((Date.now() - new Date(ag.data_hora_inicio).getTime()) / 86400000)
    const msg = M.reativacao({ nome: c.nome, dias })
    enfileirarMensagem(c.whatsapp_number, msg, 'proativa')
    marcarReativacaoEnviada(c.whatsapp_number)
  }
}

async function jobFeedback() {
  if (!dentroDaJanelaProativa()) return
  const ags = getAgendamentosParaFeedback()
  for (const a of ags) {
    const msg = M.feedback({ nome: a.nome_cliente })
    enfileirarMensagem(a.whatsapp_number, msg, 'proativa')
    marcarFeedbackEnviado(a.id)
  }
}

async function jobFollowUpHandoff() {
  if (!dentroDaJanelaProativa()) return
  const paradas = getConversasAguardandoAndyAntigas(60)
  for (const c of paradas) {
    enfileirarMensagem(c.whatsapp_number, M.handoffFollowUp(), 'proativa')
    limparAguardandoAndy(c.whatsapp_number)
  }
}

async function jobLimpezaDiaria() {
  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  agregarMetricasDoDia(ontem)
  const removidas = purgarMensagensAntigas(180)
  log(`🧹 Limpeza diária: ${removidas} mensagens antigas removidas, métricas de ${ontem} agregadas`)
}

export async function detectarRespostaConfirmacao(texto, whatsappNumber) {
  const prompt = `Classifique a mensagem do cliente em uma das 3 categorias:
- "confirmar" se ele está confirmando presença/agendamento
- "cancelar" se está cancelando ou recusando
- "ambiguo" se não dá pra dizer com certeza

Responda APENAS com a palavra: confirmar, cancelar ou ambiguo. Nada mais.

Mensagem do cliente: "${texto}"`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const resposta = data.content?.[0]?.text?.toLowerCase().trim() || ''
    if (resposta.includes('confirmar')) return 'confirmar'
    if (resposta.includes('cancelar')) return 'cancelar'
    return null
  } catch (err) {
    logError('detectarRespostaConfirmacao erro:', err)
    return null
  }
}

export function initReminders() {
  // Modo silencioso: se env BOT_MODO_SILENCIOSO=1, jobs proativos ficam desligados
  // (fila proativa, lembretes, follow-ups, reativação). Bot continua respondendo
  // mensagens recebidas normalmente. Ideal para testes/QA sem spammar clientes reais.
  const modoSilencioso = process.env.BOT_MODO_SILENCIOSO === '1'
  if (modoSilencioso) {
    log('🔇 MODO SILENCIOSO ativo — jobs proativos desligados. Bot só responde a mensagens recebidas.')
    return
  }

  // Delay de 60s antes do primeiro disparo dos jobs cron. Evita que ao reiniciar o
  // servidor mensagens pendentes sejam reenfileiradas imediatamente.
  const DELAY_INICIAL_MS = 60_000

  setTimeout(() => {
    let _filaRodando = false
    cron.schedule('* * * * *', async () => {
      if (_filaRodando) return
      _filaRodando = true
      try { await processarFilaProativa() } finally { _filaRodando = false }
    }, { timezone: 'America/Sao_Paulo' })

    let _jobs5mRodando = false
    cron.schedule('*/5 * * * *', async () => {
      if (_jobs5mRodando) return
      _jobs5mRodando = true
      try {
        await jobLembretes()
        await jobCancelamentosAutomaticos()
        await jobUpsellPosServico()
        await jobNotificarFila()
        await jobFeedback()
        await jobFollowUpHandoff()
      } finally {
        _jobs5mRodando = false
      }
    }, { timezone: 'America/Sao_Paulo' })

    cron.schedule('0 10,11 * * 2-5', jobReativacao, { timezone: 'America/Sao_Paulo' })
    cron.schedule('0 3 * * *', jobLimpezaDiaria, { timezone: 'America/Sao_Paulo' })

    cron.schedule('*/15 * * * *', async () => {
      await jobConcluirAgendamentosAutomatico()
    }, { timezone: 'America/Sao_Paulo' })

    log('⏰ Sistema de lembretes ativo após delay inicial (cron a cada 5 min + reativação ter-sex 10-12h + limpeza 3h)')
    log('⏰ Auto-conclusão de agendamentos: cron a cada 15 min (America/Sao_Paulo)')
  }, DELAY_INICIAL_MS)

  log(`⏳ Aguardando ${DELAY_INICIAL_MS / 1000}s antes de ativar jobs proativos (anti-spam no restart)`)
}

export { jobNotificarFila }

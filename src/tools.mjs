import {
  findFreeSlots,
  getNextAvailableAcrossStaff,
  isSlotAvailable,
  createEvent,
  deleteEvent,
} from './calendar.mjs'

import {
  getDb,
  getCliente,
  upsertCliente,
  criarAgendamento,
  getAgendamentosFuturosCliente,
  cancelarAgendamento,
  marcarUpsellPosAgendamento,
  adicionarFilaEspera,
  getFilaParaHorario,
  marcarNotificadoFila,
  marcarRespondeufila,
  getProdutosEmEstoque,
  getProduto,
  getServico,
  getServicosAtivos,
  getPerfilProgressivo,
  registrarInteresseProduto,
  registrarSinalRecebido,
  getConfig,
  enfileirarMensagem,
  incrementarNoShowParcial,
  registrarNoShow,
  getNomeBarbeiroDisplay as staffNameById,
  getNomeBarbeiroOuNull,
} from './db.mjs'

import { staff, schedule, upsellMap, MIN_ADVANCE_MINUTES, MAX_DAILY_ACTIVE_MESSAGES } from './config.mjs'
import { isoBRT } from './time.mjs'
import { log, warn, error as logError } from './logger.mjs'

function validarWhatsappNumber(numero) {
  if (!numero || typeof numero !== 'string') return false
  // Aceita formatos WPPConnect: @c.us (telefone), @lid (linked ID), @s.whatsapp.net, @g.us (grupo)
  return /^\d{8,18}@(c\.us|lid|s\.whatsapp\.net|g\.us)$/.test(numero)
}

// ── Helpers ──────────────────────────────────────────────────────

function parseDateBR(texto) {
  // Resolve referências relativas em pt-BR para ISO date string YYYY-MM-DD
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const hoje = now.toISOString().slice(0, 10)

  const t = texto.toLowerCase().trim()
  if (t === 'hoje') return hoje

  if (t === 'amanhã' || t === 'amanha') {
    const d = new Date(now); d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }

  const diasSemana = { 'domingo':0,'segunda':1,'terça':2,'terca':2,'quarta':3,'quinta':4,'sexta':5,'sábado':6,'sabado':6 }
  for (const [nome, idx] of Object.entries(diasSemana)) {
    if (t.includes(nome)) {
      const d = new Date(now)
      const diff = (idx - d.getDay() + 7) % 7 || 7
      d.setDate(d.getDate() + diff)
      return d.toISOString().slice(0, 10)
    }
  }

  // Formato DD/MM ou DD/MM/YYYY
  const dmMatch = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
  if (dmMatch) {
    const year = dmMatch[3]
      ? (dmMatch[3].length === 2 ? '20' + dmMatch[3] : dmMatch[3])
      : now.getFullYear()
    return `${year}-${String(dmMatch[2]).padStart(2,'0')}-${String(dmMatch[1]).padStart(2,'0')}`
  }

  return texto // devolve como veio se não reconheceu
}

function buildSlotISO(dateStr, timeStr) {
  // dateStr: YYYY-MM-DD, timeStr: "14:30" ou "14h30" ou "14h"
  const t = timeStr.replace('h', ':').replace('::', ':')
  const [h, m = '00'] = t.split(':')
  return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`
}

function isOpenDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00-03:00')
  const dow = d.getDay()
  return schedule.openDays.includes(dow)
}

function minutesUntil(isoStr) {
  const now = new Date()
  return (new Date(isoStr) - now) / 60000
}

export function getUpsellParaServico(servicoId) {
  const emEstoque = getProdutosEmEstoque().map(p => p.id)
  const candidatos = upsellMap[servicoId] || []
  return candidatos
    .filter(id => emEstoque.includes(id))
    .slice(0, 2)
    .map(id => getProduto(id))
    .filter(Boolean)
}

// ── Tool: verificar_disponibilidade ──────────────────────────────
function filtrarSlotsAntecedencia(slots) {
  const antecedenciaMinutos = Number(getConfig('antecedencia_minima_minutos') || 30)
  const limiteMinimo = new Date(Date.now() + antecedenciaMinutos * 60 * 1000)
  return slots.filter((slot) => new Date(slot.start || slot.inicio) >= limiteMinimo)
}

function staffIdsComNome() {
  return staff.filter(s => s.active).map(s => s.id).filter(id => getNomeBarbeiroOuNull(id))
}

export async function verificarDisponibilidade({ data, horario, servico_id, staff_id }) {
  // Normaliza valores que Claude pode mandar como string
  if (horario === 'null' || horario === 'undefined' || horario === '') horario = null
  if (staff_id === 'null' || staff_id === '') staff_id = 'qualquer'

  try {
    const servico = getServico(servico_id)
    if (!servico) return { disponivel: false, erro: `Serviço "${servico_id}" não encontrado.` }

    const dateStr = parseDateBR(data)
    if (!isOpenDay(dateStr)) {
      return { disponivel: false, motivo: 'A barbearia não abre nesse dia.' }
    }

    // Se horário não especificado, retorna todos slots livres do dia
    if (!horario) {
      if (staff_id && staff_id !== 'qualquer') {
        if (!getNomeBarbeiroOuNull(staff_id)) {
          return { disponivel: false, erro: 'Barbeiro inválido.' }
        }
        const slots = filtrarSlotsAntecedencia(await findFreeSlots(staff_id, dateStr, servico.duracao_minutos))
        return { slots_disponiveis: slots.map(s => s.label), staff_id, data: dateStr }
      }
      const todos = filtrarSlotsAntecedencia(await getNextAvailableAcrossStaff(dateStr, servico.duracao_minutos))
      const porBarbeiro = {}
      for (const s of todos) {
        if (!porBarbeiro[s.staffId]) porBarbeiro[s.staffId] = []
        porBarbeiro[s.staffId].push(s.label)
      }
      return { slots_por_barbeiro: porBarbeiro, data: dateStr }
    }

    const startISO = buildSlotISO(dateStr, horario)
    const minutos = minutesUntil(startISO)

    if (minutos < 0) return { disponivel: false, motivo: 'Esse horário já passou.' }

    const aviso_presencial = minutos < 60 && minutos >= MIN_ADVANCE_MINUTES
      ? 'Horário próximo — existe risco de ser preenchido por cliente presencial. Recomendo confirmar com Andy.'
      : null

    if (minutos < MIN_ADVANCE_MINUTES) {
      return { disponivel: false, motivo: `Agendamentos online precisam de pelo menos ${MIN_ADVANCE_MINUTES} minutos de antecedência.` }
    }

    const targetStaff = (staff_id && staff_id !== 'qualquer')
      ? (getNomeBarbeiroOuNull(staff_id) ? [staff_id] : [])
      : staffIdsComNome()
    if (staff_id && staff_id !== 'qualquer' && !targetStaff.length) {
      return { disponivel: false, erro: 'Barbeiro inválido.' }
    }
    const resultados = []

    for (const sid of targetStaff) {
      const livre = await isSlotAvailable(sid, startISO, servico.duracao_minutos)
      resultados.push({ staff_id: sid, staff_nome: staffNameById(sid), disponivel: livre })
    }

    const algumLivre = resultados.filter(r => r.disponivel)
    if (algumLivre.length === 0) {
      // Sugere alternativas no mesmo dia
      const alternativos = await getNextAvailableAcrossStaff(dateStr, servico.duracao_minutos)
      const proximos = alternativos.filter(a => a.start > startISO).slice(0, 3)
      return {
        disponivel: false,
        motivo: 'Horário ocupado para todos os barbeiros.',
        sugestoes: proximos.map(a => ({ horario: a.label, staff_nome: staffNameById(a.staffId), staff_id: a.staffId })),
      }
    }

    return {
      disponivel: true,
      opcoes: algumLivre,
      aviso_presencial,
      start_iso: startISO,
      duracao_minutos: servico.duracao_minutos,
      servico_nome: servico.nome,
      preco: servico.preco,
    }
  } catch (err) {
    logError('verificarDisponibilidade erro:', err)
    return { erro: 'Erro ao verificar disponibilidade. Tente novamente.' }
  }
}

// ── Tool: criar_agendamento ───────────────────────────────────────
export async function criarAgendamentoTool({ whatsapp_number, cliente_nome, staff_id, servico_id, start_iso }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    start_iso = isoBRT(new Date(start_iso))
    const servico = getServico(servico_id)
    if (!servico) return { sucesso: false, erro: `Serviço "${servico_id}" não encontrado.` }

    // Resolve "qualquer" para um barbeiro real e disponível no horário pedido.
    if (staff_id === 'qualquer' || !staff_id) {
      const barbeirosAtivos = staffIdsComNome()
      let staffEscolhido = null
      for (const sid of barbeirosAtivos) {
        if (await isSlotAvailable(sid, start_iso, servico.duracao_minutos)) {
          staffEscolhido = sid
          break
        }
      }
      if (!staffEscolhido) {
        return { sucesso: false, erro: 'Nenhum barbeiro disponível nesse horário.' }
      }
      staff_id = staffEscolhido
      log(`staff_id="qualquer" resolvido para "${staff_id}"`)
    } else if (!getNomeBarbeiroOuNull(staff_id)) {
      return { sucesso: false, erro: 'Barbeiro inválido.' }
    }

    // Validação: serviço não pode terminar após o horário de fechamento
    const closeTimeStr = schedule.closeTime || '22:00'
    const fimMs = new Date(start_iso).getTime() + servico.duracao_minutos * 60000
    const fimLocal = new Date(fimMs).toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    if (fimLocal > closeTimeStr) {
      return { sucesso: false, erro: `O serviço termina às ${fimLocal}, após o fechamento (${closeTimeStr}). Vamos escolher um horário mais cedo?` }
    }

    const cliente = getCliente(whatsapp_number)
    if (cliente?.confirmacao_rigorosa) {
      const valorSinal = (servico.preco * 0.5).toFixed(2)
      const chavePix = getConfig('chave_pix_sinal') || '[chave Pix não configurada no painel]'
      return {
        sucesso: false,
        exige_sinal: true,
        valor_sinal: Number(valorSinal),
        chave_pix: chavePix,
        mensagem: `Cliente com confirmação rigorosa — exija sinal de 50% (R$${valorSinal}) antes de criar agendamento.`,
      }
    }

    const endISO = isoBRT(new Date(new Date(start_iso).getTime() + servico.duracao_minutos * 60000))

    // Verifica de novo antes de criar (race condition)
    const ainda_livre = await isSlotAvailable(staff_id, start_iso, servico.duracao_minutos)
    if (!ainda_livre) return { sucesso: false, erro: 'Horário foi preenchido enquanto confirmávamos. Vamos escolher outro?' }

    // Cria evento no Google Calendar
    const evento = await createEvent(staff_id, {
      summary:      `${servico.nome} — ${cliente_nome}`,
      description:  `WhatsApp: ${whatsapp_number}\nServiço: ${servico.nome}\nBarbeiro: ${staffNameById(staff_id)}`,
      startTime:    start_iso,
      endTime:      endISO,
      clientePhone: whatsapp_number,
    })

    // Salva no banco
    upsertCliente(whatsapp_number, cliente_nome)
    const agendamento = criarAgendamento({
      whatsappNumber:   whatsapp_number,
      clienteNome:      cliente_nome,
      staffId:          staff_id,
      servicoId:        servico_id,
      dataHoraInicio:   start_iso,
      dataHoraFim:      endISO,
      googleEventId:    evento.id,
    })

    // Upsell produtos
    const upsell = getUpsellParaServico(servico_id)

    log(`Agendamento criado: #${agendamento.id} — ${cliente_nome} — ${servico.nome} — ${staff_id}`)

    const horaLabel = new Date(start_iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    })
    const dataLabel = new Date(start_iso).toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo',
    })

    return {
      sucesso:          true,
      agendamento_id:   agendamento.id,
      staff_nome:       staffNameById(staff_id),
      servico_nome:     servico.nome,
      preco:            servico.preco,
      data_label:       dataLabel,
      hora_label:       horaLabel,
      upsell_produtos:  upsell,
    }
  } catch (err) {
    logError('criarAgendamentoTool erro:', err)
    return { sucesso: false, erro: 'Erro ao criar agendamento. Tente novamente.' }
  }
}

// ── Tool: cancelar_agendamento ────────────────────────────────────
export async function cancelarAgendamentoTool({ whatsapp_number, agendamento_id }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    const agendamentos = getAgendamentosFuturosCliente(whatsapp_number)
    if (!agendamentos.length) return { sucesso: false, mensagem: 'Nenhum agendamento futuro encontrado para cancelar.' }

    let alvo = agendamentos.find(a => a.id === agendamento_id)
    if (!alvo && agendamentos.length === 1) alvo = agendamentos[0]
    if (!alvo) {
      return {
        sucesso: false,
        agendamentos: agendamentos.map(a => ({
          id: a.id,
          servico: a.servico_id,
          data_hora: a.data_hora_inicio,
          staff: staffNameById(a.staff_id),
        })),
        mensagem: 'Qual agendamento deseja cancelar?',
      }
    }

    // Remove do Google Calendar
    if (alvo.google_event_id) {
      await deleteEvent(alvo.staff_id, alvo.google_event_id)
    }

    const minutos = minutesUntil(alvo.data_hora_inicio)
    let aviso_cancelamento = null
    if (minutos < 60) {
      registrarNoShow(whatsapp_number, alvo.id)
      aviso_cancelamento = 'no_show_completo'
    } else if (minutos < 180) {
      incrementarNoShowParcial(whatsapp_number, 0.5)
      aviso_cancelamento = 'meio_no_show'
    }

    cancelarAgendamento(alvo.id, 'manual')

    await notificarFilaEspera(alvo.data_hora_inicio, alvo.staff_id)

    return { sucesso: true, mensagem: `Agendamento cancelado com sucesso.`, agendamento_id: alvo.id, aviso_cancelamento }
  } catch (err) {
    logError('cancelarAgendamentoTool erro:', err)
    return { sucesso: false, erro: 'Erro ao cancelar agendamento.' }
  }
}

// ── Tool: listar_agendamentos_cliente ─────────────────────────────
export function listarAgendamentosCliente({ whatsapp_number }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    const agendamentos = getAgendamentosFuturosCliente(whatsapp_number)
    if (!agendamentos.length) return { agendamentos: [], mensagem: 'Nenhum agendamento futuro.' }
    return {
      agendamentos: agendamentos.map(a => ({
        id:          a.id,
        servico:     a.servico_id,
        data_hora:   a.data_hora_inicio,
        staff_nome:  staffNameById(a.staff_id),
        status:      a.status,
      })),
    }
  } catch (err) {
    logError('listarAgendamentosCliente erro:', err)
    return { erro: 'Erro ao buscar agendamentos.' }
  }
}

// ── Tool: consultar_servicos ──────────────────────────────────────
export function consultarServicos() {
  try {
    const servicos = getServicosAtivos()
    return { servicos: servicos.map(s => ({ id: s.id, nome: s.nome, preco: s.preco, duracao_minutos: s.duracao_minutos })) }
  } catch (err) {
    return { erro: 'Erro ao buscar serviços.' }
  }
}

// ── Tool: consultar_produtos ──────────────────────────────────────
export function consultarProdutos({ categoria } = {}) {
  try {
    let produtos = getProdutosEmEstoque()
    if (categoria) {
      produtos = produtos.filter(p => (p.categoria || '').toLowerCase() === String(categoria).toLowerCase())
    }
    if (!produtos.length) {
      return { produtos: [], aviso: 'Nenhum produto em estoque' + (categoria ? ` na categoria ${categoria}` : '') + ' no momento.' }
    }
    return {
      produtos: produtos.map(p => ({
        id:         p.id,
        nome:       p.nome,
        descricao:  p.descricao,
        preco:      p.preco,
        categoria:  p.categoria,
        em_estoque: p.estoque > 0,
      })),
    }
  } catch (err) {
    logError('consultarProdutos erro:', err)
    return { erro: 'Erro ao buscar produtos.' }
  }
}

// ── Tool: adicionar_fila_espera ───────────────────────────────────
export function adicionarFilaEsperaTool({ whatsapp_number, cliente_nome, staff_id, servico_id, data_hora_alvo }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    const result = adicionarFilaEspera({ whatsappNumber: whatsapp_number, clienteNome: cliente_nome, staffId: staff_id, servicoId: servico_id, dataHoraAlvo: data_hora_alvo })
    return { sucesso: true, fila_id: result.id }
  } catch (err) {
    return { sucesso: false, erro: 'Erro ao adicionar à fila.' }
  }
}

// ── Notificar fila quando slot libera ────────────────────────────
export async function notificarFilaEspera(dataHoraAlvo, staffId) {
  const fila = getFilaParaHorario(dataHoraAlvo, staffId)
  if (!fila.length) return

  const primeiro = fila[0]
  marcarNotificadoFila(primeiro.id)

  return {
    notificar_numero: primeiro.whatsapp_number,
    mensagem: `Boa notícia! O horário que você queria ficou disponível 🎉 Quer que eu reserve agora?`,
    fila_id: primeiro.id,
    data_hora: dataHoraAlvo,
    servico_id: primeiro.servico_id,
    staff_id: staffId,
  }
}

// ── Tool: resumir_perfil_cliente ─────────────────────────────────
export function resumirPerfilCliente({ whatsapp_number }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    const perfil = getPerfilProgressivo(whatsapp_number)
    if (!perfil || (!perfil.total_visitas && !perfil.barbeiro_favorito)) {
      return { cliente_novo: true }
    }
    return { cliente_novo: false, perfil }
  } catch (err) {
    logError('resumirPerfilCliente erro:', err)
    return { erro: 'Erro ao buscar perfil.' }
  }
}

// ── Tool: registrar_interesse_produto ────────────────────────────
export function registrarInteresseProdutoTool({ whatsapp_number, produto_id, contexto }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    const produto = getProduto(produto_id)
    if (!produto) return { sucesso: false, erro: 'Produto não encontrado.' }
    registrarInteresseProduto(whatsapp_number, produto_id, contexto || 'pergunta direta')
    return { sucesso: true, produto_nome: produto.nome }
  } catch (err) {
    logError('registrarInteresseProdutoTool erro:', err)
    return { sucesso: false, erro: 'Erro ao registrar interesse.' }
  }
}

// ── Tool: notificar_sinal_recebido ───────────────────────────────
export async function notificarSinalRecebidoTool({ whatsapp_number, agendamento_id_provisorio, valor, comprovante_path }) {
  try {
    if (!validarWhatsappNumber(whatsapp_number)) {
      logError('Tool rejeitada: whatsapp_number inválido', whatsapp_number)
      return { erro: 'Número de WhatsApp inválido ou ausente.' }
    }
    registrarSinalRecebido(agendamento_id_provisorio, valor, comprovante_path || null)
    const cliente = getCliente(whatsapp_number)
    const andyPhone = getConfig('andy_phone')
    if (andyPhone) {
      const msg = `🔔 SINAL RECEBIDO\nCliente: ${cliente?.nome || whatsapp_number}\nValor: R$${valor}\nAgendamento ID: ${agendamento_id_provisorio}\nResponda "OK ${agendamento_id_provisorio}" para aprovar.`
      enfileirarMensagem(andyPhone, msg, 'critica')
    }
    return { sucesso: true, aguardando_aprovacao: true }
  } catch (err) {
    logError('notificarSinalRecebidoTool erro:', err)
    return { sucesso: false, erro: 'Erro ao notificar sinal.' }
  }
}

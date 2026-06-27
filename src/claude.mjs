import {
  verificarDisponibilidade,
  criarAgendamentoTool,
  cancelarAgendamentoTool,
  listarAgendamentosCliente,
  consultarServicos,
  consultarProdutos,
  adicionarFilaEsperaTool,
  resumirPerfilCliente,
  registrarInteresseProdutoTool,
  notificarSinalRecebidoTool,
} from './tools.mjs'
import { buildSystemPrompt } from './config.mjs'
import {
  getCliente,
  getConversa,
  salvarConversa,
  marcarAguardandoAndy,
  getPerfilProgressivo,
  registrarEvento,
  getConversasAtivasCount,
  enfileirarMensagem,
  getConfig,
  upsertCliente,
  getAgendamentosFuturosCliente,
  listarBarbeiros,
  getNomeBarbeiroOuNull,
} from './db.mjs'
import { M } from './messages.mjs'
import { log, error as logError } from './logger.mjs'

const MODEL      = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 2048
const HISTORY_LIMIT = 8
const SUMMARIZE_AFTER = 14

// Padrões que indicam que o bot escalou pro Andy (qualquer um dispara handoff)
const HANDOFF_PATTERNS = [
  'Andy te responder',
  'chamar o Andy',
  'pedir pro Andy',
  'passar pro Andy',
  'falar com o Andy',
  'pro Andy te atender',
]

const TOOLS = [
  {
    name: 'consultar_servicos',
    description: `Retorna lista de serviços ativos com id, nome, preço e duração. Chame quando precisar resolver o servico_id exato antes de outra tool, ou quando o cliente pedir o catálogo. Não chame se o serviço pedido já mapeia direto (ex: "corte" → "corte").`,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_produtos',
    description: `Retorna lista de produtos em estoque com id, nome, descrição, preço e categoria. **OBRIGATÓRIA** sempre que o cliente perguntar sobre produtos (pomada, cera, shampoo, óleo, minoxidil, etc.) ou pedir recomendação. NUNCA invente nomes ou preços — só use o que esta tool retornar. Pode filtrar por categoria opcional ("finalizador-cabelo", "cuidado-barba", "cuidado-cabelo", "crescimento").`,
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Filtro opcional. Omita para ver todos.',
        },
      },
    },
  },
  {
    name: 'resumir_perfil_cliente',
    description: `Busca perfil do cliente (barbeiro favorito, serviço habitual, última visita, no-shows, produtos de interesse). Chame uma única vez por conversa, na primeira mensagem de cliente já cadastrado. Não chame para cliente novo.`,
    input_schema: {
      type: 'object',
      properties: { whatsapp_number: { type: 'string' } },
      required: ['whatsapp_number'],
    },
  },
  {
    name: 'verificar_disponibilidade',
    description: `Consulta horários livres no Google Calendar. Obrigatória antes de qualquer confirmação de horário e antes de chamar criar_agendamento. Para listar todos os slots do dia, omita o campo "horario" (não envie a string "null"). Não chame se ainda faltam servico_id ou data — colete primeiro.`,
    input_schema: {
      type: 'object',
      properties: {
        data:       { type: 'string', description: 'Data (ex: "hoje", "amanhã", "quinta", "25/06")' },
        horario:    { type: 'string', description: 'Horário (ex: "14h", "14:30"). Null se aberto.' },
        servico_id: { type: 'string', description: 'ID exato do serviço (use consultar_servicos se incerto)' },
        staff_id:   { type: 'string', description: 'ID do barbeiro ou "qualquer"' },
      },
      required: ['data', 'servico_id', 'staff_id'],
    },
  },
  {
    name: 'criar_agendamento',
    description: `Cria o agendamento no Google Calendar e no banco. Gatilhos: cliente disse o nome após você pedir, OU respondeu "sim/fecha/ok/blz/beleza/pode ser/confirma" após o resumo. Chame direto — sem pedir 2ª confirmação. Se o perfil tiver confirmacao_rigorosa=true, NÃO chame: exija sinal Pix primeiro. O campo whatsapp_number é injetado pelo sistema — pode passar "".`,
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_number: { type: 'string', description: 'Pode passar "" (string vazia). Sistema injeta o número real automaticamente.' },
        cliente_nome:    { type: 'string' },
        staff_id:        { type: 'string' },
        servico_id:      { type: 'string' },
        start_iso:       { type: 'string', description: 'ISO8601 com timezone -03:00' },
      },
      required: ['cliente_nome', 'staff_id', 'servico_id', 'start_iso'],
    },
  },
  {
    name: 'cancelar_agendamento',
    description: `Cancela um agendamento futuro do cliente. Chame após o cliente confirmar qual cancelar. Se houver múltiplos e o cliente não especificou, passe agendamento_id=0 — a tool devolve a lista para você apresentar.`,
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_number: { type: 'string' },
        agendamento_id:  { type: 'number', description: '0 se não informado' },
      },
      required: ['whatsapp_number'],
    },
  },
  {
    name: 'listar_agendamentos_cliente',
    description: `Lista agendamentos futuros do cliente. CHAME quando o cliente perguntar sobre seus horários, OU quando ele quiser cancelar sem especificar qual.`,
    input_schema: {
      type: 'object',
      properties: { whatsapp_number: { type: 'string' } },
      required: ['whatsapp_number'],
    },
  },
  {
    name: 'adicionar_fila_espera',
    description: `Adiciona o cliente à fila de espera de um horário ocupado. Chame apenas após o cliente concordar explicitamente ("me avisa se abrir", "fico na espera", etc.). O sistema notifica automaticamente quando a vaga liberar.`,
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_number: { type: 'string' },
        cliente_nome:    { type: 'string' },
        staff_id:        { type: 'string' },
        servico_id:      { type: 'string' },
        data_hora_alvo:  { type: 'string', description: 'ISO8601' },
      },
      required: ['whatsapp_number', 'servico_id', 'data_hora_alvo'],
    },
  },
  {
    name: 'registrar_interesse_produto',
    description: `Registra interesse do cliente em um produto (a compra é sempre presencial). Chame quando ele pedir detalhes de um produto específico ou disser que vai levar quando vier. Não chame só porque você ofereceu no upsell — exige interesse claro do cliente.`,
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_number: { type: 'string' },
        produto_id:      { type: 'string' },
        contexto:        { type: 'string', description: '"pós-corte" | "pergunta direta" | "upsell pós-agendamento"' },
      },
      required: ['whatsapp_number', 'produto_id'],
    },
  },
  {
    name: 'notificar_sinal_recebido',
    description: `Registra o sinal Pix do cliente e notifica o Andy para aprovar. Chame quando um cliente com confirmacao_rigorosa=true enviar o comprovante de 50%. Use o agendamento_id_provisorio retornado pela chamada anterior de criar_agendamento.`,
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_number:              { type: 'string' },
        agendamento_id_provisorio:    { type: 'number' },
        valor:                        { type: 'number' },
        comprovante_path:             { type: 'string', description: 'Caminho do arquivo salvo' },
      },
      required: ['whatsapp_number', 'agendamento_id_provisorio', 'valor'],
    },
  },
]

function getApiKey() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || key === 'COLE_SUA_CHAVE_AQUI') throw new Error('ANTHROPIC_API_KEY não definida no .env')
  return key
}

async function executeTool(toolName, toolInput, whatsappNumber) {
  log(`🔧 Tool: ${toolName}`, JSON.stringify(toolInput).slice(0, 120))
  const input = { ...toolInput, whatsapp_number: whatsappNumber }
  switch (toolName) {
    case 'consultar_servicos':           return consultarServicos()
    case 'consultar_produtos':           return consultarProdutos(input)
    case 'resumir_perfil_cliente':         return resumirPerfilCliente(input)
    case 'verificar_disponibilidade':    return await verificarDisponibilidade(input)
    case 'criar_agendamento':            return await criarAgendamentoTool(input)
    case 'cancelar_agendamento':         return await cancelarAgendamentoTool(input)
    case 'listar_agendamentos_cliente':  return listarAgendamentosCliente(input)
    case 'adicionar_fila_espera':        return adicionarFilaEsperaTool(input)
    case 'registrar_interesse_produto':  return registrarInteresseProdutoTool(input)
    case 'notificar_sinal_recebido':     return await notificarSinalRecebidoTool(input)
    default:                              return { erro: `Tool desconhecida: ${toolName}` }
  }
}

function estaAberto() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const dow = agora.getDay()
  // Segunda (1) a Sábado (6). Fechado domingo (0).
  if (dow === 0) return false
  const hora = agora.getHours() + agora.getMinutes() / 60
  return hora >= 8 && hora < 22
}

async function fetchClaudeComRetry(body) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type':      'application/json',
          'x-api-key':         getApiKey(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
      if (r.ok) return await r.json()
      const errTxt = await r.text()
      logError(`Claude API erro tentativa ${tentativa + 1}:`, errTxt)
    } catch (err) {
      logError(`Claude API exception tentativa ${tentativa + 1}:`, err.message)
    }
    if (tentativa === 0) await new Promise(r => setTimeout(r, 2000))
  }
  return null
}

async function gerarResumoHistorico(mensagensAntigas, resumoAnterior) {
  const concat = mensagensAntigas.map(m =>
    `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${typeof m.content === 'string' ? m.content : '[tool]'}`
  ).join('\n')

  const prompt = `Resuma essa conversa de WhatsApp em UMA FRASE focando em: o que o cliente quer, qual serviço, dia/hora preferida, barbeiro escolhido, se já agendou.${resumoAnterior ? `\n\nResumo anterior: ${resumoAnterior}` : ''}\n\nConversa:\n${concat}\n\nResumo:`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': getApiKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    })
    const data = await r.json()
    return data.content?.[0]?.text || resumoAnterior
  } catch {
    return resumoAnterior
  }
}

export async function askClaude(userMessage, whatsappNumber) {
  const inicio = Date.now()
  const cliente  = getCliente(whatsappNumber)
  const conversa = getConversa(whatsappNumber)

  // ── Limite de conversas simultâneas (controla pico de custo) ─────
  const MAX_CONVERSAS = Number(process.env.MAX_CONVERSAS_SIMULTANEAS || 20)
  const ativasAgora = getConversasAtivasCount()
  if (ativasAgora > MAX_CONVERSAS) {
    log(`Limite de ${MAX_CONVERSAS} conversas simultâneas atingido. Descartando mensagem de ${whatsappNumber}.`)
    return { text: 'Estamos com muita demanda agora. Tenta de novo em alguns minutos! 🙏', error: false }
  }

  // Dev whitelist: reset de histórico a cada 10 minutos (sem apagar perfil/agendamentos)
  const devWhitelistClaude = (process.env.DEV_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)
  const isDevNumberClaude = devWhitelistClaude.includes(whatsappNumber)
  if (isDevNumberClaude && conversa.ultima_atividade) {
    const minutosInativo = (Date.now() - new Date(conversa.ultima_atividade).getTime()) / 60000
    if (minutosInativo > 10) {
      conversa.historico = []
      conversa.resumo = null
      log(`🔧 [DEV] Histórico resetado (${minutosInativo.toFixed(1)}min inativo) para ${whatsappNumber}`)
    }
  }

  // Expira histórico se última atividade > 8h (cliente "voltou do nada")
  // Perfil/nome/agendamentos passados PERSISTEM — só o histórico de mensagens é zerado.
  // 8h evita que termos relativos como "amanhã" da véspera vazem para o dia seguinte.
  const HORAS_EXPIRACAO_HISTORICO = 8
  if (!isDevNumberClaude && conversa.ultima_atividade) {
    const horasInativo = (Date.now() - new Date(conversa.ultima_atividade).getTime()) / 3600000
    if (horasInativo > HORAS_EXPIRACAO_HISTORICO) {
      conversa.historico = []
      conversa.resumo = null
      log(`🕐 Histórico expirado (${horasInativo.toFixed(1)}h inativo) para ${whatsappNumber}`)
    }
  }

  const historicoAtual = conversa.historico || []

  // Injeta timestamp da mensagem atual para o modelo ter noção de tempo entre turnos.
  // Sem isso, "amanhã" da véspera pode parecer "amanhã" de hoje quando o cliente volta horas depois.
  const agoraBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const agora = agoraBRT.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  const userMessageComTimestamp = `[${agora}] ${userMessage}`

  let messagesArray = [...historicoAtual, { role: 'user', content: userMessageComTimestamp }]
  let resumoUsar = conversa.resumo

  if (messagesArray.length > SUMMARIZE_AFTER) {
    const antigas = messagesArray.slice(0, -HISTORY_LIMIT)
    resumoUsar = await gerarResumoHistorico(antigas, resumoUsar)
    messagesArray = messagesArray.slice(-HISTORY_LIMIT)
  }

  const foraHorario = !estaAberto()
  const perfil = cliente?.nome ? getPerfilProgressivo(whatsappNumber) : null
  const barbeiros = listarBarbeiros()
  const staffNomesDB = Object.fromEntries(
    barbeiros
      .map((b) => [b.id, getNomeBarbeiroOuNull(b.id)])
      .filter(([, nome]) => nome !== null),
  )
  const systemPrompt = buildSystemPrompt(cliente?.nome, perfil, { fora_horario: foraHorario }, staffNomesDB)

  if (resumoUsar) {
    messagesArray = [
      { role: 'user', content: `[Resumo das mensagens anteriores: ${resumoUsar}]` },
      { role: 'assistant', content: 'Entendido, continuando o atendimento.' },
      ...messagesArray,
    ]
  }

  let finalText = ''
  let currentMessages = messagesArray
  const toolsChamadas = []
  let tokensInput = 0, tokensOutput = 0
  let precisouHandoff = false
  let ultimoAgendamentoCriado = null

  const MAX_ROUNDS = Number(process.env.MAX_CLAUDE_ROUNDS || 5)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await fetchClaudeComRetry({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: TOOLS,
      messages: currentMessages,
    })

    if (!response) {
      marcarAguardandoAndy(whatsappNumber, 'falha_api')
      const andyPhone = getConfig('andy_phone')
      if (andyPhone) enfileirarMensagem(andyPhone, `⚠️ Falha de API ao atender ${whatsappNumber}. Atender manualmente.`, 'critica')
      precisouHandoff = true
      return { text: M.falhaApi(), error: true }
    }

    tokensInput += response.usage?.input_tokens || 0
    tokensOutput += response.usage?.output_tokens || 0

    if (response.stop_reason === 'end_turn') {
      finalText = response.content.find(b => b.type === 'text')?.text || 'Não consegui formular uma resposta.'

      // 🛡️ Defesa anti-mentira: detecta se o bot anunciou sucesso sem ter chamado criar_agendamento.
      // Regra: só dispara se a palavra de fechamento aparecer em uma FRASE AFIRMATIVA (sem "?" depois).
      // Textos como "Fechado, X com Y. Vou reservar?" são perguntas legítimas pedindo última confirmação.
      const FECHAMENTO_PALAVRAS = /\b(agendad[oa]|confirmad[oa]|marcad[oa]|reservad[oa]|te espero|t[ôo] te esperando)\b/i
      const chamouTool = toolsChamadas.includes('criar_agendamento')
      let anunciouSucesso = false
      if (!chamouTool && FECHAMENTO_PALAVRAS.test(finalText)) {
        const temDataHora = /\b(\d{1,2}[h:]\d{0,2}|\d{1,2}\/\d{2}|hoje|amanhã|segunda|terça|quarta|quinta|sexta|sábado)\b/i.test(finalText)
        if (temDataHora) {
          const frases = finalText.split(/(?<=[.!?])\s+/)
          const anunciouFrase = frases.some(f => FECHAMENTO_PALAVRAS.test(f) && !f.trim().endsWith('?'))
          if (anunciouFrase) {
            if (toolsChamadas.includes('verificar_disponibilidade')) {
              // Verificou disponibilidade mas nao criou — definitivamente falhou
              anunciouSucesso = true
            } else {
              // Nao verificou nem criou — checar se menciona horario de agendamento ja existente
              const agsFuturos = getAgendamentosFuturosCliente(whatsappNumber) ?? []
              const mencionaExistente = agsFuturos.some(ag => {
                const d = new Date(ag.data_hora_inicio)
                const hhmm = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0')
                const hh = d.getHours() + 'h'
                return finalText.includes(hhmm) || finalText.includes(hh)
              })
              anunciouSucesso = !mencionaExistente
            }
          }
        }
      }
      if (anunciouSucesso) {
        logError(`🚨 Bot anunciou sucesso SEM chamar criar_agendamento. Texto bloqueado: "${finalText.slice(0, 120)}"`)
        marcarAguardandoAndy(whatsappNumber, 'mentiu_sucesso')
        const andyPhone = getConfig('andy_phone')
        if (andyPhone) {
          enfileirarMensagem(
            andyPhone,
            `🚨 BOT MENTIU sucesso pra ${whatsappNumber} (cliente: ${cliente?.nome || '—'}). Texto que ia ser enviado: "${finalText.slice(0, 200)}". Atender manualmente.`,
            'critica'
          )
        }
        precisouHandoff = true
        finalText = 'Brother, tive um problema técnico aqui pra fechar. Vou pedir pro Andy te responder direto pra garantir teu horário ✂️'
      }

      if (HANDOFF_PATTERNS.some(p => finalText.includes(p))) {
        marcarAguardandoAndy(whatsappNumber, 'handoff_bot')
        precisouHandoff = true
      }
      const novoHistorico = [
        ...historicoAtual,
        { role: 'user', content: userMessageComTimestamp },
        { role: 'assistant', content: finalText },
      ].slice(-HISTORY_LIMIT * 2)
      salvarConversa(whatsappNumber, novoHistorico, resumoUsar)
      break
    }

    if (response.stop_reason === 'tool_use') {
      const assistantMsg = { role: 'assistant', content: response.content }
      const toolResults  = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        toolsChamadas.push(block.name)
        const result = await executeTool(block.name, block.input, whatsappNumber)
        if (block.name === 'criar_agendamento' && result?.sucesso) {
          ultimoAgendamentoCriado = result
          if (block.input?.cliente_nome) {
            upsertCliente(whatsappNumber, block.input.cliente_nome)
          }
        }
        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     JSON.stringify(result),
        })
      }
      currentMessages = [...currentMessages, assistantMsg, { role: 'user', content: toolResults }]
      continue
    }

    break
  }

  // Fallback: se Claude não gerou texto MAS criar_agendamento foi sucesso, monta confirmação automática
  if ((!finalText || finalText === 'Não consegui formular uma resposta.') && ultimoAgendamentoCriado) {
    const r = ultimoAgendamentoCriado
    const nome = cliente?.nome ? `, ${cliente.nome}` : ''
    finalText = `Fechado${nome}! ${r.servico_nome} ${r.data_label} às ${r.hora_label} com ${r.staff_nome}. Te espero ✂️`
    log(`⚠️ Fallback acionado: Claude não gerou texto, mas agendamento #${r.agendamento_id} foi criado. Mensagem padrão enviada.`)
    // Salva no histórico com o texto do fallback
    const novoHistorico = [
      ...historicoAtual,
      { role: 'user', content: userMessageComTimestamp },
      { role: 'assistant', content: finalText },
    ].slice(-HISTORY_LIMIT * 2)
    salvarConversa(whatsappNumber, novoHistorico, resumoUsar)
  }

  registrarEvento({
    whatsapp_number: whatsappNumber,
    tools_chamadas: toolsChamadas,
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    latencia_resposta_ms: Date.now() - inicio,
    conversa_resolveu_agendamento: toolsChamadas.includes('criar_agendamento'),
    precisou_handoff: precisouHandoff,
  })

  return { text: finalText || 'Não consegui processar agora, brother. Pode tentar de novo?', error: false }
}

export function getHistory(phone) {
  return getConversa(phone).historico
}

export function clearHistory(phone) {
  salvarConversa(phone, [], null)
}

export function getActiveConversationCount() {
  return getConversasAtivasCount()
}

/**
 * API pública de agendamento + landing /agendar
 * Mesmas funções do WhatsApp (tools + calendar) — single source of truth.
 */
import { Router } from 'express'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { staff, schedule, business } from './config.mjs'
import { findFreeSlots, getNextAvailableAcrossStaff } from './calendar.mjs'
import { criarAgendamentoTool } from './tools.mjs'
import { enfileirarMensagem, getServicosAtivos, getServico, getConfig } from './db.mjs'
import { isoBRT } from './time.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, '..', 'public')

export const bookingRouter = Router()

const CATEGORY_LABELS = {
  cabelo: 'Cabelo',
  barba: 'Barba',
  estetica: 'Estética',
}

function corsMiddleware(req, res, next) {
  const allowed = (process.env.PUBLIC_BOOKING_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const origin = req.headers.origin
  // Aceita: (a) origens explícitas em PUBLIC_BOOKING_ORIGINS, (b) qualquer subdomínio *.vercel.app
  // O (b) cobre os deploys de preview da Vercel que mudam de URL a cada commit.
  const isAllowed = origin && (allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin))
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
}

bookingRouter.use(corsMiddleware)

// GET /api/servicos
bookingRouter.get('/api/servicos', (req, res) => {
  const servicos = getServicosAtivos().map(s => ({
    id: s.id,
    name: s.nome,
    price: s.preco,
    durationMinutes: s.duracao_minutos,
    category: s.categoria || 'cabelo',
    categoryLabel: CATEGORY_LABELS[s.categoria] || s.categoria,
  }))
  res.json({ servicos })
})

// GET /api/barbeiros
bookingRouter.get('/api/barbeiros', (req, res) => {
  res.json({
    barbeiros: staff.filter(s => s.active).map(s => ({ id: s.id, name: s.name })),
  })
})

// GET /api/horario-funcionamento
// Single source of truth para dias abertos/fechados — usado pelo front pra montar o seletor de datas.
bookingRouter.get('/api/horario-funcionamento', (req, res) => {
  res.json({
    openDays:   schedule.openDays,
    closedDays: schedule.closedDays,
    openTime:   schedule.openTime,
    closeTime:  schedule.closeTime,
  })
})

// GET /api/disponibilidade?data=YYYY-MM-DD&servico_id=&staff_id=qualquer
bookingRouter.get('/api/disponibilidade', async (req, res) => {
  try {
    const { data, servico_id, staff_id = 'qualquer' } = req.query
    if (!data || !servico_id) {
      return res.status(400).json({ erro: 'parâmetros faltando' })
    }
    const dow = new Date(`${data}T12:00:00-03:00`).getDay()
    if (!schedule.openDays.includes(dow)) {
      return res.json({ slots: [] })
    }

    const servico = getServico(servico_id)
    if (!servico) return res.status(400).json({ erro: 'serviço inválido' })

    const duracao = servico.duracao_minutos
    const antecedenciaMinutos = Number(getConfig('antecedencia_minima_minutos') || 30)
    const limiteMinimo = new Date(Date.now() + antecedenciaMinutos * 60 * 1000)
    const filtrarSlots = (slots) =>
      slots.filter((slot) => new Date(slot.start || slot.inicio) >= limiteMinimo)

    if (staff_id === 'qualquer') {
      const slots = filtrarSlots(await getNextAvailableAcrossStaff(data, duracao))
      console.log('[debug-slots] limiteMinimo:', limiteMinimo.toISOString(), 'primeiro slot:', slots[0]?.start)
      return res.json({ slots })
    }

    const member = staff.find(s => s.id === staff_id)
    if (!member?.active) return res.status(400).json({ erro: 'barbeiro inválido' })

    const slots = filtrarSlots(await findFreeSlots(staff_id, data, duracao))
    console.log('[debug-slots] limiteMinimo:', limiteMinimo.toISOString(), 'primeiro slot:', slots[0]?.start)
    return res.json({
      slots: slots.map(sl => ({
        ...sl,
        staffId: staff_id,
        staffName: member.name,
      })),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/agendar
bookingRouter.post('/api/agendar', express.json(), async (req, res) => {
  try {
    let { nome, whatsapp, servico_id, staff_id, start_iso } = req.body || {}
    if (!nome || !whatsapp || !servico_id || !staff_id || !start_iso) {
      return res.status(400).json({ erro: 'campos obrigatórios faltando' })
    }
    start_iso = isoBRT(new Date(start_iso))

    const numeroLimpo = String(whatsapp).replace(/\D/g, '')
    if (numeroLimpo.length < 10 || numeroLimpo.length > 13) {
      return res.status(400).json({ erro: 'whatsapp inválido' })
    }
    const wppNumber = numeroLimpo.startsWith('55')
      ? `${numeroLimpo}@c.us`
      : `55${numeroLimpo}@c.us`

    const resultado = await criarAgendamentoTool({
      whatsapp_number: wppNumber,
      cliente_nome: nome,
      staff_id,
      servico_id,
      start_iso,
    })

    if (resultado?.exige_sinal) {
      return res.status(402).json({
        erro: 'Este agendamento exige sinal antecipado. Fale conosco pelo WhatsApp.',
        exige_sinal: true,
      })
    }

    if (!resultado?.sucesso) {
      return res.status(409).json({
        erro: resultado?.erro || 'horário não disponível',
      })
    }

    const msgConfirma = `✂️ Agendamento confirmado na ${business.name}!\n\n${resultado.servico_nome}\n${resultado.data_label} às ${resultado.hora_label}\nBarbeiro: ${resultado.staff_nome}\n\nEndereço: ${business.address} — ${business.city}\n\nAté lá! 👊`
    enfileirarMensagem(wppNumber, msgConfirma, 'critica')

    res.json({ sucesso: true, agendamento: resultado })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /agendar — landing
bookingRouter.get('/agendar', (req, res) => {
  res.sendFile(path.join(publicDir, 'agendar.html'))
})

bookingRouter.use('/agendar/assets', express.static(path.join(publicDir, 'assets')))

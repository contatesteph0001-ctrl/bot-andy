import { google }   from 'googleapis'
import { getConfig, getNomeBarbeiroOuNull } from './db.mjs'
import { staff, schedule, BUFFER_MINUTES, timezone } from './config.mjs'
import { log, error as logError } from './logger.mjs'
import { isoBRT } from './time.mjs'

// ── OAuth client ─────────────────────────────────────────────────
function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  )
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return client
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getOAuth2Client() })
}

// ── Resolve Calendar ID pelo staff_id ────────────────────────────
function resolveCalendarId(staffId) {
  if (!staffId || staffId === 'geral') {
    return process.env.GOOGLE_CALENDAR_ID_GERAL
  }
  const member = staff.find(s => s.id === staffId)
  if (!member) throw new Error(`Barbeiro não encontrado: ${staffId}`)
  return process.env[member.calendarEnvKey]
}

// ── Listar eventos num intervalo ─────────────────────────────────
export async function listEvents(staffId, timeMin, timeMax) {
  try {
    const calendarId = resolveCalendarId(staffId)
    const res = await getCalendarClient().events.list({
      calendarId,
      timeMin:       timeMin instanceof Date ? timeMin.toISOString() : timeMin,
      timeMax:       timeMax instanceof Date ? timeMax.toISOString() : timeMax,
      singleEvents:  true,
      orderBy:       'startTime',
    })
    return res.data.items || []
  } catch (err) {
    logError('listEvents erro:', err.message)
    return []
  }
}

// ── Criar evento ─────────────────────────────────────────────────
export async function createEvent(staffId, { summary, description, startTime, endTime, clientePhone }) {
  try {
    const calendarId = resolveCalendarId(staffId)
    const resource = {
      summary,
      description,
      start: { dateTime: startTime, timeZone: timezone },
      end:   { dateTime: endTime,   timeZone: timezone },
      extendedProperties: {
        private: { whatsapp_number: clientePhone || '' }
      },
    }
    const res = await getCalendarClient().events.insert({ calendarId, resource })
    log(`Evento criado no Calendar: ${res.data.id}`)
    return res.data
  } catch (err) {
    logError('createEvent erro:', err.message)
    throw err
  }
}

// ── Deletar evento ───────────────────────────────────────────────
export async function deleteEvent(staffId, googleEventId) {
  try {
    const calendarId = resolveCalendarId(staffId)
    await getCalendarClient().events.delete({ calendarId, eventId: googleEventId })
    log(`Evento deletado do Calendar: ${googleEventId}`)
    return true
  } catch (err) {
    logError('deleteEvent erro:', err.message)
    return false
  }
}

// ── Atualizar evento (remarcação) ────────────────────────────────
export async function updateEvent(staffId, googleEventId, { startTime, endTime }) {
  try {
    const calendarId = resolveCalendarId(staffId)
    const existing   = await getCalendarClient().events.get({ calendarId, eventId: googleEventId })
    const updated = {
      ...existing.data,
      start: { dateTime: startTime, timeZone: timezone },
      end:   { dateTime: endTime,   timeZone: timezone },
    }
    const res = await getCalendarClient().events.update({ calendarId, eventId: googleEventId, resource: updated })
    return res.data
  } catch (err) {
    logError('updateEvent erro:', err.message)
    throw err
  }
}

// ── Verificar se slot específico está livre ───────────────────────
export async function isSlotAvailable(staffId, startISO, durationMinutes) {
  try {
    const start  = new Date(startISO)
    const end    = new Date(start.getTime() + durationMinutes * 60 * 1000)
    const events = await listEvents(staffId, start, end)
    return events.filter(e => e.status !== 'cancelled').length === 0
  } catch (err) {
    logError('isSlotAvailable erro:', err.message)
    return false
  }
}

// ── Encontrar slots livres num dia ────────────────────────────────
// Retorna array de { start, end, label } com todos os slots livres
// respeitando: horário de funcionamento, almoço, buffer e eventos existentes.
export async function findFreeSlots(staffId, date, durationMinutes) {
  try {
    const openTime   = getConfig('horario_abertura')       || schedule.openTime
    const closeTime  = getConfig('horario_fechamento')     || schedule.closeTime
    console.log('[debug-findFreeSlots] openTime:', openTime, 'closeTime:', closeTime, 'date:', date, 'durationMinutes:', durationMinutes)
    const lunchStart = getConfig('horario_almoco_inicio')  || schedule.lunchStart
    const lunchEnd   = getConfig('horario_almoco_fim')     || schedule.lunchEnd

    // Monta datas em UTC-3 (Brasília)
    const toLocal = (h, m) => new Date(`${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-03:00`)
    const [oH, oM]   = openTime.split(':').map(Number)
    const [cH, cM]   = closeTime.split(':').map(Number)
    const [lsH, lsM] = lunchStart.split(':').map(Number)
    const [leH, leM] = lunchEnd.split(':').map(Number)

    const dayStart = toLocal(oH, oM)
    const dayEnd   = toLocal(cH, cM)
    const lunchS   = toLocal(lsH, lsM)
    const lunchE   = toLocal(leH, leM)

    // Eventos existentes no dia
    const events = await listEvents(staffId, dayStart, dayEnd)
    const busy = [
      ...(lunchS.getTime() !== lunchE.getTime() ? [{ start: lunchS, end: lunchE }] : []),
      ...events
        .filter(e => e.status !== 'cancelled')
        .map(e => ({
          start: new Date(e.start.dateTime || e.start.date),
          end:   new Date(e.end.dateTime   || e.end.date),
        })),
    ]

    const slotMs   = durationMinutes * 60 * 1000
    const bufferMs = BUFFER_MINUTES  * 60 * 1000
    const slots    = []
    const STEP_MS  = 15 * 60 * 1000  // granularidade 15 min

    let current = dayStart
    while (current.getTime() + slotMs <= dayEnd.getTime()) {
      const slotEnd = new Date(current.getTime() + slotMs)

      const hasConflict = busy.some(b => {
        const bufEnd = new Date(b.end.getTime() + bufferMs)
        return current < bufEnd && slotEnd > b.start
      })

      if (!hasConflict) {
        slots.push({
          start: isoBRT(current),
          end:   isoBRT(slotEnd),
          label: current.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
          }),
        })
      }

      current = new Date(current.getTime() + STEP_MS)
    }

    return slots
  } catch (err) {
    logError('findFreeSlots erro:', err.message)
    return []
  }
}

// ── Checar disponibilidade via freebusy (múltiplos barbeiros) ─────
// Útil para encontrar o próximo disponível sem preferência
export async function getNextAvailableAcrossStaff(date, durationMinutes) {
  const results = []
  for (const member of staff.filter(s => s.active)) {
    const nome = getNomeBarbeiroOuNull(member.id)
    if (!nome) continue
    const slots = await findFreeSlots(member.id, date, durationMinutes)
    for (const slot of slots) {
      results.push({ ...slot, staffId: member.id, staffName: nome })
    }
  }
  // Ordena por horário, depois por barbeiro
  results.sort((a, b) => new Date(a.start) - new Date(b.start))
  return results
}

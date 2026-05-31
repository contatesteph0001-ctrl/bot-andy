/** Utilitários de data/hora — sempre America/Sao_Paulo (BRT, UTC-3). */

export const TZ = 'America/Sao_Paulo'

/** Agora em BRT, ISO8601 com offset -03:00 (mesmo formato dos agendamentos no SQLite). */
export function nowIsoBRT() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')
  return `${s}-03:00`
}

/** Agora ± N minutos em BRT, formato ISO com -03:00. */
export function nowIsoBRTOffsetMinutes(offsetMinutes) {
  const ms = Date.now() + offsetMinutes * 60_000
  const s = new Date(ms).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')
  return `${s}-03:00`
}

/** Data de hoje YYYY-MM-DD em BRT. */
export function todayBRT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ })
}

// Converte um Date/instante para string ISO com offset -03:00 (sem milissegundos).
// Preserva o INSTANTE real; só muda a representação para o fuso BRT.
export function isoBRT(date) {
  const d = (date instanceof Date) ? date : new Date(date)
  const s = d.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')
  return `${s}-03:00`
}

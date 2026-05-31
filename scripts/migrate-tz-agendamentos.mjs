import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chatbot.db')
const DRY = process.argv.includes('--dry')
const TZ = 'America/Sao_Paulo'

function isoBRT(value) {
  const d = new Date(value)
  const s = d.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')
  return `${s}-03:00`
}

// Só converte o que NÃO está já em -03:00 (ex: termina em Z, .000Z, ou outro offset)
function precisaConverter(v) {
  return !!v && !/-03:00$/.test(v)
}

const db = new Database(DB_PATH)
const rows = db.prepare(`SELECT id, data_hora_inicio, data_hora_fim FROM agendamentos`).all()
let n = 0
const upd = db.prepare(`UPDATE agendamentos SET data_hora_inicio = ?, data_hora_fim = ? WHERE id = ?`)
const tx = db.transaction(() => {
  for (const r of rows) {
    const novoInicio = precisaConverter(r.data_hora_inicio) ? isoBRT(r.data_hora_inicio) : r.data_hora_inicio
    const novoFim    = precisaConverter(r.data_hora_fim)    ? isoBRT(r.data_hora_fim)    : r.data_hora_fim
    if (novoInicio !== r.data_hora_inicio || novoFim !== r.data_hora_fim) {
      console.log(`#${r.id}: ${r.data_hora_inicio} -> ${novoInicio} | ${r.data_hora_fim} -> ${novoFim}`)
      n++
      if (!DRY) upd.run(novoInicio, novoFim, r.id)
    }
  }
})
tx()
console.log(`${DRY ? '[DRY-RUN] ' : ''}${n} registro(s) ${DRY ? 'seriam' : 'foram'} convertidos.`)
db.close()

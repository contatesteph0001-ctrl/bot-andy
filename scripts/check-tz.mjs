import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chatbot.db')

const dia = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const db = new Database(DB_PATH)

const rows = db.prepare(
  `SELECT id, staff_id, data_hora_inicio, data_hora_fim
   FROM agendamentos
   WHERE date(data_hora_inicio, '-03:00') = ?
   ORDER BY data_hora_inicio`
).all(dia)

console.log(`Agendamentos em ${dia}:`)
console.table(rows)

const comZ = db.prepare(
  `SELECT count(*) AS c FROM agendamentos
   WHERE data_hora_inicio NOT LIKE '%-03:00' OR data_hora_fim NOT LIKE '%-03:00'`
).get()
console.log(`Registros NÃO em -03:00 (legado em Z): ${comZ.c}`)

db.close()

/**
 * Sincroniza barbeiros.nome ← usuarios.nome para cada slot ativo.
 * Corrige resíduos (ex.: "Douglas" em barbeiros.nome desatualizado).
 *
 * Uso:
 *   node scripts/fix-sync-nome-barbeiros.mjs --dry
 *   node scripts/fix-sync-nome-barbeiros.mjs
 *   DB_PATH=/app/data/chatbot.db node scripts/fix-sync-nome-barbeiros.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, getDbPath } from '../src/db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DRY = process.argv.includes('--dry')

const SLOTS = ['barbeiro1', 'barbeiro2', 'barbeiro3']

function main() {
  const db = getDb()
  console.log(`[fix-sync-nome-barbeiros] DB: ${getDbPath()}`)
  if (DRY) console.log('[fix-sync-nome-barbeiros] Modo dry-run — nenhum UPDATE será aplicado')

  const selectUsuario = db.prepare(`
    SELECT nome FROM usuarios
    WHERE staff_id = ? AND ativo = 1
    LIMIT 1
  `)
  const selectBarbeiro = db.prepare(`
    SELECT nome FROM barbeiros WHERE id = ?
  `)
  const updateBarbeiro = db.prepare(`
    UPDATE barbeiros SET nome = ?, updated_at = datetime('now') WHERE id = ?
  `)

  let alterados = 0

  for (const staffId of SLOTS) {
    const usuario = selectUsuario.get(staffId)
    const barbeiro = selectBarbeiro.get(staffId)

    if (!usuario?.nome) {
      console.warn(`[fix-sync-nome-barbeiros] SKIP ${staffId}: sem usuarios.nome ativo`)
      continue
    }
    if (!barbeiro) {
      console.warn(`[fix-sync-nome-barbeiros] SKIP ${staffId}: registro em barbeiros não encontrado`)
      continue
    }

    const nomeAntigo = barbeiro.nome ?? '(null)'
    const nomeNovo = usuario.nome

    if (nomeAntigo === nomeNovo) {
      console.log(`[fix-sync-nome-barbeiros] OK ${staffId}: já sincronizado ("${nomeNovo}")`)
      continue
    }

    console.log(`[fix-sync-nome-barbeiros] ${staffId}: "${nomeAntigo}" → "${nomeNovo}"`)

    if (!DRY) {
      updateBarbeiro.run(nomeNovo, staffId)
      alterados += 1
    }
  }

  console.log(
    `${DRY ? '[DRY-RUN] ' : ''}Concluído. ${alterados} registro(s) atualizado(s) em barbeiros.nome.`,
  )
}

main()

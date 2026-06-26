#!/usr/bin/env node
// Reset de senha dos usuários do painel.
// Uso:
//   node scripts/reset-senha.mjs                      -> reseta TODOS para a senha padrão
//   node scripts/reset-senha.mjs andy NovaSenha#2026   -> reseta só o usuário 'andy'
//   node scripts/reset-senha.mjs --senha NovaSenha#2026 -> reseta TODOS com senha custom
//
// DB_PATH é respeitado (em produção/Railway: /app/data/chatbot.db).

import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chatbot.db')

const SENHA_PADRAO = 'Trocar@2026'

// Parse de argumentos
const args = process.argv.slice(2)
let alvoUsername = null
let novaSenha = SENHA_PADRAO

if (args[0] === '--senha') {
  novaSenha = args[1] || SENHA_PADRAO
} else if (args[0]) {
  alvoUsername = args[0].trim().toLowerCase()
  if (args[1]) novaSenha = args[1]
}

const db = new Database(DB_PATH)
const hash = bcrypt.hashSync(novaSenha, 10)

let result
if (alvoUsername) {
  result = db
    .prepare(`UPDATE usuarios SET senha_hash = ? WHERE username = ? AND ativo = 1`)
    .run(hash, alvoUsername)
  if (result.changes === 0) {
    console.error(`Nenhum usuário ativo encontrado com username = "${alvoUsername}"`)
    process.exit(1)
  }
  console.log(`Senha redefinida para "${alvoUsername}".`)
} else {
  result = db.prepare(`UPDATE usuarios SET senha_hash = ? WHERE ativo = 1`).run(hash)
  console.log(`Senha redefinida para ${result.changes} usuário(s) ativo(s).`)
}

console.log(`Nova senha: ${novaSenha}`)
console.log('Confirme o login e troque a senha em seguida.')
db.close()

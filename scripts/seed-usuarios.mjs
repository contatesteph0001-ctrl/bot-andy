/**
 * Seed de usuários do painel (login por username).
 * Edite SENHAS abaixo antes de rodar. Não commite senhas reais.
 *
 * Uso:
 *   node scripts/seed-usuarios.mjs --dry
 *   node scripts/seed-usuarios.mjs
 *   DB_PATH=/app/data/chatbot.db node scripts/seed-usuarios.mjs
 */
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chatbot.db')
const DRY = process.argv.includes('--dry')

// username, papel, staff_id, nome, senha (placeholder — TROCAR)
const USUARIOS = [
  { username: 'andy',     papel: 'admin',    staff_id: null,        nome: 'Andy',     senha: 'AndyAdmin#2026forte' },
  { username: 'recepcao', papel: 'recepcao', staff_id: null,        nome: 'Recepção', senha: 'Recepcao#balneario26' },
  { username: 'barbeiro1', papel: 'barbeiro', staff_id: 'barbeiro1', nome: 'Michael',  senha: 'Michael#corte2026' },
  { username: 'barbeiro2', papel: 'barbeiro', staff_id: 'barbeiro2', nome: 'Gabriel',  senha: 'Gabriel#corte2026' },
  { username: 'barbeiro3', papel: 'barbeiro', staff_id: 'barbeiro3', nome: 'Douglas',  senha: 'Douglas#corte2026' },
]

const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    papel TEXT NOT NULL,
    staff_id TEXT,
    nome TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

const upsert = db.prepare(`
  INSERT INTO usuarios (username, senha_hash, papel, staff_id, nome, ativo)
  VALUES (@username, @senha_hash, @papel, @staff_id, @nome, 1)
  ON CONFLICT(username) DO UPDATE SET
    senha_hash = excluded.senha_hash,
    papel = excluded.papel,
    staff_id = excluded.staff_id,
    nome = excluded.nome,
    ativo = 1
`)

const tx = db.transaction(() => {
  for (const u of USUARIOS) {
    if (u.senha.startsWith('TROCAR_')) {
      console.warn(`[seed-usuarios] AVISO: senha placeholder em ${u.username} — edite o script antes de produção`)
    }
    const senha_hash = bcrypt.hashSync(u.senha, 10)
    if (!DRY) {
      upsert.run({
        username: u.username,
        senha_hash,
        papel: u.papel,
        staff_id: u.staff_id,
        nome: u.nome,
      })
    }
    console.log(`[seed-usuarios] ${DRY ? '[DRY] ' : ''}OK: ${u.username} (${u.papel}${u.staff_id ? ` / ${u.staff_id}` : ''})`)
  }
})

tx()
console.log(`${DRY ? '[DRY-RUN] ' : ''}Seed concluído. Usernames: ${USUARIOS.map((u) => u.username).join(', ')}`)
db.close()

import 'dotenv/config'
import { existsSync, rmSync, readdirSync, lstatSync, mkdirSync } from 'fs'
import { services, products } from './src/config.mjs'
import { initDb } from './src/db.mjs'
import { log, error as logError } from './src/logger.mjs'
import { createExpressApp, startHttpServer, startWhatsApp } from './src/whatsapp.mjs'
import { initReminders } from './src/reminders.mjs'

const RECONNECT_DELAY_MS = 15_000
const SESSION = process.env.WPP_SESSION || 'andy-prod'

// Garante que o diretório base de tokens exista antes de qualquer operação.
// Necessário em volume Railway recém-criado (/app/data/tokens ainda vazio),
// para que a limpeza de lock e o WPPConnect não falhem por path inexistente.
function garantirDiretorioTokens() {
  const baseDir = process.env.WPP_USER_DATA_DIR || `/app/tokens/${SESSION}`
  try {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true })
      log(`📁 Diretório de tokens criado: ${baseDir}`)
    }
  } catch (err) {
    logError(`Falha ao criar diretório de tokens ${baseDir}:`, err.message)
  }
}

// Remove lock files do Chromium que ficam presos entre deploys.
// No Linux, SingletonLock/Cookie/Socket são SYMLINKS apontando para o hostname
// do container anterior. existsSync() retorna false para symlink quebrado, por
// isso usamos lstatSync (que enxerga o symlink em si, não o alvo) para detectar
// e remover incondicionalmente.
function limparLockChromium() {
  const baseDir = process.env.WPP_USER_DATA_DIR || `/app/tokens/${SESSION}`
  const locks = [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'DevToolsActivePort',
  ]
  for (const nome of locks) {
    const f = `${baseDir}/${nome}`
    try {
      // lstatSync lança se não existir NADA (nem symlink quebrado).
      // Se chegou aqui, existe algo (arquivo ou symlink) — remove.
      lstatSync(f)
      rmSync(f, { force: true, recursive: true })
      log(`🔓 Lock removido: ${f}`)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log(`⚠️ Falha ao remover lock ${f}: ${err.message}`)
      }
      // ENOENT = não existe, ignora silenciosamente
    }
  }
}

// DIAGNÓSTICO TEMPORÁRIO — remover após confirmar o caminho
function diagnosticarVolume() {
  const caminhos = [
    '/app/tokens',
    '/app/data',
    '/var/lib/containers/railwayapp',
  ]
  for (const c of caminhos) {
    if (existsSync(c)) {
      try {
        log(`📁 Existe: ${c} → ${JSON.stringify(readdirSync(c))}`)
      } catch (e) {
        log(`📁 Existe mas sem permissão: ${c}`)
      }
    } else {
      log(`❌ Não existe: ${c}`)
    }
  }
}

const MAX_CONNECT_ATTEMPTS = Number(process.env.MAX_CONNECT_ATTEMPTS || 5)

async function connectWhatsApp() {
  let tentativa = 0
  while (tentativa < MAX_CONNECT_ATTEMPTS) {
    tentativa++
    try {
      garantirDiretorioTokens()
      limparLockChromium()
      await startWhatsApp()
      log('WhatsApp conectado com sucesso.')
      return
    } catch (err) {
      logError(`Erro ao conectar WhatsApp (tentativa ${tentativa}/${MAX_CONNECT_ATTEMPTS}):`, err.message)
      if (tentativa >= MAX_CONNECT_ATTEMPTS) {
        logError('Limite de tentativas atingido. Encerrando processo para o Railway reiniciar o container limpo.')
        process.exit(1)
      }
      log(`Aguardando ${RECONNECT_DELAY_MS / 1000}s antes de reconectar...`)
      await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS))
    }
  }
}

async function main() {
  diagnosticarVolume()
  initDb({ services, products })
  const app = createExpressApp()
  startHttpServer()
  initReminders()
  await connectWhatsApp()
}

main()

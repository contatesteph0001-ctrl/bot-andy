import { google } from 'googleapis'
import readline from 'readline'
import 'dotenv/config'

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost'
)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar'],
  prompt: 'consent',
})

console.log('\n=== SETUP GOOGLE CALENDAR ===')
console.log('1. Abra esse link no navegador:\n')
console.log(authUrl)
console.log('\n2. Faça login com a conta Google da barbearia')
console.log('3. Autorize o acesso ao Google Calendar')
console.log('4. Copie o código exibido na tela\n')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.question('Cole o código aqui: ', async (code) => {
  rl.close()
  try {
    const { tokens } = await oauth2Client.getToken(code.trim())
    console.log('\n✅ SUCESSO! Adicione ao .env:\n')
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log('\nEsse token não expira. Guarde-o com segurança.')
  } catch (err) {
    console.error('❌ Erro:', err.message)
  }
})

import bcrypt from 'bcryptjs'

export function verificarSenha(plana, hash) {
  if (!plana || !hash) return false
  return bcrypt.compareSync(plana, hash)
}

export function currentUser(req) {
  return req.session?.user ?? null
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.redirect('/login')
  }
  next()
}

export function requireRole(...papeis) {
  return (req, res, next) => {
    const user = req.session?.user
    if (!user) return res.redirect('/login')
    if (!papeis.includes(user.papel)) {
      return res.status(403).send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Acesso negado</title></head><body style="font-family:sans-serif;background:#0a0a0a;color:#fafafa;padding:2rem"><h1>403 — Acesso negado</h1><p>Você não tem permissão para esta área.</p><p><a href="/login" style="color:#d4a853">Voltar ao login</a></p></body></html>`)
    }
    next()
  }
}

/** Redirect após login conforme papel. */
export function redirectPosLogin(papel) {
  if (papel === 'admin') return '/admin/kanban'
  if (papel === 'recepcao') return '/recepcao/kanban'
  if (papel === 'barbeiro') return '/barbeiro'
  return '/login'
}

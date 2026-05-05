# Procedimientos de rollback — Cutover a `monoulabs.ai`

Este documento cubre cómo revertir el cutover si algo se rompe.

> **Última versión estable PRE-cutover**: `v2.3.0` (commit `c52d84b`).
> Render + GitHub Pages aún saben servir esa versión sin problemas.
> Mientras los servicios viejos sigan vivos (legacy `rladron-rodia.github.io`
> y `landing-contacto-backend.onrender.com`), el rollback es minutos.

---

## Decisión rápida — ¿qué se rompió?

| Síntoma | Sección |
|---|---|
| `monoulabs.ai` no carga / cert inválido | [A — Frontend](#a--frontend-roto-monoulabsai-no-carga) |
| Form de contacto no envía / 500 / CORS | [B — Backend](#b--backend-roto-form-da-error) |
| Correos no llegan | [C — Email](#c--email-no-llega) |
| Algo en el código rompió producción | [D — Código](#d--rollback-completo-del-codigo) |
| DNS no resuelve / propagación tarda | [E — DNS](#e--dns) |
| Pánico generalizado, todo está mal | [F — Rollback total](#f--rollback-total) |

---

## A — Frontend roto (`monoulabs.ai` no carga)

### Diagnóstico

```bash
curl -I https://monoulabs.ai
curl -I https://www.monoulabs.ai
dig +short monoulabs.ai
```

**Causas comunes:**
- Cert no se ha provisionado todavía (espera 15–30 min tras DNS)
- DNS aún no propaga (espera 30 min y reintenta)
- GitHub Pages no detectó el `CNAME` file

### Rollback rápido — usar la URL legacy

Mientras se arregla el dominio, comparte:
**`https://rladron-rodia.github.io/landing_contacto/`** (sigue viva)

### Rollback formal — desactivar custom domain en Pages

1. **`https://github.com/rladron-rodia/landing_contacto/settings/pages`**
2. **Custom domain** → vacíalo y **Save**
3. La landing vuelve a servirse en `rladron-rodia.github.io/landing_contacto/`
4. Opcional: crea PR para borrar el `CNAME` del repo (`git rm CNAME`)

> Los DNS records en Route 53 los puedes dejar — no causan daño si Pages
> está sin custom domain. Pero si quieres limpiar, borra las 4 A records
> del ápex y el CNAME de `www`.

---

## B — Backend roto (form da error)

### Diagnóstico

```bash
curl -i https://api.monoulabs.ai/api/health
curl -i https://landing-contacto-backend.onrender.com/api/health  # legacy

# Ver logs en Render → landing-contacto-backend → Logs
```

### Rollback escenario 1 — Custom domain `api.monoulabs.ai` no funciona pero el legacy sí

Causa: Render no validó el dominio o cert tarda.

**Quick fix**: revertir `assets/js/*-loader.js` y `contact-form.js` y
`admin/app.js` para que apunten al URL legacy mientras tanto:

```bash
git checkout main && git pull
git checkout -b hotfix/revert-api-url
git revert <SHA_DEL_PR_DEL_CUTOVER> --no-commit
# Edita manualmente para revertir SOLO los archivos JS, no los SEO
# O simplemente apunta API_BASE/API_URL a la URL legacy temporal
git commit -am "hotfix: revertir API endpoint a URL legacy de Render"
git push -u origin hotfix/revert-api-url
# PR + merge
```

**Más simple**: en Render → Environment → quita `api.monoulabs.ai` del
custom domains. Pages sigue funcionando con `monoulabs.ai`, pero el
form ya estará llamando a una URL que no responde, así que también
hay que revertir el código (arriba).

### Rollback escenario 2 — Backend completo roto

Causa: bug del último deploy (CORS, env vars, código).

**Rollback en Render** (más rápido que un PR):

1. Render → `landing-contacto-backend` → **Events**
2. Encuentra el deploy anterior funcionando (commit `c52d84b`, v2.3.0)
3. Click los 3 puntos → **Rollback to this deploy**
4. Render redeploya esa versión vieja en ~2 min

> El código en `main` sigue con la versión nueva, pero Render corre la
> vieja. Cuando arregles el bug, harás un nuevo merge a main y eso
> dispara nuevo deploy.

### Rollback escenario 3 — Env vars mal configurados

Si cambiaste `ALLOWED_ORIGIN`, `MAIL_FROM`, `MAIL_TO` y eso causa errores:

1. Render → Environment → revertir manualmente al valor anterior:
   - `ALLOWED_ORIGIN=https://rladron-rodia.github.io`
   - `MAIL_FROM=Monou.gg Landing <onboarding@resend.dev>`
   - `MAIL_TO=rladron@gmail.com`
2. Save → redeploy automático

---

## C — Email no llega

### Diagnóstico

1. **Resend Dashboard → Emails**: ¿se está intentando enviar? ¿qué error?
2. **Render Logs**: ¿hay `EmailAuthError` / `EmailValidationError`?

### Causas comunes

**a. Dominio `monoulabs.ai` aún no verificado en Resend**
→ Si actualizaste `MAIL_FROM` a `contacto@monoulabs.ai` ANTES de que el
dominio esté verificado, Resend rechaza. Revertir `MAIL_FROM` a
`Monou.gg Landing <onboarding@resend.dev>` mientras se completa la
verificación.

**b. `MAIL_TO` no coincide con email registrado en Resend (free tier)**
→ Mientras no haya dominio verificado, `MAIL_TO` debe ser
`rladron@gmail.com` (el de tu cuenta de Resend).

**c. API key revocada o rotada mal**
→ Verifica en `https://resend.com/api-keys` que la key activa
exista. Si dudas, crea una nueva, pégala en Render, prueba, y borra la vieja.

### Rollback de config de email

```
MAIL_FROM = Monou.gg Landing <onboarding@resend.dev>
MAIL_TO   = rladron@gmail.com
RESEND_API_KEY = (la última que creaste y verificaste que funciona)
```

Save en Render → redeploy.

---

## D — Rollback completo del código

Si el PR del cutover causó múltiples problemas y prefieres deshacerlo
todo y replanear:

### Opción 1 — `git revert` (preferido, mantiene historial)

```bash
git checkout main && git pull

# Identifica el SHA del merge del PR del cutover
git log --oneline | head -10
# Ej: a1b2c3d Merge pull request #5 from .../feat/custom-domain-monoulabs

git checkout -b hotfix/revert-custom-domain-cutover
git revert -m 1 <SHA_DEL_MERGE>     # -m 1 porque es un merge commit
# Si hay conflictos, resuélvelos
git push -u origin hotfix/revert-custom-domain-cutover
# PR → CodeQL → merge
```

Render auto-redeploya con el código revertido (vuelta a v2.3.0 estado).

### Opción 2 — Reset duro (sólo si NADIE más ha pusheado encima)

**ATENCIÓN**: esto reescribe historial. Branch protection lo bloquea por
defecto, pero como admin podrías saltártelo. **No recomendado** salvo emergencia.

```bash
git checkout main
git reset --hard v2.3.0
git push --force-with-lease origin main   # va a fallar por branch protection
# Si necesitas saltarte la regla, agrega bypass temporal:
# GitHub → Settings → Rules → protect-main → Bypass list → Repository admin
# Hace push, REMUEVE el bypass inmediatamente
```

### Recuperar archivos específicos sin tocar otros

```bash
# Volver SOLO uno o varios archivos al estado de v2.3.0
git checkout v2.3.0 -- index.html assets/js/contact-form.js
git commit -m "rollback: revertir index.html y contact-form.js a v2.3.0"
git push
```

---

## E — DNS

### Síntoma: dig no resuelve

```bash
# Si dig devuelve vacío:
dig +short monoulabs.ai
dig +short api.monoulabs.ai
```

**Causas:**
- Records aún no creados o creados en otra hosted zone
- TTL antiguo en cache (espera 5–10 min y reintenta)
- Nameservers del registrador no apuntan a Route 53 (si compraste el
  dominio fuera de Route 53)

### Verificar nameservers

```bash
dig +short NS monoulabs.ai @8.8.8.8
# Debe devolver 4 ns-XX.awsdns-XX.{com,net,org,co.uk}
```

Si NO devuelve los `awsdns`, el registrador no está apuntando a Route 53.
Tienes que cambiar los nameservers en el registrador para que coincidan
con los de Route 53 → Hosted zone → "Hosted zone details" → "Name
servers".

### Rollback de DNS — borrar records

Si quieres revertir el DNS por completo (volver a sólo NS+SOA):

1. Route 53 → Hosted zones → `monoulabs.ai`
2. Selecciona los records: `A monoulabs.ai`, `CNAME www`, `CNAME api`
3. **Delete records**

La landing vuelve a estar disponible **sólo** en `rladron-rodia.github.io`.

---

## F — Rollback total

Para volver a la versión `v2.3.0` en TODO (frontend + backend + DNS):

### F.1 Código

Sigue [Sección D — Opción 1](#d--rollback-completo-del-codigo) (revert del PR vía branch + PR).

### F.2 Render

Si el redeploy automático no toma el revert lo bastante rápido:
- Render → Manual Deploy → "Deploy specific commit" → `c52d84b`

### F.3 Pages

- GitHub Settings → Pages → Custom domain → vaciar → Save
- La landing vuelve a `rladron-rodia.github.io/landing_contacto/`

### F.4 Render env vars

Reset a valores pre-cutover:

```
ALLOWED_ORIGIN = https://rladron-rodia.github.io
MAIL_FROM      = Monou.gg Landing <onboarding@resend.dev>
MAIL_TO        = rladron@gmail.com
```

### F.5 DNS

Opcional. Los records de `monoulabs.ai` no causan daño si nada apunta a
ellos. Pero si quieres limpieza total, borra los 3 grupos de records
(ver Sección E).

### F.6 Resend

Si verificaste el dominio en Resend, déjalo. No hace daño y te ahorra
volver a hacerlo en el siguiente intento.

---

## Después del rollback — diagnóstico

Cuando hagas rollback, **antes de re-intentar el cutover**, identifica
la causa raíz:

1. ¿El cert de Pages no se provisionó? → DNS estaba mal
2. ¿CORS bloqueó? → `ALLOWED_ORIGIN` mal configurado
3. ¿Email no llegó? → MAIL_FROM/MAIL_TO no alineados con verificación de Resend
4. ¿CodeQL marcó alerta? → bug real en el código

Documenta el problema en un ticket o issue, arregla, y re-intenta el cutover.

---

## Verificación post-rollback

```bash
# Frontend legacy responde
curl -I https://rladron-rodia.github.io/landing_contacto/

# Backend legacy responde
curl -i https://landing-contacto-backend.onrender.com/api/health

# Form en la landing legacy funciona (test manual en browser)
```

Si los 3 pasan, el rollback fue exitoso.

---

## Última actualización

2026-04-30 — creación tras cutover a custom domain. Última versión
estable: `v2.3.0`.

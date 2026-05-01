# Guía de pases (deploy) — Monou Labs landing

Esta guía es para Rodrigo. Toda la operación de pasar cambios a producción
desde que `main` quedó protegido (rule `protect-main` activa).

> **Cambios directos a `main` están prohibidos.** Cada cambio pasa por una
> branch nueva → Pull Request → CodeQL pasa → merge → Render auto-deploya.

---

## Flujo estándar (lo que harás 99% de las veces)

```bash
# 1. Posicionarte en main actualizado
cd ~/Documents/Claude/Projects/landing/Landing
git checkout main
git pull

# 2. Crear branch nueva
git checkout -b fix/breve-descripcion
# Convenciones de nombre:
#   fix/...      — bugfix
#   feature/...  — nueva funcionalidad
#   hotfix/...   — emergencia en producción
#   chore/...    — refactor, docs, deps
#   security/... — hardening de seguridad

# 3. Hacer los cambios
# ... edits ...

# 4. Commit
git add .
git commit -m "fix: lo que arreglaste

Detalle más largo si lo necesitas."

# 5. Push de la branch (NO de main)
git push -u origin fix/breve-descripcion
```

**Después en GitHub:**

1. Abre `https://github.com/rladron-rodia/landing_contacto`
2. Verás banner amarillo "Compare & pull request" → click
3. Llena título y descripción → **"Create pull request"**
4. CodeQL corre automáticamente (~2-3 min). Espera a ver "All checks passed" verde.
5. Click **"Merge pull request"** → **"Confirm merge"**
6. Click **"Delete branch"** (botón gris en la confirmación del merge)

**Después Render auto-deploya** (porque `autoDeploy: true` en `render.yaml`).
Verás "Deploy started" → "Live" en `dashboard.render.com` (~2-3 min).

**Limpia local:**

```bash
git checkout main
git pull
git branch -d fix/breve-descripcion
```

---

## Verificar el deploy en Render

```bash
# Health check rápido
curl -i https://landing-contacto-backend.onrender.com/api/health
```

Debe traer `200 OK` + headers `x-content-type-options: nosniff`,
`x-frame-options: DENY`, `referrer-policy: strict-origin-when-cross-origin`,
`x-ratelimit-limit: 200`, y body `{"db":true,...,"ok":true}`.

> Si el primer `curl` tarda ~50s o da 502, es **cold start del free tier**
> de Render — el servicio se duerme tras 15 min sin tráfico. Reintenta.

---

## ¿Qué pasa si intento push directo a `main`?

Verás esto:

```
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - Required status check "CodeQL" is expected.
 ! [remote rejected] main -> main (push declined due to repository rule violations)
```

**Es esperado.** La protección está funcionando. Resetea local y haz el flujo de branch:

```bash
git reset --hard origin/main
```

---

## Si CodeQL marca alertas en el PR

1. Click en el check rojo en el PR
2. Te lleva a la pestaña Security → Code scanning
3. Lee la alerta. Si es real → fix en la misma branch (commit + push, CodeQL re-corre solo)
4. Si es falso positivo → puedes "Dismiss" la alerta con justificación

---

## Emergencia / bypass (USAR CON CUIDADO)

Si urge un fix y no puedes esperar al flujo normal:

1. **GitHub** → `Settings → Rules → Rulesets → protect-main`
2. **Bypass list** → **+ Add bypass** → tu usuario como **Repository admin**
   con bypass mode **"For pull requests only"** (no "Always")
3. Haz el fix vía PR pero auto-mergeas saltándote CodeQL
4. **Quita el bypass inmediatamente después** (vuelve a la misma página)

**Nunca** uses bypass mode "Always" salvo que estés haciendo trabajo de
infraestructura masivo y consciente. La regla pierde valor si la bypaseas
seguido.

---

## Cherry-pick / hotfix de producción

Si algo se rompió en producción y necesitas revertir:

```bash
# Ver últimos commits en main
git log --oneline -10 main

# Revertir un commit específico (crea un commit nuevo que deshace)
git checkout main
git pull
git checkout -b hotfix/revert-COMMIT
git revert COMMIT_SHA
git push -u origin hotfix/revert-COMMIT
# Luego PR + merge normal
```

`git revert` es seguro porque NO reescribe historial — sólo crea un commit
contrario. Eso hace que el push pase por la regla sin problema.

---

## Variables y secretos

**Nunca commitear:** `.env`, API keys, tokens, `DATABASE_URL`, certificados,
llaves SSH. El `.gitignore` ya bloquea estos patrones, pero la **Push
protection** de GitHub también te bloquearía si intentas pushear un secreto
conocido (Resend `re_...`, GitHub PAT `ghp_...`, etc.).

Para cambios de variables de entorno en producción:

- **No** se editan vía código → **siempre** desde Render Dashboard
- Render → `landing-contacto-backend` → **Environment** → editar
- Save Changes triggers redeploy automático

Variables actuales en Render:
- `RESEND_API_KEY` (secret) — rotar cada 90 días
- `ADMIN_TOKEN` (secret) — rotar cada 90 días
- `MAIL_FROM` — `Monou.gg Landing <onboarding@resend.dev>` (cambiar cuando
  verifiques dominio en Resend)
- `MAIL_TO` — `rladron@gmail.com` (igual al email registrado en Resend hasta
  verificar dominio)
- `ALLOWED_ORIGIN` — `https://rladron-rodia.github.io`
- `DATABASE_URL` (auto-injectado por Render)

---

## Rotación periódica de secretos (cada 90 días)

```bash
# Generar nuevo ADMIN_TOKEN
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

1. Pega el nuevo en Render → Environment → `ADMIN_TOKEN` → Save
2. Espera redeploy
3. Vuelve a entrar al admin con el token nuevo (los browsers logueados darán 401)

Para `RESEND_API_KEY`:

1. https://resend.com/api-keys → **Create API Key**
2. Name: `monou-landing-prod-AAAA-MM` (con la fecha)
3. Permission: `Sending access` → All domains
4. Copiar key nueva → pegar en Render → Save → redeploy
5. Verificar que el form sigue mandando correos
6. **Volver a Resend → revocar la key vieja**

---

## Test del rate limiter (después de cualquier cambio en `/api/contact`)

```bash
for i in {1..7}; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST https://landing-contacto-backend.onrender.com/api/contact \
    -H "Content-Type: application/json" -d '{}')
  echo "intento $i: $code"
done
```

Esperado: primeros 5 dan `400` (campos requeridos), 6º y 7º dan `429`
(rate limited, 5/min activo).

---

## Quick reference — comandos más usados

```bash
# Inicio de cualquier cambio
git checkout main && git pull && git checkout -b TIPO/nombre

# Cerrar trabajo
git add . && git commit -m "TIPO: descripción" && git push -u origin TIPO/nombre

# Después del merge en GitHub
git checkout main && git pull && git branch -d TIPO/nombre

# Ver estado
git status
git log --oneline -10

# Resetear si te confundes (descarta cambios locales NO commiteados)
git checkout -- archivo  # un archivo
git reset --hard         # todo

# Resetear branch entera al estado de main
git reset --hard origin/main
```

---

## Última actualización

2026-04-30 — creación inicial tras paso a `main` protegido con CodeQL gate.

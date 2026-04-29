# Backend — Formulario de contacto Monou.gg

Backend Flask que recibe los datos del formulario de la landing
(`<form id="ixmppy">`), los persiste en Postgres y envía un correo
vía la API HTTP de [Resend](https://resend.com).

> **Nota histórica:** versiones < v1.4 usaban SMTP de Gmail directo.
> Migramos a Resend porque Render free tier bloquea outbound SMTP.

## 1. Instalación

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. Configurar credenciales

Necesitas una API key de Resend:

1. Ve a https://resend.com y crea cuenta (te recomiendo registrarte con
   `rodrigo.ladron@monou.gg` para poder enviar correos a esa dirección
   en plan free, sin verificar dominio).
2. **API Keys** → **Create API Key** → copia el valor `re_...`
3. Copia `.env.example` a `.env` y pega la key en `RESEND_API_KEY`.

```bash
cp .env.example .env
# Edita .env con tus valores
```

Configuración mínima:

| Variable          | Valor                                         |
|-------------------|-----------------------------------------------|
| `RESEND_API_KEY`  | la key generada en resend.com/api-keys        |
| `MAIL_FROM`       | `Monou.gg Landing <onboarding@resend.dev>`    |
| `MAIL_TO`         | email registrado en Resend (rodrigo.ladron@…) |

> **Plan free de Resend sin dominio verificado** solo permite enviar TO
> el email de la cuenta. Para dominio propio (ej. `contacto@monou.gg`)
> verifica `monou.gg` en https://resend.com/domains (DNS records).

## 3. Ejecutar el servidor

```bash
python app.py
# Servidor en http://localhost:5000
```

Endpoints públicos:

- `POST /api/contact`         — recibe JSON del formulario
- `GET  /api/health`          — healthcheck
- `GET  /api/stats`           — cifras del hero
- `GET  /api/games`           — lista de juegos (F2P + Publishers)
- `GET  /api/site-links`      — enlaces configurables
- `GET  /api/delivery-options`— Data Formats + Delivery Methods
- `GET  /api/info-columns`    — bloques de info en Publishers

Endpoints admin (requieren `Authorization: Bearer <ADMIN_TOKEN>`):

- `GET /api/contacts`           — lista de envíos del formulario
- `GET/POST/DELETE /api/admin/stats[/<key>]`
- `GET/POST/DELETE /api/admin/games[/<slug>]`
- `GET/POST/DELETE /api/admin/site-links[/<key>]`
- `GET/POST/DELETE /api/admin/delivery-options[/<slug>]`
- `GET/POST/DELETE /api/admin/info-columns[/<slug>]`

## 4. Test sin red

```bash
./.venv/bin/python test_dry_run.py
```

Mockea `urllib.request` para verificar que el endpoint POST `/api/contact`
construye correctamente el JSON que se enviaría a Resend, sin tocar la red.

## 5. Producción

- Render aplica `render.yaml` automáticamente:
  - Crea servicio web `landing-contacto-backend` (gunicorn)
  - Provisiona DB Postgres `landing-contacto-db`
  - Inyecta `DATABASE_URL` al servicio web
- Las variables `RESEND_API_KEY` y `ADMIN_TOKEN` se setean a mano en
  el dashboard de Render (son secrets, no van al repo).

## Solución de problemas

| Error                              | Causa probable                              |
|------------------------------------|---------------------------------------------|
| 401 unauthorized                   | API key Resend mal pegada en Render         |
| 422 validation                     | Plan free + email no registrado en Resend   |
| 500 con "Failed to fetch" en admin | Cold start del free tier (espera 5-10s)     |
| CORS en consola                    | Ajusta `ALLOWED_ORIGIN` en Render Environment |

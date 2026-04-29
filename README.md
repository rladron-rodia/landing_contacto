# Monou.gg — Landing de Desarrolladores

Landing page para Monou.gg con formulario de contacto que envía correos
vía la API HTTP de Resend, persiste contactos en Postgres y tiene un
dashboard admin para administrar todos los textos, imágenes y enlaces
del sitio sin tocar código.

URLs en producción:
- **Landing**: https://rladron-rodia.github.io/landing_contacto/
- **Admin**:   https://rladron-rodia.github.io/landing_contacto/admin/
- **API**:     https://landing-contacto-backend.onrender.com

## Estructura

```
.
├── index.html                         # Landing pública
├── admin/
│   ├── index.html                     # Dashboard admin (sidebar + vistas)
│   └── app.js                         # Lógica del admin (CRUD + nav)
├── server/
│   ├── app.py                         # Backend Flask (endpoints REST)
│   ├── db.py                          # Persistencia Postgres + seeds
│   ├── contact-form.js                # Wiring del form de la landing
│   ├── stats-loader.js                # Cifras dinámicas (10k+, 2.5M, 50+, etc.)
│   ├── games-loader.js                # Carrusel F2P + Publishers
│   ├── links-loader.js                # CTAs y enlaces configurables
│   ├── delivery-loader.js             # Data Formats + Delivery Methods
│   ├── info-columns-loader.js         # Bloques de info en Publishers
│   ├── test_dry_run.py                # Test sin red (mockea Resend)
│   ├── requirements.txt               # Flask + psycopg + gunicorn
│   ├── .env.example                   # Plantilla de variables
│   └── README.md                      # Setup detallado del backend
├── render.yaml                        # Blueprint para Render
├── DEPLOY.md                          # Guía de despliegue
└── CONTRIBUTING.md                    # Workflow de PRs y branches
```

## Quick start (local)

### Frontend

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

### Backend

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # rellena RESEND_API_KEY
python app.py         # http://localhost:5000
```

Detalles en [`server/README.md`](server/README.md).

## Stack

| Capa | Tecnología |
|---|---|
| Hosting frontend | GitHub Pages |
| Hosting backend  | Render (Flask + gunicorn, free tier) |
| Base de datos    | Postgres en Render |
| Email            | [Resend](https://resend.com) (HTTP API) |
| Estilos          | Tailwind CSS (CDN) |
| Iconos           | FontAwesome 6 |

## Workflow

`main` siempre representa producción. Cualquier merge dispara redespliegue
automático. Cambios viven en ramas `feature/`, `fix/` o `chore/` con PR.

Detalles en [CONTRIBUTING.md](CONTRIBUTING.md).

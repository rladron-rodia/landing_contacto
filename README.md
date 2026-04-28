# Monou.gg — Landing de Desarrolladores

Landing page para Monou.gg con formulario de contacto que envía correos vía
SMTP de Gmail.

## Estructura

```
.
├── index.html                  # Landing page principal
├── server/
│   ├── app.py                  # Backend Flask (recibe formulario, envía SMTP)
│   ├── contact-form.js         # JS que conecta el form con el backend
│   ├── requirements.txt        # Dependencias Python
│   ├── .env.example            # Plantilla de variables de entorno
│   └── README.md               # Guía detallada del backend
└── README.md
```

## Quick start

### Frontend
Servir el HTML en local:

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

### Backend (formulario de contacto)

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # rellena SMTP_PASSWORD con tu App Password de Gmail
python app.py         # http://localhost:5000
```

Detalles en [`server/README.md`](server/README.md).

## Conectar el form al backend

En `index.html`, antes de `</body>`:

```html
<script>window.MONOU_API_URL = "http://localhost:5000/api/contact";</script>
<script src="server/contact-form.js" defer></script>
```

Y al `<form>` del frame `ixmppy` agrégale `id="ixmppy"` y los atributos
`name="..."` a cada campo (ver `server/README.md`).

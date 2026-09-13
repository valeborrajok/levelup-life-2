# LevelUp Life 🎮📈

PWA personal de productividad gamificada: convierte tareas de la vida real
(facultad, casa, hobbies) en misiones con recompensas de XP, Gold Coins,
y un árbol de habilidades por materia/carrera.

## Estado del proyecto

- [x] **Fase 1** — Estructura del proyecto, esquema de base de datos y semilla de datos.
- [x] **Fase 2** — Backend Flask (`app.py`) con endpoints REST.
- [x] **Fase 3** — Frontend (`index.html`, `style.css`, `app.js`) + PWA instalable.

## Estructura

```
levelup-life/
├── app.py              # App Flask + todas las rutas de la API REST + sirve el frontend
├── app_factory.py       # Fábrica de la app Flask (la comparten seed.py y app.py)
├── config.py             # Configuración: SECRET_KEY, URI de base de datos, huso horario
├── extensions.py         # Instancia compartida de SQLAlchemy
├── models.py              # Esquema: PlayerProfile, Quest, SkillTree, Branch, Node, RewardItem, PurchaseLog
├── services.py            # Lógica de negocio (reset de misiones, nodos, recursar, compras)
├── seed.py                # Crea las tablas y carga los datos iniciales
├── requirements.txt
├── Procfile                # Comando de arranque en Railway (gunicorn)
├── .env.example
├── .gitignore
├── templates/
│   └── index.html           # Vista única (SPA simple, sin build step)
├── static/
│   ├── css/style.css         # Estilos (modo oscuro RPG, mobile-first)
│   ├── js/
│   │   ├── app.js             # Controlador de interacción (fetch + DOM, sin frameworks)
│   │   └── sw.js               # Service worker — shell offline básico
│   ├── manifest.json           # Manifest para "Agregar a inicio"
│   └── icons/                   # Íconos de la PWA (192/512/maskable/apple-touch/favicon)
└── instance/                     # Se crea sola — acá vive levelup.db (ignorada por git)
```

## Cómo correrlo localmente

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # opcional para dev, pero recomendado
python seed.py                  # crea instance/levelup.db y la puebla
python app.py                   # http://localhost:5000
```

Para reiniciar la base de datos desde cero en cualquier momento (borra el progreso actual):

```bash
python seed.py --reset
```

## Instalarla como PWA

En iOS Safari: abrir la app → botón compartir → "Agregar a inicio". En
Chrome/Android o desktop: el navegador va a ofrecer instalarla solo (ícono
de instalación en la barra de direcciones), gracias a `manifest.json` +
`sw.js`. El service worker cachea el "shell" (HTML/CSS/JS/íconos) para que
la app abra aunque no haya conexión — nunca cachea `/api/*`, así que los
datos que muestra siempre están actualizados cuando hay internet.

## Nota sobre Railway y SQLite

El sistema de archivos de Railway es efímero por defecto: si el servicio se
reinicia o se redeploya sin un [Volume](https://docs.railway.app/reference/volumes)
montado en `instance/`, la base SQLite se pierde. Antes de deployar en serio,
conviene:

1. Adjuntar un Volume de Railway montado en `/app/instance`, **o**
2. Migrar `DATABASE_URL` a Postgres — el código ya está preparado para esto
   vía variable de entorno, sin tener que tocar `models.py`.

## Decisiones de diseño a confirmar con vos

1. **`real_money_balance` como `Integer`**: asumí pesos sin decimales, ya
   que todos los montos del enunciado son redondos ($20000, $4000, $30000).
2. **`Node.position` como `Float`**: permite insertar un "Recuperatorio"
   entre dos nodos calculando el punto medio (ej: entre 10 y 20 se inserta
   uno en 15), sin reordenar el resto de la rama.
3. **`Branch.times_reset`**: campo extra para llevar la cuenta de cuántas
   veces se "recursó" una rama.
4. **Categorías de misión como código corto** (`diaria`, `semanal`,
   `campana`, `meta`, `evento`) — el frontend traduce cada código a su
   nombre visible en español (`CATEGORY_LABELS` en `app.js`).
5. **Bonus nodes no bloquean la cadena**: completar un nodo bonus da su
   recompensa pero no desbloquea el siguiente nodo regular — eso solo lo
   hace completar un nodo regular o de recuperatorio.
6. **Sin "deshacer" completado**: ni en misiones ni en nodos. El XP se
   pidió como "acumulado para siempre", así que deshacer contradiría esa regla.
7. **Service worker con scope de raíz**: se sirve desde `/sw.js` (ruta
   dedicada en `app.py`, no `/static/js/sw.js`) para que controle toda la
   app y no solo la carpeta `static/`.

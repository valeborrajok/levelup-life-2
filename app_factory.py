"""
app_factory.py — Fábrica de la aplicación Flask.

Se comparte entre seed.py (Fase 1) y app.py (Fase 2) para que ambos
construyan la app exactamente de la misma manera (misma config, misma
instancia de SQLAlchemy), sin duplicar código ni generar imports
circulares.
"""
from flask import Flask

from config import Config
from extensions import db


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)

    # Fase 2 registrará acá los blueprints con las rutas de la API
    # (quests, skill-tree, shop, profile).

    return app

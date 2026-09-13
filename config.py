"""
config.py — Configuración de la aplicación.

Todos los valores sensibles se leen de variables de entorno (con defaults
razonables para desarrollo local). En Railway, definí SECRET_KEY como
variable de entorno del servicio.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")  # no falla si el archivo no existe

INSTANCE_DIR = BASE_DIR / "instance"
INSTANCE_DIR.mkdir(exist_ok=True)


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-cambiar-en-produccion")

    # Por defecto: SQLite local en instance/levelup.db.
    # En producción se puede sobrescribir con DATABASE_URL (ej: para migrar
    # a Postgres en el futuro sin tocar el resto del código).
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", f"sqlite:///{INSTANCE_DIR / 'levelup.db'}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Que las respuestas JSON de la API (Fase 2) mantengan el orden
    # en que se definen los campos, en vez de ordenarlas alfabéticamente.
    JSON_SORT_KEYS = False

    # Desplazamiento horario respecto a UTC usado para decidir cuándo
    # "es un nuevo día" o "es una nueva semana" al resetear las misiones
    # diarias/semanales. Buenos Aires es UTC-3 todo el año (no tiene
    # horario de verano), así que el default es -3. Se puede sobrescribir
    # con la variable de entorno TIMEZONE_OFFSET_HOURS si hiciera falta.
    TIMEZONE_OFFSET_HOURS = int(os.environ.get("TIMEZONE_OFFSET_HOURS", "-3"))

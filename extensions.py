"""
extensions.py — Instancias de extensiones compartidas.

Se define acá (y no directamente en app_factory.py) para evitar imports
circulares: models.py necesita 'db', y app_factory.py necesita tanto 'db'
como (eventualmente, en la Fase 2) los modelos.
"""
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

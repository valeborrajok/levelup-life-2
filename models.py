"""
models.py — Esquema de la base de datos de LevelUp Life.

Convenciones:
- Los campos internos (nombres de columnas, claves de categoría/estado)
  están en inglés/español técnico corto, para que el backend los pueda
  filtrar y comparar de forma robusta.
- Todo el TEXTO que ve el usuario (títulos, nombres de ítems, etc.) se
  carga en español desde seed.py — ver ese archivo para el detalle.

Jerarquía del árbol de habilidades (agregada en la ronda de fixes/features):
    Folder ("Universidad") -> SkillTree ("Lic. en Bioinformática")
        -> Branch ("Álgebra") -> Node ("Aprobar Parcial 1")
"""
import math
from datetime import datetime

from extensions import db


class PlayerProfile(db.Model):
    """Perfil único del jugador. La app es de un solo usuario: se espera
    una sola fila en esta tabla."""

    __tablename__ = "player_profile"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=True)
    avatar = db.Column(db.String(300), nullable=True)  # emoji corto o URL de imagen
    total_xp = db.Column(db.Integer, nullable=False, default=0)
    gold_coins = db.Column(db.Integer, nullable=False, default=0)
    real_money_balance = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @property
    def _level_info(self) -> dict:
        """
        Calcula todo el estado de nivel de una — si existe algún
        LevelConfig, esos umbrales reemplazan la fórmula matemática por
        completo. Si no hay ninguno, se usa la fórmula de siempre.

        El nivel 1 (índice 0) es siempre el piso: aunque el XP actual
        esté por debajo de TODOS los umbrales cargados, el perfil igual
        muestra el primer nivel configurado (nunca "nivel 0").
        """
        custom_levels = LevelConfig.query.order_by(LevelConfig.xp_threshold.asc()).all()

        if not custom_levels:
            level = math.floor(0.1 * math.sqrt(max(self.total_xp, 0))) + 1
            return {
                "level": level,
                "level_title": None,
                "level_image_url": None,
                "xp_for_current_level": 100 * (level - 1) ** 2,
                "xp_for_next_level": 100 * level**2,
                "is_max_level": False,
            }

        current_index = 0
        for i, cfg in enumerate(custom_levels):
            if self.total_xp >= cfg.xp_threshold:
                current_index = i
            else:
                break

        current = custom_levels[current_index]
        has_next = current_index + 1 < len(custom_levels)
        next_config = custom_levels[current_index + 1] if has_next else None

        return {
            "level": current_index + 1,
            "level_title": current.title,
            "level_image_url": current.image_url,
            "xp_for_current_level": current.xp_threshold,
            "xp_for_next_level": next_config.xp_threshold if next_config else current.xp_threshold,
            "is_max_level": not has_next,
        }

    def to_dict(self) -> dict:
        info = self._level_info
        return {
            "id": self.id,
            "name": self.name,
            "avatar": self.avatar,
            "total_xp": self.total_xp,
            "level": info["level"],
            "level_title": info["level_title"],
            "level_image_url": info["level_image_url"],
            "xp_for_current_level": info["xp_for_current_level"],
            "xp_for_next_level": info["xp_for_next_level"],
            "is_max_level": info["is_max_level"],
            "gold_coins": self.gold_coins,
            "real_money_balance": self.real_money_balance,
        }


class Quest(db.Model):
    """
    Misión / tarea.

    category ∈ CATEGORIES:
      - "diaria" / "semanal": tareas recurrentes. Se resetean automáticamente
        (lógica de reseteo en services.py, usando last_completed_at).
      - "campana" / "meta" / "evento": tareas de una sola vez, usan
        is_completed como estado final.
    """

    __tablename__ = "quests"

    CATEGORIES = ("diaria", "semanal", "campana", "meta", "evento")

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    category = db.Column(db.String(20), nullable=False)
    xp_reward = db.Column(db.Integer, nullable=False, default=0)
    gold_reward = db.Column(db.Integer, nullable=False, default=0)
    is_completed = db.Column(db.Boolean, nullable=False, default=False)
    last_completed_at = db.Column(db.DateTime, nullable=True)
    due_date = db.Column(db.Date, nullable=True)  # usado por "campana"
    is_active = db.Column(db.Boolean, nullable=False, default=True)  # soft delete
    icon = db.Column(db.String(16), nullable=True)
    color = db.Column(db.String(7), nullable=True)  # "#rrggbb"
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "category": self.category,
            "xp_reward": self.xp_reward,
            "gold_reward": self.gold_reward,
            "is_completed": self.is_completed,
            "last_completed_at": (
                self.last_completed_at.isoformat() if self.last_completed_at else None
            ),
            "due_date": self.due_date.isoformat() if self.due_date else None,
            "icon": self.icon,
            "color": self.color,
        }


class Folder(db.Model):
    """
    Agrupa árboles de habilidades relacionados — el nivel de jerarquía
    arriba de SkillTree (ej: Folder 'Universidad' con los árboles
    'Álgebra' y 'Programación'; Folder 'Hobbies' con el árbol 'Piano').

    Sin cascade de borrado a propósito: borrar un folder no debe borrar
    los árboles que contiene (ver app.py:delete_folder, que primero los
    des-asocia dejándolos "sin categoría").
    """

    __tablename__ = "folders"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    trees = db.relationship("SkillTree", backref="folder")

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name}


class SkillTree(db.Model):
    """Árbol de progresión individual (ej: una materia, un instrumento)."""

    __tablename__ = "skill_trees"

    id = db.Column(db.Integer, primary_key=True)
    folder_id = db.Column(db.Integer, db.ForeignKey("folders.id"), nullable=True)
    name = db.Column(db.String(150), nullable=False)
    position = db.Column(db.Float, nullable=False, default=0)

    branches = db.relationship(
        "Branch",
        backref="tree",
        cascade="all, delete-orphan",
        order_by="Branch.position",
    )

    def to_dict(self, include_branches: bool = True) -> dict:
        data = {"id": self.id, "folder_id": self.folder_id, "name": self.name}
        if include_branches:
            data["branches"] = [b.to_dict() for b in self.branches]
        return data


class Branch(db.Model):
    """Rama dentro de un árbol de habilidades (ej: 'Álgebra')."""

    __tablename__ = "branches"

    id = db.Column(db.Integer, primary_key=True)
    tree_id = db.Column(db.Integer, db.ForeignKey("skill_trees.id"), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    position = db.Column(db.Float, nullable=False, default=0)
    times_reset = db.Column(db.Integer, nullable=False, default=0)

    nodes = db.relationship(
        "Node",
        backref="branch",
        cascade="all, delete-orphan",
        order_by="Node.position",
    )

    @property
    def progress_percent(self) -> float:
        core_nodes = [n for n in self.nodes if n.node_type != "bonus"]
        if not core_nodes:
            return 0.0
        completed = sum(1 for n in core_nodes if n.status == "completed")
        return round((completed / len(core_nodes)) * 100, 1)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tree_id": self.tree_id,
            "name": self.name,
            "progress_percent": self.progress_percent,
            "times_reset": self.times_reset,
            "nodes": [n.to_dict() for n in self.nodes],
        }


class Node(db.Model):
    """
    Nodo / hito dentro de una rama.

    node_type ∈ {"regular", "bonus", "recovery"}
    status    ∈ {"locked", "available", "completed", "failed"}

    'position' es Float a propósito: permite insertar un nodo de
    recuperación/llamado entre dos existentes calculando el punto medio,
    sin reordenar el resto de la rama.

    'recovers_node_id' apunta al nodo RAÍZ original que este nodo intenta
    recuperar (None en un nodo raíz). Junto con 'base_title' +
    'attempt_number' resuelven el bug del loop infinito de recuperatorios:
    cada nodo generado por una falla guarda el título ORIGINAL (sin
    sufijos) en base_title, así "Recuperatorio: X" nunca termina
    generando "Recuperatorio: Recuperatorio: X". attempt_number cuenta
    qué intento es (1 = original), y junto con max_attempts decide cuándo
    dejar de insertar nodos y recursar la rama en su lugar (ver
    services.fail_node).
    """

    __tablename__ = "nodes"

    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    base_title = db.Column(db.String(200), nullable=True)
    node_type = db.Column(db.String(20), nullable=False, default="regular")
    status = db.Column(db.String(20), nullable=False, default="locked")
    position = db.Column(db.Float, nullable=False)
    attempt_number = db.Column(db.Integer, nullable=False, default=1)
    recovers_node_id = db.Column(db.Integer, db.ForeignKey("nodes.id"), nullable=True)
    xp_reward = db.Column(db.Integer, nullable=False, default=0)
    gold_reward = db.Column(db.Integer, nullable=False, default=0)
    icon = db.Column(db.String(16), nullable=True)
    color = db.Column(db.String(7), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @property
    def max_attempts(self) -> int:
        """
        2 intentos (original + 1 recuperatorio) para cualquier nodo normal.
        3 intentos (original + Llamado 2 + Llamado 3) si el título contiene
        la palabra 'final' — replica el régimen real de finales
        universitarios con múltiples llamados.
        """
        return 3 if "final" in (self.base_title or self.title).lower() else 2

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "branch_id": self.branch_id,
            "title": self.title,
            "base_title": self.base_title,
            "node_type": self.node_type,
            "status": self.status,
            "position": self.position,
            "attempt_number": self.attempt_number,
            "max_attempts": self.max_attempts,
            "xp_reward": self.xp_reward,
            "gold_reward": self.gold_reward,
            "icon": self.icon,
            "color": self.color,
        }


class RewardItem(db.Model):
    """Ítem de la tienda de recompensas."""

    __tablename__ = "reward_items"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    gold_cost = db.Column(db.Integer, nullable=False, default=0)
    cash_cost = db.Column(db.Integer, nullable=False, default=0)
    is_active = db.Column(db.Boolean, nullable=False, default=True)  # soft delete
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "gold_cost": self.gold_cost,
            "cash_cost": self.cash_cost,
        }


class PurchaseLog(db.Model):
    """Historial de compras — auditoría simple del ledger de dinero real."""

    __tablename__ = "purchase_log"

    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey("reward_items.id"), nullable=True)
    item_name = db.Column(db.String(200), nullable=False)
    gold_spent = db.Column(db.Integer, nullable=False, default=0)
    cash_spent = db.Column(db.Integer, nullable=False, default=0)
    purchased_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "item_name": self.item_name,
            "gold_spent": self.gold_spent,
            "cash_spent": self.cash_spent,
            "purchased_at": (
                self.purchased_at.isoformat() if self.purchased_at else None
            ),
        }


class Achievement(db.Model):
    """
    Logro manual — vos decidís cuándo se desbloquea (no hay detección
    automática de condiciones, es una vitrina de trofeos, no un sistema
    de reglas).
    """

    __tablename__ = "achievements"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(150), nullable=False)
    description = db.Column(db.String(500), nullable=True)
    image_url = db.Column(db.String(500), nullable=True)
    is_unlocked = db.Column(db.Boolean, nullable=False, default=False)
    unlocked_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "image_url": self.image_url,
            "is_unlocked": self.is_unlocked,
            "unlocked_at": self.unlocked_at.isoformat() if self.unlocked_at else None,
        }


class LevelConfig(db.Model):
    """
    Nivel personalizado. En cuanto exista al menos una fila, reemplaza
    por completo la fórmula matemática de PlayerProfile.level (ver
    PlayerProfile._level_info).

    El NÚMERO de nivel no se guarda acá a propósito: es la posición
    (1, 2, 3...) al ordenar todas las filas por xp_threshold ascendente.
    Así es imposible terminar con dos niveles "3" o un hueco en la
    numeración — simplemente se re-calcula al leer.
    """

    __tablename__ = "level_configs"

    id = db.Column(db.Integer, primary_key=True)
    xp_threshold = db.Column(db.Integer, nullable=False, unique=True)
    title = db.Column(db.String(150), nullable=True)
    image_url = db.Column(db.String(500), nullable=True)

    def to_dict(self, level_number: int = None) -> dict:
        return {
            "id": self.id,
            "level_number": level_number,
            "xp_threshold": self.xp_threshold,
            "title": self.title,
            "image_url": self.image_url,
        }

"""
app.py — Punto de entrada de la app Flask y todas las rutas de la API REST
de LevelUp Life.

La lógica de negocio (reset de misiones, completar/fallar nodos, recursar
ramas, validar compras) vive en services.py. Estas rutas se limitan a:
parsear el request, validar los datos de entrada, llamar a services.py, y
devolver la respuesta JSON con el código de estado adecuado.

Para correr en desarrollo:
    python app.py
Para producción (Railway usa esto vía Procfile):
    gunicorn app:app --bind 0.0.0.0:$PORT
"""
import os
import re
from datetime import date

from flask import jsonify, render_template, request, send_from_directory

import services
from app_factory import create_app
from extensions import db
from models import Achievement, Branch, Folder, LevelConfig, Node, PurchaseLog, Quest, RewardItem, SkillTree

app = create_app()

HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


# --------------------------------------------------------------------- #
# Helpers de parsing / validación
# --------------------------------------------------------------------- #

def json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def get_json_body() -> dict:
    return request.get_json(silent=True) or {}


def require_text(data: dict, field: str) -> str:
    value = (data.get(field) or "").strip()
    if not value:
        raise services.GameError(f"'{field}' es obligatorio.")
    return value


def parse_int(data: dict, field: str, default=None):
    if field not in data:
        return default
    try:
        return int(data[field])
    except (TypeError, ValueError):
        raise services.GameError(f"'{field}' debe ser un número entero.")


def parse_float(data: dict, field: str, default=None):
    if field not in data:
        return default
    try:
        return float(data[field])
    except (TypeError, ValueError):
        raise services.GameError(f"'{field}' debe ser un número.")


def parse_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise services.GameError(f"Fecha inválida: '{value}' (usar formato AAAA-MM-DD).")


def require_choice(data: dict, field: str, choices, default=None):
    if field not in data:
        if default is None:
            raise services.GameError(f"'{field}' es obligatorio.")
        return default
    value = data[field]
    if value not in choices:
        raise services.GameError(f"'{field}' debe ser una de: {', '.join(choices)}.")
    return value


def parse_optional_text(data: dict, field: str, max_len: int = None):
    """Para campos de texto libres y opcionales (nombre, avatar): '' -> None."""
    if field not in data:
        return None, False
    value = (data[field] or "").strip() or None
    if value and max_len and len(value) > max_len:
        raise services.GameError(f"'{field}' es demasiado largo (máximo {max_len} caracteres).")
    return value, True


def parse_hex_color(data: dict, field: str):
    """Devuelve (valor, fue_provisto). '' se interpreta como 'sacar el color'."""
    if field not in data:
        return None, False
    value = (data[field] or "").strip() or None
    if value and not HEX_COLOR_RE.match(value):
        raise services.GameError(f"'{field}' debe ser un color hex válido, ej: #9b8cff.")
    return value, True


def parse_icon(data: dict, field: str):
    """Emoji/ícono corto. No se valida el contenido (cualquier string corto vale)."""
    if field not in data:
        return None, False
    value = (data[field] or "").strip() or None
    if value and len(value) > 16:
        raise services.GameError(f"'{field}' es demasiado largo.")
    return value, True


# --------------------------------------------------------------------- #
# Manejo de errores — la API siempre responde en JSON, nunca con HTML
# --------------------------------------------------------------------- #

@app.errorhandler(services.GameError)
def handle_game_error(err: services.GameError):
    return json_error(err.message, err.status_code)


@app.errorhandler(404)
def handle_not_found(err):
    return json_error("Recurso no encontrado.", 404)


@app.errorhandler(405)
def handle_method_not_allowed(err):
    return json_error("Método no permitido para esta ruta.", 405)


@app.errorhandler(500)
def handle_server_error(err):
    db.session.rollback()
    return json_error("Error interno del servidor.", 500)


# --------------------------------------------------------------------- #
# Salud / raíz
# --------------------------------------------------------------------- #

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/sw.js")
def service_worker():
    return send_from_directory(
        os.path.join(app.root_path, "static", "js"),
        "sw.js",
        mimetype="application/javascript",
    )


@app.get("/api/health")
def health_check():
    return jsonify({"status": "ok"})


# --------------------------------------------------------------------- #
# Perfil
# --------------------------------------------------------------------- #

@app.get("/api/profile")
def get_profile():
    profile = services.get_or_create_profile()
    return jsonify(profile.to_dict())


@app.put("/api/profile")
def update_profile():
    """
    Edición manual del perfil: nombre, avatar (emoji o URL), y los tres
    saldos. A diferencia de /complete o /purchase (que suman/restan),
    acá el valor que mandás REEMPLAZA directamente al que había — es a
    propósito, para poder corregir XP de prueba o ajustar el saldo real
    a mano.
    """
    profile = services.get_or_create_profile()
    data = get_json_body()

    name, provided = parse_optional_text(data, "name", max_len=60)
    if provided:
        profile.name = name

    avatar, provided = parse_optional_text(data, "avatar", max_len=500)
    if provided:
        profile.avatar = avatar

    if "total_xp" in data:
        xp = parse_int(data, "total_xp")
        if xp < 0:
            raise services.GameError("El XP no puede ser negativo.")
        profile.total_xp = xp

    if "gold_coins" in data:
        gold = parse_int(data, "gold_coins")
        if gold < 0:
            raise services.GameError("Los Gold Coins no pueden ser negativos.")
        profile.gold_coins = gold

    if "real_money_balance" in data:
        # Se permite negativo a propósito: puede reflejar un saldo en contra real.
        profile.real_money_balance = parse_int(data, "real_money_balance")

    db.session.commit()
    return jsonify(profile.to_dict())


# --------------------------------------------------------------------- #
# Misiones (Quests)
# --------------------------------------------------------------------- #

@app.get("/api/quests")
def list_quests():
    category = request.args.get("category")
    query = Quest.query.filter_by(is_active=True)
    if category:
        if category not in Quest.CATEGORIES:
            return json_error(f"Categoría inválida: '{category}'.")
        query = query.filter_by(category=category)

    quests = query.order_by(Quest.created_at.asc()).all()
    services.refresh_all_quests(quests)
    db.session.commit()

    return jsonify([q.to_dict() for q in quests])


@app.post("/api/quests")
def create_quest():
    data = get_json_body()
    icon, _ = parse_icon(data, "icon")
    color, _ = parse_hex_color(data, "color")
    quest = Quest(
        title=require_text(data, "title"),
        category=require_choice(data, "category", Quest.CATEGORIES),
        xp_reward=parse_int(data, "xp_reward", 0),
        gold_reward=parse_int(data, "gold_reward", 0),
        due_date=parse_date(data.get("due_date")),
        icon=icon,
        color=color,
    )
    db.session.add(quest)
    db.session.commit()
    return jsonify(quest.to_dict()), 201


@app.get("/api/quests/<int:quest_id>")
def get_quest(quest_id):
    quest = Quest.query.get_or_404(quest_id)
    services.refresh_quest_state(quest)
    db.session.commit()
    return jsonify(quest.to_dict())


@app.put("/api/quests/<int:quest_id>")
def update_quest(quest_id):
    quest = Quest.query.get_or_404(quest_id)
    data = get_json_body()

    if "title" in data:
        quest.title = require_text(data, "title")
    if "category" in data:
        quest.category = require_choice(data, "category", Quest.CATEGORIES)
    if "xp_reward" in data:
        quest.xp_reward = parse_int(data, "xp_reward")
    if "gold_reward" in data:
        quest.gold_reward = parse_int(data, "gold_reward")
    if "due_date" in data:
        quest.due_date = parse_date(data["due_date"])

    icon, provided = parse_icon(data, "icon")
    if provided:
        quest.icon = icon
    color, provided = parse_hex_color(data, "color")
    if provided:
        quest.color = color

    db.session.commit()
    return jsonify(quest.to_dict())


@app.delete("/api/quests/<int:quest_id>")
def delete_quest(quest_id):
    quest = Quest.query.get_or_404(quest_id)
    quest.is_active = False  # soft delete
    db.session.commit()
    return jsonify({"deleted": True, "id": quest_id})


@app.post("/api/quests/<int:quest_id>/complete")
def complete_quest(quest_id):
    quest = Quest.query.get_or_404(quest_id)
    services.refresh_quest_state(quest)

    if quest.is_completed:
        raise services.GameError("Esta misión ya fue completada.", 409)

    profile = services.get_or_create_profile()
    services.award(profile, quest.xp_reward, quest.gold_reward)
    quest.is_completed = True
    quest.last_completed_at = services.local_now()

    db.session.commit()
    return jsonify({"quest": quest.to_dict(), "profile": profile.to_dict()})


# --------------------------------------------------------------------- #
# Folders (agrupan árboles de habilidades — ej. "Universidad", "Hobbies")
# --------------------------------------------------------------------- #

@app.get("/api/folders")
def list_folders():
    folders = Folder.query.order_by(Folder.id.asc()).all()
    return jsonify([f.to_dict() for f in folders])


@app.post("/api/folders")
def create_folder():
    data = get_json_body()
    folder = Folder(name=require_text(data, "name"))
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict()), 201


@app.put("/api/folders/<int:folder_id>")
def update_folder(folder_id):
    folder = Folder.query.get_or_404(folder_id)
    data = get_json_body()
    folder.name = require_text(data, "name")
    db.session.commit()
    return jsonify(folder.to_dict())


@app.delete("/api/folders/<int:folder_id>")
def delete_folder(folder_id):
    """Borrar un folder NUNCA borra los árboles que contiene — quedan
    sin categoría ('Sin categoría' en la UI), no se pierden."""
    folder = Folder.query.get_or_404(folder_id)
    for tree in list(folder.trees):
        tree.folder_id = None
    db.session.delete(folder)
    db.session.commit()
    return jsonify({"deleted": True, "id": folder_id})


# --------------------------------------------------------------------- #
# Árboles de habilidades
# --------------------------------------------------------------------- #

@app.get("/api/skill-trees")
def list_skill_trees():
    trees = SkillTree.query.order_by(SkillTree.id.asc()).all()
    return jsonify([t.to_dict() for t in trees])


@app.post("/api/skill-trees")
def create_skill_tree():
    data = get_json_body()
    folder_id = parse_int(data, "folder_id", None)
    if folder_id is not None:
        Folder.query.get_or_404(folder_id)
    tree = SkillTree(name=require_text(data, "name"), folder_id=folder_id)
    db.session.add(tree)
    db.session.commit()
    return jsonify(tree.to_dict()), 201


@app.get("/api/skill-trees/<int:tree_id>")
def get_skill_tree(tree_id):
    tree = SkillTree.query.get_or_404(tree_id)
    return jsonify(tree.to_dict())


@app.put("/api/skill-trees/<int:tree_id>")
def update_skill_tree(tree_id):
    tree = SkillTree.query.get_or_404(tree_id)
    data = get_json_body()

    if "name" in data:
        tree.name = require_text(data, "name")
    if "folder_id" in data:
        folder_id = parse_int(data, "folder_id", None)
        if folder_id is not None:
            Folder.query.get_or_404(folder_id)
        tree.folder_id = folder_id

    db.session.commit()
    return jsonify(tree.to_dict())


@app.delete("/api/skill-trees/<int:tree_id>")
def delete_skill_tree(tree_id):
    tree = SkillTree.query.get_or_404(tree_id)
    db.session.delete(tree)  # cascade: borra ramas y nodos asociados
    db.session.commit()
    return jsonify({"deleted": True, "id": tree_id})


# --- Ramas --------------------------------------------------------------

@app.post("/api/skill-trees/<int:tree_id>/branches")
def create_branch(tree_id):
    tree = SkillTree.query.get_or_404(tree_id)
    data = get_json_body()

    position = parse_float(data, "position")
    if position is None:
        position = max((b.position for b in tree.branches), default=0) + 10

    branch = Branch(tree_id=tree.id, name=require_text(data, "name"), position=position)
    db.session.add(branch)
    db.session.commit()
    return jsonify(branch.to_dict()), 201


@app.get("/api/branches/<int:branch_id>")
def get_branch(branch_id):
    branch = Branch.query.get_or_404(branch_id)
    return jsonify(branch.to_dict())


@app.put("/api/branches/<int:branch_id>")
def update_branch(branch_id):
    branch = Branch.query.get_or_404(branch_id)
    data = get_json_body()

    if "name" in data:
        branch.name = require_text(data, "name")
    if "position" in data:
        branch.position = parse_float(data, "position")

    db.session.commit()
    return jsonify(branch.to_dict())


@app.delete("/api/branches/<int:branch_id>")
def delete_branch(branch_id):
    branch = Branch.query.get_or_404(branch_id)
    db.session.delete(branch)  # cascade: borra los nodos asociados
    db.session.commit()
    return jsonify({"deleted": True, "id": branch_id})


@app.post("/api/branches/<int:branch_id>/reset")
def reset_branch_route(branch_id):
    """'Recursar': ver services.reset_branch para el detalle de la regla."""
    branch = Branch.query.get_or_404(branch_id)
    services.reset_branch(branch)
    db.session.commit()
    return jsonify(branch.to_dict())


# --- Nodos ----------------------------------------------------------------

NODE_TYPES = ("regular", "bonus", "recovery")
NODE_STATUSES = ("locked", "available", "completed", "failed")


@app.post("/api/branches/<int:branch_id>/nodes")
def create_node(branch_id):
    branch = Branch.query.get_or_404(branch_id)
    data = get_json_body()

    position = parse_float(data, "position")
    if position is None:
        position = max((n.position for n in branch.nodes), default=0) + 10

    node_type = require_choice(data, "node_type", NODE_TYPES, default="regular")
    # Bug fix: antes esto era siempre "locked" salvo que el caller lo diga
    # explícitamente, así que un nodo creado a mano en una rama nueva
    # quedaba bloqueado para siempre (nada lo desbloqueaba nunca).
    if "status" in data:
        status = require_choice(data, "status", NODE_STATUSES)
    else:
        status = services.default_node_status_for_new_node(branch, node_type)

    icon, _ = parse_icon(data, "icon")
    color, _ = parse_hex_color(data, "color")
    title = require_text(data, "title")

    node = Node(
        branch_id=branch.id,
        title=title,
        base_title=title,
        node_type=node_type,
        status=status,
        position=position,
        xp_reward=parse_int(data, "xp_reward", 0),
        gold_reward=parse_int(data, "gold_reward", 0),
        icon=icon,
        color=color,
    )
    db.session.add(node)
    db.session.commit()
    return jsonify(node.to_dict()), 201


@app.get("/api/nodes/<int:node_id>")
def get_node(node_id):
    node = Node.query.get_or_404(node_id)
    return jsonify(node.to_dict())


@app.put("/api/nodes/<int:node_id>")
def update_node(node_id):
    node = Node.query.get_or_404(node_id)
    data = get_json_body()

    if "title" in data:
        node.title = require_text(data, "title")
    if "node_type" in data:
        node.node_type = require_choice(data, "node_type", NODE_TYPES)
    if "status" in data:
        node.status = require_choice(data, "status", NODE_STATUSES)
    if "position" in data:
        node.position = parse_float(data, "position")
    if "xp_reward" in data:
        node.xp_reward = parse_int(data, "xp_reward")
    if "gold_reward" in data:
        node.gold_reward = parse_int(data, "gold_reward")

    icon, provided = parse_icon(data, "icon")
    if provided:
        node.icon = icon
    color, provided = parse_hex_color(data, "color")
    if provided:
        node.color = color

    db.session.commit()
    return jsonify(node.to_dict())


@app.delete("/api/nodes/<int:node_id>")
def delete_node(node_id):
    node = Node.query.get_or_404(node_id)
    db.session.delete(node)
    db.session.commit()
    return jsonify({"deleted": True, "id": node_id})


@app.post("/api/nodes/<int:node_id>/complete")
def complete_node_route(node_id):
    node = Node.query.get_or_404(node_id)
    next_node = services.complete_node(node)
    db.session.commit()

    profile = services.get_or_create_profile()
    return jsonify(
        {
            "node": node.to_dict(),
            "unlocked_next": next_node.to_dict() if next_node else None,
            "profile": profile.to_dict(),
        }
    )


@app.post("/api/nodes/<int:node_id>/fail")
def fail_node_route(node_id):
    """'Recuperatorio' / sistema de llamados — ver services.fail_node."""
    node = Node.query.get_or_404(node_id)
    result = services.fail_node(node)
    db.session.commit()
    return (
        jsonify(
            {
                "failed_node": result["failed_node"].to_dict(),
                "new_node": result["new_node"].to_dict() if result["new_node"] else None,
                "reset": result["reset"],
            }
        ),
        201,
    )


# --------------------------------------------------------------------- #
# Tienda de recompensas
# --------------------------------------------------------------------- #

@app.get("/api/shop")
def list_shop_items():
    items = RewardItem.query.filter_by(is_active=True).order_by(RewardItem.id.asc()).all()
    return jsonify([i.to_dict() for i in items])


@app.post("/api/shop")
def create_shop_item():
    data = get_json_body()
    item = RewardItem(
        name=require_text(data, "name"),
        gold_cost=parse_int(data, "gold_cost", 0),
        cash_cost=parse_int(data, "cash_cost", 0),
    )
    db.session.add(item)
    db.session.commit()
    return jsonify(item.to_dict()), 201


@app.get("/api/shop/<int:item_id>")
def get_shop_item(item_id):
    item = RewardItem.query.get_or_404(item_id)
    return jsonify(item.to_dict())


@app.put("/api/shop/<int:item_id>")
def update_shop_item(item_id):
    item = RewardItem.query.get_or_404(item_id)
    data = get_json_body()

    if "name" in data:
        item.name = require_text(data, "name")
    if "gold_cost" in data:
        item.gold_cost = parse_int(data, "gold_cost")
    if "cash_cost" in data:
        item.cash_cost = parse_int(data, "cash_cost")

    db.session.commit()
    return jsonify(item.to_dict())


@app.delete("/api/shop/<int:item_id>")
def delete_shop_item(item_id):
    item = RewardItem.query.get_or_404(item_id)
    item.is_active = False  # soft delete
    db.session.commit()
    return jsonify({"deleted": True, "id": item_id})


@app.post("/api/shop/<int:item_id>/purchase")
def purchase_shop_item(item_id):
    item = RewardItem.query.get_or_404(item_id)
    log = services.purchase_item(item)
    db.session.commit()

    profile = services.get_or_create_profile()
    return jsonify({"purchase": log.to_dict(), "profile": profile.to_dict()}), 201


@app.get("/api/purchase-log")
def list_purchase_log():
    limit = request.args.get("limit", default=20, type=int)
    logs = PurchaseLog.query.order_by(PurchaseLog.purchased_at.desc()).limit(limit).all()
    return jsonify([entry.to_dict() for entry in logs])


# --------------------------------------------------------------------- #
# Logros (Achievements) — vitrina manual, sin detección automática
# --------------------------------------------------------------------- #

@app.get("/api/achievements")
def list_achievements():
    achievements = Achievement.query.order_by(
        Achievement.is_unlocked.desc(),
        Achievement.unlocked_at.desc(),
        Achievement.id.asc(),
    ).all()
    return jsonify([a.to_dict() for a in achievements])


@app.post("/api/achievements")
def create_achievement():
    data = get_json_body()
    achievement = Achievement(
        title=require_text(data, "title"),
        description=(data.get("description") or "").strip() or None,
        image_url=(data.get("image_url") or "").strip() or None,
    )
    db.session.add(achievement)
    db.session.commit()
    return jsonify(achievement.to_dict()), 201


@app.get("/api/achievements/<int:achievement_id>")
def get_achievement(achievement_id):
    achievement = Achievement.query.get_or_404(achievement_id)
    return jsonify(achievement.to_dict())


@app.put("/api/achievements/<int:achievement_id>")
def update_achievement(achievement_id):
    achievement = Achievement.query.get_or_404(achievement_id)
    data = get_json_body()

    if "title" in data:
        achievement.title = require_text(data, "title")
    if "description" in data:
        achievement.description = (data["description"] or "").strip() or None
    if "image_url" in data:
        achievement.image_url = (data["image_url"] or "").strip() or None

    db.session.commit()
    return jsonify(achievement.to_dict())


@app.delete("/api/achievements/<int:achievement_id>")
def delete_achievement(achievement_id):
    achievement = Achievement.query.get_or_404(achievement_id)
    db.session.delete(achievement)
    db.session.commit()
    return jsonify({"deleted": True, "id": achievement_id})


@app.post("/api/achievements/<int:achievement_id>/toggle")
def toggle_achievement(achievement_id):
    """Alterna desbloqueado <-> bloqueado. No otorga XP/oro — es una
    vitrina manual, no una mecánica de recompensas."""
    achievement = Achievement.query.get_or_404(achievement_id)
    achievement.is_unlocked = not achievement.is_unlocked
    achievement.unlocked_at = services.local_now() if achievement.is_unlocked else None
    db.session.commit()
    return jsonify(achievement.to_dict())


# --------------------------------------------------------------------- #
# Niveles personalizados (LevelConfig)
# --------------------------------------------------------------------- #

@app.get("/api/level-configs")
def list_level_configs():
    configs = LevelConfig.query.order_by(LevelConfig.xp_threshold.asc()).all()
    return jsonify([c.to_dict(level_number=i + 1) for i, c in enumerate(configs)])


@app.post("/api/level-configs")
def create_level_config():
    data = get_json_body()
    threshold = parse_int(data, "xp_threshold")
    if threshold is None or threshold < 0:
        return json_error("'xp_threshold' es obligatorio y no puede ser negativo.")
    if LevelConfig.query.filter_by(xp_threshold=threshold).first():
        return json_error(f"Ya existe un nivel con umbral {threshold} XP.", 409)

    config = LevelConfig(
        xp_threshold=threshold,
        title=(data.get("title") or "").strip() or None,
        image_url=(data.get("image_url") or "").strip() or None,
    )
    db.session.add(config)
    db.session.commit()
    return jsonify(config.to_dict()), 201


@app.put("/api/level-configs/<int:config_id>")
def update_level_config(config_id):
    config = LevelConfig.query.get_or_404(config_id)
    data = get_json_body()

    if "xp_threshold" in data:
        threshold = parse_int(data, "xp_threshold")
        if threshold is None or threshold < 0:
            return json_error("'xp_threshold' no puede ser negativo.")
        clash = LevelConfig.query.filter(
            LevelConfig.xp_threshold == threshold, LevelConfig.id != config_id
        ).first()
        if clash:
            return json_error(f"Ya existe un nivel con umbral {threshold} XP.", 409)
        config.xp_threshold = threshold
    if "title" in data:
        config.title = (data["title"] or "").strip() or None
    if "image_url" in data:
        config.image_url = (data["image_url"] or "").strip() or None

    db.session.commit()
    return jsonify(config.to_dict())


@app.delete("/api/level-configs/<int:config_id>")
def delete_level_config(config_id):
    config = LevelConfig.query.get_or_404(config_id)
    db.session.delete(config)
    db.session.commit()
    return jsonify({"deleted": True, "id": config_id})


if __name__ == "__main__":
    app.run(debug=True, port=8000)

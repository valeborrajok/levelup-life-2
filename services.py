"""
services.py — Lógica de negocio del juego, separada de las rutas Flask.

app.py se encarga de HTTP (parsear el request, elegir el código de estado);
este módulo se encarga de las reglas: cuándo resetear una misión, qué pasa
al completar o fallar un nodo, qué implica "recursar" una rama, y cómo
validar una compra en la tienda.
"""
import re
from datetime import datetime, timedelta
from typing import Optional

from config import Config
from extensions import db
from models import Branch, Node, PlayerProfile, PurchaseLog, RewardItem


class GameError(Exception):
    """Error de negocio esperable (se traduce a un 4xx/5xx en app.py)."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def local_now() -> datetime:
    """'Ahora' ajustado a Config.TIMEZONE_OFFSET_HOURS (Buenos Aires)."""
    return datetime.utcnow() + timedelta(hours=Config.TIMEZONE_OFFSET_HOURS)


# --------------------------------------------------------------------- #
# Perfil
# --------------------------------------------------------------------- #

def get_or_create_profile() -> PlayerProfile:
    profile = PlayerProfile.query.first()
    if profile is None:
        profile = PlayerProfile(total_xp=0, gold_coins=0, real_money_balance=0)
        db.session.add(profile)
        db.session.commit()
    return profile


def award(profile: PlayerProfile, xp: int, gold: int) -> None:
    profile.total_xp += xp
    profile.gold_coins += gold


# --------------------------------------------------------------------- #
# Misiones: reset automático de diarias/semanales
# --------------------------------------------------------------------- #

def refresh_quest_state(quest) -> None:
    if not quest.is_completed or quest.last_completed_at is None:
        return

    now = local_now()
    last = quest.last_completed_at

    if quest.category == "diaria":
        if last.date() < now.date():
            quest.is_completed = False

    elif quest.category == "semanal":
        last_sunday = last.date() - timedelta(days=(last.date().weekday() + 1) % 7)
        now_sunday = now.date() - timedelta(days=(now.date().weekday() + 1) % 7)
        if last_sunday < now_sunday:
            quest.is_completed = False

    # "campana", "meta" y "evento" son de una sola vez: nunca se resetean.


def refresh_all_quests(quests) -> None:
    for quest in quests:
        refresh_quest_state(quest)


# --------------------------------------------------------------------- #
# Árbol de habilidades: crear / completar / fallar nodos, recursar ramas
# --------------------------------------------------------------------- #

FINAL_KEYWORD = "final"
MAX_FINAL_ATTEMPTS = 3


def _is_final_exam(node: Node) -> bool:
    return FINAL_KEYWORD in node.title.lower()


def _strip_llamado_suffix(title: str) -> str:
    return re.sub(r"\s*\(Llamado \d+\)\s*$", "", title).strip()


def _is_root_node(node: Node) -> bool:
    """Un nodo 'core' de la cadena principal: no es bonus y no es él
    mismo un recuperatorio/llamado de otro nodo."""
    return node.node_type != "bonus" and node.recovers_node_id is None


def _next_gating_node(node: Node) -> Optional[Node]:
    """
    El siguiente nodo RAÍZ de la cadena principal por posición dentro de
    la misma rama. Se excluyen tanto los nodos bonus (contenido
    paralelo/opcional) como los recuperatorios/llamados (son variantes
    de un nodo raíz que ya está contado, no un paso nuevo de la cadena).
    """
    return (
        Node.query.filter(
            Node.branch_id == node.branch_id,
            Node.position > node.position,
            Node.node_type != "bonus",
            Node.recovers_node_id.is_(None),
        )
        .order_by(Node.position.asc())
        .first()
    )


def default_node_status_for_new_node(branch: Branch, node_type: str) -> str:
    """
    Estado inicial de un nodo creado a mano desde la UI.

    Corrige el bug de "nodos que nacen bloqueados para siempre": si no
    hay ningún nodo core en la rama todavía, o si todos los que hay ya
    están completados, el nuevo nodo nace 'available' (es el nuevo
    "próximo paso"). Si ya hay un core pendiente sin completar, el nuevo
    nodo se agrega 'locked' al final de la cola, como corresponde.
    Los nodos bonus siempre nacen 'available': no forman parte de la
    cadena principal, así que nunca deberían depender de que algo los
    desbloquee.
    """
    if node_type == "bonus":
        return "available"

    core_nodes = [n for n in branch.nodes if _is_root_node(n)]
    if not core_nodes or all(n.status == "completed" for n in core_nodes):
        return "available"
    return "locked"


def complete_node(node: Node) -> Optional[Node]:
    """
    Marca el nodo como completado y otorga su recompensa. Si el nodo es
    un recuperatorio o un llamado, además marca resuelto al nodo raíz
    original (para que cuente en el % de progreso de la rama). Si el
    nodo no es bonus, desbloquea el siguiente nodo raíz de la cadena
    (si estaba 'locked'). Devuelve ese nodo desbloqueado, o None.
    """
    if node.status == "completed":
        raise GameError("Este nodo ya fue completado.", 409)
    if node.status == "locked":
        raise GameError("Este nodo todavía está bloqueado.", 409)

    node.status = "completed"
    profile = get_or_create_profile()
    award(profile, node.xp_reward, node.gold_reward)

    if node.recovers_node_id:
        root = Node.query.get(node.recovers_node_id)
        if root and root.status != "completed":
            root.status = "completed"

    if node.node_type == "bonus":
        return None

    next_node = _next_gating_node(node)
    if next_node and next_node.status == "locked":
        next_node.status = "available"
    return next_node


def fail_node(node: Node) -> dict:
    """
    Marca un nodo como fallado. Nunca bloquea el avance de la rama: el
    siguiente nodo raíz se desbloquea igual, así el recuperatorio queda
    "diferido" — en la vida real uno puede rendir el parcial siguiente
    sin haber dado todavía el recuperatorio del anterior, sin que el
    usuario tenga que hacer nada especial para lograr eso.

    - Un nodo 'recovery' NO se puede volver a fallar por acá: si el
      recuperatorio también sale mal, académicamente corresponde
      recursar la rama entera (ver reset_branch), no encadenar otro
      recuperatorio de un recuperatorio.
    - Si el título contiene "final" (sin importar mayúsculas), sigue el
      sistema de llamados universitario: hasta 3 intentos en total (el
      original + Llamado 2 + Llamado 3) antes de forzar un reset de
      rama en vez de generar un 4to intento.
    - Cualquier otro nodo regular genera un 'Recuperatorio' normal.

    Devuelve {"failed_node", "new_node", "reset"} — "new_node" es None
    cuando "reset" es True.
    """
    if node.node_type == "recovery":
        raise GameError(
            "Un recuperatorio no se puede volver a fallar: si no salió, "
            "corresponde recursar la rama entera (usá 'Recursar rama').",
            409,
        )
    if node.status == "completed":
        raise GameError(
            "Este nodo ya fue completado, no se lo puede marcar como fallado.", 409
        )
    if node.status == "locked":
        raise GameError("Este nodo todavía está bloqueado.", 409)

    node.status = "failed"
    root_id = node.recovers_node_id or node.id
    is_final = _is_final_exam(node)

    # Recuperatorio diferido: fallar no bloquea lo que sigue en la rama.
    next_node = _next_gating_node(node)
    if next_node and next_node.status == "locked":
        next_node.status = "available"

    if is_final and node.attempt_number >= MAX_FINAL_ATTEMPTS:
        reset_branch(node.branch)
        return {"failed_node": node, "new_node": None, "reset": True}

    if is_final:
        attempt = node.attempt_number + 1
        new_node = Node(
            branch_id=node.branch_id,
            title=f"{_strip_llamado_suffix(node.title)} (Llamado {attempt})",
            base_title=node.base_title or _strip_llamado_suffix(node.title),
            node_type="regular",
            status="available",
            position=node.position + 0.01,
            xp_reward=node.xp_reward,
            gold_reward=node.gold_reward,
            attempt_number=attempt,
            recovers_node_id=root_id,
        )
    else:
        new_node = Node(
            branch_id=node.branch_id,
            title=f"Recuperatorio: {node.title}",
            base_title=node.base_title or node.title,
            node_type="recovery",
            status="available",
            position=node.position + 0.01,
            xp_reward=node.xp_reward,
            gold_reward=node.gold_reward,
            recovers_node_id=root_id,
        )

    db.session.add(new_node)
    return {"failed_node": node, "new_node": new_node, "reset": False}


def reset_branch(branch: Branch) -> None:
    """
    'Recursar': vuelve el progreso de la rama a 0% SIN tocar el XP/oro ya
    ganado en el perfil.
    - Elimina TODOS los nodos generados por un fallo (recuperatorios y
      llamados — cualquier nodo con recovers_node_id set), ya que son
      artefactos de un intento anterior que ya no aplican.
    - Los nodos 'bonus' vuelven a estar disponibles.
    - De los nodos raíz restantes, el primero por posición queda
      'available' y el resto 'locked', reproduciendo el estado inicial.
    """
    for node in list(branch.nodes):
        if node.recovers_node_id is not None:
            db.session.delete(node)

    remaining = sorted(
        (n for n in branch.nodes if n.recovers_node_id is None),
        key=lambda n: n.position,
    )

    first_core_seen = False
    for node in remaining:
        if node.node_type == "bonus":
            node.status = "available"
            continue
        if not first_core_seen:
            node.status = "available"
            first_core_seen = True
        else:
            node.status = "locked"
        node.attempt_number = 1

    branch.times_reset += 1


# --------------------------------------------------------------------- #
# Tienda: compra con validación de doble moneda (oro + dinero real)
# --------------------------------------------------------------------- #

def purchase_item(item: RewardItem) -> PurchaseLog:
    if not item.is_active:
        raise GameError("Este ítem ya no está disponible.", 404)

    profile = get_or_create_profile()

    if profile.gold_coins < item.gold_cost:
        raise GameError("No tenés suficientes Gold Coins para este ítem.", 402)
    if profile.real_money_balance < item.cash_cost:
        raise GameError("No tenés suficiente saldo real para este ítem.", 402)

    profile.gold_coins -= item.gold_cost
    profile.real_money_balance -= item.cash_cost

    log = PurchaseLog(
        item_id=item.id,
        item_name=item.name,
        gold_spent=item.gold_cost,
        cash_spent=item.cash_cost,
    )
    db.session.add(log)
    return log

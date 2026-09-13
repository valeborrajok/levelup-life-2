"""
seed.py — Crea el esquema de la base de datos y la puebla con los datos
iniciales de LevelUp Life.

Uso:
    python seed.py            # crea las tablas si no existen y siembra
                               # datos solo si la base está vacía
    python seed.py --reset    # BORRA todas las tablas y arranca de cero
                               # (pierde todo el progreso guardado)
"""
import argparse

from app_factory import create_app
from extensions import db
from models import (
    Branch,
    Folder,
    Node,
    PlayerProfile,
    Quest,
    RewardItem,
    SkillTree,
)

# --------------------------------------------------------------------- #
# Data semilla (en español, tal como la ve el usuario en la UI)
# --------------------------------------------------------------------- #

PROFILE_NAME = "Valentín"
PROFILE_AVATAR = "🧬"

QUESTS_SEED = [
    # (título, categoría, xp, oro, icono)
    ("Estudiar temario del día (1 hr)", "diaria", 15, 10, "📚"),
    ("Ordenar espacio de trabajo", "diaria", 10, 5, "🧹"),
    ("Limpiar a fondo la caja de arena", "semanal", 40, 30, "🐱"),
    ("Avanzar curso de Coursera", "semanal", 50, 40, "💻"),
    ("Ir al turno médico", "campana", 100, 70, "🩺"),
    ("Aprobar materias del cuatrimestre", "meta", 200, 150, "🎓"),
    ("Comprar un regalo para mi novia", "evento", 150, 100, "🎁"),
]

SHOP_SEED = [
    # (nombre, costo en oro, costo en dinero real)
    ("Comprar un helado", 120, 4000),
    ("1 Hora de juego libre (Rain World / Minecraft / Switch)", 80, 0),
    ("Comprar un juego nuevo", 500, 30000),
]

FOLDER_NAME = "Universidad"
SKILL_TREE_NAME = "Licenciatura en Bioinformática"
BRANCH_NAMES = ["Álgebra", "Programación 1", "Química Biológica 1"]

# (título, tipo, posición) — posiciones separadas de a 10 para dejar
# lugar a futuros recuperatorios/llamados insertados entremedio.
ALGEBRA_NODES = [
    ("Aprobar Parcial 1", "regular", 10),
    ("Aprobar Parcial 2", "regular", 20),
    ("Aprobar Final", "regular", 30),
]
# (título, tipo, posición, xp extra, oro extra, ícono)
ALGEBRA_BONUS_NODE = ("Resolver guía de ejercicios", "bonus", 15, 20, 15, "✏️")


def seed_database(reset: bool = False) -> None:
    app = create_app()

    with app.app_context():
        if reset:
            print("⚠️  Eliminando todas las tablas existentes...")
            db.drop_all()

        db.create_all()

        if PlayerProfile.query.first() is not None and not reset:
            print(
                "ℹ️  La base de datos ya tiene datos cargados. "
                "Ejecutá 'python seed.py --reset' si querés reiniciarla "
                "desde cero (esto borra el progreso actual)."
            )
            return

        # --- Perfil del jugador ---
        db.session.add(
            PlayerProfile(
                name=PROFILE_NAME,
                avatar=PROFILE_AVATAR,
                total_xp=0,
                gold_coins=50,
                real_money_balance=20000,
            )
        )

        # --- Misiones ---
        for title, category, xp, gold, icon in QUESTS_SEED:
            db.session.add(
                Quest(
                    title=title,
                    category=category,
                    xp_reward=xp,
                    gold_reward=gold,
                    icon=icon,
                )
            )

        # --- Folder + árbol de habilidades ---
        folder = Folder(name=FOLDER_NAME)
        db.session.add(folder)
        db.session.flush()  # necesitamos folder.id

        tree = SkillTree(name=SKILL_TREE_NAME, folder_id=folder.id)
        db.session.add(tree)
        db.session.flush()  # necesitamos tree.id para crear las ramas

        branches_by_name = {}
        for i, name in enumerate(BRANCH_NAMES, start=1):
            branch = Branch(tree_id=tree.id, name=name, position=i * 10)
            db.session.add(branch)
            branches_by_name[name] = branch
        db.session.flush()  # necesitamos branch.id para crear los nodos

        algebra = branches_by_name["Álgebra"]
        for idx, (title, node_type, position) in enumerate(ALGEBRA_NODES):
            db.session.add(
                Node(
                    branch_id=algebra.id,
                    title=title,
                    base_title=title,
                    node_type=node_type,
                    position=position,
                    # Solo el primer nodo arranca disponible; el resto
                    # empieza bloqueado hasta completar el anterior.
                    status="available" if idx == 0 else "locked",
                )
            )

        b_title, b_type, b_pos, b_xp, b_gold, b_icon = ALGEBRA_BONUS_NODE
        db.session.add(
            Node(
                branch_id=algebra.id,
                title=b_title,
                base_title=b_title,
                node_type=b_type,
                position=b_pos,
                status="available",
                xp_reward=b_xp,
                gold_reward=b_gold,
                icon=b_icon,
            )
        )

        # --- Tienda de recompensas ---
        for name, gold_cost, cash_cost in SHOP_SEED:
            db.session.add(
                RewardItem(name=name, gold_cost=gold_cost, cash_cost=cash_cost)
            )

        db.session.commit()
        print("✅ Base de datos inicializada y poblada con éxito.")
        print(f"   → {len(QUESTS_SEED)} misiones")
        print(f"   → carpeta '{FOLDER_NAME}' con el árbol '{SKILL_TREE_NAME}' ({len(BRANCH_NAMES)} ramas)")
        print(f"   → {len(SHOP_SEED)} ítems en la tienda")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Inicializa y puebla la base de datos de LevelUp Life."
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Borra todas las tablas existentes antes de recrearlas y poblarlas de nuevo.",
    )
    args = parser.parse_args()
    seed_database(reset=args.reset)

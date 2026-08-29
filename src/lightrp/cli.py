from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from lightrp.cards import aliases_from_card, load_card, save_card_yaml, slugify
from lightrp.config import AppConfig, load_config
from lightrp.engine import Engine, resolve_nmem_space
from lightrp.nmem import NmemClient, NmemError
from lightrp.paths import (
    default_user_prompts_dir,
    find_example_world,
    package_prompts_dir,
)
from lightrp.promptlib import PromptLibrary
from lightrp.session import create_session, latest_session, load_session
from lightrp.world import CastMember, ensure_world_files, load_world, resolve_world_root


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lightrp", description="Light RP — 世界观 + 多角色轻量引擎")
    sub = parser.add_subparsers(dest="cmd", required=True)

    play = sub.add_parser("play", help="进入一个世界")
    play.add_argument("world")
    play.add_argument("--space", help="nmem 工作区名称或 id")
    play.add_argument("--new", action="store_true", help="开新会话")
    play.add_argument("--session", help="指定会话 id")
    play.add_argument("--config", type=Path)

    init = sub.add_parser("init", help="从示例世界复制一份到 worlds 目录")
    init.add_argument("name", nargs="?", default="lamp-harbor")
    init.add_argument("--config", type=Path)

    imp = sub.add_parser("import-card", help="导入角色卡（YAML / JSON / PNG）")
    imp.add_argument("card", type=Path)
    imp.add_argument("--world", required=True)
    imp.add_argument("--id")
    imp.add_argument("--present", action="store_true")
    imp.add_argument("--config", type=Path)

    lore = sub.add_parser("import-lore", help="导入世界书 JSON/YAML")
    lore.add_argument("file", type=Path)
    lore.add_argument("--world", required=True)
    lore.add_argument("--config", type=Path)

    lib = sub.add_parser("import-library", help="从 nmem library 拉取角色卡")
    lib.add_argument("source_id")
    lib.add_argument("--world", required=True)
    lib.add_argument("--id")
    lib.add_argument("--space")
    lib.add_argument("--config", type=Path)

    sub.add_parser("spaces", help="列出 nmem 工作区").add_argument("--config", type=Path)

    pr = sub.add_parser("prompts", help="显示实际加载的提示词文件")
    pr.add_argument("world", nargs="?")
    pr.add_argument("--config", type=Path)

    st = sub.add_parser("status", help="显示世界与会话状态")
    st.add_argument("world")
    st.add_argument("--config", type=Path)

    serve = sub.add_parser("serve", help="启动 Web UI")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--config", type=Path)

    args = parser.parse_args(argv)
    config = load_config(getattr(args, "config", None))
    if args.cmd == "play":
        return cmd_play(args, config)
    if args.cmd == "init":
        return cmd_init(args, config)
    if args.cmd == "import-card":
        return cmd_import_card(args, config)
    if args.cmd == "import-lore":
        return cmd_import_lore(args, config)
    if args.cmd == "import-library":
        return cmd_import_library(args, config)
    if args.cmd == "spaces":
        return cmd_spaces(config)
    if args.cmd == "prompts":
        return cmd_prompts(args, config)
    if args.cmd == "status":
        return cmd_status(args, config)
    if args.cmd == "serve":
        return cmd_serve(args, config)
    parser.error("unknown command")
    return 2


def cmd_init(args: argparse.Namespace, config: AppConfig) -> int:
    src = find_example_world()
    dest = config.worlds_dir / args.name
    if dest.exists():
        print(f"already exists: {dest}", file=sys.stderr)
        return 1
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns("sessions", "__pycache__"))
    print(dest)
    return 0


def cmd_import_card(args: argparse.Namespace, config: AppConfig) -> int:
    pack = load_world(resolve_world_root(args.world, config.worlds_dir))
    src = Path(args.card)
    card = load_card(src, default_id=args.id or "")
    cid = args.id or card.id or slugify(card.name)
    card.id = cid
    pack.characters_dir.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() in {".json", ".png"}:
        rel = Path("characters") / f"{cid}.json"
        dest = pack.root / rel
        if src.suffix.lower() == ".json":
            shutil.copy2(src, dest)
        else:
            dest.write_text(json.dumps(card.to_export_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        rel = Path("characters") / f"{cid}.yaml"
        save_card_yaml(card, pack.root / rel)
    pack.upsert_cast(
        CastMember(
            id=cid,
            name=card.name,
            card=str(rel).replace("\\", "/"),
            blurb="",
            present=bool(args.present),
            aliases=aliases_from_card(card),
        )
    )
    print(pack.root / rel)
    return 0


def cmd_import_lore(args: argparse.Namespace, config: AppConfig) -> int:
    pack = load_world(resolve_world_root(args.world, config.worlds_dir))
    pack.lorebooks_dir.mkdir(parents=True, exist_ok=True)
    dest = pack.lorebooks_dir / args.file.name
    shutil.copy2(args.file, dest)
    print(dest)
    return 0


def cmd_import_library(args: argparse.Namespace, config: AppConfig) -> int:
    pack = load_world(resolve_world_root(args.world, config.worlds_dir))
    space = args.space or resolve_nmem_space(None, pack, config)
    client = NmemClient(binary=config.nmem.binary, space=space)
    if not client.available:
        print("nmem not found on PATH", file=sys.stderr)
        return 1
    try:
        text = client.library_read(args.source_id)
    except NmemError as exc:
        print(exc, file=sys.stderr)
        return 1
    dest = pack.characters_dir / f"{args.id or args.source_id}.txt"
    pack.characters_dir.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")
    print(dest)
    return 0


def cmd_spaces(config: AppConfig) -> int:
    client = NmemClient(binary=config.nmem.binary)
    if not client.available:
        print("nmem not found on PATH", file=sys.stderr)
        return 1
    try:
        spaces = client.list_spaces()
    except NmemError as exc:
        print(exc, file=sys.stderr)
        return 1
    if not spaces:
        print("(no spaces)")
        return 0
    for item in spaces:
        print(f"{item.id}\t{item.name}")
    return 0


def cmd_prompts(args: argparse.Namespace, config: AppConfig) -> int:
    world_dir = None
    if args.world:
        pack = load_world(resolve_world_root(args.world, config.worlds_dir))
        world_dir = pack.prompts_dir
    library = PromptLibrary(
        package_dir=package_prompts_dir(),
        user_dir=default_user_prompts_dir(),
        world_dir=world_dir,
    )
    for item in library.inventory():
        print(f"{item.layer:8} {item.name}\t{item.path}")
    return 0


def cmd_status(args: argparse.Namespace, config: AppConfig) -> int:
    pack = load_world(resolve_world_root(args.world, config.worlds_dir))
    session = latest_session(pack.sessions_dir)
    space = resolve_nmem_space(None, pack, config)
    print(f"world\t{pack.name} ({pack.world_id})")
    print(f"root\t{pack.root}")
    print(f"cast\t{len(pack.cast)}")
    print(f"nmem.space\t{space or '(unset — will not write to default)'}")
    if session:
        print(f"session\t{session.session_id} ({len(session.messages)} messages)")
        print(f"thread\t{session.thread_id or '-'}")
    else:
        print("session\t(none)")
    return 0


def cmd_serve(args: argparse.Namespace, config: AppConfig) -> int:
    import uvicorn

    from lightrp.server import create_app

    app = create_app(config)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def cmd_play(args: argparse.Namespace, config: AppConfig) -> int:
    try:
        root = resolve_world_root(args.world, config.worlds_dir)
    except FileNotFoundError:
        try:
            example = find_example_world()
        except FileNotFoundError:
            example = None
        if args.world in {"_example", "lamp-harbor", "example"} and example:
            root = example
        else:
            print(f"world not found: {args.world}", file=sys.stderr)
            print("hint: lightrp init lamp-harbor", file=sys.stderr)
            return 1
    pack = load_world(root)
    ensure_world_files(pack.root)
    pack = load_world(pack.root)
    pack.sessions_dir.mkdir(parents=True, exist_ok=True)
    if args.session:
        path = pack.sessions_dir / args.session
        session = load_session(path) if path.exists() else create_session(pack.sessions_dir, args.session)
    elif args.new:
        session = create_session(pack.sessions_dir)
    else:
        session = latest_session(pack.sessions_dir) or create_session(pack.sessions_dir)
    engine = Engine(pack, config, session, nmem_space=args.space)
    _print_play_banner(engine)
    opening = engine.opening()
    if opening and not session.messages:
        print(opening)
        print()
    return _repl(engine)


def _print_play_banner(engine: Engine) -> None:
    space = engine.nmem.space or "(unset)"
    print(f"Light RP · {engine.pack.name} · session {engine.session.session_id}")
    print(f"nmem space: {space}")
    for warning in engine.warnings:
        print(f"! {warning}", file=sys.stderr)
    print("/help 退出 /quit")
    print()


def _repl(engine: Engine) -> int:
    while True:
        try:
            line = input("> ").rstrip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            continue
        if line.startswith("/"):
            code = _command(engine, line)
            if code == "quit":
                return 0
            continue
        try:
            result = engine.turn(line)
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            continue
        print()
        print(result.text)
        print()
        for warning in result.warnings:
            print(f"! {warning}", file=sys.stderr)
    return 0


def _command(engine: Engine, line: str) -> str | None:
    parts = line.split(maxsplit=1)
    cmd = parts[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""
    if cmd in {"/quit", "/exit", "/q"}:
        return "quit"
    if cmd == "/help":
        print("/quit /compact /space <name> /scene /memory /status /prompts")
        return None
    if cmd == "/compact":
        try:
            summary = engine.compact()
        except Exception as exc:  # noqa: BLE001
            print(f"error: {exc}", file=sys.stderr)
            return None
        print(summary)
        return None
    if cmd == "/space":
        if not arg:
            print(engine.nmem.space or "(unset)")
            return None
        engine.nmem.set_space(arg)
        engine.session.nmem_space = engine.nmem.space
        engine.session.save_meta()
        print(f"nmem space: {engine.nmem.space}")
        return None
    if cmd == "/scene":
        print(engine.scene.as_yaml())
        return None
    if cmd == "/memory":
        print(engine.memory.live_text("world") or "(empty)")
        return None
    if cmd == "/status":
        print(f"{engine.pack.world_id} session={engine.session.session_id} space={engine.nmem.space or '(unset)'}")
        print(f"messages={len(engine.session.messages)} present={engine.scene.present}")
        return None
    if cmd == "/prompts":
        for item in engine.prompts.inventory():
            print(f"{item.layer:8} {item.name}\t{item.path}")
        return None
    print(f"unknown command: {cmd}", file=sys.stderr)
    return None


if __name__ == "__main__":
    raise SystemExit(main())

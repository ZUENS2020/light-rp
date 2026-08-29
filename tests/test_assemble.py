from __future__ import annotations

from lightrp.assemble import assemble_system, render_cast_index, render_lore, select_mini_members, with_breach_phi
from lightrp.lorebook import LoreEntry, load_lorebook, trigger_lore
from lightrp.memory import MemoryStore
from lightrp.paths import find_example_world, package_prompts_dir
from lightrp.promptlib import PromptLibrary
from lightrp.scene import load_scene
from lightrp.world import load_world


def test_present_cast_and_lore_in_prompt() -> None:
    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    scene.present = ["anlan"]
    memory = MemoryStore(pack.root)
    memory.load_from_disk()
    lib = PromptLibrary(package_dir=package_prompts_dir())
    cards = [pack.load_member_card(pack.member("anlan"))]  # type: ignore[arg-type]
    lore = trigger_lore(
        load_lorebook(pack.lorebook_files()[0]),
        haystack="灯塔",
        scene_text=scene.haystack(),
        token_budget=1024,
    )
    prompt = assemble_system(lib, pack, memory, scene, cards, lore, nmem_recall="")
    assert "阿澜" in prompt
    assert "小雾" in render_cast_index(pack, scene.present)
    assert "灯塔每晚必亮" in prompt or "灯塔" in prompt
    assert "你是这个世界的 GM" in prompt
    extra = lib.text("layers/breach.md")
    with_breach = assemble_system(lib, pack, memory, scene, cards, lore, nmem_recall="", extra_system=extra)
    assert extra.splitlines()[0] in with_breach
    assert with_breach.index(extra.splitlines()[0]) < with_breach.index("你是这个世界的 GM")


def test_breach_phi_appended_after_user() -> None:
    lib = PromptLibrary(package_dir=package_prompts_dir())
    line = "我掐住他的喉咙。"
    messages = [{"role": "user", "content": line}]
    with_phi = with_breach_phi(messages, lib, True)
    assert with_phi[0]["content"] == line
    assert with_phi[-1]["role"] == "system"
    assert "I will generate the response" in with_phi[-1]["content"]
    assert with_breach_phi(messages, lib, False) == messages


def test_lore_uses_entry_char_name() -> None:
    lib = PromptLibrary(package_dir=package_prompts_dir())
    entries = [LoreEntry(keys=["a"], content="{{char}} 的秘密", char_name="铃鹿", source="suzuka")]
    text = render_lore(lib, entries, "玩家", "阿澜")
    assert "铃鹿 的秘密" in text
    assert "阿澜" not in text


def test_old_scene_notes_become_scene() -> None:
    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    assert "海风很大" in (scene.scene or scene.notes)
    assert scene.location


def test_mini_activation_keeps_present_and_mentions() -> None:
    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    scene.present = ["anlan", "xiaowu"]
    minis = select_mini_members(pack, scene, haystack="去茶铺", mention_ids=[], primary_id="anlan")
    assert {item.id for item in minis} == {"xiaowu"}
    mentioned = select_mini_members(pack, scene, haystack="", mention_ids=["xiaowu"], primary_id="anlan")
    assert {item.id for item in mentioned} == {"xiaowu"}


def test_full_and_mini_in_prompt() -> None:
    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    memory = MemoryStore(pack.root)
    memory.load_from_disk()
    lib = PromptLibrary(package_dir=package_prompts_dir())
    primary = [pack.load_member_card(pack.member("anlan"))]  # type: ignore[arg-type]
    mini = [pack.load_member_card(pack.member("xiaowu"))]  # type: ignore[arg-type]
    prompt = assemble_system(lib, pack, memory, scene, primary, [], nmem_recall="", mini_cards=mini)
    assert "多人场角色卡" in prompt
    assert "小雾" in prompt and "· Mini" in prompt
    assert prompt.index("阿澜") < prompt.index("· Mini")

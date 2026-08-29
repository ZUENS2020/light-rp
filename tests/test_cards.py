from __future__ import annotations

import base64
import json
from pathlib import Path

from lightrp.cards import CharacterCard, aliases_from_card, ensemble_acting, load_card
from lightrp.pngcard import write_png_with_text


def test_hermes_yaml(tmp_path: Path) -> None:
    path = tmp_path / "lin.yaml"
    path.write_text("name: 林\ndescription: 黑发\npersonality: 冷\nspeech: 短句\n", encoding="utf-8")
    card = load_card(path)
    assert card.name == "林"
    assert "黑发" in card.description


def test_st_v2(tmp_path: Path) -> None:
    payload = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "Ava",
            "description": "tall",
            "personality": "wry",
            "first_mes": "Hi {{user}}",
            "character_book": {
                "entries": [
                    {
                        "keys": ["harbor"],
                        "content": "Ava knows the harbor.",
                        "enabled": True,
                        "insertion_order": 1,
                        "extensions": {},
                        "constant": False,
                    }
                ]
            },
        },
    }
    path = tmp_path / "ava.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    card = load_card(path)
    assert card.name == "Ava"
    assert card.character_book is not None
    sub = card.substitute("Ren")
    assert sub.first_mes == "Hi Ren"


def test_st_v2_original_and_phi(tmp_path: Path) -> None:
    payload = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "铃鹿",
            "description": "逃马",
            "personality": "短句",
            "system_prompt": "{{original}}\n只扮演{{char}}。",
            "post_history_instructions": "继续只以{{char}}回应。",
            "character_book": {
                "entries": [{"name": "名号", "keys": ["铃鹿", "Silence Suzuka"], "content": "名号。", "enabled": True}]
            },
        },
    }
    path = tmp_path / "suzuka.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    card = load_card(path)
    assert "{{original}}" not in card.system_prompt
    assert "只扮演{{char}}" in card.system_prompt
    assert "继续只以{{char}}回应" in card.post_history_instructions
    assert "Silence Suzuka" in aliases_from_card(card)
    filled = card.substitute("玩家")
    assert "扮演「铃鹿」时遵守" in ensemble_acting(filled.system_prompt, filled.name)
    assert "写到「铃鹿」时用该角色口吻" in ensemble_acting(filled.post_history_instructions, filled.name)


def test_aliases_from_key_field() -> None:
    card = CharacterCard(
        id="suzuka",
        name="无声铃鹿",
        character_book={"entries": [{"name": "名号", "key": ["Silence Suzuka", "{{char}}"]}]},
    )
    aliases = aliases_from_card(card)
    assert "Silence Suzuka" in aliases
    assert "{{char}}" not in aliases


def test_st_v3(tmp_path: Path) -> None:
    payload = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {"name": "Bo", "description": "quiet", "personality": "soft"},
    }
    path = tmp_path / "bo.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert load_card(path).name == "Bo"


def test_png_chara(tmp_path: Path) -> None:
    inner = {
        "spec": "chara_card_v2",
        "data": {"name": "Pix", "description": "from png", "personality": "bright"},
    }
    encoded = base64.b64encode(json.dumps(inner).encode("utf-8")).decode("ascii")
    path = tmp_path / "pix.png"
    write_png_with_text(path, {"chara": encoded})
    card = load_card(path)
    assert card.name == "Pix"
    assert "from png" in card.description

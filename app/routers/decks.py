"""
题库主题路由：主题的增删改查，以及各主题的卡片数量统计

题库主题（decks）用于将题目归类到不同主题（如「操作系统」「计算机网络」），
卡片通过 deck_id 外键归属某个主题；删除主题会级联删除其下全部卡片。
"""
from typing import List

from fastapi import APIRouter, HTTPException

from ..database import DEFAULT_DECK_NAME, execute_write, get_conn, query_all, query_one

router = APIRouter(prefix="/api/decks", tags=["题库主题"])


def _resolve_default_id() -> int:
    """返回默认题库 ID（确保存在）"""
    row = query_one("SELECT id FROM decks WHERE name = ?", (DEFAULT_DECK_NAME,))
    if row:
        return row["id"]
    return execute_write("INSERT INTO decks (name) VALUES (?)", (DEFAULT_DECK_NAME,))


@router.get("", response_model=List[dict], summary="题库主题列表（含卡片数）")
def list_decks():
    """返回全部题库主题及其下卡片数量，供前端切换/多选题库使用"""
    rows = query_all(
        """
        SELECT d.id, d.name, COUNT(c.id) AS card_count
        FROM decks d LEFT JOIN cards c ON c.deck_id = d.id
        GROUP BY d.id, d.name
        ORDER BY d.id
        """
    )
    return [dict(r) for r in rows]


@router.post("", response_model=dict, status_code=201, summary="新建题库主题")
def create_deck(body: dict):
    """新建一个题库主题（名称唯一，不可为空）"""
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="题库名称不能为空")
    exists = query_one("SELECT id FROM decks WHERE name = ?", (name,))
    if exists:
        raise HTTPException(status_code=409, detail=f"已存在同名题库：{name}")

    new_id = execute_write("INSERT INTO decks (name) VALUES (?)", (name,))
    row = query_one("SELECT id, name, 0 AS card_count FROM decks WHERE id = ?", (new_id,))
    return dict(row)


@router.put("/{deck_id}", response_model=dict, summary="重命名题库主题")
def rename_deck(deck_id: int, body: dict):
    """重命名指定题库主题（默认题库也可改名）"""
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="题库名称不能为空")
    row = query_one("SELECT id FROM decks WHERE id = ?", (deck_id,))
    if not row:
        raise HTTPException(status_code=404, detail="题库不存在")
    clash = query_one("SELECT id FROM decks WHERE name = ? AND id != ?", (name, deck_id))
    if clash:
        raise HTTPException(status_code=409, detail=f"已存在同名题库：{name}")

    conn = get_conn()
    try:
        conn.execute(
            "UPDATE decks SET name = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
            (name, deck_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": deck_id, "name": name}


@router.delete("/{deck_id}", status_code=204, summary="删除题库主题")
def delete_deck(deck_id: int):
    """
    删除题库主题：级联删除其下全部卡片（及关联错题记录）。
    至少保留一个题库，避免系统无主题可用。
    """
    total = query_one("SELECT COUNT(*) AS cnt FROM decks")
    if total and total["cnt"] <= 1:
        raise HTTPException(status_code=400, detail="至少需保留一个题库主题")

    row = query_one("SELECT id FROM decks WHERE id = ?", (deck_id,))
    if not row:
        raise HTTPException(status_code=404, detail="题库不存在")

    conn = get_conn()
    try:
        # 外键 ON DELETE CASCADE 会一并清理 cards 与 wrong_book
        conn.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
        conn.commit()
    finally:
        conn.close()

"""
学习与错题本路由：获取学习牌组、标记对错、错题本管理
"""
import random
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..database import execute_write, get_conn, query_all, query_one
from ..models import StudyResult, WrongBookItem

router = APIRouter(prefix="/api", tags=["学习与错题本"])


@router.get("/study/deck", response_model=List[WrongBookItem], summary="获取学习牌组")
def get_deck(
    mode: str = Query("all", pattern="^(all|wrong)$", description="all=全部题目 / wrong=仅错题"),
    shuffle: bool = Query(False, description="是否打乱顺序"),
    cards: int = Query(0, ge=0, description="牌组数量上限（对应前端 cards 参数），0 表示不限制"),
    deck_ids: str = Query("", description="逗号分隔的题库主题 ID，空表示全部题库（支持多选）"),
):
    """
    获取逐卡学习的题目序列：
    - mode=all：全题库学习
    - mode=wrong：错题重练（仅错题本题目）
    - shuffle：支持随机打乱，避免记忆顺序化
    - deck_ids：按选中的题库主题筛选（多选），为空则不过滤
    """
    # 解析并校验 deck_ids，构造 IN 子句参数
    deck_params: list = []
    deck_clause = ""
    if deck_ids:
        try:
            deck_params = [int(x) for x in deck_ids.split(",") if x.strip()]
        except ValueError:
            deck_params = []
        if deck_params:
            placeholders = ",".join("?" * len(deck_params))
            deck_clause = f" AND c.deck_id IN ({placeholders})"

    if mode == "wrong":
        # 错题模式：关联错题表，按最近答错时间倒序（打乱后无意义）
        sql = f"""
            SELECT c.id AS card_id, c.question, c.answer, c.question_type, c.ai_summary,
                   w.wrong_count, w.last_wrong_at,
                   c.deck_id AS deck_id, d.name AS deck_name
            FROM wrong_book w JOIN cards c ON c.id = w.card_id
            LEFT JOIN decks d ON d.id = c.deck_id
            WHERE 1=1{deck_clause}
            ORDER BY w.last_wrong_at DESC
        """
        rows = query_all(sql, tuple(deck_params))
    else:
        rows = query_all(
            f"SELECT c.id AS card_id, c.question, c.answer, c.question_type, c.ai_summary, "
            f"0 AS wrong_count, '' AS last_wrong_at, "
            f"c.deck_id AS deck_id, d.name AS deck_name "
            f"FROM cards c LEFT JOIN decks d ON d.id = c.deck_id "
            f"WHERE 1=1{deck_clause} ORDER BY c.id",
            tuple(deck_params),
        )

    # 打乱逻辑放在 SQL 之外，保证两种模式的打乱行为一致
    if shuffle:
        random.shuffle(rows)
    if cards > 0:
        rows = rows[:cards]

    return [WrongBookItem(**r) for r in rows]


@router.post("/study/{card_id}/result", summary="记录答题结果")
def record_result(card_id: int, body: StudyResult):
    """
    学习过程中的核心交互：
    - wrong：写入/累加错题本
    - correct：从错题本移除（表示已掌握）
    """
    card = query_one("SELECT id FROM cards WHERE id = ?", (card_id,))
    if not card:
        raise HTTPException(status_code=404, detail="题目不存在")

    conn = get_conn()
    try:
        if body.result == "wrong":
            # 答错：存在则错误次数 +1 并刷新时间，否则新增记录
            conn.execute(
                """
                INSERT INTO wrong_book (card_id) VALUES (?)
                ON CONFLICT(card_id) DO UPDATE SET
                    wrong_count = wrong_count + 1,
                    last_wrong_at = datetime('now', 'localtime')
                """,
                (card_id,),
            )
        else:
            # 答对：从错题本移除（掌握后不再出现在错题重练中）
            conn.execute("DELETE FROM wrong_book WHERE card_id = ?", (card_id,))
        conn.commit()
    finally:
        conn.close()

    return {"card_id": card_id, "result": body.result}


# ---------- 错题本 ----------

@router.get("/wrongbook", response_model=List[WrongBookItem], summary="错题本列表")
def list_wrong():
    """返回全部错题，按错误次数降序 + 最近答错时间倒序"""
    rows = query_all(
        """
        SELECT c.id AS card_id, c.question, c.answer, c.question_type, c.ai_summary,
               w.wrong_count, w.last_wrong_at,
               c.deck_id AS deck_id, d.name AS deck_name
        FROM wrong_book w JOIN cards c ON c.id = w.card_id
        LEFT JOIN decks d ON d.id = c.deck_id
        ORDER BY w.wrong_count DESC, w.last_wrong_at DESC
        """
    )
    return [WrongBookItem(**r) for r in rows]


@router.get("/wrongbook/count", response_model=dict, summary="错题数量统计")
def wrong_count():
    row = query_one("SELECT COUNT(*) AS cnt FROM wrong_book")
    return {"count": row["cnt"] if row else 0}


@router.get("/stats", response_model=dict, summary="题库整体统计")
def stats():
    """首页/学习页展示的统计信息"""
    total_row = query_one("SELECT COUNT(*) AS cnt FROM cards")
    wrong_row = query_one("SELECT COUNT(*) AS cnt FROM wrong_book")
    type_rows = query_all(
        "SELECT question_type, COUNT(*) AS cnt FROM cards GROUP BY question_type ORDER BY cnt DESC"
    )
    return {
        "total_cards": total_row["cnt"] if total_row else 0,
        "total_wrong": wrong_row["cnt"] if wrong_row else 0,
        "by_type": [{"type": r["question_type"], "count": r["cnt"]} for r in type_rows],
    }

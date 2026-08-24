"""
题库管理路由：卡片的增删改查、搜索、分页
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from ..database import execute_write, query_all, query_one
from ..models import Card, CardCreate, CardListResponse, CardUpdate

router = APIRouter(prefix="/api/cards", tags=["题库管理"])


def _row_to_card(row: dict) -> Card:
    """数据库行转 Card 模型"""
    return Card(**row)


@router.get("", response_model=CardListResponse, summary="分页查询题目列表")
def list_cards(
    search: str = Query("", description="关键词：模糊匹配问题与答案"),
    question_type: str = Query("", description="按问题类型筛选"),
    source: str = Query("", description="按来源筛选：manual/import/ai"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """支持关键词搜索 + 类型/来源筛选的分页列表"""
    where_clauses: List[str] = []
    params: list = []

    # 动态拼接查询条件（参数化防注入）
    if search:
        where_clauses.append("(question LIKE ? OR answer LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    if question_type:
        where_clauses.append("question_type = ?")
        params.append(question_type)
    if source:
        where_clauses.append("source = ?")
        params.append(source)

    where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

    # 查询总数用于分页
    total_row = query_one(f"SELECT COUNT(*) AS cnt FROM cards {where_sql}", tuple(params))
    total = total_row["cnt"] if total_row else 0

    # 分页取数据，最新创建的排前面
    offset = (page - 1) * page_size
    rows = query_all(
        f"SELECT * FROM cards {where_sql} ORDER BY id DESC LIMIT ? OFFSET ?",
        tuple(params) + (page_size, offset),
    )

    return CardListResponse(total=total, items=[_row_to_card(r) for r in rows])


@router.get("/types", response_model=list, summary="获取所有问题类型（去重）")
def list_types():
    """返回题库中已使用的全部问题类型，供前端下拉筛选"""
    rows = query_all("SELECT DISTINCT question_type FROM cards ORDER BY question_type")
    return [r["question_type"] for r in rows]


@router.get("/{card_id}", response_model=Card, summary="查询单个题目")
def get_card(card_id: int):
    row = query_one("SELECT * FROM cards WHERE id = ?", (card_id,))
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")
    return _row_to_card(row)


@router.post("", response_model=Card, status_code=201, summary="新增题目")
def create_card(body: CardCreate):
    """用户自定义录入题目：问题、答案、类型"""
    new_id = execute_write(
        "INSERT INTO cards (question, answer, question_type, ai_summary, source) VALUES (?, ?, ?, ?, 'manual')",
        (body.question.strip(), body.answer.strip(), body.question_type.strip() or "问答", body.ai_summary.strip()),
    )
    row = query_one("SELECT * FROM cards WHERE id = ?", (new_id,))
    return _row_to_card(row)


@router.put("/{card_id}", response_model=Card, summary="更新题目")
def update_card(card_id: int, body: CardUpdate):
    """部分更新：仅修改请求中携带的字段；答案修改不设限但前端有原文对照提醒"""
    row = query_one("SELECT * FROM cards WHERE id = ?", (card_id,))
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")

    # 仅更新非空字段
    updates = {
        "question": body.question,
        "answer": body.answer,
        "question_type": body.question_type,
        "ai_summary": body.ai_summary,
    }
    set_parts = ["updated_at = datetime('now', 'localtime')"]
    params: list = []
    for col, val in updates.items():
        if val is not None:
            set_parts.append(f"{col} = ?")
            params.append(val.strip())
    params.append(card_id)

    from ..database import get_conn

    conn = get_conn()
    try:
        conn.execute(f"UPDATE cards SET {', '.join(set_parts)} WHERE id = ?", tuple(params))
        conn.commit()
    finally:
        conn.close()

    new_row = query_one("SELECT * FROM cards WHERE id = ?", (card_id,))
    return _row_to_card(new_row)


@router.delete("/{card_id}", status_code=204, summary="删除题目")
def delete_card(card_id: int):
    """删除题目（错题本记录通过外键级联删除）"""
    row = query_one("SELECT id FROM cards WHERE id = ?", (card_id,))
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")

    from ..database import get_conn

    conn = get_conn()
    try:
        conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))
        conn.commit()
    finally:
        conn.close()


@router.post("/batch", response_model=dict, status_code=201, summary="批量导入题目")
def batch_create(items: List[CardCreate], source: str = "import"):
    """文件导入/AI 生成的批量入库入口，跳过重复问题（以问题文本判重）"""
    inserted = 0
    skipped = 0
    for item in items:
        # 以问题全文判重：避免同一笔记重复导入产生冗余卡片
        exists = query_one("SELECT id FROM cards WHERE question = ?", (item.question.strip(),))
        if exists:
            skipped += 1
            continue
        execute_write(
            "INSERT INTO cards (question, answer, question_type, ai_summary, source) VALUES (?, ?, ?, ?, ?)",
            (
                item.question.strip(),
                item.answer.strip(),
                item.question_type.strip() or "问答",
                item.ai_summary.strip(),
                source,
            ),
        )
        inserted += 1

    return {"inserted": inserted, "skipped": skipped}

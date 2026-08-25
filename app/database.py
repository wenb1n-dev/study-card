"""
SQLite 数据库访问层

设计要点：
- 使用标准库 sqlite3，零额外依赖；
- WAL 模式提升读写并发性能；
- 每次请求独立连接（FastAPI 同步路由自动放入线程池），用 row_factory 返回字典；
- 数据库文件固定在项目根目录 data/studycard.db。
"""
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

# 数据库文件路径：项目根目录/data/studycard.db
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "studycard.db"

# 默认题库名称：历史卡片与未指定题库时使用，确保外键非空
DEFAULT_DECK_NAME = "默认题库"


def get_conn() -> sqlite3.Connection:
    """获取数据库连接（每请求独立，WAL 模式，返回字典行）"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # 开启外键约束（SQLite 默认关闭）
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    """初始化数据库表结构（幂等执行）"""
    conn = get_conn()
    try:
        # WAL 模式：允许读写并发，适合 Web 应用场景
        conn.execute("PRAGMA journal_mode = WAL")

        # 题库主表：存储问答卡片
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cards (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                question      TEXT NOT NULL,              -- 卡片正面：问题
                answer        TEXT NOT NULL,              -- 卡片背面：答案（必须与笔记原文一致）
                question_type TEXT NOT NULL DEFAULT '',-- 问题类型：概念/原理/实践/对比/排查等
                ai_summary    TEXT NOT NULL DEFAULT '',   -- AI 辅助总结（答案底部展示，不篡改原文）
                source        TEXT NOT NULL DEFAULT 'manual', -- 来源：manual=手工 / import=文件导入 / ai=AI生成
                deck_id       INTEGER NOT NULL DEFAULT 1, -- 所属题库主题（外键关联 decks）
                created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
            )
            """
        )

        # 题库主题表：将题目归类到不同主题（如「操作系统」「计算机网络」）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS decks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,         -- 题库主题名称
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )

        # 确保存在默认题库，供历史卡片与未指定题库时使用
        default_row = conn.execute(
            "SELECT id FROM decks WHERE name = ?", (DEFAULT_DECK_NAME,)
        ).fetchone()
        if default_row is None:
            cur = conn.execute("INSERT INTO decks (name) VALUES (?)", (DEFAULT_DECK_NAME,))
            default_id = cur.lastrowid
        else:
            default_id = default_row["id"]

        # 兼容旧库：cards 缺 deck_id 列时追加（SQLite 不允许 ALTER 同时加 REFERENCES 与非空默认值，
        # 故先加可空外键列，再回填历史卡片到默认题库）
        existing_cols = [r[1] for r in conn.execute("PRAGMA table_info(cards)").fetchall()]
        if "deck_id" not in existing_cols:
            conn.execute(
                "ALTER TABLE cards ADD COLUMN deck_id INTEGER "
                "REFERENCES decks(id) ON DELETE CASCADE"
            )
            conn.execute("UPDATE cards SET deck_id = ? WHERE deck_id IS NULL", (default_id,))
        conn.commit()

        # 错题本表：记录答错的题目与错误次数
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS wrong_book (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id       INTEGER NOT NULL UNIQUE,    -- 题目 ID（唯一：一题一条错题记录）
                wrong_count   INTEGER NOT NULL DEFAULT 1, -- 累计错误次数
                last_wrong_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
            )
            """
        )

        # 配置表：键值对存储 AI 接口配置等全局设置
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
            """
        )

        # 常用查询索引：按类型筛选、按来源筛选、按题库筛选、按创建时间排序
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(question_type)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_source ON cards(source)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_wrong_card ON wrong_book(card_id)")

        conn.commit()
    finally:
        conn.close()


def query_all(sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
    """执行查询并返回字典列表"""
    conn = get_conn()
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def query_one(sql: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
    """执行查询单条记录"""
    rows = query_all(sql, params)
    return rows[0] if rows else None


def execute_write(sql: str, params: tuple = ()) -> int:
    """执行写操作并返回 lastrowid"""
    conn = get_conn()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid or 0
    finally:
        conn.close()


def execute_many(sql: str, seq_of_params: list) -> None:
    """批量执行写操作（事务内提交）"""
    conn = get_conn()
    try:
        with conn:  # with 自动 commit/rollback
            conn.executemany(sql, seq_of_params)
    finally:
        conn.close()

"""
初始题库导入脚本

将「一面-技术面试内容.md」格式的笔记（# 问题 + 正文答案，--- 分隔）
解析为问答卡片并批量写入 SQLite 题库。

用法（项目根目录执行）：
    .venv/bin/python scripts/import_initial.py [笔记文件路径]

不传路径时使用默认的坚果云面试笔记。
"""
import sys
from pathlib import Path

# 将项目根目录加入 sys.path 以便导入 app 包
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from app.database import init_db, query_one  # noqa: E402
from app.services.file_parser import parse_markdown_qa  # noqa: E402
import sqlite3  # noqa: E402

# 默认初始题库：一面技术面试笔记
DEFAULT_NOTES = Path(
    "/Users/xuwenbin/Library/CloudStorage/坚果云-xwb602625136@163.com/mybook/myBook/自媒体/面试/一面-技术面试内容.md"
)


def import_notes(note_path: Path) -> None:
    """解析笔记并入库（按问题文本判重）"""
    if not note_path.exists():
        print(f"[错误] 笔记文件不存在: {note_path}")
        sys.exit(1)

    content = note_path.read_text(encoding="utf-8", errors="replace")
    qa_pairs = parse_markdown_qa(content)
    print(f"[解析] 共识别出 {len(qa_pairs)} 个问答对")

    if not qa_pairs:
        print("[警告] 未识别出任何问答对，请检查文件格式")
        sys.exit(0)

    conn = sqlite3.connect(PROJECT_ROOT / "data" / "studycard.db")
    try:
        inserted, skipped = 0, 0
        for pair in qa_pairs:
            exists = conn.execute(
                "SELECT id FROM cards WHERE question = ?", (pair["question"],)
            ).fetchone()
            if exists:
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO cards (question, answer, question_type, ai_summary, source) "
                "VALUES (?, ?, ?, ?, 'import')",
                (pair["question"], pair["answer"], pair["question_type"], pair["ai_summary"]),
            )
            inserted += 1
        conn.commit()
        print(f"[入库] 新增 {inserted} 题，跳过重复 {skipped} 题")

        total = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
        print(f"[题库] 当前总题数: {total}")
    finally:
        conn.close()


if __name__ == "__main__":
    # 支持命令行传入自定义笔记路径
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_NOTES
    print(f"[初始化] 数据库: {PROJECT_ROOT / 'data' / 'studycard.db'}")
    init_db()
    import_notes(target)

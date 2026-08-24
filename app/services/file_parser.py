"""
笔记文本解析服务

职责：
1. 从 markdown / txt / pdf 文件提取纯文本；
2. 解析「# 标题为问题 + 正文为答案」结构的 markdown（初始题库即此格式）。

核心约束：答案内容必须忠实于原文，不做改写。
"""
import re
from pathlib import Path
from typing import Dict, List


def extract_text_from_file(file_path: Path, filename: str) -> str:
    """根据文件扩展名分发到对应的文本提取器"""
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(file_path)
    elif suffix in (".md", ".markdown", ".txt"):
        # 显式按 utf-8 读取，容错处理非法字符
        return file_path.read_text(encoding="utf-8", errors="replace")
    else:
        raise ValueError(f"不支持的文件格式: {suffix}（仅支持 md / txt / pdf）")


def _extract_pdf(file_path: Path) -> str:
    """使用 pypdf 提取 PDF 全文文本"""
    from pypdf import PdfReader

    reader = PdfReader(str(file_path))
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages.append(text)
    return "\n".join(pages)


def parse_markdown_qa(content: str) -> List[Dict[str, str]]:
    """
    解析结构化 markdown 笔记为问答对列表（不调用 AI，纯规则解析）。

    约定的笔记格式（也是初始题库文件的格式）：
        # 问题标题
        答案正文（可多行、含列表/表格/代码块）
        ---
        # 下一个问题
        ...

    规则：
    - 一级标题 `# ` 行作为问题；
    - 标题之后到下一个一级标题之间的全部内容作为答案（保持原文，不删改）；
    - 答案中的分隔线 `---` 与首尾空行被清理，其余原样保留；
    - 跳过无答案内容的空标题。
    """
    lines = content.splitlines()
    qa_pairs: List[Dict[str, str]] = []
    current_question: str | None = None
    answer_lines: List[str] = []

    def flush():
        """将当前累积的问题+答案写入结果集"""
        nonlocal current_question, answer_lines
        if current_question is None:
            return
        # 清理答案：去掉首尾空行；若整段只有分隔线则视为无答案
        cleaned = [ln for ln in answer_lines]
        while cleaned and not cleaned[0].strip():
            cleaned.pop(0)
        while cleaned and not cleaned[-1].strip():
            cleaned.pop()
        # 去掉答案内部独立的水平分隔线（--- / *** / ___）
        body = "\n".join(ln for ln in cleaned if not re.fullmatch(r"\s*([-*_])\1{2,}\s*", ln))
        body = body.strip()
        if body:
            qa_pairs.append(
                {
                    "question": current_question.strip(),
                    "answer": body,
                    # 规则解析无法判断类型，统一归为「问答」，用户可在前端修改
                    "question_type": "问答",
                    "ai_summary": "",
                }
            )
        current_question = None
        answer_lines = []

    for line in lines:
        # 匹配 ATX 一级标题：`# xxx`（排除 ## 二级及以后、代码块内标题）
        heading_match = re.match(r"^#\s+(.+)$", line)
        if heading_match and not line.startswith("##"):
            flush()  # 遇到新标题，先落盘上一个问答
            current_question = heading_match.group(1).strip()
            # 清理问题中常见的多余标记（如重复的 # 前缀："# InfluxDB 1.x..."）
            current_question = re.sub(r"^#+\s*", "", current_question)
        elif current_question is not None:
            answer_lines.append(line)

    flush()  # 文件末尾最后一个问答
    return qa_pairs

"""
文件导入路由：上传 md / txt / pdf 文件并解析

两种导入路径：
1. 规则解析：markdown「# 标题=问题」结构直接解析入库（无需 AI）；
2. AI 解析：任意文本交给 AI 提取问答对（先预览再确认入库）。
"""
from pathlib import Path
import tempfile
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..models import CardCreate
from ..services.file_parser import extract_text_from_file, parse_markdown_qa
from .cards import batch_create as _batch_create_impl

router = APIRouter(prefix="/api/import", tags=["文件导入"])

# 允许上传的扩展名白名单
ALLOWED_SUFFIXES = {".md", ".markdown", ".txt", ".pdf"}
# 单文件大小上限：20MB（PDF 可能较大）
MAX_FILE_SIZE = 20 * 1024 * 1024


@router.post("/file", response_model=dict, summary="上传文件解析为题目")
async def import_file(
    file: UploadFile = File(..., description="md/txt/pdf 笔记文件"),
    use_ai: bool = Form(False, description="是否调用 AI 智能提取（False 时仅支持规则解析 markdown 结构）"),
    count: int = Form(10, ge=1, le=50, description="AI 模式下期望生成的题目数量"),
):
    """
    上传笔记文件：
    - use_ai=false：纯规则解析，要求文件为「# 问题 + 正文答案」的 markdown 格式，解析后直接入库；
    - use_ai=true：提取全文文本返回给前端，由前端调用 /api/ai/generate 走预览-确认流程。
    """
    filename = file.filename or "unknown"
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式 {suffix}，仅支持：md / txt / pdf")

    # 读取文件内容到临时文件（PDF 需要文件路径），同时校验大小
    content_bytes = await file.read()
    if len(content_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="文件超过 20MB 大小限制")

    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content_bytes)
            tmp_path = Path(tmp.name)

        # 提取全文文本
        text = extract_text_from_file(tmp_path, filename)
    except ValueError:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"文件解析失败：{e}")
    finally:
        if tmp_path and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="未能从文件中提取到文本内容")

    # ---- AI 模式：返回文本，由前端走预览-确认流程 ----
    if use_ai:
        return {"mode": "ai_preview", "text": text, "text_length": len(text)}

    # ---- 规则模式：解析 markdown 结构直接入库 ----
    qa_pairs = parse_markdown_qa(text)
    if not qa_pairs:
        raise HTTPException(
            status_code=422,
            detail="未解析出任何问答对。规则解析要求笔记使用「# 问题标题 + 正文答案」格式；"
                   "非该格式的笔记请勾选「AI 智能提取」。",
        )

    items = [CardCreate(**pair) for pair in qa_pairs]
    # batch_create 为同步路由处理函数，直接调用即可（FastAPI 自动放线程池）
    result = _batch_create_impl(items)
    return {"mode": "rule", "text_length": len(text), **result}

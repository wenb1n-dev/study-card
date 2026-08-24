"""
AI 服务路由：接口配置管理、连接测试、AI 智能出题
"""
import json
from typing import List

from fastapi import APIRouter, HTTPException

from ..database import get_conn, query_one
from ..models import (
    AISettings,
    AISettingsResponse,
    AITestRequest,
    ConfirmImportRequest,
    GenerateItem,
    GenerateRequest,
    GenerateResponse,
)
from ..services.openai_client import chat_completion, extract_json_array

router = APIRouter(prefix="/api/ai", tags=["AI 服务"])

# settings 表中 AI 配置的键名
KEY_API_URL = "ai_api_url"
KEY_API_KEY = "ai_api_key"
KEY_MODEL = "ai_model"


# ---------- 配置管理 ----------

def _load_settings() -> dict:
    """从 settings 表读取 AI 配置"""
    result = {}
    for key in (KEY_API_URL, KEY_API_KEY, KEY_MODEL):
        row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
        result[key] = row["value"] if row else ""
    return {
        "api_url": result[KEY_API_URL],
        "api_key": result[KEY_API_KEY],
        "model": result[KEY_MODEL],
    }


def _save_settings(api_url: str, api_key: str, model: str) -> None:
    """保存 AI 配置（upsert 语义）"""
    conn = get_conn()
    try:
        for key, value in ((KEY_API_URL, api_url), (KEY_API_KEY, api_key), (KEY_MODEL, model)):
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()


def mask_key(key: str) -> str:
    """API Key 脱敏：仅保留末四位"""
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"****{key[-4:]}"


@router.get("/settings", response_model=AISettingsResponse, summary="读取 AI 配置（密钥脱敏）")
def read_settings():
    cfg = _load_settings()
    has_key = bool(cfg["api_key"])
    return AISettingsResponse(
        api_url=cfg["api_url"],
        # 不回传明文密钥，前端展示脱敏值；保存时空值表示不修改
        api_key=mask_key(cfg["api_key"]) if has_key else "",
        model=cfg["model"],
        api_key_masked=has_key,
    )


@router.put("/settings", response_model=dict, summary="保存 AI 配置")
def write_settings(body: AISettings):
    """
    保存配置。特殊规则：api_key 为空字符串且原已配置时，保留原密钥不覆盖，
    避免编辑其他字段时误清空密钥。
    """
    old = _load_settings()
    new_key = body.api_key.strip()
    # 前端回传的是脱敏值（以****开头）或空 → 维持原密钥
    if not new_key or new_key.startswith("****"):
        new_key = old["api_key"]

    _save_settings(body.api_url.strip(), new_key, body.model.strip())
    return {"ok": True}


@router.post("/test", response_model=dict, summary="测试 AI 接口连通性")
async def test_connection(body: AITestRequest):
    """发送一条极短消息验证 url/key/model 是否可用。未传字段自动回落到已保存配置。"""
    saved = _load_settings()
    api_url = body.api_url.strip() or saved["api_url"]
    api_key = body.api_key.strip() or saved["api_key"]
    # 脱敏值不代表真实密钥，直接用已保存的
    if body.api_key.startswith("****"):
        api_key = saved["api_key"]
    model = body.model.strip() or saved["model"]

    try:
        reply = await chat_completion(
            api_url=api_url,
            api_key=api_key,
            model=model,
            messages=[{"role": "user", "content": "回复：OK"}],
            max_tokens=10,
        )
        return {"ok": True, "reply": reply[:50]}
    except (RuntimeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- AI 出题 ----------

# 系统提示词：核心约束——答案必须忠实原文，禁止篡改
GENERATE_SYSTEM_PROMPT = """你是一个专业的学习卡片出题助手。用户会提供一段学习笔记，你需要基于笔记内容生成问答卡片。

严格遵守以下规则：
1. answer 字段必须摘录或严格基于笔记原文组织，禁止编造、篡改、臆测笔记中没有的内容；
2. question 字段是针对答案内容提出的问题，表述清晰独立，能不看原文也能理解问的是什么；
3. question_type 从以下类型中选择最贴切的一个：「概念」「原理」「对比」「实践」「排查」「配置」「问答」；
4. ai_summary 字段结合本题问题与答案，写一段结构化的补充扩展讲解（将用 Markdown 渲染，请用 ### 标题、- 列表、`反引号` 包裹参数/命令）：先点明核心考查机制，再按最贴切的维度（如原理类的「存储-传输-负载-调度」、概念类的「是什么-为什么-怎么用-注意点」）逐维度用"原因/场景 + 解决/排查"拆解，每个维度给出具体可落地手段（真实参数名、命令或优化项），可加一句生活类比；帮助用户真正吃透，而非仅提炼要点；忠实于答案，不得编造与答案矛盾的内容。

输出要求：
- 仅输出 JSON 数组，不要输出任何其他文字说明；
- 数组元素格式：{"question": "...", "answer": "...", "question_type": "...", "ai_summary": "..."}"""


@router.post("/generate", response_model=GenerateResponse, summary="AI 从笔记文本生成题目（预览不入库）")
async def generate_questions(body: GenerateRequest):
    """
    两阶段导入的第一阶段：调用 AI 分析笔记文本生成候选题目。
    返回结果供用户预览确认，确认后经 /confirm 接口入库。
    """
    cfg = _load_settings()
    if not cfg["api_url"] or not cfg["model"]:
        raise HTTPException(status_code=400, detail="请先在「AI 设置」页配置接口地址与模型名称")

    # 文本过长时分段提示（超出多数模型上下文的保护）
    text = body.text.strip()
    if len(text) > 60000:
        text = text[:60000] + "\n\n（注：原文超长已被截断）"

    user_prompt = (
        f"请从下面的学习笔记中提取不超过 {body.count} 个最有价值的问答卡片。\n\n"
        f"=== 笔记开始 ===\n{text}\n=== 笔记结束 ==="
    )

    try:
        reply = await chat_completion(
            api_url=cfg["api_url"],
            api_key=cfg["api_key"],
            model=cfg["model"],
            messages=[
                {"role": "system", "content": GENERATE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,  # 低温度保证输出稳定、贴近原文
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=str(e))

    # 解析 AI 返回的 JSON 数组并逐项校验
    try:
        raw_items = extract_json_array(reply)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=f"AI 输出解析失败：{e}；原始返回前 300 字符：{reply[:300]}")

    items: List[GenerateItem] = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        q = str(it.get("question", "")).strip()
        a = str(it.get("answer", "")).strip()
        if not q or not a:
            continue  # 缺问题或缺答案的条目直接丢弃
        items.append(
            GenerateItem(
                question=q,
                answer=a,
                question_type=str(it.get("question_type", "问答")).strip() or "问答",
                ai_summary=str(it.get("ai_summary", "")).strip(),
            )
        )

    if not items:
        raise HTTPException(status_code=502, detail="AI 未生成有效题目，请检查笔记内容或重试")

    return GenerateResponse(items=items, raw_text_length=len(body.text))


# AI 补充讲解的系统提示词：结合问题+答案，做「核心机制 + 维度拆解 + 可操作解决方案 + 类比」的扩展讲解
SUMMARIZE_SYSTEM_PROMPT = """你是一个善于拆解原理、并能给出落地手段的学习辅导助手。用户会提供一道题的「问题」与「答案」。

你的目标不是复述答案，而是结合问题与答案，给出一段能帮用户真正"吃透并会排查"这道题的「补充扩展讲解」。讲解将以 Markdown 渲染，请使用规范 Markdown 排版，让标题、列表、代码块清晰美观。

请严格按以下结构与格式组织：

### 核心机制
用一段精炼文字点明这道题真正考查的底层机制/本质原理（根因是什么），关键词可用 **加粗** 强调。

### 排查维度与解决方案
针对本题提炼最贴切的维度框架，逐维度用「三级标题 + 列表」展开（不要挤在一行用箭头连接）：
#### 维度名
- **原因 / 典型场景**：……（该维度为何会导致问题、常见表现）。
- **解决 / 排查**：……（可操作的修复手段）。其中可调参数、命令、配置项务必用 `反引号` 包裹，例如 `replica.fetch.max.bytes`；若需多条命令或配置，使用代码块：
  ```bash
  iostat -x 1
  ```
维度选取示例：
- 技术原理类题目，可按「存储-传输-负载-调度」或「定义-原理-对比-易错」逐一排查；
- 概念类题目，可按"是什么-为什么-怎么用-注意点"展开；
- 维度数量以"覆盖本题关键原因"为准（通常 3~5 个）。

解决方案必须具体可落地：给出真实可调参数名、排查命令/方向、配置或架构优化项；若用户答案已给出具体措施，优先采用并展开；若答案未涉及，可补充该领域通用标准排查手段，但必须准确、不得编造与答案矛盾或明显错误的命令。

### 生活类比
（可选但强烈推荐）用一段文字做贴近生活的类比，关键处用 **加粗**，帮助用户记忆与迁移。仅当题目适合类比时补充，不要硬凑；类比必须准确、不与原答案矛盾。

硬性约束：
- 必须忠实于用户给出的「答案」，可补充延伸与机制剖析、可补充通用标准排查手段，但不得编造与原答案矛盾或答案中没有依据的结论；
- 若答案本身已非常完整，仍要给出"核心机制"段、逐维度的"解决/排查"手段，不要只重复答案。

输出要求：
- 仅输出讲解的 Markdown 文本本身，不要使用「总结：」「讲解：」等前缀；
- 参数/命令用 `反引号`、必要时代码块；禁止把"维度名"和"解决方案"写在同一行用「→」连接；
- 长度控制在 5~9 个段落/列表项，信息密度高但不啰嗦。"""

"""
输出要求：
- 仅输出讲解的 Markdown 文本本身，不要使用「总结：」「讲解：」等前缀；
- 必须使用 Markdown：三级标题 `###`、四级标题 `####`、列表 `-`、参数/命令用 `反引号`、必要时代码块；禁止把"维度名"和"解决方案"写在同一行用「→」连接；
- 长度控制在 5~9 个段落/列表项，信息密度高但不啰嗦。
"""

@router.post("/summarize", response_model=dict, summary="AI 结合问题+答案生成补充扩展讲解")
async def summarize_answer(payload: dict):
    """
    为已有卡片生成「补充扩展讲解」（写入 ai_summary 字段，卡片底部展示）。

    与单纯总结答案不同：此处同时接收 question 与 answer，由 AI 结合二者
    给出解题思路、关键概念补充与延伸，帮助用户理解而非仅提炼要点。
    """
    question = str(payload.get("question", "")).strip()
    answer = str(payload.get("answer", "")).strip()
    if not question and not answer:
        raise HTTPException(status_code=400, detail="缺少问题或答案内容")

    cfg = _load_settings()
    try:
        reply = await chat_completion(
            api_url=cfg["api_url"],
            api_key=cfg["api_key"],
            model=cfg["model"],
            messages=[
                {"role": "system", "content": SUMMARIZE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"问题：\n{question}\n\n答案：\n{answer}"
                    ),
                },
            ],
            temperature=0.4,
            max_tokens=1000,
        )
    except (RuntimeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=str(e))

    return {"summary": reply.strip()}


@router.post("/confirm", response_model=dict, status_code=201, summary="确认入库（批量写入题库）")
def confirm_import(body: ConfirmImportRequest):
    """第二阶段：将用户确认过的题目批量写入题库（问题判重跳过）"""
    inserted = 0
    skipped = 0
    from ..database import execute_write, query_one

    for item in body.items:
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
                body.source,
            ),
        )
        inserted += 1

    return {"inserted": inserted, "skipped": skipped}

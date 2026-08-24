"""
Pydantic 数据模型：API 请求/响应的数据校验与文档定义

命名保持英文，字段含义见中文注释。
"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


# ---------- 题库 CRUD ----------

class CardCreate(BaseModel):
    """新建题目请求体"""
    question: str = Field(..., min_length=1, description="卡片正面：问题")
    answer: str = Field(..., min_length=1, description="卡片背面：答案")
    question_type: str = Field(default="", description="题目所属分类/主题（如 kafka、redis、mysql 等，可空）")
    ai_summary: str = Field(default="", description="AI 辅助总结")
    deck_id: Optional[int] = Field(None, description="所属题库主题 ID，缺省归入默认题库")


class CardUpdate(BaseModel):
    """更新题目请求体（部分字段可选）"""
    question: Optional[str] = Field(None, min_length=1)
    answer: Optional[str] = Field(None, min_length=1)
    question_type: Optional[str] = None
    ai_summary: Optional[str] = None
    deck_id: Optional[int] = None


class Card(BaseModel):
    """题目完整数据（响应体）"""
    id: int
    question: str
    answer: str
    question_type: str
    ai_summary: str
    source: str
    deck_id: int
    deck_name: str = ""
    created_at: str
    updated_at: str


class CardListResponse(BaseModel):
    """分页列表响应"""
    total: int
    items: List[Card]


# ---------- 学习与错题本 ----------

class StudyResult(BaseModel):
    """学习结果标记请求体"""
    result: Literal["wrong", "correct"] = Field(..., description="wrong=答错进入错题本 / correct=已掌握移出错题本")


class WrongBookItem(BaseModel):
    """错题本条目（含题目信息与错误统计）"""
    card_id: int
    question: str
    answer: str
    question_type: str
    ai_summary: str
    wrong_count: int
    last_wrong_at: str
    deck_id: int = 0
    deck_name: str = ""


# ---------- AI 配置 ----------

class AISettings(BaseModel):
    """通用 OpenAI 接口配置"""
    api_url: str = Field(default="", description="OpenAI 兼容接口地址，如 https://api.openai.com/v1/chat/completions")
    api_key: str = Field(default="", description="API Key")
    model: str = Field(default="", description="模型名称，如 gpt-4o-mini")


class AISettingsResponse(AISettings):
    """AI 配置响应：api_key 脱敏返回，前端仅展示尾四位"""
    api_key_masked: bool = Field(False, description="是否已配置 API Key（脱敏）")


class AITestRequest(BaseModel):
    """测试 AI 连接请求体（允许临时使用未保存的配置）"""
    api_url: str = ""
    api_key: str = ""
    model: str = ""


class GenerateItem(BaseModel):
    """AI 生成的候选题目（预览阶段，尚未入库）"""
    question: str
    answer: str
    question_type: str = ""
    ai_summary: str = ""


class GenerateRequest(BaseModel):
    """从笔记文本生成题目的请求体"""
    text: str = Field(..., min_length=10, description="笔记原文内容")
    count: int = Field(default=5, ge=1, le=20, description="期望生成的题目数量上限")
    auto_category: bool = Field(default=True, description="是否由 AI 自动识别题目所属分类/主题（如 kafka、redis、mysql）")
    mode: str = Field(default="extract", description="extract=从笔记提取已有问答（答案逐字原文）；generate=基于笔记自动出题（AI 生成新问答）")


class GenerateResponse(BaseModel):
    """AI 生成结果响应"""
    items: List[GenerateItem]
    raw_text_length: int = Field(0, description="输入文本长度")


class ConfirmImportRequest(BaseModel):
    """确认入库请求体：将预览的题目批量写入题库"""
    items: List[GenerateItem] = Field(..., min_length=1)
    source: Literal["manual", "import", "ai"] = "ai"
    deck_id: int = Field(0, description="目标题库主题 ID，0 表示默认题库")

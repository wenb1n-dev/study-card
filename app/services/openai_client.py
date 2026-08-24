"""
通用 OpenAI 兼容接口客户端

支持任意兼容 OpenAI Chat Completions 协议的服务：
- 官方 OpenAI / Azure OpenAI
- 各类中转/代理服务
- 本地部署（Ollama、vLLM、LM Studio 等）

配置项：api_url（完整接口地址）、api_key、model
"""
import json
from typing import List, Dict, Any

import httpx

# 默认请求超时：AI 生成可能较慢，放宽到 120 秒
DEFAULT_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


async def chat_completion(
    api_url: str,
    api_key: str,
    model: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.3,
    max_tokens: int = 4096,
    extra_headers: Dict[str, str] | None = None,
) -> str:
    """
    调用 OpenAI 兼容的 Chat Completions 接口，返回助手回复文本。

    参数:
        api_url: 完整接口地址。若用户只填了 base_url（如 https://api.openai.com/v1），
                 自动补全为 .../chat/completions
        api_key: 鉴权密钥
        model:   模型名称
        messages: OpenAI 消息数组 [{"role": ..., "content": ...}]
    """
    if not api_url or not model:
        raise ValueError("请先在「AI 设置」中配置接口地址与模型名称")

    # 兼容只填 base_url 的写法：自动补全路径
    url = api_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions"

    headers = {
        "Content-Type": "application/json",
        # 兼容部分仅本地部署无需鉴权的服务：key 为空时不发送 Authorization 头
        **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
        **(extra_headers or {}),
    }

    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        try:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            # 上游返回错误码时透出响应体，便于排查（如额度不足、模型名错误）
            detail = e.response.text[:500]
            raise RuntimeError(f"AI 接口返回错误 {e.response.status_code}: {detail}") from e
        except httpx.RequestError as e:
            raise RuntimeError(f"无法连接 AI 接口: {e}") from e

    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"AI 接口响应格式异常: {json.dumps(data, ensure_ascii=False)[:500]}") from e


def extract_json_array(text: str) -> List[Dict[str, Any]]:
    """
    从 AI 回复文本中提取 JSON 数组。

    大模型可能输出 ```json 代码块包裹或夹杂说明文字，也可能因 max_tokens 限制
    被截断（缺结尾 ]）。这里做健壮解析：定位第一个 '['，优先整体解析；
    若被截断则尝试回退到最后一个完整对象边界，恢复一个有效前缀数组。
    """
    import re

    text = text.strip()
    # 去除 markdown 代码块围栏
    if "```" in text:
        parts = text.split("```")
        # 取代码块内容（跳过语言标记行）
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("["):
                text = part
                break

    start = text.find("[")
    if start == -1:
        raise ValueError("AI 返回内容中未找到有效的 JSON 数组")

    end = text.rfind("]")
    if end != -1 and end > start:
        try:
            arr = json.loads(text[start : end + 1])
            return arr if isinstance(arr, list) else []
        except json.JSONDecodeError as e:
            raise ValueError(f"AI 返回的 JSON 解析失败: {e}") from e

    # 没有结尾 ]：视为被 max_tokens 截断，尝试从最后一个完整对象边界恢复
    recovered = _recover_truncated_array(text[start:])
    if recovered is None:
        raise ValueError("AI 返回内容被截断，未形成完整的 JSON 数组")
    return recovered


def _recover_truncated_array(body: str) -> List[Dict[str, Any]] | None:
    """
    输入以 '[' 开头的、被截断的 JSON 数组文本（缺少结尾 ]）。
    回退到最后一个完整对象（} 后跟逗号或结尾）的位置，补齐 ']' 后尝试解析，
    从而丢弃不完整的最后一个元素，保留之前所有完整题目。
    """
    import re

    matches = list(re.finditer(r"\}\s*(?:,|\s*$)", body))
    for m in reversed(matches):
        pos = m.end()
        candidate = body[:pos].rstrip(",") + "]"
        try:
            arr = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(arr, list):
            return arr
    return None

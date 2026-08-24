# 学习卡片 StudyCard

基于个人笔记自动生成问答卡片的学习工具。卡片正面为问题，点击翻转展示答案；支持 AI 出题、题库管理、逐卡学习与错题本。

## 功能特性

| 功能 | 说明 |
|------|------|
| 逐卡学习 | 卡片单个展示，点击翻转看答案，支持上一题/下一题 |
| 答案渲染 | 答案支持完整 Markdown（表格、代码块、引用、列表），marked + DOMPurify 安全渲染 |
| 打乱顺序 | 一键打乱牌组，避免记忆顺序化 |
| 错题本 | 学习中标记「不会」自动进错题本，支持错题重练与移除 |
| 题库管理 | 手工新增/编辑/删除题目，支持搜索、类型筛选、分页 |
| 文件导入 | 支持 Markdown / TXT / PDF，两种模式：结构化规则解析（答案与原文完全一致）或 AI 智能提取 |
| AI 出题 | 通过通用 OpenAI 兼容接口从笔记自动生成问答对，先预览确认后入库 |
| AI 总结 | 答案底部展示 AI 辅助总结（仅要点提炼，不篡改原文） |

## 快速开始

```bash
# 1. 创建虚拟环境并安装依赖
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. 启动服务
.venv/bin/uvicorn app.main:app --port 8666

# 3. 浏览器访问
open http://127.0.0.1:8666
```

### 导入初始题库

```bash
# 默认导入坚果云「一面-技术面试内容.md」
.venv/bin/python scripts/import_initial.py

# 或指定任意同格式笔记
.venv/bin/python scripts/import_initial.py /path/to/notes.md
```

## AI 配置

进入「AI 设置」页填写：

- **API URL**：OpenAI 兼容接口地址（完整地址或 base_url 均可，自动补全 `/chat/completions`）
- **API Key**：密钥脱敏存储展示，留空保存表示不修改原值
- **Model**：模型名称

兼容官方 OpenAI、各类中转服务及本地部署（Ollama / vLLM / LM Studio）。

> 答案忠实性保障：AI 出题的系统提示词强制要求 answer 必须摘录或严格基于笔记原文，
> AI 总结独立存于 `ai_summary` 字段在卡片底部展示，二者互不影响。

## 笔记格式约定（结构化导入）

Markdown 一级标题作为问题，标题后正文作为答案，`---` 分隔可选：

```markdown
# 这里是问题？

这里是答案正文，多行保留。
```

非此格式的笔记请使用「AI 智能提取」模式。

## 项目结构

```
study-card-web/
├── app/
│   ├── main.py              # FastAPI 入口
│   ├── database.py          # SQLite 访问层（WAL 模式）
│   ├── models.py            # Pydantic 数据模型
│   ├── routers/
│   │   ├── cards.py         # 题库 CRUD
│   │   ├── study.py         # 学习牌组与错题本
│   │   ├── ai.py            # AI 配置/出题/总结
│   │   └── import_router.py # 文件上传解析
│   ├── services/
│   │   ├── openai_client.py # 通用 OpenAI 兼容客户端
│   │   └── file_parser.py   # md/txt/pdf 文本提取与规则解析
│   └── static/              # 前端单页应用（Tailwind CSS）
├── scripts/
│   └── import_initial.py    # 初始题库导入脚本
└── data/studycard.db        # SQLite 数据文件（自动创建）
```

## 快捷键（学习模式）

| 按键 | 动作 |
|------|------|
| 空格 | 翻转卡片 |
| ← / → | 上一题 / 下一题 |
| 1 | 不会（进错题本） |
| 2 | 会了（移出错题本） |

## API 文档

服务启动后访问 `http://127.0.0.1:8666/docs` 查看交互式接口文档。


"""
输出要求：
- 仅输出讲解的 Markdown 文本本身，不要使用「总结：」「讲解：」等前缀；
- 必须使用 Markdown：三级标题 `###`、四级标题 `####`、列表 `-`、参数/命令用 `反引号`、必要时代码块；禁止把"维度名"和"解决方案"写在同一行用「→」连接；
- 长度控制在 5~9 个段落/列表项，信息密度高但不啰嗦。
"""
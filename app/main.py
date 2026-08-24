"""
学习卡片应用 - FastAPI 入口

启动方式（项目根目录执行）：
    uvicorn app.main:app --reload --port 8666

访问地址：
    http://127.0.0.1:8666
"""
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .database import init_db
from .routers import ai, cards, import_router, study

# 静态资源目录（前端单页应用）
STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(
    title="学习卡片 StudyCard",
    description="基于笔记的问答卡片学习工具：AI 出题、题库管理、逐卡学习、错题本",
    version="1.0.0",
)


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    """开发期禁用静态资源与首页缓存，避免改了样式/脚本却仍显示旧文件。"""
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response

# 注册 API 路由
app.include_router(cards.router)
app.include_router(study.router)
app.include_router(ai.router)
app.include_router(import_router.router)

# 挂载静态资源
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def on_startup():
    """应用启动时初始化数据库表结构（幂等）"""
    init_db()


@app.get("/", include_in_schema=False)
def index():
    """前端单页入口"""
    return FileResponse(STATIC_DIR / "index.html")

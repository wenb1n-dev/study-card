/**
 * 学习卡片 StudyCard - PM2 进程管理配置
 *
 * 用法：
 *   pm2 start ecosystem.config.js       启动（守护进程，开机可自启）
 *   pm2 stop  study-card                关闭
 *   pm2 restart study-card              重启
 *   pm2 logs  study-card                查看日志
 *   pm2 save && pm2 startup             保存并设置开机自启（按需）
 *
 * 说明：通过 interpreter 直接调用虚拟环境内的 Python，
 *       由 uvicorn 拉起 FastAPI 应用；cwd 指向项目根目录。
 */
module.exports = {
  apps: [
    {
      name: "study-card",
      cwd: __dirname,
      // 使用项目虚拟环境内的 Python 解释器
      interpreter: "./.venv/bin/python",
      script: "-m",
      args: "uvicorn app.main:app --port 8666 --host 127.0.0.1",
      // 日志落盘，便于排查
      error_file: "data/pm2-error.log",
      out_file: "data/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // 异常退出自动重启，最多 3 次/10s，防止死循环
      autorestart: true,
      max_restarts: 3,
      min_uptime: 10000,
      // 仅使用 1 个工作进程（SQLite 单库，避免多进程写竞争）
      instances: 1,
      exec_mode: "fork",
    },
  ],
};

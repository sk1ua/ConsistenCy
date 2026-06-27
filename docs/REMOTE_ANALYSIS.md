# 远程分析

远程分析路径允许 ConsistenCy 在没有完整本地 checkout 的情况下检查 GitHub PR。

它适合数据采集和评估，依赖仓库访问权限以及可用的 base/head refs。

本地确定性分析仍可通过以下命令使用：

```bash
python backend/cli.py pr-report --repo . --base <base> --head <head> --json-output
```

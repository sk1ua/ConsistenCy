@echo off
REM 启动脚本 (Windows)

echo ConsistenCy - 代码一致性审查工具
echo.

cd backend

REM 检查Python
python --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到Python，请先安装Python 3.8+
    exit /b 1
)

REM 显示菜单
echo 请选择操作:
echo 1. 扫描项目
echo 2. 检查文件
echo 3. 搜索代码
echo 4. 查看知识库信息
echo 5. 运行测试示例
echo.

set /p choice="请输入选项 (1-5): "

if "%choice%"=="1" (
    set /p path="请输入项目路径: "
    python cli.py scan "%path%"
) else if "%choice%"=="2" (
    set /p file="请输入文件路径: "
    python cli.py check "%file%" --verbose
) else if "%choice%"=="3" (
    set /p query="请输入搜索关键词: "
    python cli.py query "%query%"
) else if "%choice%"=="4" (
    python cli.py info
) else if "%choice%"=="5" (
    echo 运行测试示例...
    python cli.py scan ../tests/example_project.py --clear
    echo.
    echo 按任意键继续检查示例...
    pause >nul
    python cli.py check ../tests/example_project.py --verbose
) else (
    echo 无效选项
)

echo.
pause

@echo off
REM 清理 Python 缓存目录
echo 正在清理 __pycache__ 目录...

if exist "__pycache__" (
    rmdir /s /q "__pycache__"
    echo ✓ 已删除 __pycache__ 目录
) else (
    echo 未找到 __pycache__ 目录
)

echo.
echo 清理完成！
pause

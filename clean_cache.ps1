# 清理 Python 缓存目录
Write-Host "正在清理 __pycache__ 目录..." -ForegroundColor Cyan

if (Test-Path "__pycache__") {
    Remove-Item -Recurse -Force "__pycache__"
    Write-Host "✓ 已删除 __pycache__ 目录" -ForegroundColor Green
} else {
    Write-Host "未找到 __pycache__ 目录" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "清理完成！" -ForegroundColor Green
Read-Host "按 Enter 键退出"

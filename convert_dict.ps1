# 词典转换工具 PowerShell 脚本
# 使用方法：右键点击 -> 使用 PowerShell 运行

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "词典转换工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "ecdict.csv")) {
    Write-Host "[错误] 找不到 ecdict.csv 文件" -ForegroundColor Red
    Write-Host "请确保 ecdict.csv 文件在当前目录下" -ForegroundColor Yellow
    Read-Host "按 Enter 键退出"
    exit 1
}

Write-Host "请选择转换模式：" -ForegroundColor Yellow
Write-Host "1. 测试版（5000个单词，快速测试）"
Write-Host "2. 中等规模（50000个单词，推荐日常使用）"
Write-Host "3. 完整词典（所有单词，约40万词）"
Write-Host "4. 自定义数量"
Write-Host ""
$choice = Read-Host "请输入选项 (1-4)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "开始转换测试版词典（5000个单词）..." -ForegroundColor Green
        python dict_converter.py convert ecdict.csv offline_dict_test.json --max-words 5000
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "[完成] 测试版词典已生成：offline_dict_test.json" -ForegroundColor Green
        }
    }
    "2" {
        Write-Host ""
        Write-Host "开始转换中等规模词典（50000个单词）..." -ForegroundColor Green
        python dict_converter.py convert ecdict.csv offline_dict_50k.json --max-words 50000
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "[完成] 中等规模词典已生成：offline_dict_50k.json" -ForegroundColor Green
        }
    }
    "3" {
        Write-Host ""
        Write-Host "开始转换完整词典（所有单词，可能需要几分钟）..." -ForegroundColor Green
        python dict_converter.py convert ecdict.csv offline_dict_full.json
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "[完成] 完整词典已生成：offline_dict_full.json" -ForegroundColor Green
        }
    }
    "4" {
        $wordcount = Read-Host "请输入单词数量"
        Write-Host ""
        Write-Host "开始转换自定义词典（$wordcount 个单词）..." -ForegroundColor Green
        python dict_converter.py convert ecdict.csv offline_dict_custom.json --max-words $wordcount
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "[完成] 自定义词典已生成：offline_dict_custom.json" -ForegroundColor Green
        }
    }
    default {
        Write-Host "[错误] 无效的选项" -ForegroundColor Red
        Read-Host "按 Enter 键退出"
        exit 1
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "转换完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "1. 打开扩展设置页面"
Write-Host "2. 找到'离线词典管理'部分"
Write-Host "3. 选择生成的JSON文件并导入"
Write-Host "4. 重新加载扩展"
Write-Host ""
Read-Host "按 Enter 键退出"

@echo off
chcp 65001 >nul
echo ========================================
echo 词典转换工具
echo ========================================
echo.

if not exist "ecdict.csv" (
    echo [错误] 找不到 ecdict.csv 文件
    echo 请确保 ecdict.csv 文件在当前目录下
    pause
    exit /b 1
)

echo 请选择转换模式：
echo 1. 测试版（5000个单词，快速测试）
echo 2. 中等规模（50000个单词，推荐日常使用）
echo 3. 完整词典（所有单词，约40万词）
echo 4. 自定义数量
echo.
set /p choice="请输入选项 (1-4): "

if "%choice%"=="1" (
    echo.
    echo 开始转换测试版词典（5000个单词）...
    python dict_converter.py convert ecdict.csv offline_dict_test.json --max-words 5000
    if %errorlevel%==0 (
        echo.
        echo [完成] 测试版词典已生成：offline_dict_test.json
    )
) else if "%choice%"=="2" (
    echo.
    echo 开始转换中等规模词典（50000个单词）...
    python dict_converter.py convert ecdict.csv offline_dict_50k.json --max-words 50000
    if %errorlevel%==0 (
        echo.
        echo [完成] 中等规模词典已生成：offline_dict_50k.json
    )
) else if "%choice%"=="3" (
    echo.
    echo 开始转换完整词典（所有单词，可能需要几分钟）...
    python dict_converter.py convert ecdict.csv offline_dict_full.json
    if %errorlevel%==0 (
        echo.
        echo [完成] 完整词典已生成：offline_dict_full.json
    )
) else if "%choice%"=="4" (
    set /p wordcount="请输入单词数量: "
    echo.
    echo 开始转换自定义词典（%wordcount%个单词）...
    python dict_converter.py convert ecdict.csv offline_dict_custom.json --max-words %wordcount%
    if %errorlevel%==0 (
        echo.
        echo [完成] 自定义词典已生成：offline_dict_custom.json
    )
) else (
    echo [错误] 无效的选项
    pause
    exit /b 1
)

echo.
echo ========================================
echo 转换完成！
echo ========================================
echo.
echo 下一步：
echo 1. 打开扩展设置页面
echo 2. 找到"离线词典管理"部分
echo 3. 选择生成的JSON文件并导入
echo 4. 重新加载扩展
echo.
pause

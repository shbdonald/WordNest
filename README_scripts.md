# 词典转换脚本使用说明

## 快速使用

### Windows 批处理脚本（推荐）

双击运行 `convert_dict.bat`，然后按提示选择：

1. **测试版**：5000个单词，约0.3MB，快速测试用
2. **中等规模**：50000个单词，约2.7MB，推荐日常使用
3. **完整词典**：所有单词（约40万），约21MB，完整覆盖
4. **自定义数量**：自己指定单词数量

### PowerShell 脚本

右键点击 `convert_dict.ps1`，选择"使用 PowerShell 运行"。

如果遇到执行策略限制，可以运行：
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## 手动使用 Python 脚本

如果脚本无法运行，可以手动使用 Python：

```bash
# 测试版（5000个单词）
python dict_converter.py convert ecdict.csv offline_dict_test.json --max-words 5000

# 中等规模（50000个单词）
python dict_converter.py convert ecdict.csv offline_dict_50k.json --max-words 50000

# 完整词典（所有单词）
python dict_converter.py convert ecdict.csv offline_dict_full.json

# 验证词典
python dict_converter.py validate offline_dict_50k.json
```

## 注意事项

- 确保 `ecdict.csv` 文件在当前目录
- 确保已安装 Python 3.6+
- 完整词典转换可能需要几分钟时间
- 生成的 JSON 文件可以直接在扩展设置页面导入

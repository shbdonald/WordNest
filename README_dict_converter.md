# 词典转换工具使用说明

## Python 脚本 (`dict_converter.py`)

这是一个功能完善的词典转换工具，支持多种转换和优化操作。

### 安装要求

```bash
# Python 3.6+
# 无需额外依赖，使用标准库
```

### 使用方法

#### 1. CSV 转 JSON（完整转换）

将 ECDICT CSV 文件转换为 JSON 格式：

```bash
python dict_converter.py convert ecdict.csv offline_dict.json
```

#### 2. CSV 转 JSON（限制单词数，适合快速测试）

只转换前 N 个单词：

```bash
python dict_converter.py convert ecdict.csv offline_dict.json --max-words 10000
```

#### 3. 优化现有词典

去重、清理、排序：

```bash
python dict_converter.py optimize offline_dict.json offline_dict_optimized.json
```

#### 4. 生成 IndexedDB 格式

生成适合 IndexedDB 分批存储的格式：

```bash
python dict_converter.py indexeddb offline_dict.json offline_dict_indexeddb.json
```

#### 5. 验证词典文件

检查词典文件的有效性：

```bash
python dict_converter.py validate offline_dict.json
```

### 功能特点

- ✅ **自动去重**：合并重复单词的翻译
- ✅ **数据验证**：过滤无效单词和空翻译
- ✅ **进度显示**：实时显示转换进度
- ✅ **错误处理**：优雅处理错误，不影响整体转换
- ✅ **批量处理**：支持 IndexedDB 分批存储
- ✅ **统计信息**：显示详细的转换统计

### 推荐工作流程

1. **首次转换（完整词典）**：
   ```bash
   python dict_converter.py convert ecdict.csv offline_dict_full.json
   ```

2. **生成精简版（常用词）**：
   ```bash
   python dict_converter.py convert ecdict.csv offline_dict_common.json --max-words 50000
   ```

3. **验证词典**：
   ```bash
   python dict_converter.py validate offline_dict_common.json
   ```

4. **优化词典**：
   ```bash
   python dict_converter.py optimize offline_dict_common.json offline_dict_final.json
   ```

### 注意事项

- 完整 ECDICT 词典可能很大（60MB+），转换需要几分钟
- 建议先用 `--max-words` 参数测试小规模转换
- 生成的 JSON 文件可以直接在设置页面导入

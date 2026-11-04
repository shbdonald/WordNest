#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
词典转换工具
功能：
1. ECDICT CSV 转 JSON
2. 词典优化（去重、筛选高频词等）
3. 生成适合 IndexedDB 的格式
4. 统计和验证
"""

import json
import csv
import sys
import os
from collections import Counter
from typing import Dict, List, Optional

class DictConverter:
    def __init__(self):
        self.dictionary = {}
        self.lemma_map = {}  # 变形词 -> 原形词映射表
        self.stats = {
            'total_lines': 0,
            'processed_words': 0,
            'duplicates': 0,
            'errors': 0,
            'lemma_entries': 0
        }
    
    def parse_exchange_field(self, exchange_str: str) -> List[str]:
        """
        解析 ECDICT 的 exchange 字段
        格式：p:studied/d:studied/i:studying/3:studies/s:studies
        返回所有变形词的列表
        """
        if not exchange_str or not exchange_str.strip():
            return []
        
        variations = []
        # 按 / 分割
        parts = exchange_str.split('/')
        for part in parts:
            part = part.strip()
            if ':' in part:
                # 格式：p:studied
                code, word = part.split(':', 1)
                if word and word.strip():
                    variations.append(word.strip().lower())
        return variations
    
    def convert_csv_to_json(self, input_file: str, output_file: str, 
                           max_words: Optional[int] = None,
                           min_word_length: int = 2,
                           max_word_length: int = 50,
                           filter_common: bool = True,
                           generate_lemma_map: bool = True) -> Dict:
        """
        将 ECDICT CSV 转换为 JSON 格式
        
        Args:
            input_file: 输入的 CSV 文件路径
            output_file: 输出的 JSON 文件路径
            max_words: 最大单词数（None表示不限制）
            min_word_length: 最小单词长度
            max_word_length: 最大单词长度
            filter_common: 是否只保留常用词（基于频率）
        """
        print(f"开始转换 {input_file}...")
        print("这可能需要几分钟时间，请耐心等待...")
        
        if not os.path.exists(input_file):
            print(f"错误：找不到文件 {input_file}")
            return {}
        
        self.dictionary = {}
        self.lemma_map = {}  # 重置映射表
        self.stats = {
            'total_lines': 0,
            'processed_words': 0,
            'duplicates': 0,
            'errors': 0,
            'lemma_entries': 0
        }
        
        word_frequency = Counter()
        
        try:
            with open(input_file, 'r', encoding='utf-8') as f:
                reader = csv.reader(f)
                
                # 跳过标题行
                next(reader, None)
                
                for row in reader:
                    self.stats['total_lines'] += 1
                    
                    if len(row) < 4:
                        continue
                    
                    try:
                        word = row[0].strip().lower()
                        phonetic = row[1].strip() if len(row) > 1 else ''  # phonetic 字段（第2列，索引1）
                        translation = row[3].strip()  # translation 字段（第4列，索引3）
                        exchange = row[10].strip() if len(row) > 10 else ''  # exchange 字段（第11列，索引10）
                        
                        # 验证单词
                        if not word or not translation:
                            continue
                        
                        if len(word) < min_word_length or len(word) > max_word_length:
                            continue
                        
                        # 只保留字母单词（排除特殊字符）
                        if not word.replace('-', '').replace("'", '').isalpha():
                            continue
                        
                        # 统计频率
                        word_frequency[word] += 1
                        
                        # 构建词典数据（包含音标）
                        word_entry = {
                            'translation': translation,
                            'phonetic': phonetic if phonetic else None  # 如果没有音标，设为 None
                        }
                        
                        # 如果单词已存在，合并翻译
                        if word in self.dictionary:
                            # 如果已有数据是字符串格式（旧格式），转换为对象格式
                            if isinstance(self.dictionary[word], str):
                                self.dictionary[word] = {
                                    'translation': self.dictionary[word],
                                    'phonetic': None
                                }
                            
                            # 合并翻译（如果新翻译不在已有翻译中）
                            existing_translation = self.dictionary[word]['translation']
                            if translation not in existing_translation:
                                self.dictionary[word]['translation'] = existing_translation + '；' + translation
                            
                            # 如果已有数据没有音标，但新数据有音标，则更新音标
                            if not self.dictionary[word]['phonetic'] and phonetic:
                                self.dictionary[word]['phonetic'] = phonetic
                            
                            self.stats['duplicates'] += 1
                        else:
                            self.dictionary[word] = word_entry
                            self.stats['processed_words'] += 1
                        
                        # 解析 exchange 字段，构建词形变化映射表
                        if generate_lemma_map and exchange:
                            variations = self.parse_exchange_field(exchange)
                            for variation in variations:
                                if variation and variation != word and len(variation) >= min_word_length:
                                    # 只保留有效的单词（排除单个字母如 's'）
                                    if len(variation) >= 2 and variation.replace('-', '').replace("'", '').isalpha():
                                        # 变形词 -> 原形词（如果已存在，保留第一个映射，因为原形词更准确）
                                        if variation not in self.lemma_map:
                                            self.lemma_map[variation] = word
                                            self.stats['lemma_entries'] += 1
                        
                        # 显示进度
                        if self.stats['total_lines'] % 10000 == 0:
                            print(f"已处理 {self.stats['total_lines']} 行，已提取 {self.stats['processed_words']} 个单词，词形映射 {self.stats['lemma_entries']} 条...")
                        
                        # 如果设置了最大单词数限制
                        if max_words and len(self.dictionary) >= max_words:
                            print(f"已达到最大单词数限制 {max_words}，停止处理")
                            break
                    
                    except Exception as e:
                        self.stats['errors'] += 1
                        if self.stats['errors'] < 10:  # 只显示前10个错误
                            print(f"处理第 {self.stats['total_lines']} 行时出错: {e}")
                        continue
        
        except Exception as e:
            print(f"读取文件时出错: {e}")
            return {}
        
        # 如果启用常用词过滤
        if filter_common and max_words:
            print(f"\n按频率筛选常用词...")
            # 按频率排序，取前 max_words 个
            sorted_words = sorted(word_frequency.items(), key=lambda x: x[1], reverse=True)
            filtered_dict = {}
            for word, freq in sorted_words[:max_words]:
                if word in self.dictionary:
                    filtered_dict[word] = self.dictionary[word]
            self.dictionary = filtered_dict
            self.stats['processed_words'] = len(self.dictionary)
        
        # 保存为 JSON
        print(f"\n保存到 {output_file}...")
        try:
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(self.dictionary, f, ensure_ascii=False, indent=2)
            
            file_size = os.path.getsize(output_file) / 1024 / 1024
            print(f"\n[完成] 转换完成！")
            print(f"总行数：{self.stats['total_lines']}")
            print(f"提取单词数：{self.stats['processed_words']}")
            print(f"重复词数：{self.stats['duplicates']}")
            print(f"错误数：{self.stats['errors']}")
            print(f"词形变化映射数：{self.stats['lemma_entries']}")
            print(f"文件大小：{file_size:.2f} MB")
            print(f"\n已保存到 {output_file}")
            
            # 如果生成了词形变化映射表，也保存
            if generate_lemma_map and self.lemma_map:
                lemma_file = output_file.replace('.json', '_lemma_map.json')
                with open(lemma_file, 'w', encoding='utf-8') as f:
                    json.dump(self.lemma_map, f, ensure_ascii=False, indent=2)
                lemma_size = os.path.getsize(lemma_file) / 1024 / 1024
                print(f"\n[完成] 词形变化映射表已生成！")
                print(f"映射条目数：{len(self.lemma_map)}")
                print(f"文件大小：{lemma_size:.2f} MB")
                print(f"已保存到 {lemma_file}")
            
            return self.dictionary
        
        except Exception as e:
            print(f"保存文件时出错: {e}")
            return {}
    
    def optimize_dictionary(self, input_file: str, output_file: str,
                           keep_top_n: Optional[int] = None) -> Dict:
        """
        优化现有词典（去重、排序、筛选）
        
        Args:
            input_file: 输入的 JSON 文件路径
            output_file: 输出的 JSON 文件路径
            keep_top_n: 只保留前N个单词（按字母顺序）
        """
        print(f"加载词典 {input_file}...")
        
        try:
            with open(input_file, 'r', encoding='utf-8') as f:
                self.dictionary = json.load(f)
        except Exception as e:
            print(f"读取文件时出错: {e}")
            return {}
        
        original_count = len(self.dictionary)
        print(f"原始单词数：{original_count}")
        
        # 去重和清理
        cleaned_dict = {}
        for word, translation in self.dictionary.items():
            word_lower = word.lower().strip()
            if word_lower and translation:
                # 如果已存在，合并翻译
                if word_lower in cleaned_dict:
                    if translation not in cleaned_dict[word_lower]:
                        cleaned_dict[word_lower] = cleaned_dict[word_lower] + '；' + translation
                else:
                    cleaned_dict[word_lower] = translation
        
        self.dictionary = cleaned_dict
        
        # 如果设置了保留数量
        if keep_top_n:
            print(f"筛选前 {keep_top_n} 个常用词...")
            sorted_items = sorted(self.dictionary.items())[:keep_top_n]
            self.dictionary = dict(sorted_items)
        
        # 保存
        print(f"保存优化后的词典...")
        try:
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(self.dictionary, f, ensure_ascii=False, indent=2)
            
            file_size = os.path.getsize(output_file) / 1024 / 1024
            print(f"\n[完成] 优化完成！")
            print(f"原始单词数：{original_count}")
            print(f"优化后单词数：{len(self.dictionary)}")
            print(f"文件大小：{file_size:.2f} MB")
            print(f"\n已保存到 {output_file}")
            
            return self.dictionary
        
        except Exception as e:
            print(f"保存文件时出错: {e}")
            return {}
    
    def generate_indexeddb_format(self, input_file: str, output_file: str,
                                  batch_size: int = 1000) -> None:
        """
        生成适合 IndexedDB 的格式（分批存储）
        
        Args:
            input_file: 输入的 JSON 文件路径
            output_file: 输出的 JSON 文件路径（包含批次信息）
            batch_size: 每批的单词数
        """
        print(f"加载词典 {input_file}...")
        
        try:
            with open(input_file, 'r', encoding='utf-8') as f:
                dictionary = json.load(f)
        except Exception as e:
            print(f"读取文件时出错: {e}")
            return
        
        print(f"总单词数：{len(dictionary)}")
        print(f"分批处理，每批 {batch_size} 个单词...")
        
        batches = []
        items = list(dictionary.items())
        
        for i in range(0, len(items), batch_size):
            batch = dict(items[i:i + batch_size])
            batches.append({
                'batch_id': i // batch_size,
                'data': batch,
                'count': len(batch)
            })
            print(f"生成批次 {i // batch_size + 1}/{len(batches)}...")
        
        result = {
            'total_words': len(dictionary),
            'batch_size': batch_size,
            'total_batches': len(batches),
            'batches': batches
        }
        
        # 保存
        try:
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            
            file_size = os.path.getsize(output_file) / 1024 / 1024
            print(f"\n[完成] 生成完成！")
            print(f"总单词数：{len(dictionary)}")
            print(f"总批次数：{len(batches)}")
            print(f"文件大小：{file_size:.2f} MB")
            print(f"\n已保存到 {output_file}")
        
        except Exception as e:
            print(f"保存文件时出错: {e}")
    
    def validate_dictionary(self, file_path: str) -> Dict:
        """
        验证词典文件的有效性
        
        Args:
            file_path: 词典文件路径
        """
        print(f"验证词典文件 {file_path}...")
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                dictionary = json.load(f)
        except Exception as e:
            print(f"读取文件时出错: {e}")
            return {}
        
        stats = {
            'total_words': len(dictionary),
            'empty_translations': 0,
            'invalid_words': 0,
            'sample_words': []
        }
        
        for word, translation in list(dictionary.items())[:10]:
            stats['sample_words'].append({'word': word, 'translation': translation[:50]})
            
            if not translation or not translation.strip():
                stats['empty_translations'] += 1
            
            if not word or len(word) < 2:
                stats['invalid_words'] += 1
        
        print(f"\n[完成] 验证完成！")
        print(f"总单词数：{stats['total_words']}")
        print(f"空翻译数：{stats['empty_translations']}")
        print(f"无效单词数：{stats['invalid_words']}")
        print(f"\n示例单词（前10个）：")
        for item in stats['sample_words']:
            print(f"  {item['word']}: {item['translation']}")
        
        return stats


def main():
    converter = DictConverter()
    
    if len(sys.argv) < 2:
        print("""
词典转换工具使用说明：

1. CSV 转 JSON（完整转换）：
   python dict_converter.py convert ecdict.csv offline_dict.json

2. CSV 转 JSON（限制单词数，适合快速测试）：
   python dict_converter.py convert ecdict.csv offline_dict.json --max-words 10000

3. 优化现有词典：
   python dict_converter.py optimize offline_dict.json offline_dict_optimized.json

4. 生成 IndexedDB 格式：
   python dict_converter.py indexeddb offline_dict.json offline_dict_indexeddb.json

5. 验证词典文件：
   python dict_converter.py validate offline_dict.json

示例：
  python dict_converter.py convert ecdict.csv offline_dict.json --max-words 50000
        """)
        return
    
    command = sys.argv[1]
    
    if command == 'convert':
        if len(sys.argv) < 4:
            print("错误：需要指定输入和输出文件")
            print("用法：python dict_converter.py convert <input.csv> <output.json> [--max-words N]")
            return
        
        input_file = sys.argv[2]
        output_file = sys.argv[3]
        max_words = None
        
        # 解析参数
        if '--max-words' in sys.argv:
            idx = sys.argv.index('--max-words')
            if idx + 1 < len(sys.argv):
                max_words = int(sys.argv[idx + 1])
        
        converter.convert_csv_to_json(input_file, output_file, max_words=max_words)
    
    elif command == 'optimize':
        if len(sys.argv) < 4:
            print("错误：需要指定输入和输出文件")
            print("用法：python dict_converter.py optimize <input.json> <output.json>")
            return
        
        input_file = sys.argv[2]
        output_file = sys.argv[3]
        converter.optimize_dictionary(input_file, output_file)
    
    elif command == 'indexeddb':
        if len(sys.argv) < 4:
            print("错误：需要指定输入和输出文件")
            print("用法：python dict_converter.py indexeddb <input.json> <output.json>")
            return
        
        input_file = sys.argv[2]
        output_file = sys.argv[3]
        converter.generate_indexeddb_format(input_file, output_file)
    
    elif command == 'validate':
        if len(sys.argv) < 3:
            print("错误：需要指定词典文件")
            print("用法：python dict_converter.py validate <dict.json>")
            return
        
        file_path = sys.argv[2]
        converter.validate_dictionary(file_path)
    
    else:
        print(f"未知命令：{command}")
        print("可用命令：convert, optimize, indexeddb, validate")


if __name__ == '__main__':
    main()
